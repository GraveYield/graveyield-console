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

Ownership rules (no overlaps, no inference):

- **Anchor absence** (the definitive `absent` status, §5.1) means "no Phase 1 pass exists on
  chain" — nothing more. It is NOT "discovered-and-evaluated-eligible"; the console never renders
  eligibility intent from absence, and an `unavailable`, `corrupt`, or `owner-mismatched` anchor
  read is never folded into absence.
- **`firstEligibleEpoch`** (anchor) and the **live epoch** together own the epoch-progress and
  re-evaluation-window distinctions (§5.4): epoch progress is reported alongside `anchored`, and
  reaching the window means only that GraveScanner may re-evaluate. The console does not decide
  eligibility — it reports what the scanner's own Phase-1 record + the epoch clock show.
- **`expiresAt`** (cert) owns certificate expiry. It is an on-chain i64 (unix seconds), not a
  client-side TTL guess.
- **`invalidated`** (anchor) owns invalidation — set only by the scanner's multisig-only
  `invalidate_anchor`. The console can never manufacture it.
- **`PoolRegistry` existence** owns "salvaged" — and only a valid, correctly owned, successfully
  decoded registry read (`present`, §5.1) proves it; an `unavailable`, `corrupt`, or
  `owner-mismatched` registry read proves nothing and is never treated as absence. The registry
  is init-once at salvage (`salvage_pool`), so its presence is the canonical settled fact. The
  receipt is optional detail for display (proceeds split) — its absence after the registry
  exists is rendered as a partial row, never as an error hiding the settlement.

Read count per pool: 4 `getAccountInfo`-class calls (or one `getMultipleAccounts` over the four
PDAs) + one shared `getEpochInfo` per refresh (already implemented in `protocolLive.ts`).

## 2. Canonical SDK usage (no console-side derivation)

Everything derives and decodes through the vendored canonical SDK
(`src/lib/gy/vendor/graveyield-sdk/`, sha256-pinned by `sdkVendored.test.ts`):

- PDA derivation: `eligibilityAnchorPda(scannerProgramId, amm, pool)`,
  `eligibilityCertPda(...)`, `poolRegistryPda(vaultProgramId, pool)`,
  `salvageReceiptPda(vaultProgramId, pool)` — the console never hand-builds a seed.
- Decoding: `decodeEligibilityAnchor` / `decodeEligibilityCert` / `decodePoolRegistry` /
  `decodeSalvageReceipt` (discriminator-asserting). The server-side `fetch*` wrappers in the same
  file (Connection-based) are the preferred call shape because they already run server-only and
  use the canonical `Connection` plumbing, matching `claimsOnchain.ts` (P4.4) precedent.
- Program IDs: `PROGRAM_IDS.graveScanner` / `PROGRAM_IDS.graveVault` (`src/lib/gy/data.ts`).
  No new identity constants.

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
reusable with a batched `getMultipleAccounts` call; the per-pool state derivation and every
fail-closed rule stay identical. That is an additive change — the design keeps it out of scope.

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
  nowUnix:      TimeRead;                     // caller's clock, passed in as an explicit read with status
}
```

Clock reads carry explicit statuses for the same reason — an unavailable epoch or clock is never
represented as a numeric value (no `0` sentinel, no `NaN`, no assumed fallback):

```ts
export type EpochRead =
  | { status: "available"; value: number }
  | { status: "unavailable"; reason: string };

export type TimeRead =
  | { status: "available"; value: number }   // unix seconds; explicit argument — never Date.now() inside the derivation
  | { status: "unavailable"; reason: string };
