# Console lifecycle integration — technical design (DRAFT for owner review)

**Status:** design only — nothing here is implemented. Per owner decision **O4**, the console's
lifecycle read scope and strategy must be approved before any code lands. This document is the
review artifact for that decision. It corresponds to audit findings **5.2 [HIGH]** and **5.8 [LOW]**
in `GraveYield-Console-Audit-Report.md` and to Phase-2 prompt Section 4 (design-and-preparation-only).

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

- **Anchor absence** means "no Phase 1 pass exists on chain" — nothing more. It is NOT
  "discovered-and-evaluated-eligible"; the console never renders eligibility intent from absence.
- **`firstEligibleEpoch`** (anchor) and the **live epoch** together own the
  waiting-for-epoch-confirmation vs certification-eligible distinction. The console does not
  decide eligibility — it reports what the scanner's own Phase-1 record + the epoch clock show.
- **`expiresAt`** (cert) owns certificate expiry. It is an on-chain i64 (unix seconds), not a
  client-side TTL guess.
- **`invalidated`** (anchor) owns invalidation — set only by the scanner's multisig-only
  `invalidate_anchor`. The console can never manufacture it.
- **`PoolRegistry` existence** owns "salvaged". The registry is init-once at salvage
  (`salvage_pool`), so its presence is the canonical settled fact. The receipt is optional detail
  for display (proceeds split) — its absence after the registry exists is rendered as a partial
  row, never as an error hiding the settlement.

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
(snapshot = discovery evidence) while the sheet shows chain truth.

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
  transports) with per-fact error strings. The client re-validates the payload with the same
  fail-closed parser (client-side revalidation is a preservation requirement).
- Program ownership check at the transport: `getAccountInfo` returns `owner`; a PDA whose owner
  is not the expected program is treated as **not found** (see §6.3), never decoded.

## 5. State derivation — a pure, total function

A new pure module `src/lib/gy/lifecycle.ts` (no React, no fetch — fully unit-testable):

```ts
export interface LifecycleReads {
  anchor: EligibilityAnchor | null;   // null = account absent or unreadable-for-a-stated-reason
  cert:   EligibilityCert | null;
  registry: PoolRegistry | null;
  receipt:  SalvageReceipt | null;
  currentEpoch: number | null;        // from getEpochInfo; null = unavailable
  nowUnix: number;                    // caller's clock (explicit argument, never Date.now() inside)
}

export type LifecycleState =
  | "unavailable"                     // cannot see the chain — honest unknown, NOT "discovered"
  | "discovered"                      // on-chain reads succeeded; no anchor, no registry
  | "anchored"                        // anchor present, not invalidated, epoch gap < 2
  | "waiting-epochs"                  // anchored; currentEpoch − firstEligibleEpoch < 2 (fact-reporting)
  | "certification-ready"             // anchored; gap ≥ 2; no cert
  | "certified"                       // cert present and nowUnix < expiresAt
  | "certificate-expired"             // cert present and nowUnix ≥ expiresAt (finding 5.8)
  | "invalidated"                     // anchor.invalidated (finding 5.8)
  | "salvaged";                       // registry present
```

Derivation order (first match wins; each line is a canonical fact, not a heuristic):

1. **Read failure / unavailable epoch where required** → `"unavailable"` (§6).
2. `registry !== null` → `"salvaged"`. (Post-settlement, anchor/cert state is history; the
   registry is the terminal fact. Receipt detail is displayed alongside, never required.)
3. `anchor === null && cert === null` → `"discovered"`. (A cert cannot exist without an anchor on
   canonical paths; if that impossible shape ever appears, it degrades to `"unavailable"` with a
   reason — malformed, see §6.3.)
4. `anchor.invalidated === true` → `"invalidated"`. (Even if a later cert exists — the scanner's
   censor is authoritative for Phase 1; the sheet shows both facts.)
5. cert present:
   - `nowUnix < cert.expiresAt` → `"certified"` (TTL countdown = `expiresAt − nowUnix`).
   - `nowUnix ≥ cert.expiresAt` → `"certificate-expired"`.
6. cert absent, anchor present and `currentEpoch !== null`:
   - `currentEpoch − firstEligibleEpoch < 2` → `"waiting-epochs"` (value: `gap / 2 epochs`).
   - gap `≥ 2` → `"certification-ready"`.
