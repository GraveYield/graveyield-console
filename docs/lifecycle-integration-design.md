# Console lifecycle integration — technical design (DRAFT for owner review)

**Status:** design only — nothing here is implemented. Per owner decision **O4**, the console's
lifecycle read scope and strategy must be approved before any code lands. This document is the
review artifact for that decision. It corresponds to audit findings **5.2 [HIGH]** and **5.8 [LOW]**
in `GraveYield-Console-Audit-Report.md` and to Phase-2 prompt Section 4 (design-and-preparation-only).

**Revision (2026-11-14, owner review round — delivered in PR #12).** The lifecycle model below was
corrected per the owner's review: every account read is an explicit `AccountRead` discriminated
union (`present` / `absent` / `unavailable` / `corrupt` / `owner-mismatch`) instead of a nullable
field; the epoch and clock reads carry explicit statuses (`EpochRead` / `TimeRead`);
classification is a deterministic precedence order with a normative truth table (§6);
`waiting-epochs` is removed as a lifecycle state — epoch progress is a dedicated `EpochProgress`
object rendered alongside `anchored`; `certification-ready` is renamed to
`re-evaluation-window-reached`; and an account with an unexpected owner is an explicit
`owner-mismatch` read that is never treated as absent. The document remains design-only — no
code is changed by this document.

**Revision (2026-11-14, owner review round 2 — delivered in PR #12).** Six further corrections
from the PR #12 review, each verified against the canonical sources before being written down:

1. **Anchor sweep and certificate lifecycle.** The previous revision classified a certificate
   existing while its anchor is definitively absent as `"inconsistent"` ("a certificate cannot
   exist without an anchor"). That is wrong against the canonical protocol: the permissionless
   `sweep_stale_anchor` (`programs/grave-scanner/src/instructions/sweep_stale_anchor.rs`) closes
   ANY anchor whose staleness window has elapsed — certified or not — and no instruction closes
   an `EligibilityCert` (its rent "stays locked until a close instruction exists",
   `programs/grave-scanner/src/state/eligibility_cert.rs`). A certificate without an anchor is
   therefore a legitimate post-sweep lifecycle, and since `cert_ttl_seconds` is
   governance-configurable with only a floor (`MIN_CERT_TTL_SECONDS = 600`), a swept anchor does
   not even imply an expired certificate. Certificate validity is now decided solely by the
   certificate's own on-chain fields (`expiresAt` vs a cluster-time estimate), never by anchor
   presence; anchor state renders as a history note.
2. **Epoch-gap source.** `requiredEpochGap` was described as a live scanner `ProtocolConfig`
   field (`minEpochConfirmation`). Canonical `ProtocolConfig` carries no such field and
   `update_protocol_config` exposes no such parameter; the gap is the compile-time constant
   `MIN_EPOCH_CONFIRMATION = 2` (`programs/grave-scanner/src/constants.rs`), enforced on-chain at
   Phase 2 (`programs/grave-scanner/src/criteria.rs`, else error 6016
   `EpochConfirmationPending`). Changing it requires a program upgrade. The SDK's
   `minEpochConfirmation` (`sdk/src/types.ts`, `EligibilityCriteria`) is the evaluation-criteria
   input mirroring that constant — not a live config field.
3. **Account fetch and owner validation.** The canonical SDK's server-side `fetch*` wrappers
   (`sdk/src/accountDecoders.ts`) fetch-and-decode in one step and do NOT validate the account
   owner before decoding (the decoder asserts only the 8-byte discriminator). The design now
   specifies the full console-side read sequence — derive (SDK) → raw fetch → owner check → SDK
   decode → identity-field check — and adds an explicit `identity-mismatch` read status (§5.1,
   §7.3).
4. **Certificate expiry time source.** `cert.expiresAt` is stamped on-chain as
   `Clock::get().unix_timestamp + cert_ttl_seconds` (`evaluate_pool_phase2.rs`) — Solana
   validator-cluster time. A server's local `Date.now()` is not authoritative on-chain time; the
   console obtains a cluster-time estimate over RPC (`getBlockTime` of a recent slot) and fails
   closed when it cannot be obtained or refreshed (§7.5).
5. **RPC batch semantics.** The previous revision claimed `getMultipleAccounts` can return
   per-account transport failures while other accounts in the same batch succeed. A batch call
   either returns a response or fails as one request; individual `null` entries are definitive
   absences, not transport errors (§7.2).
6. **Decoded identity validation.** A successful decode alone does not prove the account belongs
   to the requested pool: the decoded identity fields (`ammProgramId`/`poolAddress` for anchor,
   cert and registry; `poolAddress` for the receipt) are compared against the requested pool
   after decoding, and mismatches are an explicit `identity-mismatch` status that can never be
   read as valid evidence (§7.3).

**Revision (2026-11-15, owner review round 3 — delivered in PR #12).** Four further corrections
from the PR #12 review, each verified against the canonical sources (`graveyield-protocol`
`main` @ `16f76add` — the same commit the round-2 corrections were verified against) before
being written down:

1. **Certificate classification is anchor-independent.** The round-2 rule order made an invalid
   anchor read block every later classification — including a live certificate's. That
   contradicts the canonical settlement path: `GraveVault::salvage_pool` requires the
   `EligibilityCert` and never references an `EligibilityAnchor` (the `SalvagePool` accounts
   context in `programs/grave-vault/src/instructions/salvage_pool.rs` carries no anchor
   account). Certificate validity now classifies (§5.3 rule 6) BEFORE the anchor read is
   consulted (rule 7): a valid, identity-matched, unexpired certificate remains `"certified"`
   with ANY anchor read status — valid, invalidated, definitively absent (swept), or
   invalid/unavailable — and the anchor renders only as history. For an expired certificate
   whose anchor read is invalid, the classification is `"certificate-expired"` and the rendering
   makes no re-certification inference (the anchor's state is not established).
2. **Receipt evidence must be resolved before a non-settled classification.** `salvage_pool`
   creates `PoolRegistry` and `SalvageReceipt` atomically — both are `init` accounts of the same
   instruction (`salvage_pool.rs`; its own comments call the registry "the canonical
   double-salvage defense" and the receipt "second canonical defense layer"). A new §5.3 rule 4
   therefore fails closed when the registry is definitively absent but the receipt read is
   `unavailable`, `owner-mismatch`, or `identity-mismatch`: the atomic-pair cross-check is
   incomplete, so the outcome is `"unavailable"` — never `"discovered"`, `"anchored"`, or any
   other non-settled state. Only a definitively absent receipt lets the non-settled
   classifications proceed (§5.3 rule 10 now requires all four absences).
3. **Certificate criteria-bitmap validation (salvage preflight).** `salvage_pool` requires
   `cert.criteria_bitmap == ALL_CRITERIA_MASK` (`0b00111111` = `0x3F`, all six criteria —
   `programs/grave-vault/src/instructions/salvage_pool.rs:95`, mirrored by
   `grave_scanner::criteria::ALL_CRITERIA_MASK`, the OR of the six `CRITERION_*` bits). The
   design now states explicitly (new §5.6) what `"certified"` establishes — existence,
   structural/identity validity, and expiry per the cluster-time estimate — and what it does
   NOT: satisfaction of the vault's criteria-bitmap requirement and the vault's other salvage
   preflight conditions. The console renders the bitmap comparison as an explicitly-typed
   preflight fact; it never folds it into the lifecycle state and never evaluates the criteria
   themselves.
4. **Cluster-time freshness and expiry-boundary uncertainty.** §7.5 now defines the estimate's
   maximum age (a bounded `getBlockTime` look-back window, validated source slot and
   timestamp), and an explicit expiry-boundary margin: when the estimate lies within ±60 s of
   the cert's `expiresAt`, the expiry decision is inside the estimate's uncertainty and the
   classification fails closed to `"unavailable"` rather than asserting `certified` or
   `certificate-expired` from an approximate timestamp. No precision is claimed beyond what
   Solana RPC provides, and the estimate is never presented as definitive on-chain validity.

The document remains design-only — no code is changed by this document.

**Non-goals (hard boundaries).** This design does not change protocol behavior, does not make the
console an eligibility authority, does not evaluate criteria, does not sign anything, and does not
infer any state from the indexer snapshot. **GraveScanner remains the sole eligibility authority;
GraveVault remains the sole settlement authority.** The console only READS canonical on-chain
accounts through the vendored canonical SDK and renders what those accounts prove — everything
else is "unavailable".

---

## 1. Account set and fact ownership

For one pool (identified by `ammProgramId` + `poolAddress` — both carried by every snapshot row
today; the snapshot already records `ammProgramId`, and `address` is the pool):

| # | Account | Program | PDA seed set (canonical, verified) | Fact it owns | Decoder |
| --- | --- | --- | --- | --- | --- |
| 1 | `EligibilityAnchor` | GraveScanner | `["eligibility_anchor", amm_program_id, pool_address]` | Phase 1 happened: `firstEligibleEpoch`, `writtenAt`, `criteriaBitmap`, **`invalidated`** | `decodeEligibilityAnchor` |
| 2 | `EligibilityCert` | GraveScanner | `["eligibility_cert", amm_program_id, pool_address]` | Phase 2 happened: `anchorEpoch`, `certEpoch`, `issuedAt`, **`expiresAt`**, `criteriaBitmap`, `reissueGeneration` | `decodeEligibilityCert` |
| 3 | `PoolRegistry` | GraveVault | `["pool_registry", pool_address]` | **Settlement happened**: merkle root, snapshot supply, LP-bucket totals, `salvagedAtSlot/Ts` | `decodePoolRegistry` |
| 4 | `SalvageReceipt` | GraveVault | `["salvage_receipt", pool_address]` | Settlement detail: 40/40/20 amounts, memecoin mint, dust, `dustSweptAtTs` | `decodeSalvageReceipt` |
| — | `EpochInfo` (RPC) | — | — (not an account) | the current epoch — the only clock the epoch-gap math may use | `getEpochInfo` (already shipped by `fetchEpochTelemetry`) |
| — | cluster time (RPC) | — | — (not an account) | the cluster-time estimate against which `expiresAt` is judged (§7.5) | `getSlot` + `getBlockTime` |

Decoded identity fields (verified against the canonical state structs and the SDK decoders that
mirror them): `EligibilityAnchor`, `EligibilityCert` and `PoolRegistry` each carry
`ammProgramId` + `poolAddress`; `SalvageReceipt` carries `poolAddress` only (it has no
`ammProgramId` field — `programs/grave-vault/src/state/salvage_receipt.rs`). After a successful
decode these fields are compared against the requested pool identity (§7.3, step 5); a mismatch
is the explicit `identity-mismatch` read status, never valid evidence.

Ownership rules (no overlaps, no inference):

- **Anchor absence** (the definitive `absent` status, §5.1) means exactly "no live anchor PDA at
  the canonical address" — nothing more. Two canonical causes produce it: Phase 1 never passed
  for this pool, or the permissionless `sweep_stale_anchor` closed the anchor after its
  staleness window (`anchor_staleness_seconds`, floored at 3 epochs / 6 days by
  `MIN_ANCHOR_STALENESS_SECONDS`; the anchor itself carries no TTL). Absence is therefore NOT
  proof that Phase 1 never ran, and it is NOT "discovered-and-evaluated-eligible"; the console
  never renders eligibility intent from absence, and an `unavailable`, `corrupt`,
  `owner-mismatched`, or `identity-mismatched` anchor read is never folded into absence. The
  sweep closes only the anchor — a certificate issued from it is untouched and is judged by its
  own fields (§5.3 rule 6 classifies the certificate before the anchor read is even consulted;
  the vault's own settlement preflight requires the certificate and never references an anchor —
  `salvage_pool`'s accounts context has no anchor account).
- **`firstEligibleEpoch`** (anchor) and the **live epoch** together own the epoch-progress and
  re-evaluation-window distinctions (§5.4): epoch progress is reported alongside `anchored`, and
  reaching the window means only that GraveScanner may re-evaluate. The console does not decide
  eligibility — it reports what the scanner's own Phase-1 record + the epoch clock show.
- **`expiresAt`** (cert) owns certificate expiry. It is an on-chain i64 (unix seconds) stamped
  by `evaluate_pool_phase2` as `Clock::get().unix_timestamp + ProtocolConfig.cert_ttl_seconds`,
  judged against a cluster-time estimate (§7.5) — not a client-side TTL guess and never local
  wall-clock time.
- **`invalidated`** (anchor) owns anchor invalidation — set only by the scanner's multisig-only
  `invalidate_anchor`, and a **pre-certification control only**: the canonical instruction's own
  scope note states that "an EligibilityCert already issued from this anchor is NOT affected —
  the cert's own TTL bounds its life, and `salvage_pool` verifies freshness against the cert,
  not the anchor" (`programs/grave-scanner/src/instructions/invalidate_anchor.rs`). Invalidation
  blocks future certification (Phase 2 refuses with `AnchorInvalidated` 6017; the flag is
  one-way) but never revokes a live certificate. The console can never manufacture the flag and
  never invents a revocation semantics the protocol does not implement.
- **`cert_ttl_seconds`** (scanner `ProtocolConfig`) is governance-configurable with a hardcoded
  floor of 600 s (`MIN_CERT_TTL_SECONDS`) and no upper cap; `anchor_staleness_seconds` is
  governance-configurable with a 6-day floor. Because a governance-raised cert TTL can outlive
  a governance-narrowed sweep window, **a swept anchor does not imply an expired certificate** —
  expiry is always read from the cert's own `expiresAt`, never inferred from the anchor's
  absence.
- **`criteriaBitmap`** (cert, decoded u8) owns the cert-side salvage-preflight input: the
  vault's `salvage_pool` requires `cert.criteria_bitmap == ALL_CRITERIA_MASK` — `0b00111111`
  (`0x3F`), all six criteria (`programs/grave-vault/src/instructions/salvage_pool.rs:95`, where
  the vault hardcodes the mask so a misnamed scanner re-export fails at compile time; the
  scanner defines the same value as the OR of its six `CRITERION_*` bits,
  `programs/grave-scanner/src/criteria.rs`). The console compares the decoded bitmap against
  the pinned canonical mask and renders the result as an explicitly-typed preflight fact
  (§5.6) — it never folds the bitmap into the lifecycle classification and never evaluates the
  criteria themselves.
- **`PoolRegistry` existence** owns "salvaged" — and only a valid, correctly owned, successfully
  decoded, identity-matched registry read (`present`, §5.1) proves it; an `unavailable`,
  `corrupt`, `owner-mismatched`, or `identity-mismatched` registry read proves nothing and is
  never treated as absence. The registry is init-once at salvage (`salvage_pool`), so its
  presence is the canonical settled fact. **The receipt is the other half of the same atomic
  write** — `salvage_pool` `init`s both accounts in one instruction (its own comments call the
  registry "the canonical double-salvage defense" and the receipt "second canonical defense
  layer") — so the two reads corroborate each other. After the registry exists, the receipt is
  optional display detail: its absence or an unavailable read renders as a partial row, never
  as an error hiding the settlement. While the registry is absent, a receipt read that is not
  resolved — definitively `absent` — blocks every non-settled classification (§5.3 rule 4).

Read count per pool: 4 account reads (individual `getAccountInfo` requests run concurrently via
`Promise.allSettled`, §7.2) + one shared `getEpochInfo` per refresh (already implemented in
`protocolLive.ts`) + one cluster-time estimate (`getSlot` + `getBlockTime`, §7.5).

## 2. Canonical SDK usage (no console-side derivation)

Everything derives and decodes through the vendored canonical SDK
(`src/lib/gy/vendor/graveyield-sdk/`, sha256-pinned by `sdkVendored.test.ts`):

- PDA derivation: `eligibilityAnchorPda(scannerProgramId, amm, pool)`,
  `eligibilityCertPda(...)`, `poolRegistryPda(vaultProgramId, pool)`,
  `salvageReceiptPda(vaultProgramId, pool)` — the console never hand-builds a seed.
- Decoding: `decodeEligibilityAnchor` / `decodeEligibilityCert` / `decodePoolRegistry` /
  `decodeSalvageReceipt` (discriminator-asserting).
- **The SDK's server-side `fetch*` wrappers (`fetchEligibilityAnchor`, `fetchEligibilityCert`,
  `fetchPoolRegistry`, `fetchSalvageReceipt`) are NOT used as the primary read mechanism.**
  Verified against `sdk/src/accountDecoders.ts`: each wrapper calls `getAccountInfo`, maps `null`
  to `null`, and decodes immediately — they do not check `info.owner` before decoding, and the
  decoders themselves assert only the 8-byte account discriminator (which is program-independent,
  so a wrong-owner account can pass it). Using them alone would let a foreign-owned account
  decode as protocol state. The console instead performs the explicit read sequence of §7.3 —
  derive (SDK) → raw fetch → owner validation → SDK decode → identity-field validation — and
  uses the SDK for the two steps it owns (derivation and decoding). No competing PDA seed
  implementation and no custom account decoder is introduced.
- Program IDs: `PROGRAM_IDS.graveScanner` / `PROGRAM_IDS.graveVault` (`src/lib/gy/data.ts`),
  pinned to the canonical `declare_id!` values
  (`EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL` scanner, `7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya`
  vault). No new identity constants.

## 3. Read strategy: per selected pool, on sheet open (recommended)

**Recommendation: read per selected pool when the Graveyard detail sheet opens, plus an explicit
manual "refresh lifecycle" affordance in the sheet. No table-wide fan-out.**

Rationale, stated as verifiable properties:

1. The snapshot table can carry ~hundreds of pools; 4 reads × N pools on every table render
   would multiply RPC load by orders of magnitude for facts the operator is not looking at. The
   console's existing discipline is *manual refresh, no polling* — a table-wide fan-out would
   violate it in spirit on every render.
2. The lifecycle states that matter operationally (certified window countdown, epoch-gap
   progress) are decision inputs for the pool the operator opened. Per-sheet reads place the
   freshness exactly where the decision is made.
3. It matches the two precedents already in the codebase: the pool sheet's ProtocolConfig pulse
   (P4.5 — one read per sheet open) and the claims route's on-chain read set (P4.4).
4. It keeps the blast radius of a misconfigured RPC inside the sheet: the table keeps rendering
   the indexer snapshot even when chain reads fail.

If the owner prefers table-wide state badges later (O4 scope decision), the same module is
reusable with a batched `getMultipleAccounts` call (whole-request semantics — §7.2); the per-pool
state derivation and every fail-closed rule stay identical. That is an additive change — the
design keeps it out of scope.

**A `Pool` row's `state` remains `"discovered"` for snapshot rows in the table.** Only the sheet's
lifecycle panel (and the badge/stepper inside it) consume the derived on-chain state. The table
does not silently change state vocabulary per row — that keeps the table's provenance honest
(snapshot = discovery evidence) while the sheet shows chain truth. Note the table's snapshot-row
`"discovered"` is the console's pre-existing discovery-evidence vocabulary, not the on-chain
`discovered` classification of §5.3 — the table never computes lifecycle classifications.

## 4. RPC commitment, endpoint, and transport

- **Commitment: `confirmed`.** Matches `claimsOnchain.ts` (P4.4). Anchors/certs/registries are
  written by governance- and oracle-gated instructions with no optimistic client path; the
  ~1.5s-confirmation level is sufficient and avoids exposing unconfirmed forks on an
  operational console. `finalized` would add latency for no decision value here.
- **Endpoint: the single configured RPC surface** introduced by the Phase-2 B1 correction
  (`protocolLive.configuredRpcEndpoint()` — `NEXT_PUBLIC_SOLANA_RPC_URL`, devnet fallback). The
  lifecycle read MUST NOT introduce a second RPC variable. Server-side route execution only
  (`/api/gy/lifecycle?pool=…&amm=…`, Node runtime) so the vendored SDK's `node:crypto` stays out
  of the browser bundle — the exact pattern of `/api/gy/claims`.
- The route validates its query parameters (base58 `pool`/`amm`, exact lengths) and answers in a
  **four-state envelope** (`valid | stale | missing | corrupt`-shaped, mirroring the existing
  transports) carrying each fact as an explicit `AccountRead` status (§5.1) with per-fact reason
  strings. The client re-validates the payload with the same fail-closed parser (client-side
  revalidation is a preservation requirement).
- Program ownership check at the transport: `getAccountInfo` returns `owner`; owner validation
  runs BEFORE decoding, and a PDA owned by a program other than the expected one maps to the
  explicit `owner-mismatch` read status (see §7.3) — never to absence — and is never decoded.
- Decoded identity check at the derivation boundary: after a successful decode, the decoded
  identity fields are compared against the requested pool; a mismatch maps to the explicit
  `identity-mismatch` read status (see §7.3, step 5) — never to `present`, never to absence.
- Cluster time at the transport: the route also obtains the cluster-time estimate the expiry
  decision consumes (§7.5) — the response's `TimeRead` is an RPC cluster-time estimate with its
  own explicit status, never the server's local clock.

## 5. State derivation — a pure, total function over explicitly-typed reads

A new pure module `src/lib/gy/lifecycle.ts` (no React, no fetch — fully unit-testable).

### 5.1 Explicit account-read model (no nullable reads)

Nullable account fields are forbidden in this model. `null` cannot distinguish a definitively
absent account from an RPC failure, from corrupt account data, or from an account owned by the
wrong program — and conflating those cases lets infrastructure failure or identity
misconfiguration masquerade as on-chain fact. Every lifecycle account read is therefore an
explicit discriminated union:

```ts
export type AccountRead<T> =
  | { status: "present"; data: T }
  | { status: "absent" }
  | { status: "unavailable"; reason: string }
  | { status: "corrupt"; reason: string }
  | {
      status: "owner-mismatch";
      expectedOwner: string;
      actualOwner: string;
    }
  | {
      status: "identity-mismatch";
      expectedIdentity: Record<string, string>; // the requested pool identity, e.g. { ammProgramId, poolAddress }
      actualIdentity: Record<string, string>;   // the decoded account's identity fields
    };
```

It applies uniformly to all four lifecycle accounts — `EligibilityAnchor`, `EligibilityCert`,
`PoolRegistry`, `SalvageReceipt`:

```ts
export interface LifecycleReads {
  anchor:   AccountRead<EligibilityAnchor>;   // GraveScanner PDA — Phase-1 record
  cert:     AccountRead<EligibilityCert>;     // GraveScanner PDA — Phase-2 record
  registry: AccountRead<PoolRegistry>;        // GraveVault PDA — settlement fact
  receipt:  AccountRead<SalvageReceipt>;      // GraveVault PDA — optional settlement detail
  currentEpoch: EpochRead;                    // getEpochInfo — the only epoch clock the gap math may use
  nowUnix:      TimeRead;                     // RPC cluster-time estimate (§7.5) — the only clock the expiry decision may use
}
```

Clock reads carry explicit statuses for the same reason — an unavailable epoch or clock is never
represented as a numeric value (no `0` sentinel, no `NaN`, no assumed fallback):

```ts
export type EpochRead =
  | { status: "available"; value: number }
  | { status: "unavailable"; reason: string };

export type TimeRead =
  | {
      status: "available";
      value: number;             // unix seconds — RPC cluster-time estimate (§7.5); never Date.now() substituted
      sourceSlot: number;        // the slot whose block time supplied `value` — at most CLUSTER_TIME_MAX_LOOKBACK_SLOTS behind the head slot (§7.5)
      estimatedAtUnixMs: number; // local fetch stamp — bookkeeping only, never a cluster-time input
    }
  | { status: "unavailable"; reason: string };
```

Status semantics, and what each status may contribute to classification:

| Status | Meaning | Effect on lifecycle classification |
| --- | --- | --- |
| `present` | The account exists at the expected PDA, its `owner` matched the expected program (validated **before** decoding), the SDK decoder accepted the data, and the decoded identity fields match the requested pool (§7.3, step 5). | The only status whose `data` may be used as classification input; with `corrupt`, the only existence evidence that may participate in the impossible-shape checks (§5.3 rule 3). |
| `absent` | The RPC call succeeded and definitively returned no account at the PDA (all four accounts are init-once at their lifecycle step). | Positive, definitive evidence of absence — the only path to `discovered` and to non-settlement. For the anchor it means "no live anchor PDA": Phase 1 never passed OR the anchor was swept (§1) — never an eligibility statement. |
| `unavailable` | The read could not be completed (RPC/infrastructure failure, timeout, transport error). | Never evidence of presence or absence. Any classification that needs this read fails closed to `unavailable` with diagnostics. |
| `corrupt` | The account exists but could not be decoded (discriminator mismatch, truncated/short data, out-of-shape integers). | Never treated as `absent`; never partially decoded. Its content is unusable — content-dependent classifications fail closed — but its owner-validated existence at a protocol PDA may establish an impossible shape (§5.3 rule 3). |
| `owner-mismatch` | An account exists at the expected PDA but is owned by a program other than the expected one. | Never treated as `absent`; never decoded; never used as evidence of any protocol invariant (a foreign program's account proves nothing about this protocol's state). Classification fails closed; surfaces an identity-misconfiguration diagnostic. |
| `identity-mismatch` | The account is owned by the expected program, decodes cleanly, but its decoded identity fields disagree with the requested pool (e.g. `poolAddress` ≠ the requested pool). | Never treated as `absent` and never as `present`: the account exists but is not evidence about THIS pool. Classification fails closed with the expected-vs-actual identity in diagnostics (§7.3). |

### 5.2 Lifecycle states

```ts
export type LifecycleState =
  | "unavailable"                    // a required read is unavailable/corrupt/owner-mismatched/identity-mismatched, the receipt cross-check is unresolved (§5.3 rule 4), or a needed clock read is unavailable — honest unknown, NOT "discovered"
  | "inconsistent"                   // verifiably-read evidence contradicts canonical invariants — never rendered as a normal lifecycle state
  | "discovered"                     // registry, receipt, anchor and cert each DEFINITIVELY absent — no on-chain lifecycle evidence
  | "anchored"                       // valid anchor, no cert, re-evaluation window NOT reached — epoch progress reported separately (§5.4)
  | "re-evaluation-window-reached"   // valid anchor, no cert, gap ≥ required gap — GraveScanner MAY re-evaluate; nothing more (§5.4)
  | "certified"                      // valid cert with now < expiresAt, outside the §7.5 boundary margin — cert fields decide, independent of the anchor read; the anchor renders as a note in any state
  | "certificate-expired"            // valid cert with now ≥ expiresAt (outside the §7.5 boundary margin) whose anchor is not known-invalidated (finding 5.8); re-certification context renders only where the anchor read supports it
  | "invalidated"                    // valid anchor with invalidated = true and no LIVE cert — invalidation never revokes an issued cert (a live cert classifies "certified" with an invalidation note)
  | "salvaged";                      // valid, correctly-owned, decoded, identity-matched PoolRegistry — settlement precedence
```

Certificate classification is anchor-independent by design, matching the canonical settlement
path: `GraveVault::salvage_pool` requires the `EligibilityCert` and never references an
`EligibilityAnchor` (the `SalvagePool` accounts context carries no anchor account), so a
certificate's validity is decided solely by the certificate's own fields against a cluster-time
estimate (§7.5) — never by anchor presence, and never by the anchor's `invalidated` flag (the
canonical `invalidate_anchor` is a pre-certification control that does not affect an issued
cert). The anchor read renders only as history: `sweep_stale_anchor` closes an anchor while its
certificate may remain (no close instruction exists for certs), and an invalid or unavailable
anchor read never blocks a live certificate's classification (§5.3 rule 6 precedes rule 7).

`waiting-epochs` is deliberately NOT a lifecycle state: waiting for epoch confirmation is epoch
*progress within* `anchored`, carried by the dedicated `EpochProgress` object (§5.4), so the
state vocabulary cannot overlap itself. For the same reason, `"unavailable"` and
`"inconsistent"` are availability/diagnostic outcomes, not members of the `PoolState` filter
vocabulary (§9).

### 5.3 Deterministic classification (first match wins)

Each rule is a canonical fact, not a heuristic; the first matching rule wins, and the outcome is
the single `LifecycleState` of §5.2 (plus, where noted, the separate `EpochProgress` object).

1. **Settlement precedence.** `registry.status === "present"` → `"salvaged"`. A valid, correctly
   owned, successfully decoded, identity-matched `PoolRegistry` is authoritative proof that the
   pool has been settled — regardless of the status of the optional `SalvageReceipt` read
   (absent, unavailable, corrupt, or otherwise) and regardless of the anchor/cert/epoch reads,
   which are post-settlement history: they are rendered, when valid, as history chips (e.g. a
   registry + invalidated anchor renders `salvaged` with a visible invalidation note, never
   `invalidated`).
2. **Registry read invalid.** `registry` is `unavailable`, `corrupt`, `owner-mismatch`, or
   `identity-mismatch` → `"unavailable"` + diagnostics. An invalid registry read can prove
   neither settlement nor non-settlement, and it is NEVER treated as absence: every
   classification below (all non-settled states) requires the registry read to be
   **definitively** `absent`.
3. **Impossible shape (verifiably-read contradiction).** `receipt` verifiably exists at its PDA
   (status `present` or `corrupt` — owner-validated) while `registry` is definitively `absent` →
   `"inconsistent"`: salvage writes the registry and the receipt atomically in one transaction
   (both are `init` accounts of the same `salvage_pool` instruction; the receipt is populated
   last), so a receipt without a registry cannot occur on canonical paths. **This is the only
   impossible-shape rule.** Cert-without-anchor is deliberately NOT one: `sweep_stale_anchor`
   legitimately closes an anchor whose staleness window has elapsed while its certificate remains
   on chain (§1, §5.2), so that combination classifies by the certificate's own validity (rules 6
   and 8) — it is never `"inconsistent"`. An `owner-mismatch` or `identity-mismatch` read never
   feeds this check — a foreign program's account, or an account that decodes to a different
   pool, proves nothing about protocol invariants (those unresolved receipt statuses are rule 4's
   fail-closed input, not contradiction evidence).
4. **Receipt evidence unresolved (atomic-pair cross-check incomplete).** `registry` is
   definitively `absent` and `receipt` is `unavailable`, `owner-mismatch`, or
   `identity-mismatch` → `"unavailable"` + diagnostics. `salvage_pool` creates the registry and
   the receipt atomically (both `init` accounts of one instruction), so a non-settled
   classification asserts the pair's JOINT absence; a receipt read that never resolved leaves
   that cross-check incomplete, and the outcome fails closed — never `"discovered"`,
   `"anchored"`, `"re-evaluation-window-reached"`, `"certified"`, `"certificate-expired"`, or
   `"invalidated"`. A receipt that verifiably exists was already classified `inconsistent` by
   rule 3; only a definitively `absent` receipt lets the classification continue. Every rule
   below therefore sees a definitively absent registry AND a definitively absent receipt.
5. **Cert read invalid.** `cert` is `unavailable`, `corrupt`, `owner-mismatch`, or
   `identity-mismatch` (no earlier rule applied) → `"unavailable"` + diagnostics. Every
   remaining classification needs the cert — either as a valid record or as definitive absence —
   so an invalid cert read blocks them all; no certified, certificate-expired, anchored, or
   invalidated outcome may be derived from an unread or undecodable cert.
6. **Certificate validity (anchor-independent).** `cert` is `present` (valid decode,
   identity-matched); the anchor read is NOT consulted for the classification — only for the
   rendering note:
   - `nowUnix` unavailable → `"unavailable"` + diagnostics — the on-chain `expiresAt` compared
     against a successfully obtained cluster-time estimate is the only expiry authority; a
     missing or stale clock never guesses "expired" or "valid" (§7.5; finding-5.8 discipline).
   - `nowUnix` available but `|nowUnix.value − cert.expiresAt| ≤ EXPIRY_BOUNDARY_MARGIN_SECONDS`
     (§7.5) → `"unavailable"` + diagnostics — the certified-vs-expired decision lies inside the
     estimate's uncertainty window, so the console fails closed instead of presenting an
     approximate timestamp as definitive validity. (The vault's own `is_expired` gate remains
     the authority at salvage time.)
   - `nowUnix` available, outside the margin, `nowUnix.value < cert.expiresAt` → `"certified"`
     (TTL countdown = `expiresAt − nowUnix`). The anchor read renders alongside in ANY state and
     never changes the outcome: valid → normal; invalidated → a prominent invalidation note
     (invalidation never revokes an issued cert — the canonical `invalidate_anchor` scope note
     and `salvage_pool`'s cert-only preflight are authoritative — but Phase 2 refuses to
     re-certify with `AnchorInvalidated` 6017); definitively absent → a swept-anchor note (the
     permissionless sweep closed the anchor after certification; the remaining salvage window is
     governed by the cert's own `expiresAt`, exactly as `salvage_pool` itself decides — the
     vault verifies freshness against the cert, never the anchor); `unavailable` / `corrupt` /
     `owner-mismatch` / `identity-mismatch` → an explicit note that the anchor read is not
     established, with no invalidation or sweep inference.
   - `nowUnix` available, outside the margin, `nowUnix.value ≥ cert.expiresAt`, and the anchor
     is `present` with `invalidated === true` → falls through to rule 8 (with no live cert,
     invalidation is the terminal fact: the salvage window is closed AND re-certification is
     permanently blocked; the expiry renders as a detail chip).
   - `nowUnix` available, outside the margin, `nowUnix.value ≥ cert.expiresAt`, anchor NOT
     invalidated → `"certificate-expired"` (finding 5.8):
     - anchor valid → normal rendering;
     - anchor definitively absent → the note adds that re-certification requires a fresh Phase 1
       run to re-create the swept anchor;
     - anchor `unavailable` / `corrupt` / `owner-mismatch` / `identity-mismatch` → the expiry
       fact stands (it is the cert's own, judged against the cert's `expiresAt`), but the note
       states that re-certification possibility is INDETERMINATE — the anchor's state is not
       established and the console does not infer it.
7. **Anchor read invalid without a live certificate.** `anchor` is `unavailable`, `corrupt`,
   `owner-mismatch`, or `identity-mismatch`, and no earlier rule applied — i.e. the registry and
   receipt are definitively absent (rule 4 filtered the unresolved receipt statuses) and the
   cert is definitively absent (a cert-invalid read was rule 5; a live cert was rule 6) →
   `"unavailable"` + diagnostics. Every remaining classification needs the anchor — as a valid
   record (rules 8–9), as definitive absence (rule 10), or as the invalidation fact (rule 8) —
   so with no live certificate an invalid anchor read blocks them all. A live certificate never
   reaches this rule: rule 6 classifies it first, rendering the anchor as a note in whatever
   state its read stands.
8. **Invalidation.** `anchor` is `present` with `invalidated === true` (no earlier rule applied —
   so the cert is definitively `absent`, or was present and expired) → `"invalidated"`: the
   multisig-only `invalidate_anchor` flag is one-way, so with no live cert the pool can be
   neither salvaged now nor re-certified later (Phase 2 refuses `AnchorInvalidated` 6017). When
   a present cert has expired, its expiry renders as detail. A live cert never reaches this rule
   (rule 6 keeps it `"certified"` — invalidation never revokes an issued cert), and neither does
   an expired cert whose anchor read is invalid (rule 6 classifies `"certificate-expired"`
   without inferring the anchor's state). A valid `PoolRegistry` outranks this (rule 1).
9. **Anchored / re-evaluation window.** `anchor` present (valid, not invalidated), `cert`
   definitively `absent`, and `currentEpoch` available:
   - elapsed epochs (`currentEpoch − firstEligibleEpoch`) < the required gap → `"anchored"` (the
     `EpochProgress` object renders alongside).
   - elapsed ≥ the required gap → `"re-evaluation-window-reached"`.
   - `currentEpoch` unavailable → `"unavailable"` + diagnostics — the window boundary is never
     evaluated against an assumed epoch. The required gap itself is the protocol's compile-time
     constant (`MIN_EPOCH_CONFIRMATION = 2`, §5.4): it is never read from `ProtocolConfig`,
     which carries no such field, so there is no gap-configuration read that could fail.
10. **Definitive discovery.** `registry` absent AND `receipt` absent AND `anchor` absent AND
    `cert` absent → `"discovered"` — no on-chain lifecycle evidence. Discovery is established
    only by these four definitive absences: the atomic registry+receipt pair makes the receipt
    the corroborating half of non-settlement evidence, so its read must be definitively `absent`
    (rule 4 filtered every unresolved receipt status, and a receipt that verifiably exists was
    already classified `inconsistent` by rule 3). No clock input is needed to observe that
    nothing exists. The rendering keeps §1's honesty rule: anchor absence cannot distinguish
    "Phase 1 never ran" from "the anchor was swept"; `discovered` asserts only that nothing is
    on chain now.

### 5.4 Epoch progress (separate from the lifecycle state)

Waiting for epoch confirmation is not a lifecycle state. It is progress data rendered alongside
`anchored`:

```ts
export interface EpochProgress {
  firstEligibleEpoch: number;         // from the valid on-chain anchor
  currentEpoch: number;               // from the available EpochRead
  requiredEpochGap: number;           // the protocol's compile-time constant MIN_EPOCH_CONFIRMATION (2) — never read from ProtocolConfig (it has no such field)
  remainingEpochs: number;            // max(0, requiredEpochGap − (currentEpoch − firstEligibleEpoch))
  reEvaluationWindowReached: boolean; // (currentEpoch − firstEligibleEpoch) ≥ requiredEpochGap
}
```

- Every value is an actual on-chain/account value or a canonical constant: `firstEligibleEpoch`
  comes from the valid anchor, `currentEpoch` from the available `EpochRead`, and
  `requiredEpochGap` is the canonical compile-time protocol constant `MIN_EPOCH_CONFIRMATION = 2`
  (`programs/grave-scanner/src/constants.rs`), which the on-chain evaluator itself enforces at
  Phase 2 (`programs/grave-scanner/src/criteria.rs`: `elapsed_epochs >= MIN_EPOCH_CONFIRMATION`,
  else `EpochConfirmationPending` 6016). GraveScanner's `ProtocolConfig` carries **no**
  epoch-gap field and `update_protocol_config` exposes **no** such parameter — the required gap
  is not dynamically configurable; changing it requires a program upgrade. The SDK's
  `minEpochConfirmation` (`sdk/src/types.ts`, `EligibilityCriteria`) is the evaluation-criteria
  input that mirrors the constant (the same value the console's `data.ts` C6 default carries for
  criteria display) — it is not a live `ProtocolConfig` field, and this design claims no dynamic
  configurability for C6's gap. The console pins the constant from the vendored canonical
  sources; the sha256 SDK pins force a re-review of the value whenever the vendor tree re-syncs
  (e.g. after a program upgrade), so a moved constant cannot drift silently.
- The progress object carries no eligibility semantics: it does not imply that the pool passed
  any criterion, that it is eligible, that a certificate exists, that it is certified, or that a
  salvage execution is authorized. `reEvaluationWindowReached === true` means exactly one thing:
  the required epoch gap has elapsed, so GraveScanner **may** perform its next eligibility
  evaluation. Only a valid on-chain `EligibilityCert` can establish the certified state.
- `EpochProgress` is produced only for the `"anchored"` and `"re-evaluation-window-reached"`
  states (§5.3 rule 9) — the only classifications whose inputs it mirrors.

### 5.5 Canonical-state mapping notes (checked against the protocol docs)

The ten-state lifecycle in the alignment brief maps onto these on-chain-derivable states as:
*Not evaluated* → `discovered` (only when reads SUCCEED and definitively establish the four
absences — registry, receipt, anchor and cert) or `unavailable`; *Evaluation pending* → not console-visible (in-flight transaction;
the console has no mempool view — deliberately out of scope); *Anchored* → `anchored`, with
epoch progress carried by `EpochProgress`; *Waiting for epoch confirmation* → `anchored` with
the progress object showing `remainingEpochs` (no separate lifecycle state); *Certification
eligible for evaluation* → `re-evaluation-window-reached`; *Certified* → `certified`;
*Certificate expired* → `certificate-expired`; *Invalidated* → `invalidated`; *Salvaged* →
`salvaged`; *Unresolved/unavailable evidence* → `unavailable`. **The console never collapses
`unavailable` into `discovered`** — absence of a successful read is not evidence of an absent
account, and an invalid read (`corrupt` / `owner-mismatch` / `identity-mismatch`) is never folded
into absence either.

**Combinations the brief's ten states do not name** are classified by the canonical rules, not
invented into new states: a certificate whose anchor was swept (`sweep_stale_anchor`) classifies
by the certificate's own validity — `certified` or `certificate-expired` — with the swept anchor
rendered as a history note (§5.3 rule 6); it is never `"inconsistent"` and never silently
treated as `"invalidated"`, because the canonical protocol itself treats the cert as the
salvage-path authority (`salvage_pool` verifies freshness against the cert, not the anchor, and
its preflight never reads an anchor).

**The scanner remains the eligibility authority.** `anchored` (through its progress object) and
`re-evaluation-window-reached` report the scanner's own Phase-1 record against the epoch clock;
they assert nothing about eligibility. Reaching the re-evaluation window means only that
GraveScanner may perform the next evaluation — not that the pool passed all six criteria, not
that it is eligible, not that a certificate exists, not that it is certified, and not that a
salvage execution is authorized. Only a valid on-chain `EligibilityCert` establishes the
certified state. The sheet wording says what the anchor proves ("Phase 1 passed at epoch N per
GraveScanner") and what remains ("Phase 2 is submitted by the fleet pipeline, not this console").

### 5.6 What `"certified"` establishes — and what the vault still checks at salvage

`"certified"` is a scanner-side lifecycle fact. It is deliberately NOT a statement that a salvage
transaction will succeed. The layers are kept explicitly separate:

| Layer | What it covers | Established by |
| --- | --- | --- |
| Certificate existence | A live `EligibilityCert` PDA exists | `cert` read `present` (§5.1) |
| Certificate expiry | `now < expiresAt`, outside the §7.5 boundary margin | the cert's own `expiresAt` vs the cluster-time estimate (§7.5) |
| Structural & identity validity | Correct owner, clean decode, identity fields match the requested pool | the §7.3 read sequence |
| Criteria-bitmap satisfaction | `cert.criteriaBitmap == ALL_CRITERIA_MASK` (`0x3F`) | a read-only comparison against the pinned canonical constant — rendered as a preflight fact, never folded into the lifecycle state |
| Other salvage preflight conditions | Everything else `salvage_pool` enforces at settlement | NOT established by the console |

The vault's own preflight (`programs/grave-vault/src/instructions/salvage_pool.rs`, the m3
block) is authoritative at salvage time and re-checks everything: protocol not paused
(`ProtocolPaused` 7003), cert unexpired (`EligibilityCertExpired` 7002),
`cert.criteria_bitmap == ALL_CRITERIA_MASK` (`0b00111111`; `InvalidEligibilityCert` 7001), the
cert binding to the submitted `amm_program_id` + `pool_address`, the pool account matching the
submitted pool, and the AMM program account being executable and the pool's owner
(`PreflightFailed` 7013) — plus the one-shot `init` of `PoolRegistry` and `SalvageReceipt` as
the double-salvage defense. The console establishes exactly two of these inputs — the identity
sequence (§7.3) and the expiry estimate (§7.5) — and renders one more as a comparison: the
decoded `criteriaBitmap` (vendored SDK `EligibilityCert.criteriaBitmap`, u8) against the
canonical mask. A decoded bitmap that does not equal the mask renders a visible "salvage
preflight: criteria bitmap not satisfied" chip while the pool remains `certified` — the
classification and the preflight chip are separate facts, and the console invents no validation
rule the vault does not implement.

---

## 6. Lifecycle classification truth table

Normative cross-check for §5.3: every observable combination maps to exactly one outcome, and
nothing is left to interpretation. "Definitive" = established by successfully-read,
correctly-owned, decoded, identity-matched evidence or by definitive absence — never inferred
from an invalid read. "Normal badge" = a lifecycle badge from the `PoolState` vocabulary; a "No"
cell renders as the availability/diagnostic presentation instead. R# = the decisive rule of
§5.3. The registry read is definitively `absent` in every non-settlement row unless the row says
otherwise, and — since rule 4 — the same applies to the receipt (an unresolved receipt read is
itself a classified outcome, rows 7–9).

| # | R# | Evidence | Lifecycle result | Definitive? | Normal badge? | Diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | Registry `present` (valid, correctly owned, decoded, identity-matched); receipt/anchor/cert/epoch reads any status | `salvaged` | Yes | Yes — `salvaged` | Not required for the classification; optional-read failures render as detail chips (e.g. an `unavailable` receipt chip), a valid-but-invalidated anchor as a history note |
| 2 | 2 | Registry `unavailable` | `unavailable` | No | No | Required — transport/RPC reason; never treated as absent |
| 3 | 2 | Registry `corrupt` | `unavailable` | No | No | Required — decode reason; never treated as absent |
| 4 | 2 | Registry `owner-mismatch` | `unavailable` | No | No | Required — expected vs actual owner; never treated as absent |
| 5 | 2 | Registry `identity-mismatch` (decoded identity fields ≠ requested pool) | `unavailable` | No | No | Required — expected vs actual identity; never treated as absent and never as settlement evidence |
| 6 | 3 | Receipt exists at its PDA (`present` or `corrupt`) while registry is definitively `absent` | `inconsistent` | Yes — the contradiction is definitive | No | Required — receipt-without-registry anomaly (salvage `init`s both atomically, receipt populated last) |
| 7 | 4 | Registry definitively `absent`; receipt read `unavailable` | `unavailable` | No | No | Required — the atomic-pair cross-check is incomplete; never a non-settled state |
| 8 | 4 | Registry definitively `absent`; receipt read `owner-mismatch` | `unavailable` | No | No | Required — a foreign-owner account at the receipt PDA proves nothing about protocol invariants and cannot complete the cross-check |
| 9 | 4 | Registry definitively `absent`; receipt read `identity-mismatch` | `unavailable` | No | No | Required — an account decoding to a different pool proves nothing about THIS pool and cannot complete the cross-check |
| 10 | 5 | Cert read `unavailable` / `corrupt` / `owner-mismatch` / `identity-mismatch` (no earlier row applied) | `unavailable` | No | No | Required — per-read reason; no certified, certificate-expired, anchored, or invalidated outcome may be derived from an unread or undecodable cert |
| 11 | 6 | Cert `present` (valid, identity-matched); `nowUnix` unavailable | `unavailable` | No | No | Required — expiry is never guessed from a missing or stale clock (§7.5) |
| 12 | 6 | Cert `present` (valid); `nowUnix` available; \|nowUnix.value − cert.expiresAt\| ≤ EXPIRY_BOUNDARY_MARGIN_SECONDS (§7.5) | `unavailable` | No | No | Required — the certified-vs-expired decision lies inside the estimate's uncertainty window; the approximate timestamp is never presented as definitive validity |
| 13 | 6 | Cert `present` (valid, identity-matched); outside the margin; now < `expiresAt`; anchor ANY status — valid, invalidated, definitively `absent` (swept), or `unavailable`/`corrupt`/`owner-mismatch`/`identity-mismatch` | `certified` | Yes | Yes — `certified` | Not required for the classification; the anchor state renders as the note: invalidated → invalidation note (`AnchorInvalidated` blocks re-certification but never revokes the live cert); absent → swept-anchor note (the cert's own TTL governs the remaining salvage window); invalid/unavailable anchor read → "anchor status not established" note, no invalidation or sweep inference |
| 14 | 6→8 | Cert `present` (valid); outside the margin; now ≥ `expiresAt`; anchor `present` with `invalidated = true` | `invalidated` | Yes | Yes — `invalidated` | Expiry renders as a detail chip: salvage window closed AND re-certification permanently blocked (one-way flag; Phase 2 refuses `AnchorInvalidated` 6017) |
| 15 | 6 | Cert `present` (valid); outside the margin; now ≥ `expiresAt`; anchor valid or definitively `absent` (swept) | `certificate-expired` | Yes | Yes — `certificate-expired` | Not required (the expiry fact is the content); with a definitively absent anchor the note adds that re-certification requires a fresh Phase 1 run |
| 16 | 6 | Cert `present` (valid); outside the margin; now ≥ `expiresAt`; anchor read `unavailable`/`corrupt`/`owner-mismatch`/`identity-mismatch` | `certificate-expired` | Yes — the expiry is the cert's own fact | Yes — `certificate-expired` | The note states that re-certification possibility is INDETERMINATE (the anchor's state is not established); no re-certification inference is drawn |
| 17 | 8 | Anchor `present` with `invalidated = true`; cert definitively `absent` | `invalidated` | Yes | Yes — `invalidated` | The invalidation flag is the state's own content; an invalid cert read would have classified row 10 first, a live cert rows 13–16 |
| 18 | 9 | Anchor valid, not invalidated; cert `absent`; `currentEpoch` available; elapsed < required gap (`MIN_EPOCH_CONFIRMATION` = 2) | `anchored` + `EpochProgress` (window not reached) | Yes | Yes — `anchored` | Not required (the progress object is the content) |
| 19 | 9 | Anchor valid, not invalidated; cert `absent`; `currentEpoch` available; elapsed ≥ required gap | `re-evaluation-window-reached` + `EpochProgress` (window reached) | Yes | Yes — `re-evaluation-window-reached` | Not required (the progress object is the content) |
| 20 | 9 | Anchor valid, not invalidated; cert `absent`; `currentEpoch` unavailable | `unavailable` | No | No | Required — epoch progress cannot be evaluated; never rendered as `anchored` on a missing epoch |
| 21 | 10 | Registry, receipt, anchor and cert each definitively `absent` (clock reads irrelevant) | `discovered` | Yes | Yes — `discovered` | Not required; the rendering notes that anchor absence cannot distinguish "Phase 1 never ran" from "the anchor was swept" |

Coverage notes:

- **Cert-without-anchor is a classified normal case, not a contradiction.** Cert `present` +
  anchor definitively `absent` → rows 13/15: the certificate's own `expiresAt` (vs a cluster-time
  estimate, §7.5) decides `certified` vs `certificate-expired`. This is the canonical
  `sweep_stale_anchor` lifecycle — the sweep closes the anchor while the cert remains (no close
  instruction exists for certs), and `salvage_pool` verifies freshness against the cert, never
  the anchor (its preflight never reads an anchor). There is deliberately no `inconsistent` row
  for this combination, and a swept anchor does not even imply an expired cert
  (`cert_ttl_seconds` is governance-configurable with only a floor). An invalid or unavailable
  anchor read never blocks a live certificate either: cert present + anchor
  `unavailable`/`corrupt`/`owner-mismatch`/`identity-mismatch` → row 13 (`certified`) or row 16
  (`certificate-expired`, no re-certification inference) — the anchor is history, not a
  prerequisite.
- Rows 7–9 are the unresolved-receipt complement of row 6: with the registry definitively
  absent, only a definitively `absent` receipt lets a non-settled classification proceed. An
  `unavailable` receipt read is an infrastructure outcome, a `owner-mismatch`/`identity-mismatch`
  receipt proves nothing about protocol invariants — none of the three may be read as "no
  receipt, therefore consistent with non-settlement".
- An invalid cert read (row 10) applies only where no earlier rule applied: an invalidated anchor
  with a definitively absent cert is row 17; a cert read that merely fails with a definitively
  absent anchor is still row 10 (`unavailable`) — the cert read is required for discovery too,
  since `discovered` needs the cert definitively absent.
- Row 6 is the only existence-level contradiction and requires the existing account to be
  owner-validated (`present` or `corrupt`); an `owner-mismatch` or `identity-mismatch` read never
  feeds it (rows 8–9 fail closed instead), and content-dependent classifications (`certified` /
  `certificate-expired`) always require a fully decoded (`present`), identity-matched cert.
- Rows 13–16 presume nothing about the anchor read — that is the point of the round-3 anchor
  independence: the anchor read may be a valid `present`, definitively `absent` (swept),
  `invalidated` (the note case, row 13), or any invalid status (rows 13/16 with the explicit
  no-inference note). The expired-cert + invalidated-anchor combination is row 14 (invalidation
  is the terminal fact). With NO live cert, an invalid anchor read is rule 7's `unavailable` —
  the table states it once in §5.3 rule 7 rather than repeating four rows, because every
  remaining classification (rules 8–10) genuinely needs the anchor when no cert stands.
- Rows 14–21 additionally presume the receipt read is definitively `absent`: an unresolved
  receipt was rows 7–9 (rule 4), a verifiably existing receipt row 6 (contradictory evidence
  fails closed before any normal-ish state).
- Rows 2–5 never degrade into non-settled states: an invalid registry read leaves the settlement
  question open, and every non-settled classification requires the registry to be definitively
  `absent`.
- Row 12 is the round-3 boundary-margin row: within ±`EXPIRY_BOUNDARY_MARGIN_SECONDS` of
  `expiresAt` the estimate cannot safely establish certificate status, so the outcome is the
  explicit `unavailable` — never a definite badge computed from an approximate timestamp.
- The derivation is total: §5.3's rules 1–10 decide every combination of `AccountRead` and clock
  statuses; no other outcome exists.

## 7. Failure handling (all fail-closed, all explicit)

### 7.1 Account absence
`getAccountInfo` returning `null` on any PDA is a **legitimate, definitive fact** (accounts are
init-once at their lifecycle step) and maps to the `absent` status of §5.1 — the only source of
definitive absence in the model. Distinguish "absent" from "failed to look up" at the transport:
only a clean `null` maps to `absent`; anything else maps to its explicit non-present status
(`unavailable`, `corrupt`, `owner-mismatch`, or `identity-mismatch`) with a reason string.
Absence then feeds the derivation per §5.3 (it is the only path to `discovered` and to
non-settlement).

### 7.2 RPC failures and partial reads
- Route-level: any RPC throw produces the envelope's unavailable state with the redacted error
  string (host/URL never echoed — same redaction rule as B1).
- **Primary strategy (per-pool reads, §3): four individual `getAccountInfo` requests run
  concurrently via `Promise.allSettled`.** Each request settles independently, so per-account
  outcomes are preserved exactly: a rejected request marks only that account's read
  `unavailable` (its own `AccountRead` status with its own reason); a fulfilled request proceeds
  through the owner → decode → identity sequence of §7.3. Other facts still render, each with
  its own status. A partially readable pool renders the readable facts and explicit
  `"unavailable"` chips for the rest — never a blended guess.
- **Batched variant (the deferred table-wide option, §3): `getMultipleAccounts` has
  whole-request semantics.** One JSON-RPC call either returns a response — an array aligned with
  the requested keys — or fails as a whole; it cannot return per-account transport failures. On
  request failure the ENTIRE batch is classified `unavailable` (one reason, all four reads); on
  success each `null` entry is definitive absence for that account (`absent`, §5.1) and each
  returned account is validated independently (owner → decode → identity). The previous
  revision's wording — that a per-account failure inside `getMultipleAccounts` marks only that
  account's read `unavailable` — misdescribed batch semantics and is corrected here: individual
  `null` entries are absences, not transport errors.
- If a read the classification needs is unavailable, corrupt, owner-mismatched, or
  identity-mismatched, the affected states fail closed to `"unavailable"` per §5.3 (no lifecycle
  state is fabricated from a half-read, a corrupt read, a wrong-owner read, or a wrong-pool
  read).

### 7.3 Malformed, incorrectly owned, or misidentified accounts
The server-side read sequence is fixed and ordered; the SDK owns the first and the decoding
step, the console owns the validation steps between:

1. **Derive the expected PDA** with the canonical SDK (`eligibilityAnchorPda` /
   `eligibilityCertPda` / `poolRegistryPda` / `salvageReceiptPda`, §2) — no competing seed
   implementation.
2. **Fetch the raw account** (`getAccountInfo` per account, §7.2). An RPC failure →
   `unavailable` — never `absent`.
3. **Distinguish absence:** RPC succeeded and no account exists at the PDA → `absent` (the only
   source of definitive absence).
4. **Validate the owner** against the expected program: `info.owner` ≠ expected program ID →
   `owner-mismatch` (carrying `expectedOwner` / `actualOwner`); never decoded.
5. **Decode with the canonical SDK decoder** (`decodeEligibilityAnchor` / `decodeEligibilityCert`
   / `decodePoolRegistry` / `decodeSalvageReceipt`). Decode failure (discriminator mismatch,
   short data, out-of-shape integers) → `corrupt` + reason.
6. **Validate the decoded identity fields against the requested pool** — `ammProgramId` AND
   `poolAddress` for `EligibilityAnchor`, `EligibilityCert` and `PoolRegistry`; `poolAddress`
   for `SalvageReceipt` (field names verified against the canonical state structs, §1). Any
   disagreement → `identity-mismatch`, carrying the expected-vs-actual identity objects.
7. All checks passed → `present` — the only status whose data may feed classification.

- Discriminator mismatch (the SDK decoders assert), short data, or u64/i64 out of shape →
  `corrupt` + reason (`corrupt anchor account: discriminator mismatch`), surfaced in the sheet's
  diagnostics row. No partial decode of a mismatched account.
- Wrong owner (an account at the expected PDA owned by a different program) → the explicit
  `owner-mismatch` status, with the expected-vs-actual owner pair in diagnostics
  (`unexpected account owner …`). It is NEVER treated as `absent`, never "absent-for-derivation
  with a flag", and never decoded: the classification fails closed exactly as for `unavailable`
  and `corrupt` (§5.3 rules 2, 4, 5 and 7), because a wrong owner is identity misconfiguration that
  must be visible, not swallowed.
- Identity mismatch (right program, clean decode, identity fields of a different pool) → the
  explicit `identity-mismatch` status with expected-vs-actual identity in diagnostics. A
  successfully decoded account that does not belong to the requested pool is NOT valid evidence
  about that pool: no derivation rule may read it as a valid anchor, cert, registry, or receipt,
  and the transition logic cannot interpret it as any lifecycle fact (§5.3 rules 2, 4, 5 and 7).
  This guards against a wrong derivation or cross-pool contamination reaching the UI as protocol
  state.
- The six read outcomes remain distinct everywhere — account definitively absent (`absent`);
  account present, owned, decoded and identity-matched (`present`); account present but owned by
  an unexpected program (`owner-mismatch`); account present but corrupt or undecodable
  (`corrupt`); account present and decoded but belonging to a different pool
  (`identity-mismatch`); account read unavailable because of RPC or infrastructure failure
  (`unavailable`). No derivation rule, UI state, or diagnostic may collapse one into another.
- Invalid reads NEVER mutate the last good state; they only produce the current response's
  explicit invalid-read outcome.

### 7.4 Stale reads must not overwrite newer results
Per-pool request-versioning, the pattern `tx/reconcile.ts` and the snapshot transport already use:

- Each route response carries `pool` + `amm` + `checkedAtUnixMs`.
- The client store keeps, per pool key, `{ seq, payload }` where `seq` is a monotonically
  increasing client counter assigned at request time. A response is applied **only if its pool
  key matches the currently selected pool AND its seq ≥ the seq of the last applied response for
  that key**. Rapid open/close/open of different pools therefore cannot let a slow response for a
  previously-selected pool overwrite the current one (the pool-key check discards it; the sheet
  shows identity + checked-at so the operator always knows what they are looking at).
- No polling: states refresh on sheet open and on the manual refresh button only. Wall-clock
  countdowns (cert TTL) re-derive from the already-fetched `expiresAt` — the countdown moving
  does NOT re-fetch. The countdown is display-only and clearly labeled as derived from the
  on-chain value against the fetched cluster-time estimate; **the certified /
  certificate-expired classification itself changes only on a re-fetch** with a fresh
  cluster-time estimate (§7.5) — the client clock never flips the authoritative state.

### 7.5 Cluster time and certificate expiry (no local-time substitution)

- **On-chain authority.** `evaluate_pool_phase2` stamps `cert.expiresAt` as
  `Clock::get().unix_timestamp + ProtocolConfig.cert_ttl_seconds`
  (`programs/grave-scanner/src/instructions/evaluate_pool_phase2.rs` — `clock.unix_timestamp`
  read in the handler, `checked_add(cfg.cert_ttl_seconds)` at issuance), and the expiry gate is
  `is_expired(now) = now >= expires_at` with an inclusive boundary
  (`programs/grave-scanner/src/state/eligibility_cert.rs`; the vault rejects an expired cert
  with 7002 `EligibilityCertExpired` in `salvage_pool`'s preflight). `Clock::get().unix_timestamp`
  is Solana validator-cluster time — the slot timestamp the runtime advances per slot — not any
  client's wall clock. `cert_ttl_seconds` is governance-configurable with a 600 s floor
  (`MIN_CERT_TTL_SECONDS`) and a 3,600 s default.
- **Why a server's local time is not authoritative.** A server's `Date.now()` is local wall
  clock and can deviate from cluster time (validator timestamp skew, slot pacing, degraded
  cluster conditions); substituting it could flip `certified` ↔ `certificate-expired` against
  what the protocol itself will decide at salvage time. The console's local clock keeps only its
  existing, separate role — local freshness bookkeeping (`checkedAtUnixMs` and similar stamps) —
  and is never an expiry input.
- **How the console obtains cluster time — and how the source is checked.** The lifecycle route
  fetches a cluster-time estimate over RPC at the route's `confirmed` commitment:
  1. `head = getSlot()` — the newest slot at that commitment.
  2. Walk back from `head` toward older slots, at most `CLUSTER_TIME_MAX_LOOKBACK_SLOTS = 50`
     slots (≈20 s at the nominal ~2.5 slots/s — nominal pacing, not a guarantee; devnet slot
     pacing degrades under load), calling `getBlockTime(slot)` until it returns a value.
  3. Accept the first result ONLY if it is a finite non-negative integer (unix seconds); a `null`
     still unanswered beyond the window, a non-integer, or an RPC error yields no estimate.
  4. Record the accepted triple — `value` (unix seconds), `sourceSlot` (the slot whose block time
     supplied it), and `estimatedAtUnixMs` (local fetch stamp, bookkeeping only) — as the
     `TimeRead` of §5.1.
  **This is explicitly an estimate, not the runtime's exact `Clock` value**: the design makes no
  claim that the console can reproduce the `Clock::get().unix_timestamp` a future transaction
  will observe. Block time carries the slot-timestamp uncertainty (second granularity,
  validator-clock skew), which is why the classification consumes it as `TimeRead` evidence
  (§5.1), never as certainty.
- **Maximum age of the estimate.** The estimate is fetched per lifecycle refresh — the same
  refresh that reads the accounts — and consumed only within that same route execution: no
  cross-refresh reuse, no caching, no background polling (a cached estimate from a previous
  refresh is never used to classify a new read). Its uncorrected staleness is bounded by
  construction: the source slot is at most `CLUSTER_TIME_MAX_LOOKBACK_SLOTS` behind the head
  slot observed at fetch time, plus the route's own execution time. There is deliberately no
  wall-clock "age in seconds" calculation substituting for cluster time — the local clock stamps
  bookkeeping fields only (`estimatedAtUnixMs`, `checkedAtUnixMs`) and is never an expiry input.
- **Expiry-boundary uncertainty.** Because the estimate is approximate, the classification
  treats it as decisive only OUTSIDE an explicit boundary margin:
  `EXPIRY_BOUNDARY_MARGIN_SECONDS = 60` — comfortably larger than the nominal ~20 s look-back
  bound plus execution skew, and small against the 600 s `MIN_CERT_TTL_SECONDS` floor, so it
  affects only a thin band around `expiresAt`. When
  `|nowUnix.value − cert.expiresAt| ≤ EXPIRY_BOUNDARY_MARGIN_SECONDS`, the certified-vs-expired
  decision lies inside the estimate's uncertainty: the classification fails closed to
  `"unavailable"` + diagnostics (§5.3 rule 6) instead of asserting a state the vault's own
  `is_expired` gate may decide the other way. Outside the margin the classification proceeds,
  and the rendering still labels expiry as "judged against an RPC cluster-time estimate" — never
  as definitive on-chain validity.
- **Fail closed.** If the cluster-time estimate cannot be obtained (RPC failure, persistent
  `null` beyond the look-back window, unusable payload) or its freshness cannot be established,
  `TimeRead` is `unavailable` and the cert-present classification fails closed to
  `"unavailable"` + diagnostics (§5.3 rule 6) — the sheet never guesses `certified` or
  `certificate-expired` without a usable clock.
- **Honest limitations.** `getBlockTime` returns the timestamp the cluster recorded for a PAST
  block; it is not the live clock, and it drifts from a future transaction's `Clock` by at least
  the production interval between the source slot and that transaction. Solana RPC provides no
  stronger primitive the console could use instead, and the design claims none: no sub-second
  precision, no clock-sync guarantee, and no assumption that devnet block times are promptly
  available for very recent slots (the look-back window exists precisely because they often are
  not).

## 8. Honest availability vs confirmed state

- Every lifecycle fact renders with explicit provenance: `checked HH:MM:SS UTC · devnet (verified)
  · commitment confirmed`. 
- `unavailable` is a first-class chip with a reason string (RPC unreachable / corrupt account /
  owner mismatch / identity mismatch / epoch unavailable / cluster-time unavailable).
- The sheet NEVER renders a lifecycle state that the read set did not prove. In particular:
  - no "evaluation pending" fabrication while a transaction may be in flight;
  - no C1–C6 pass/fail display from chain reads (criteria display remains the snapshot's honest
    pending pins — the console still does not evaluate criteria);
  - no "re-evaluation-window-reached" without the anchor's own `firstEligibleEpoch`, a live
    epoch, AND the protocol's compile-time epoch-gap constant (§5.4) — reaching the window means
    only that GraveScanner may re-evaluate, nothing more.
  - no certified or certificate-expired rendering without the cert's own on-chain `expiresAt`
    and a successfully obtained cluster-time estimate (§7.5) — expiry is never read off a local
    clock, and a certified rendering never implies the vault's salvage preflight will pass
    (§5.6 — the bitmap chip and the other preflight conditions render separately).

## 9. Representation in the existing model (finding 5.8 vocabulary)

- Extend `PoolState` in `src/lib/gy/types.ts` with `"anchored"`, `"re-evaluation-window-reached"`,
  `"certificate-expired"`, `"invalidated"` (additive; `"unavailable"` and `"inconsistent"` are
  NOT `PoolState` members — they are the lifecycle panel's availability/diagnostic outcomes,
  kept separate so filters keep operating on true lifecycle states only).
- `POOL_STATE_META` (format.ts) gains the four labels with tones consistent with the existing
  scale (`anchored`: info, `re-evaluation-window-reached`: info, `certificate-expired`: warn,
  `invalidated`: bad). Fixture behavior is unchanged; `LifecycleStepper.stepIndex` maps the new
  states (anchored → step 1, re-evaluation-window-reached → step 2, certificate-expired → step 3
  with warning, invalidated → the failed path's red bar).
- The lifecycle panel consumes `LifecycleState` + the raw decoded facts (epoch progress, TTL
  countdown, invalidation flag, settlement totals) — the stepper, badges, and criteria
  placeholders all read from that one object, so display cannot drift from derivation.
- **Filters:** the existing six-state filter tabs keep their current semantics. With owner
  approval, a second filter row (or an extension) can offer the new states; since table rows stay
  snapshot-backed (`"discovered"`), lifecycle filters only become meaningful with the table-wide
  read strategy (§3's explicitly deferred option). The design does not silently change what the
  existing tabs match.

## 10. What this design deliberately does NOT do

- No eligibility evaluation and no criteria evaluation; the cert bitmap is rendered with the
  vault's own structural equality check (`criteriaBitmap == ALL_CRITERIA_MASK`, §5.6) — compared
  against the pinned canonical mask, never interpreted as a criteria pass/fail verdict. No oracle
  attestation handling, no salvage/certify/invalidate actions, no admin surface.
- No writes of any kind; no new signer boundaries; no new transaction machinery.
- No indexer schema changes (O3's evidence-status work remains separate and owner-gated).
- No invented certificate-revocation semantics: the canonical protocol implements none — no
  instruction closes an `EligibilityCert`, `invalidate_anchor` is a pre-certification control
  that does not affect an issued cert, and `sweep_stale_anchor` reclaims anchor rent without
  touching salvage authority. The design renders exactly what those instructions do and nothing
  more.
- No `LaunchPrice` reads (C2 stays pending in the console; the PDA read would be display-only and
  is not needed to place a pool in the lifecycle).
- No assumption that the deployed NS-3 programs are live: until `PROGRAM_IDS.deployedAt` is set
  by the owner (O2), every read honestly returns `unavailable` at the config-PDA-not-found layer
  — the feature degrades to the current honest state without any special-casing.

## 11. Test plan (defined now, executed at implementation time)

All in the existing `bun test` battery, lib-level (component/DOM tests remain out of the
console's test architecture):

1. **Derivation truth table** (`lifecycle.test.ts`): for every row of the §6 truth table, a
   fixtures-only test builds synthetic `LifecycleReads` (explicit `AccountRead` / `EpochRead` /
   `TimeRead` values) and asserts the exact `LifecycleState` + the values shown (progress, TTL).
   Include the canonical swept-anchor cases (cert present with anchor definitively absent →
   `certified` / `certificate-expired` decided by the cert's own `expiresAt`, with the
   swept-anchor note; expired cert + invalidated anchor → `invalidated` with the expiry as
   detail), the round-3 anchor-independence cases (cert present + anchor
   `unavailable`/`corrupt`/`owner-mismatch`/`identity-mismatch` → `certified` or
   `certificate-expired` with the "anchor status not established" note — never `unavailable`
   because of the anchor; expired cert + invalid anchor read → `certificate-expired` with NO
   re-certification inference asserted in the rendered notes), the receipt-evidence cases
   (registry absent + receipt `unavailable`/`owner-mismatch`/`identity-mismatch` →
   `unavailable`, never a non-settled state; receipt present with registry definitively absent →
   `inconsistent`; registry present + invalidated anchor → `salvaged` with a visible history
   note), the boundary-margin case (estimate within ±`EXPIRY_BOUNDARY_MARGIN_SECONDS` of
   `expiresAt` → `unavailable`), and every invalid-read case (unavailable / corrupt /
   owner-mismatch / identity-mismatch on a required read → `unavailable`, never a normal
   lifecycle state).
2. **Fail-closed sweep**: per-fact `unavailable` reads; epoch unavailable with anchor present →
   `unavailable` (never `anchored` — the window is never evaluated on a missing epoch); the
   cluster-time estimate unavailable with cert present → `unavailable` (expiry never guessed);
   the cluster-time estimate inside the expiry boundary margin with cert present → `unavailable`;
   registry absent + receipt unresolved → `unavailable` (never `discovered`/`anchored`);
   all four accounts unavailable → `unavailable`.
3. **Malformed accounts**: discriminator flip, truncation, wrong owner, and decoded-but-wrong-pool
   identity fields for each of the four accounts → `corrupt` / `owner-mismatch` /
   `identity-mismatch` + reason; no partial decode; wrong owner asserted to carry
   `expectedOwner` / `actualOwner`, identity mismatch asserted to carry expected-vs-actual
   identity, both to fail closed on the non-settled path, and NEVER to be classified as `absent`
   or as `present` (absence, owner-mismatch, identity-mismatch, and present never collapse into
   each other).
4. **Staleness**: unit-test the seq/key application rule — a slow response for a previous pool
   key and an out-of-order seq are both discarded.
5. **Route envelope**: param validation (bad base58, wrong length, mismatched pair), four-state
   envelope shape with per-fact `AccountRead` statuses, no URL/host material in any reason
   string, `confirmed` commitment passed.
6. **Vocabulary**: `POOL_STATE_META` covers every `PoolState` member (exhaustive keyset test);
   stepper index mapping for the four new states.
7. **Boundary honesty**: a test asserting the derivation never returns
   `anchored`/`re-evaluation-window-reached` when the epoch read is unavailable, never returns
   `certified`/`certificate-expired` when the cluster-time read is unavailable or lies inside
   the expiry boundary margin, never returns `discovered` unless registry, receipt, anchor and
   cert are each definitively `absent`, never returns a non-settled state when the receipt read
   is unresolved with a definitively absent registry, never treats
   `owner-mismatch`/`identity-mismatch`/`corrupt`/`unavailable` as `absent` (or as `present`),
   and never returns any lifecycle state from a snapshot-only input (the derivation requires the
   four on-chain reads; feeding it all-unavailable reads yields `unavailable` — this is the
   anti-inference pin).
8. **Constant pin**: `requiredEpochGap` equals the protocol's compile-time
   `MIN_EPOCH_CONFIRMATION` (2) — the derivation carries no fallback and reads no
   `ProtocolConfig` field for it; a test pins the value against the vendored canonical sources
   so a program-upgrade-driven change surfaces at SDK re-sync rather than drifting silently.
9. **Salvage-preflight bitmap chip (§5.6)**: a `present` cert with `criteriaBitmap === 0x3F`
   renders the satisfied chip; a `present` cert with any other bitmap value renders the
   "salvage preflight: criteria bitmap not satisfied" chip while the lifecycle state remains
   whatever the cert's own expiry supports (the chip never changes the classification); the
   chip is derived only from a `present` cert read and the mask value is pinned against the
   vendored canonical sources (vault `salvage_pool.rs` and scanner `criteria.rs`).

## 12. Implementation surface estimate (for the O4 decision)

- New: `src/lib/gy/lifecycle.ts` (pure derivation over the explicit `AccountRead` / `EpochRead` /
  `TimeRead` model of §5.1), `src/app/api/gy/lifecycle/route.ts` (server-only read route), sheet
  lifecycle panel wiring, `PoolState` + `POOL_STATE_META` extensions, one new test file
  (~9 describes).
- Modified: `graveyard.tsx` (panel + stepper consume the panel state), `types.ts`, `format.ts`,
  `page.tsx` (route fetch on selection change — manual, no polling).
- Unchanged: transports, claims stack, estimator economics, SDK vendor tree, program IDs, PDA
  derivations, wallet/signing boundaries.

Implementation would proceed only after O4 is decided (per-sheet vs table-wide, and confirmation
that the lifecycle panel is wanted before mainnet-relevant data exists on devnet).