```

Status semantics, and what each status may contribute to classification:

| Status | Meaning | Effect on lifecycle classification |
| --- | --- | --- |
| `present` | The account exists at the expected PDA, its `owner` matched the expected program (validated **before** decoding), and the SDK decoder accepted the data. | The only status whose `data` may be used as classification input; with `corrupt`, the only existence evidence that may participate in the impossible-shape checks (§5.3 rule 4). |
| `absent` | The RPC call succeeded and definitively returned no account at the PDA (all four accounts are init-once at their lifecycle step). | Positive, definitive evidence of absence — the only path to `discovered` and to non-settlement. |
| `unavailable` | The read could not be completed (RPC/infrastructure failure, timeout, transport error). | Never evidence of presence or absence. Any classification that needs this read fails closed to `unavailable` with diagnostics. |
| `corrupt` | The account exists but could not be decoded (discriminator mismatch, truncated/short data, out-of-shape integers). | Never treated as `absent`; never partially decoded. Its content is unusable — content-dependent classifications fail closed — but its owner-validated existence at a protocol PDA may establish an impossible shape (§5.3 rule 4). |
| `owner-mismatch` | An account exists at the expected PDA but is owned by a program other than the expected one. | Never treated as `absent`; never decoded; never used as evidence of any protocol invariant (a foreign program's account proves nothing about this protocol's state). Classification fails closed; surfaces an identity-misconfiguration diagnostic. |

### 5.2 Lifecycle states

```ts
export type LifecycleState =
  | "unavailable"                    // a required read is unavailable/corrupt/owner-mismatched, or a needed clock read is unavailable — honest unknown, NOT "discovered"
  | "inconsistent"                   // verifiably-read evidence contradicts canonical invariants — never rendered as a normal lifecycle state
  | "discovered"                     // registry, anchor and cert each DEFINITIVELY absent
  | "anchored"                       // valid anchor, no cert, re-evaluation window NOT reached — epoch progress reported separately (§5.4)
  | "re-evaluation-window-reached"   // valid anchor, no cert, gap ≥ required gap — GraveScanner MAY re-evaluate; nothing more (§5.4)
  | "certified"                      // valid cert + valid anchor, now < expiresAt
  | "certificate-expired"            // valid cert + valid anchor, now ≥ expiresAt (finding 5.8)
  | "invalidated"                    // valid anchor with invalidated = true (finding 5.8)
  | "salvaged";                      // valid, correctly-owned, decoded PoolRegistry — settlement precedence