7. anchor present but `currentEpoch === null` → the gap is unknowable → the state renders as
   `"anchored"` with the gap explicitly `"current epoch unavailable"` (the P4.2 D6 rule: a
   hardcoded epoch can never manufacture progress).

**Canonical-state mapping notes (checked against the protocol docs):** the ten-state lifecycle in
the alignment brief maps onto these on-chain-derivable states as:
*Not evaluated* → `discovered` (only when reads SUCCEED and show absence) or `unavailable`;
*Evaluation pending* → not console-visible (in-flight transaction; the console has no mempool
view — deliberately out of scope); *Anchored* → `anchored`/`waiting-epochs` depending on the
epoch clock; *Waiting for epoch confirmation* → `waiting-epochs`; *Certification eligible for
evaluation* → `certification-ready`; *Certified* → `certified`; *Certificate expired* →
`certificate-expired`; *Invalidated* → `invalidated`; *Salvaged* → `salvaged`; *Unresolved/
unavailable evidence* → `unavailable`. **The console never collapses `unavailable` into
`discovered`** — absence of a successful read is not evidence of absence of an anchor.

**The scanner remains the eligibility authority.** `certification-ready` and `waiting-epochs`
report the scanner's own Phase-1 record against the epoch clock; they do not assert "this pool is
eligible" — the sheet wording will say what the anchor proves ("Phase 1 passed at epoch N per
GraveScanner") and what remains ("Phase 2 is submitted by the fleet pipeline, not this console").

## 6. Failure handling (all fail-closed, all explicit)

### 6.1 Missing accounts
`getAccountInfo` returning `null` on any PDA is a **legitimate fact** (accounts are
init-once at their lifecycle step). Map per §5. Distinguish "absent" from "failed to look up" at
the transport: only a clean `null` maps to absence; anything else maps to an error with a reason
string carried into `unavailable`.

### 6.2 RPC failures and partial reads
- Route-level: any RPC throw produces the envelope's unavailable state with the redacted error
  string (host/URL never echoed — same redaction rule as B1).
- Per-fact: with `getMultipleAccounts`, a per-account failure marks ONLY that account
  unreadable; other facts still render, each with its own availability. A partially readable
  pool renders the readable facts and explicit `"unavailable"` chips for the rest — never a
  blended guess. If the anchor's availability is unknown, states that depend on it degrade to
  `"unavailable"` per §5 (no cert-derived state is fabricated from a half-read).

### 6.3 Malformed or incorrectly owned accounts
- Discriminator mismatch (the SDK decoders assert), short data, or u64/i64 out of shape →
  `"unavailable"` + reason (`corrupt anchor account: discriminator mismatch`), surfaced in the
  sheet's diagnostics row. No partial decode of a mismatched account.
- Wrong owner (PDA existing under the expected address but owned by a different program) →
  treated as absent-for-derivation AND flagged in diagnostics (`unexpected account owner …`) —
  it is a signal of identity misconfiguration that must be visible, not swallowed.
- Malformed reads NEVER mutate the last good state; they only produce the current response's
  unavailability.

### 6.4 Stale reads must not overwrite newer results
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

## 7. Honest availability vs confirmed state

- Every lifecycle fact renders with explicit provenance: `checked HH:MM:SS UTC · devnet (verified)
  · commitment confirmed`. 
- `unavailable` is a first-class chip with a reason string (RPC unreachable / malformed account /
  unexpected owner / epoch unavailable).
- The sheet NEVER renders a lifecycle state that the read set did not prove. In particular:
  - no "evaluation pending" fabrication while a transaction may be in flight;
  - no C1–C6 pass/fail display from chain reads (criteria display remains the snapshot's honest
    pending pins — the console still does not evaluate criteria);
  - no "certification-ready" without the anchor's own `firstEligibleEpoch` AND a live epoch.

## 8. Representation in the existing model (finding 5.8 vocabulary)

- Extend `PoolState` in `src/lib/gy/types.ts` with `"anchored"`, `"certificate-expired"`,
  `"invalidated"` (additive; `"unavailable"` is NOT a `PoolState` — it is the lifecycle panel's
  availability state, kept separate so filters keep operating on true lifecycle states only).