```

`waiting-epochs` is deliberately NOT a lifecycle state: waiting for epoch confirmation is epoch
*progress within* `anchored`, carried by the dedicated `EpochProgress` object (§5.4), so the
state vocabulary cannot overlap itself. For the same reason, `"unavailable"` and
`"inconsistent"` are availability/diagnostic outcomes, not members of the `PoolState` filter
vocabulary (§9).

### 5.3 Deterministic classification (first match wins)

Each rule is a canonical fact, not a heuristic; the first matching rule wins, and the outcome is
the single `LifecycleState` of §5.2 (plus, where noted, the separate `EpochProgress` object).

1. **Settlement precedence.** `registry.status === "present"` → `"salvaged"`. A valid, correctly
   owned, successfully decoded `PoolRegistry` is authoritative proof that the pool has been
   settled — regardless of the status of the optional `SalvageReceipt` read (absent, unavailable,
   corrupt, or otherwise) and regardless of the anchor/cert/epoch reads, which are
   post-settlement history: they are rendered, when valid, as history chips (e.g. a registry +
   invalidated anchor renders `salvaged` with a visible invalidation note, never
   `invalidated`).
2. **Registry read invalid.** `registry` is `unavailable`, `corrupt`, or `owner-mismatch` →
   `"unavailable"` + diagnostics. An invalid registry read can prove neither settlement nor
   non-settlement, and it is NEVER treated as absence: every classification below (all
   non-settled states) requires the registry read to be **definitively** `absent`.
3. **Anchor read invalid.** `anchor` is `unavailable`, `corrupt`, or `owner-mismatch` →
   `"unavailable"` + diagnostics. Every non-settled classification needs the anchor — either as
   a valid record or as definitive absence — so an invalid anchor read blocks them all.
4. **Impossible shapes (verifiably-read contradictions).** An account verifiably exists at a
   protocol PDA (status `present` or `corrupt` — owner-validated) while its canonical
   prerequisite is definitively `absent`: `cert` exists while `anchor` is `absent` →
   `"inconsistent"` (a certificate cannot exist without an anchor on canonical paths; never
   rendered as a normal certified pool); `receipt` exists while `registry` is `absent` →
   `"inconsistent"` (settlement writes the registry). An `owner-mismatch` read never feeds these
   checks — a foreign program's account proves nothing about protocol invariants.
5. **Invalidation.** `anchor` is `present` with `invalidated === true` → `"invalidated"` (the
   scanner's multisig-only `invalidate_anchor` is authoritative for Phase 1; even if a later
   cert exists or its read fails, the sheet shows both facts — the cert renders as history or as
   an invalid-read chip). A valid `PoolRegistry` outranks this (rule 1).
6. **Cert read invalid.** `cert` is `unavailable`, `corrupt`, or `owner-mismatch` (no earlier
   rule applied) → `"unavailable"` + diagnostics. Every remaining classification needs the cert
   — either as a valid record or as definitive absence — so an invalid cert read blocks them
   all; no certified, anchored, or inconsistent outcome may be derived from an unread or
   undecodable cert.
7. **Definitive discovery.** `registry` absent AND `anchor` absent AND `cert` absent →
   `"discovered"`. Discovery is established only by these three definitive absences; the
   optional receipt read does not gate it (at this rule the receipt can only be `absent` or
   `unavailable` — a receipt that verifiably exists was already classified `inconsistent` by
   rule 4 — and an `unavailable` receipt renders as an unavailable detail chip), and no clock
   input is needed to observe that nothing exists.
8. **Certificate.** `anchor` present (valid, not invalidated) and `cert` present (valid):
   - `nowUnix` available and `nowUnix.value < cert.expiresAt` → `"certified"`
     (TTL countdown = `expiresAt − nowUnix`).
   - `nowUnix` available and `nowUnix.value ≥ cert.expiresAt` → `"certificate-expired"`.
   - `nowUnix` unavailable → `"unavailable"` + diagnostics — the on-chain `expiresAt` read
     against a successfully read current time is the only expiry authority; a missing clock
     never guesses "expired" or "valid" (finding-5.8 discipline).
9. **Anchored / re-evaluation window.** `anchor` present (valid, not invalidated), `cert`
   definitively `absent`, and both classification inputs available (an available `currentEpoch`
   AND an available live gap configuration, §5.4):
   - `reEvaluationWindowReached === false` → `"anchored"` (the `EpochProgress` object renders
     alongside).
   - `reEvaluationWindowReached === true` → `"re-evaluation-window-reached"`.
   - `currentEpoch` unavailable OR the live gap configuration unavailable → `"unavailable"` +
     diagnostics — the window boundary is never evaluated against an assumed, hardcoded, or
     fallback gap value (§5.4).

### 5.4 Epoch progress (separate from the lifecycle state)

Waiting for epoch confirmation is not a lifecycle state. It is progress data rendered alongside
`anchored`:

```ts
export interface EpochProgress {
  firstEligibleEpoch: number;         // from the valid on-chain anchor
  currentEpoch: number;               // from the available EpochRead
  requiredEpochGap: number;           // live scanner ProtocolConfig (`minEpochConfirmation`) — never a hardcoded constant
  remainingEpochs: number;            // max(0, requiredEpochGap − (currentEpoch − firstEligibleEpoch))
  reEvaluationWindowReached: boolean; // (currentEpoch − firstEligibleEpoch) ≥ requiredEpochGap
}
```

- Every value is an actual on-chain/account value: `firstEligibleEpoch` comes from the valid
  anchor, `currentEpoch` from the available `EpochRead`, and `requiredEpochGap` from the live
  scanner ProtocolConfig read at sheet open (the P4.5 one-read pulse — the same live-config
  source the criteria thresholds use). The design hardcodes no assumed gap (the earlier
  `gap < 2` sketch is gone), and a default/fallback gap is never treated as authoritative: if
  the live gap configuration is unavailable, the window boundary cannot be evaluated and
  classification fails closed to `"unavailable"` with the config failure in diagnostics. (The
  canonical-default fallback used for threshold *display text* in `criteriaOf` is deliberately
  NOT used as a classification boundary here — a fallback value could silently flip `anchored` ↔
  `re-evaluation-window-reached`.)
- The progress object carries no eligibility semantics: it does not imply that the pool passed
  any criterion, that it is eligible, that a certificate exists, that it is certified, or that a
  salvage execution is authorized. `reEvaluationWindowReached === true` means exactly one thing:
  the required epoch gap has elapsed, so GraveScanner **may** perform its next eligibility
  evaluation. Only a valid on-chain `EligibilityCert` can establish the certified state.
- `EpochProgress` is produced only for the `"anchored"` and `"re-evaluation-window-reached"`
  states (§5.3 rule 9) — the only classifications whose inputs it mirrors.

### 5.5 Canonical-state mapping notes (checked against the protocol docs)

The ten-state lifecycle in the alignment brief maps onto these on-chain-derivable states as:
*Not evaluated* → `discovered` (only when reads SUCCEED and definitively establish the three
absences) or `unavailable`; *Evaluation pending* → not console-visible (in-flight transaction;
the console has no mempool view — deliberately out of scope); *Anchored* → `anchored`, with
epoch progress carried by `EpochProgress`; *Waiting for epoch confirmation* → `anchored` with
the progress object showing `remainingEpochs` (no separate lifecycle state); *Certification
eligible for evaluation* → `re-evaluation-window-reached`; *Certified* → `certified`;
*Certificate expired* → `certificate-expired`; *Invalidated* → `invalidated`; *Salvaged* →
`salvaged`; *Unresolved/unavailable evidence* → `unavailable`. **The console never collapses
`unavailable` into `discovered`** — absence of a successful read is not evidence of an absent
account, and an invalid read (`corrupt` / `owner-mismatch`) is never folded into absence either.

**The scanner remains the eligibility authority.** `anchored` (through its progress object) and
`re-evaluation-window-reached` report the scanner's own Phase-1 record against the epoch clock;
they assert nothing about eligibility. Reaching the re-evaluation window means only that
GraveScanner may perform the next evaluation — not that the pool passed all six criteria, not
that it is eligible, not that a certificate exists, not that it is certified, and not that a
salvage execution is authorized. Only a valid on-chain `EligibilityCert` establishes the
certified state. The sheet wording says what the anchor proves ("Phase 1 passed at epoch N per
GraveScanner") and what remains ("Phase 2 is submitted by the fleet pipeline, not this console").

---

## 6. Lifecycle classification truth table

Normative cross-check for §5.3: every observable combination maps to exactly one outcome, and
nothing is left to interpretation. "Definitive" = established by successfully-read,
correctly-owned, decoded evidence or by definitive absence — never inferred from an invalid
read. "Normal badge" = a lifecycle badge from the `PoolState` vocabulary; a "No" cell renders as
the availability/diagnostic presentation instead. R# = the decisive rule of §5.3. The registry
read is `absent` in every row unless the row says otherwise.

| # | R# | Evidence | Lifecycle result | Definitive? | Normal badge? | Diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | Registry `present` (valid, correctly owned, decoded); receipt/anchor/cert/epoch reads any status | `salvaged` | Yes | Yes — `salvaged` | Not required for the classification; optional-read failures render as detail chips (e.g. an `unavailable` receipt chip), a valid-but-invalidated anchor as a history note |
| 2 | 2 | Registry `unavailable` | `unavailable` | No | No | Required — transport/RPC reason; never treated as absent |
| 3 | 2 | Registry `corrupt` | `unavailable` | No | No | Required — decode reason; never treated as absent |
| 4 | 2 | Registry `owner-mismatch` | `unavailable` | No | No | Required — expected vs actual owner; never treated as absent |
| 5 | 3 | Anchor read `unavailable` | `unavailable` | No | No | Required — per-read reason; no normal state derived from an invalid read |
| 6 | 3 | Anchor read `corrupt` | `unavailable` | No | No | Required — per-read decode reason |
| 7 | 3 | Anchor read `owner-mismatch` | `unavailable` | No | No | Required — expected vs actual owner |
| 8 | 4 | Cert exists at its PDA (`present` or `corrupt`) while anchor is definitively `absent` | `inconsistent` | Yes — the contradiction is definitive | No | Required — cert-without-anchor anomaly; never rendered as `certified` |
| 9 | 4 | Receipt exists at its PDA (`present` or `corrupt`) while registry is definitively `absent` | `inconsistent` | Yes — the contradiction is definitive | No | Required — receipt-without-registry anomaly |
| 10 | 5 | Anchor `present` with `invalidated = true` (cert read any status) | `invalidated` — even if a valid cert also exists (shown as history) | Yes | Yes — `invalidated` | The invalidation flag is the state's own content; the sheet shows both facts; a failing cert read renders as an invalid chip |
| 11 | 6 | Cert read `unavailable` / `corrupt` / `owner-mismatch` (no earlier row applied) | `unavailable` | No | No | Required — per-read reason; neither a certified nor an inconsistent outcome may be derived from an unread or undecodable cert |
| 12 | 7 | Registry, anchor and cert each definitively `absent` (clock reads irrelevant) | `discovered` | Yes | Yes — `discovered` | Not required (an `unavailable` receipt renders as a detail chip) |
| 13 | 8 | Anchor valid, not invalidated; cert `present` (valid); `nowUnix` available; now < `expiresAt` | `certified` | Yes | Yes — `certified` | Not required (the TTL countdown is the content) |
| 14 | 8 | Anchor valid, not invalidated; cert `present` (valid); `nowUnix` available; now ≥ `expiresAt` | `certificate-expired` | Yes | Yes — `certificate-expired` | Not required (the expiry fact is the content) |
| 15 | 8 | Anchor valid, not invalidated; cert `present` (valid); `nowUnix` unavailable | `unavailable` | No | No | Required — expiry is never guessed from a missing clock |
| 16 | 9 | Anchor valid, not invalidated; cert `absent`; `currentEpoch` and live gap config available; gap < required | `anchored` + `EpochProgress` (window not reached) | Yes | Yes — `anchored` | Not required (the progress object is the content) |
| 17 | 9 | Anchor valid, not invalidated; cert `absent`; `currentEpoch` and live gap config available; gap ≥ required | `re-evaluation-window-reached` + `EpochProgress` (window reached) | Yes | Yes — `re-evaluation-window-reached` | Not required (the progress object is the content) |
| 18 | 9 | Anchor valid, not invalidated; cert `absent`; `currentEpoch` unavailable | `unavailable` | No | No | Required — epoch progress cannot be evaluated; never rendered as `anchored` on a missing epoch |
| 19 | 9 | Anchor valid, not invalidated; cert `absent`; live gap configuration unavailable | `unavailable` | No | No | Required — the window boundary is never evaluated against an assumed or default gap |

Coverage notes:

- "Certificate exists without a valid anchor" splits by the anchor read's status: anchor
  definitively `absent` → row 8 (`inconsistent`); anchor `unavailable`/`corrupt`/
  `owner-mismatch` → rows 5–7 (`unavailable`) — an unreadable anchor can establish neither a
  certified pool nor a definitive contradiction.
- An invalid cert read (row 11) applies only where no earlier rule applied: an invalidated
  anchor classifies first (row 10, with the failing cert read rendered as a chip), and a cert
  that verifiably exists while the anchor is definitively absent is row 8. A cert read that
  merely fails with a definitively absent anchor is still row 11 (`unavailable`) — the cert read
  is required for discovery too, since `discovered` needs the cert definitively absent.
- Rows 8–9 are existence-level contradictions and require the existing account to be
  owner-validated (`present` or `corrupt`); an `owner-mismatch` read never feeds them, and
  content-dependent classifications (`certified` / `certificate-expired`) always require a fully
  decoded (`present`) cert.
- Rows 10, 12, and 16–19 additionally presume the receipt read is `absent` or `unavailable`: a
  receipt that verifiably exists at its PDA was already classified `inconsistent` by row 9
  (contradictory evidence fails closed before any normal-ish state).
- Rows 2–4 never degrade into non-settled states: an invalid registry read leaves the settlement
  question open, and every non-settled classification requires the registry to be definitively
  `absent`.
- The derivation is total: §5.3's rules 1–9 decide every combination of `AccountRead` and clock
  statuses; no other outcome exists.

## 7. Failure handling (all fail-closed, all explicit)

### 7.1 Account absence
`getAccountInfo` returning `null` on any PDA is a **legitimate, definitive fact** (accounts are
init-once at their lifecycle step) and maps to the `absent` status of §5.1 — the only source of
definitive absence in the model. Distinguish "absent" from "failed to look up" at the transport:
only a clean `null` maps to `absent`; anything else maps to its explicit non-present status
(`unavailable`, `corrupt`, or `owner-mismatch`) with a reason string. Absence then feeds the
derivation per §5.3 (it is the only path to `discovered` and to non-settlement).

### 7.2 RPC failures and partial reads
- Route-level: any RPC throw produces the envelope's unavailable state with the redacted error
  string (host/URL never echoed — same redaction rule as B1).
- Per-fact: with `getMultipleAccounts`, a per-account failure marks ONLY that account's read as
  `unavailable` (its `AccountRead` status); other facts still render, each with its own status.
  A partially readable pool renders the readable facts and explicit `"unavailable"` chips for
  the rest — never a blended guess. If a read the classification needs is unavailable, corrupt,
  or owner-mismatched, the affected states fail closed to `"unavailable"` per §5.3 (no lifecycle
  state is fabricated from a half-read, a corrupt read, or a wrong-owner read).

### 7.3 Malformed or incorrectly owned accounts
Owner validation runs BEFORE decoding, in a fixed order: (1) RPC succeeded, no account at the
PDA → `absent`; (2) account exists but `owner` ≠ expected program → `owner-mismatch` (carrying
`expectedOwner` / `actualOwner`; never decoded); (3) decode fails → `corrupt`; (4) decode
succeeds → `present`.

- Discriminator mismatch (the SDK decoders assert), short data, or u64/i64 out of shape →
  `corrupt` + reason (`corrupt anchor account: discriminator mismatch`), surfaced in the sheet's
  diagnostics row. No partial decode of a mismatched account.
- Wrong owner (an account at the expected PDA owned by a different program) → the explicit
  `owner-mismatch` status, with the expected-vs-actual owner pair in diagnostics
  (`unexpected account owner …`). It is NEVER treated as `absent`, never "absent-for-derivation
  with a flag", and never decoded: the classification fails closed exactly as for `unavailable`
  and `corrupt` (§5.3 rule 3), because a wrong owner is identity misconfiguration that must be
  visible, not swallowed.
- The five read outcomes remain distinct everywhere — account definitively absent (`absent`);
  account present and valid (`present`); account present but owned by an unexpected program
  (`owner-mismatch`); account present but corrupt or undecodable (`corrupt`); account read
  unavailable because of RPC or infrastructure failure (`unavailable`). No derivation rule, UI
  state, or diagnostic may collapse one into another.
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
  does NOT re-fetch (and `certificate-expired` transitions when the client clock passes
  `expiresAt`, clearly labeled as client-clock-derived from the on-chain value, never re-fetched
  silently).

## 8. Honest availability vs confirmed state

- Every lifecycle fact renders with explicit provenance: `checked HH:MM:SS UTC · devnet (verified)
  · commitment confirmed`. 
- `unavailable` is a first-class chip with a reason string (RPC unreachable / corrupt account /
  owner mismatch / epoch unavailable / clock unavailable).
- The sheet NEVER renders a lifecycle state that the read set did not prove. In particular:
  - no "evaluation pending" fabrication while a transaction may be in flight;
  - no C1–C6 pass/fail display from chain reads (criteria display remains the snapshot's honest
    pending pins — the console still does not evaluate criteria);
  - no "re-evaluation-window-reached" without the anchor's own `firstEligibleEpoch`, a live
    epoch, AND the live gap configuration (§5.4) — reaching the window means only that
    GraveScanner may re-evaluate, nothing more.

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

- No eligibility evaluation, no criteria bitmap interpretation beyond displaying it, no oracle
  attestation handling, no salvage/certify/invalidate actions, no admin surface.
- No writes of any kind; no new signer boundaries; no new transaction machinery.
- No indexer schema changes (O3's evidence-status work remains separate and owner-gated).
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
   Include the impossible-shape cases (cert present with anchor definitively absent →
   `inconsistent`; registry present + invalidated anchor → `salvaged` with a visible history
   note) and every invalid-read case (unavailable / corrupt / owner-mismatch on a required read
   → `unavailable`, never a normal lifecycle state).
2. **Fail-closed sweep**: per-fact `unavailable` reads; epoch unavailable with anchor present →
   `unavailable` (never `anchored` — the window is never evaluated on a missing epoch); live gap
   configuration unavailable → `unavailable`; clock unavailable with cert present →
   `unavailable` (expiry never guessed); all four accounts unavailable → `unavailable`.
3. **Malformed accounts**: discriminator flip, truncation, and wrong owner for each of the four
   accounts → `corrupt` / `owner-mismatch` + reason; no partial decode; wrong owner asserted to
   carry `expectedOwner` / `actualOwner`, to fail closed on the non-settled path, and NEVER to
   be classified as `absent` (absence and owner-mismatch never collapse into each other).
4. **Staleness**: unit-test the seq/key application rule — a slow response for a previous pool
   key and an out-of-order seq are both discarded.
5. **Route envelope**: param validation (bad base58, wrong length, mismatched pair), four-state
   envelope shape with per-fact `AccountRead` statuses, no URL/host material in any reason
   string, `confirmed` commitment passed.
6. **Vocabulary**: `POOL_STATE_META` covers every `PoolState` member (exhaustive keyset test);
   stepper index mapping for the four new states.
7. **Boundary honesty**: a test asserting the derivation never returns
   `anchored`/`re-evaluation-window-reached` when the epoch or gap-configuration read is
   unavailable, never returns `certified`/`certificate-expired` when the clock read is
   unavailable, never returns `discovered` unless registry, anchor and cert are each definitively
   `absent`, never treats `owner-mismatch`/`corrupt`/`unavailable` as `absent`, and never returns
   any lifecycle state from a snapshot-only input (the derivation requires the four on-chain
   reads; feeding it all-unavailable reads yields `unavailable` — this is the anti-inference pin).

## 12. Implementation surface estimate (for the O4 decision)

- New: `src/lib/gy/lifecycle.ts` (pure derivation over the explicit `AccountRead` / `EpochRead` /
  `TimeRead` model of §5.1), `src/app/api/gy/lifecycle/route.ts` (server-only read route), sheet
  lifecycle panel wiring, `PoolState` + `POOL_STATE_META` extensions, one new test file
  (~7 describes).
- Modified: `graveyard.tsx` (panel + stepper consume the panel state), `types.ts`, `format.ts`,
  `page.tsx` (route fetch on selection change — manual, no polling).
- Unchanged: transports, claims stack, estimator economics, SDK vendor tree, program IDs, PDA
  derivations, wallet/signing boundaries.

Implementation would proceed only after O4 is decided (per-sheet vs table-wide, and confirmation
that the lifecycle panel is wanted before mainnet-relevant data exists on devnet).