- `POOL_STATE_META` (format.ts) gains the three labels with tones consistent with the existing
  scale (`anchored`: info, `certificate-expired`: warn, `invalidated`: bad). Fixture behavior is
  unchanged; `LifecycleStepper.stepIndex` maps the new states (anchored/waiting → step 1/2,
  certificate-expired → step 3 with warning, invalidated → the failed path's red bar).
- The lifecycle panel consumes `LifecycleState` + the raw decoded facts (gap, TTL countdown,
  invalidation flag, settlement totals) — the stepper, badges, and criteria placeholders all read
  from that one object, so display cannot drift from derivation.
- **Filters:** the existing six-state filter tabs keep their current semantics. With owner
  approval, a second filter row (or an extension) can offer the new states; since table rows stay
  snapshot-backed (`"discovered"`), lifecycle filters only become meaningful with the table-wide
  read strategy (§3's explicitly deferred option). The design does not silently change what the
  existing tabs match.

## 9. What this design deliberately does NOT do

- No eligibility evaluation, no criteria bitmap interpretation beyond displaying it, no oracle
  attestation handling, no salvage/certify/invalidate actions, no admin surface.
- No writes of any kind; no new signer boundaries; no new transaction machinery.
- No indexer schema changes (O3's evidence-status work remains separate and owner-gated).
- No `LaunchPrice` reads (C2 stays pending in the console; the PDA read would be display-only and
  is not needed to place a pool in the lifecycle).
- No assumption that the deployed NS-3 programs are live: until `PROGRAM_IDS.deployedAt` is set
  by the owner (O2), every read honestly returns `unavailable` at the config-PDA-not-found layer
  — the feature degrades to the current honest state without any special-casing.

## 10. Test plan (defined now, executed at implementation time)

All in the existing `bun test` battery, lib-level (component/DOM tests remain out of the
console's test architecture):

1. **Derivation truth table** (`lifecycle.test.ts`): for every state in §5, a fixtures-only test
   builds synthetic `LifecycleReads` and asserts the exact `LifecycleState` + the values shown
   (gap, TTL). Include the impossible-shape cases (cert without anchor → unavailable; registry +
   invalidated anchor → salvaged with a visible history note).
2. **Fail-closed sweep**: missing/failed per-fact reads; epoch unavailable with anchor present →
   `anchored` + "current epoch unavailable"; all four accounts unreadable → `unavailable`.
3. **Malformed accounts**: discriminator flip, truncation, wrong owner for each of the four
   accounts → unavailable + reason; no partial decode.
4. **Staleness**: unit-test the seq/key application rule — a slow response for a previous pool
   key and an out-of-order seq are both discarded.
5. **Route envelope**: param validation (bad base58, wrong length, mismatched pair), four-state
   envelope shape, no URL/host material in any reason string, `confirmed` commitment passed.
6. **Vocabulary**: `POOL_STATE_META` covers every `PoolState` member (exhaustive keyset test);
   stepper index mapping for the three new states.
7. **Boundary honesty**: a test asserting the derivation never returns
   `certification-ready`/`waiting-epochs` when `currentEpoch === null`, and never returns any
   lifecycle state from a snapshot-only input (the derivation requires the four on-chain reads;
   feeding it `null` reads yields `unavailable` — this is the anti-inference pin).

## 11. Implementation surface estimate (for the O4 decision)

- New: `src/lib/gy/lifecycle.ts` (pure derivation), `src/app/api/gy/lifecycle/route.ts`
  (server-only read route), sheet lifecycle panel wiring, `PoolState` + `POOL_STATE_META`
  extensions, one new test file (~7 describes).
- Modified: `graveyard.tsx` (panel + stepper consume the panel state), `types.ts`, `format.ts`,
  `page.tsx` (route fetch on selection change — manual, no polling).
- Unchanged: transports, claims stack, estimator economics, SDK vendor tree, program IDs, PDA
  derivations, wallet/signing boundaries.

Implementation would proceed only after O4 is decided (per-sheet vs table-wide, and confirmation
that the lifecycle panel is wanted before mainnet-relevant data exists on devnet).
