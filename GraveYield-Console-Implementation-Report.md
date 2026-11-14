# GraveYield Console — Phase 2 Implementation Report

**Audit-Driven Corrections, Regression Coverage & Lifecycle Design**

| | |
| --- | --- |
| **Repository** | `graveyield-console` (Phase-2 code work performed in a local audit clone; that code work involved no remote operations) |
| **Audited baseline** | `main` @ `9e000a9ccdfecb0b5c455c8c0675718cdb3e317e` |
| **Baseline status at start of Phase 2** | Unchanged since the audit — HEAD identical, working tree clean |
| **Phase** | 2 — Audit-driven corrections (per the audit report `GraveYield-Console-Audit-Report.md`, verdict PARTIALLY ALIGNED) |
| **Work performed** | A1–A6 (Phase A), B1–B2 (Phase B), Section-4 lifecycle technical design (design only) |
| **Verification** | 322/322 tests pass (277 baseline + 45 new), typecheck, ESLint, production build, dependency audit, SDK integrity pins — all green **as run in the local audit clone against the local implementation**; not re-run against PR #12, which is documentation-only |
| **Delivery** | Code: **uncommitted working-tree edits** in the local audit clone (listed in §B) — no code commits, branches, or deployments; **not part of PR #12**. Docs: this report and `docs/lifecycle-integration-design.md` delivered in **docs-only PR #12** (branch `docs/phase2-implementation-report` → `main`; these two files only), per owner instruction of 2026-11-14. |

---

## Scope of this PR (documentation-only — read before §B–§F)

**PR #12 changes exactly two files:** this report (`GraveYield-Console-Implementation-Report.md`)
and `docs/lifecycle-integration-design.md`. To keep the record accurate:

- **The code corrections documented in §B–§F are NOT part of PR #12.** A1–A6 and B1–B2 were
  implemented and verified as **uncommitted working-tree edits in the local audit clone** (the
  modified files are listed in §B.9). PR #12 delivers documentation only — no application source,
  tests, CI workflows, SDK or protocol files, and no companion-repository changes.
- **The 322/322 result is a reported local result.** Every gate in §E was run in that local clone
  against the local implementation at the time it was produced. **No test was run against the
  contents of PR #12** — the PR changes documentation only, and the test suite does not cover
  documentation.
- **No claims beyond documentation.** PR #12 does not claim that the console code implements the
  lifecycle design, does not claim full protocol alignment, does not claim a completed security
  audit, and does not claim Mainnet readiness (§H states the same boundaries).
- **Corrections carried by this PR (owner review round):** explicit account-read states
  (`AccountRead` / `EpochRead` / `TimeRead` — no nullable reads), deterministic classification
  precedence with a normative truth table, `waiting-epochs` removed as a lifecycle state (epoch
  progress is a dedicated `EpochProgress` object), `certification-ready` renamed to
  `re-evaluation-window-reached`, explicit `owner-mismatch` handling (never treated as absent),
  and PR-number corrections (the delivery PR is #12).

---

## A. Baseline verification

**A.1 Current branch and HEAD**

- Branch: `main` (tracking `origin/main`, up to date).
- HEAD at Phase-2 start: `9e000a9ccdfecb0b5c455c8c0675718cdb3e317e` — **identical to the audited commit** (`git rev-parse HEAD` verified).
- Recent history confirmed (`git log --oneline -10`): HEAD is `9e000a9` "Merge pull request #10 from GraveYield/ns3/review-fixtures".

**A.2 Did the audited baseline change?**

**No.** The repository had not moved since the Phase-1 audit. Therefore no finding re-verification against newer commits was required beyond the per-finding source inspection below, and no finding had been pre-corrected upstream. Nothing was duplicated.

**A.3 Initial working-tree status**

`git status`: `On branch main … nothing to commit, working tree clean`. No stashes, no stray branches containing fix work (branch list checked: only the pre-existing history branches).

**A.4 Initial test/build results (reproduced before any edit)**

| Gate | Command | Baseline result |
| --- | --- | --- |
| TypeScript | `bun run typecheck` (`tsc --noEmit`) | pass (exit 0) |
| ESLint | `bun run lint` (`eslint .`) | pass (exit 0) |
| Tests | `bun test` | **277 pass / 0 fail**, 1,217 expect() calls, 18 files |
| Build | `bun run build` (`next build` + standalone copy) | pass (exit 0) |
| Dependency audit | `bun audit` | 0 vulnerabilities |
| SDK integrity | `bun test src/lib/gy/__tests__/sdkVendored.test.ts` | 15/15 pass (sha256 byte-pins vs canonical `sdk/src`, live-cluster PDA pins, golden instruction vector) |

All baseline observations in the Phase-2 prompt were reproduced exactly.

**A.5 Per-finding source re-inspection**

Every implicated file was opened and read in full before editing (not from the audit's line numbers alone): `snapshotContract.ts`, `estimator.ts`, `types.ts`, `format.ts`, `data.ts`, `graveyard.tsx`, `protocol.tsx`, `shell.tsx`, `providers.tsx`, `protocolLive.ts`, `.env.example`, `page.tsx`, plus the canonical counterparts re-verified in the companion repos (`graveyield-protocol` `programs/grave-vault/src/lib.rs`, `programs/grave-scanner/src/lib.rs`, `programs/grave-scanner/src/criteria.rs`, `programs/grave-vault/src/instructions/sweep_dust.rs`, `scripts/devnet/ns3_identities.mjs`, `grave-indexer/src/discovery.ts` behavior per the audit). Two independent spot-verify results worth recording:

- The committed `snapshot.json` was re-analyzed programmatically: exactly **4 of 12 pools have `coinIsWsol: true`** (`1113EtuN…`, `11T4LcVx…`, `11jKXicH…`, `11nhDn9s…`) with `baseMint == So11…1112` and the memecoin in `quoteMint` — matching finding 5.1 precisely; 11 of 12 pools carry `lastSwap: null` — the exact input class finding 5.10 guards.
- The canonical GraveVault exposes exactly **six** instructions including `pub fn sweep_dust` (`lib.rs:114`); the console table listed five — matching finding 5.9.

---

## B. Implemented corrections

Eight findings implemented (A1–A6, B1–B2). For each: finding, severity, root cause, files, exact correction, regression coverage, verification. **14 files modified, 3 files added; +775/−89 lines; 45 new tests.**

### B.1 — A1 (audit finding 5.1) [HIGH] — pool token orientation

- **Root cause.** `poolFromSnapshot()` derived the displayed token from the artifact's `baseMint`, assuming the quote side is always WSOL. The indexer fills `baseMint`/`quoteMint` from the raw Raydium coin-vault-mint / pc-vault-mint slices in account order with no normalization (`grave-indexer/src/discovery.ts`), so for pools whose WSOL side is the Raydium *coin* side (`wsolSide.coinIsWsol: true`) `baseMint` IS the WSOL mint — one third of the real corpus rendered the WSOL mint as the traded token with the actual memecoin absent from the label.
- **Files modified.** `src/lib/gy/snapshotContract.ts`, `src/lib/gy/types.ts`.
- **Exact correction.** `baseSymbol` is now derived from **`p.wsolSide.memecoinMint`** — the snapshot's dedicated, orientation-independent memecoin witness — instead of `p.baseMint` (`mint:${shortAddr(p.wsolSide.memecoinMint, 4, 4)}`). `quoteSymbol` remains `"WSOL"` in both orientations. Reserve interpretation and economics untouched: `quoteReserveLamports` is still `wsolReserveLamports`, `baseReserve` still `memecoinReserveRaw`, regardless of coin/pc ordering. No token identity is inferred from the shortened display string. Additionally the mapping now carries the real mint identities on the row (`snapshotMints: { baseMint, quoteMint, memecoinMint, coinIsWsol }`, new optional `Pool` field) — the substrate for A2.
- **Regression coverage.** `src/lib/gy/__tests__/snapshot.test.ts`, new describe `"poolFromSnapshot — token orientation (audit finding 5.1)"` — 6 tests over the **committed artifact** through the actual mapping: fixture-validity pin (both orientations present, 4+8 of 12); `coinIsWsol:true` pools display the memecoin and NOT the WSOL mint segments while WSOL stays the quote; `coinIsWsol:false` pools unchanged (no regression); all-12-pool orientation consistency (`coinIsWsol ? baseMint===WSOL : quoteMint===WSOL` asserted against the artifact's own witness fields); reserve/economics orientation-independence (labels only, never reserves); labels-are-display-strings (contain `…`, shorter than the mint, full identity only in `snapshotMints`).
- **Verification.** `bun test src/lib/gy/__tests__/snapshot.test.ts` → 19/19 pass (was 13). No other snapshot behavior changed (parser, freshness, fail-closed validation all untouched and passing).

### B.2 — A2 (audit finding 5.11) [LOW] — estimator input orientation

- **Root cause.** The pool sheet passed `coinMint: pool.baseSymbol` — a shortened display label — as the mint identity for the estimator's 7019 orientation guard. It only worked because the label could never equal the full WSOL mint; any change making `baseSymbol` a real mint (e.g. fixing 5.1) would have flipped the orientation logic silently.
- **Files modified.** `src/lib/gy/estimator.ts` (new export `estimatorPoolInputs`), `src/components/gy/graveyard.tsx` (call site), `src/lib/gy/__tests__/estimator.test.ts`.
- **Exact correction.** New pure function `estimatorPoolInputs(pool: Pool): EstimatorPoolInputs` — for snapshot rows it feeds the guard **`pool.snapshotMints.memecoinMint`** (the real, full mint address, orientation-independent); for fixture rows (no snapshot mints) it preserves the existing symbol passthrough (display-only rows, labeled simulated). Display labels (`baseSymbol`) can no longer reach the calculation. The pool sheet now calls `estimateSalvageEconomics({ pool: estimatorPoolInputs(pool), … })`; `WSOL_MINT` is no longer imported into the component. Reserve semantics unchanged (`coinReserve = baseReserve` = memecoin side, `pcReserve = quoteReserveLamports` = WSOL side).
- **Regression coverage.** 4 new tests in `estimator.test.ts` (`"estimatorPoolInputs — display labels cannot affect orientation"`): all 12 snapshot pools yield `coinMint = wsolSide.memecoinMint ≠ WSOL` with correct reserves; **adversarial-label proof** — a real snapshot pool's `baseSymbol` poisoned with `WSOL_MINT`, `"WSOL"`, `"mint:So11…1112"` etc. produces byte-identical `EconomicEstimate` objects (`toEqual` on the full result, not just orientation fields); orientation resolves identically for `coinIsWsol` true/false; fixture rows keep the passthrough and still estimate (`ok`, gross 0.9 SOL vector).
- **Verification.** `bun test src/lib/gy/__tests__/estimator.test.ts` → 13/13 pass (was 9). Existing estimator economics vectors untouched and passing.

### B.3 — A3 (audit finding 5.10) [LOW] — criteriaOf hardening

- **Root cause.** `criteriaOf()` computed `daysSinceSwap = floor((now − lastSwapUnix×1000)/86_400_000)` with no guard: `lastSwapUnix === 0` (the exact value every `lastSwap: null` snapshot row carries) produced ≈20,xxx elapsed days and **passed C1** — the function's own contract allowed "incomplete evidence establishes inactivity", which the protocol forbids. Thresholds (90 days / 9,900 bps / 0.5 SOL / 2 epochs / "1,000 LP") were hardcoded spec defaults even though the console reads the live scanner ProtocolConfig.
- **Files modified.** `src/lib/gy/estimator.ts` (`criteriaOf` + new `CriteriaThresholdOverrides` / `CRITERIA_THRESHOLDS_DEFAULTS`), `src/components/gy/graveyard.tsx` (PoolSheet wiring), `src/lib/gy/__tests__/criteria.test.ts`.
- **Exact correction.**
  1. **Fail-closed activity evidence:** `lastSwapUnix <= 0` (and any non-finite value) → C1 `state: "pending"`, `value: "unavailable"` — mirroring exactly how `snapshotCriteriaOf` renders missing evidence, and mirroring the on-chain reality (the canonical evaluator never sees a zero timestamp: the oracle attestation gate rejects it, scanner error 6028 `AttestationTimestampInvalid`). Missing evidence can never become a passing (or fabricated-failing) criterion.
  2. **Integer-exactness preserved:** the pass comparison is integer milliseconds (`now − lastSwapUnix×1000 ≥ inactivitySeconds×1000`); the 89/90-day boundary behavior is bit-identical to before (regression-tested).
  3. **Live-config thresholds:** optional `CriteriaThresholdOverrides` (`inactivitySeconds`, `priceCollapseBps`, `minTvlLamports`, `lpBurnDustThreshold`, `minEpochConfirmation`) with **fail-safe fallback** to the canonical defaults — a missing/NaN/zero/negative override falls back rather than poisoning a comparison. The pool sheet now derives these from the live `ScannerConfigLive` (P4.5 pattern: same one-read-per-sheet-open pulse the estimator already uses); an unreadable config falls back to the canonical defaults inside `criteriaOf`. C2/C3/C6 threshold text and C6's `gap / N epochs` value derive from the (possibly live) values.
  4. **C4 inspected, semantics verified against canonical sources, not changed:** canonical C4 is strict `lp_supply > lp_burn_dust_threshold` (`grave-scanner/src/criteria.rs:144-148`) with ProtocolConfig default **1,000** (strict `>` so supply 0 is unambiguously burned). The console's boolean `lpBurned` model is the fixture-mode placeholder whose REAL state for snapshot rows is the upstream `pending` pin (`snapshotCriteriaOf`) — changing it would alter fixture behavior without owner instruction. The displayed threshold text now tracks the live config value (`supply > 1,000 LP` at defaults — identical string to before), documented in the test.
- **Regression coverage.** 8 new tests in `criteria.test.ts`: zero/negative/NaN/±Infinity timestamps → pending + "unavailable" (never "days", never pass); valid recent activity still fails (no manufactured passes or fails); integer-exact boundary (exactly-at passes, one-second-under fails); live-config C1 boundary (3,600 s config passes a 2-hour-old swap where the 90-day default fails) with broken-override fallback (NaN/0/−5/∞ → canonical default); C3/C6 live-value boundary + fail-safe fallback; C4 canonical-semantics documentation test (strict-`>` default text, boolean model unchanged).
- **Verification.** `bun test src/lib/gy/__tests__/criteria.test.ts` → 15/15 pass (was 7). Pre-existing D6 epoch fail-closed tests untouched and passing.

### B.4 — A4 (audit finding 5.9) [LOW] — vault instruction reference

- **Root cause.** The Protocol view's `VAULT_IX` reference table listed 5 instructions; the canonical GraveVault exposes 6 (`grave-vault/src/lib.rs:65-117` includes `sweep_dust`, the D6 dust recovery whose error codes 7020/7021 the same view already listed).
- **Files modified.** `src/components/gy/protocol.tsx` (imports), **new** `src/lib/gy/reference.ts`, **new** `src/lib/gy/__tests__/reference.test.ts`.
- **Exact correction.** `SCANNER_IX` and `VAULT_IX` moved verbatim into a pure data module `reference.ts` (so the reference data is testable without mounting React), and the missing row added: `["sweep_dust", "Permissionless D6 dust recovery — retained memecoin to the treasury ATA; one-shot per pool."]` — written from the canonical instruction's own doc comment (`sweep_dust.rs`: permissionless; entire vault memecoin balance → protocol treasury ATA; vault ATA closed, rent to caller; `dust_swept_at_ts` stamped; mint-bound; one-shot 7020/7021). Naming verified against the canonical source: `pub fn sweep_dust` — exact snake_case match. No other instructions invented; scanner table verified unchanged (8 canonical instructions); error-code tables preserved untouched.
- **Regression coverage.** New `reference.test.ts` (5 tests): vault table set equals exactly the six canonical instructions; scanner table equals exactly the eight canonical instructions (order-insensitive — the display order is a presentation choice, the SET is the contract); `sweep_dust` present with a substantive description; every row described, names unique; all names canonical snake_case.
- **Verification.** `bun test src/lib/gy/__tests__/reference.test.ts` → 5/5 pass. Protocol view typechecks and builds.

### B.5 — A5 (audit finding 5.13) [LOW] — score presentation

- **Root cause.** Snapshot pools carry `score: 0` as an explicit *not-fabricated* placeholder, but the Score cell printed `p.score.toFixed(2)` — every real row rendered a meaningful-looking "0.00", and the header offered score sorting that is meaningless over identical non-scores.
- **Files modified.** `src/lib/gy/format.ts` (new `formatScoreCell`), `src/components/gy/graveyard.tsx` (cell + header), `src/lib/gy/__tests__/format.test.ts`.
- **Exact correction.** Cell: `formatScoreCell(p.score, p.snapshotMeta !== undefined)` — snapshot rows render the honest em-dash placeholder (same pattern as `formatCollapseCell`); fixture rows keep the numeric two-decimal display unchanged. Header: when every row is a snapshot row, the Score sort button is replaced by a plain header with a title explaining that snapshot pools carry no operator score (the minimal change that stops sorting from implying meaningful scores; no redesign, same cell). No fabricated ranking introduced; no fixture behavior changed.
- **Regression coverage.** 2 new tests in `format.test.ts`: snapshot rows render "—" even for a non-zero score (the column is unavailable in snapshot mode, not "zero"); fixture display contract pinned (0.94 → "0.94", 0 → "0.00", and a documented float-boundary case).
- **Verification.** `bun test src/lib/gy/__tests__/format.test.ts` → 15/15 pass (was 13).

### B.6 — A6 (audit finding 5.7) [LOW] — global footer

- **Root cause.** The footer's blanket "Simulated telemetry · not financial advice" predated P4.1–P4.5; Graveyard/Fleet/Claims/Protocol now consume real protocol, indexer, fleet and on-chain data, so the footer understated the console and contradicted the top-bar "Mixed data — labeled per view" chip and each view's own banner.
- **Files modified.** `src/components/gy/shell.tsx` (one line of copy + a comment).
- **Exact correction.** Footer now reads: **"Per-view data provenance: real / simulated, labeled on every view · not financial advice"** — the audit's required wording direction. No visual redesign, no new elements, same element and classes.
- **Regression coverage.** Copy-only; existing battery covers the data-honesty model elsewhere. (The audit classifies this as documentation inconsistency; the new tests in protocolRpc/snapshot pin the honesty behaviors it summarizes.)
- **Verification.** Full suite + build pass.

### B.7 — B1 (audit finding 5.4) [MEDIUM] — unified RPC configuration

- **Root cause.** Three independent RPC configuration surfaces existed: wallet reads honored `NEXT_PUBLIC_SOLANA_RPC_URL`; protocol pulse and epoch telemetry used a hardcoded `api.devnet.solana.com` host (env ignored — contradicting `.env.example`'s own documented contract); claims reads used `GY_CLAIMS_RPC_HOST`. An operator pointing the console at a private/quota-ed devnet endpoint got a wallet on that endpoint while pulse/epoch still hit the public host, with the Protocol view's "RPC host" stat reporting the mismatch-inducing hardcoded value.
- **Files modified.** `src/lib/gy/protocolLive.ts`, `src/components/gy/providers.tsx`, `.env.example`, **new** `src/lib/gy/__tests__/protocolRpc.test.ts`.
- **Exact correction.**
  - One documented source: `DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com"` and `configuredRpcEndpoint()` — `NEXT_PUBLIC_SOLANA_RPC_URL` when set (trimmed; whitespace-only falls back), else the public-devnet fallback. **No second variable introduced.**
  - `fetchProtocolPulse(rpcEndpoint = configuredRpcEndpoint())` and `fetchEpochTelemetry(rpcEndpoint = configuredRpcEndpoint())` now fetch the configured endpoint **directly** (the `https://${host}` string-prefix construction is gone), honoring path-bearing private endpoints. Timeout (10 s), per-program partial availability, and fail-closed error handling preserved exactly.
  - **Host reporting:** the `rpcHost` field on `ProtocolPulse`/`EpochTelemetry` now carries the **redacted endpoint actually fetched** (`redactRpcEndpoint()`: scheme + host + path, userinfo → `<redacted>@`, **query strings stripped** — devnet providers commonly carry API keys in the query string, and no credential may render in the Protocol view's "RPC host" stat, the Overview caption, or the epoch tooltip). The claims-side `GY_CLAIMS_RPC_HOST` is out of scope for this finding (server-side claims transport, separately documented) and untouched.
  - `providers.tsx` now resolves the wallet endpoint through the **same** `configuredRpcEndpoint()` — one literal source for wallet + pulse + epoch + (below) cluster verification.
  - `.env.example`: the wallet-connection section is now "RPC endpoint (single configuration surface)", documenting that the one variable serves wallet reads, protocol pulse, epoch telemetry and cluster verification, the default, and the redaction guarantee.
- **Regression coverage.** New `protocolRpc.test.ts` (11 of its 20 tests): default endpoint; custom endpoint honored exactly; whitespace-only env → default; redaction (query-string API key stripped, userinfo stripped, plain endpoints unchanged, unparsable → placeholder — with `not.toContain` secret assertions); **endpoint-fidelity under mock fetch** — every captured request URL equals the custom endpoint and never contains `api.devnet.solana.com` (no accidental fallback); host-reporting (rpcHost = redacted endpoint actually fetched); RPC failure degrades per-program (executable null, configError set, no fabricated config) and epoch telemetry throws (caller renders unavailable); a live config decodes through the pulse path with decoder parity vs `decodeVaultConfigLive`.
- **Verification.** `bun test src/lib/gy/__tests__/protocolRpc.test.ts` → 20/20 pass.

### B.8 — B2 (audit finding 5.5) [MEDIUM] — genesis-hash cluster verification

- **Root cause.** The shell asserted "Solana devnet" via a hardcoded badge (and the wallet menu hardcoded "· devnet"); no `getGenesisHash` existed anywhere. A misconfigured `NEXT_PUBLIC_SOLANA_RPC_URL` would silently run wallet reads against a foreign cluster under a devnet label (the pulse's fail-closed NS-3 identity check mitigated only that one view).
- **Files modified.** `src/lib/gy/protocolLive.ts` (`DEVNET_GENESIS_HASH`, `fetchGenesisHash`, `classifyCluster`, `ClusterIdentity`), `src/components/gy/shell.tsx` (verification hook + verified/unverified states), `src/lib/gy/__tests__/protocolRpc.test.ts`.
- **Exact correction.**
  - `DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"` — the same constant pinned in `graveyield-protocol/scripts/devnet/ns3_identities.mjs:60` (verified by direct read).
  - `fetchGenesisHash(rpcEndpoint = configuredRpcEndpoint())` — JSON-RPC `getGenesisHash`, **structurally validated fail-closed** (non-empty base58-shaped string, 32–50 chars, no whitespace; anything else throws), 10 s timeout, read-only, no polling.
  - `classifyCluster(genesisHash)` — pure, total: match → `{status:"verified", cluster:"devnet", genesisHash}`; mismatch → unverified with reason; missing/empty/non-string → unverified `"genesis hash unavailable"`. The verified shape is unreachable from unverified data by construction.
  - Shell: a module-level singleton promise (`useClusterIdentity()`) performs **one** genesis read per page load, shared by the top bar and the wallet menu. Top bar: while checking → muted "checking cluster…"; verified → the same "Solana devnet" badge (design preserved) with a tooltip stating the verification (`verified: endpoint genesis hash … matches Solana devnet (getGenesisHash, read-only)`); unverified → **"Cluster unverified"** warning badge with the reason in the tooltip (RPC unreachable / hash mismatch / unusable payload). Wallet menu balance line: "· devnet" only when verified; otherwise "· cluster unverified". The endpoint's genesis hash is the only identity input — no URL inference, no wallet-connection inference.
- **Regression coverage.** 9 new tests in `protocolRpc.test.ts`: matching hash → verified devnet; a mainnet genesis hash → explicit unverified with reason; missing/empty/non-string → unverified; well-formed read returns the hash; unusable payloads (null/number/empty/short/oversized) throw; HTTP failure and JSON-RPC error throw; end-to-end matching→verified / failure→unverified classification. All three prompt-required classes (matching, mismatching, unavailable) covered at both the fetch and classification layers.
- **Verification.** `bun test src/lib/gy/__tests__/protocolRpc.test.ts` → 20/20 pass.

### B.9 Modification summary

```
.env.example                           |  14 +++-   (B1)
src/components/gy/graveyard.tsx        |  77 +---   (A1 consumer, A2, A3, A5)
src/components/gy/protocol.tsx         |  20 +--    (A4 — tables moved to reference.ts)
src/components/gy/providers.tsx        |  16 +--    (B1)
src/components/gy/shell.tsx            |  89 +--    (A6, B2)
src/lib/gy/estimator.ts                | 125 +--   (A2, A3)
src/lib/gy/format.ts                   |  13 +     (A5)
src/lib/gy/protocolLive.ts             | 127 +--   (B1, B2)
src/lib/gy/snapshotContract.ts         |  29 +--   (A1)
src/lib/gy/types.ts                    |  16 +     (A1 — snapshotMints)
src/lib/gy/__tests__/criteria.test.ts  | 113 +     (A3 — 8 tests)
src/lib/gy/__tests__/estimator.test.ts | 107 +     (A2 — 4 tests)
src/lib/gy/__tests__/format.test.ts    |  20 +     (A5 — 2 tests)
src/lib/gy/__tests__/snapshot.test.ts  |  98 +     (A1 — 6 tests)
NEW src/lib/gy/reference.ts            |  (A4)
NEW src/lib/gy/__tests__/reference.test.ts    | 5 tests
NEW src/lib/gy/__tests__/protocolRpc.test.ts  | 20 tests
NEW docs/lifecycle-integration-design.md      | (Section-4 deliverable, design only)
```

**Test delta: 277 → 322 (+45), 18 → 20 files, 1,217 → 1,639 expect() calls. Zero tests deleted, zero assertions weakened, zero skips added.**

---

## C. Deferred findings and owner-gated items (NOT implemented, by instruction)

Every item below was verified but deliberately not changed, per the Phase-2 authorization. Each is reported with its verification result so the owner decision is ready to execute.

| Item | Audit finding | Verification performed | Why not implemented | Proposed correction (for approval, not applied) |
| --- | --- | --- | --- | --- |
| **O1 — Canonical reference documents** | §0 of audit | — | Named v3.0/v4.0.1 DOCX versions are absent from all accessible repos; designating documents is an owner act | Owner confirms/supplies the canonical document set; the audit's repo-canonical set remains in use until then |
| **O2 — NS-3 deployment status** | 5.12 | Re-confirmed: `src/lib/gy/data.ts:38-39` still `deployedAt: null`; the console's fail-closed pulse handles either reality | Changing `PROGRAM_IDS.deployedAt` would claim a deployment status without owner verification against the authoritative record | Owner records the NS-3 deployment in `graveyield-protocol/docs/DEVNET.md`; console sets `deployedAt` in the same change (the cross-repo sync checker already watches this pair) |
| **O3 — Indexer evidence-status schema** | 5.6 | Re-confirmed: `ConsoleSnapshotV1` still carries only `lastSwap: {...} \| null`; the artifact's 11 `failures[]` rows still collapse to "unavailable" | `grave-indexer` is outside this authorization; the artifact schema is indexer-owned | Indexer adds per-pool `evidenceStatus` (`verified \| no_swap_in_scan \| incomplete`); console consumes fail-closed with pinned states. Integration recommendation: add the field as OPTIONAL in v1 (old artifacts stay valid; absent = `incomplete`-equivalent "unavailable" in the console), so the change is non-breaking for committed artifacts. Implementation deferred to a separately authorized cross-repo task |
| **O4 — Lifecycle scope** | 5.2, 5.8 | Design produced (§D) | Implementation requires the design review + scope decision first | Approve/amend §D, then authorize implementation |
| **O5 — Governance/timelock wording** | (§7.4 of audit) | Not touched | Per protocol decision D2 the on-chain timelock fields are reserved write-only state; rewording is an owner decision | Owner decides the Protocol-view wording so the 72h timelock is never read as program-enforced |
| **O6 — PDA seed discrepancy in the audit brief** | — | Re-verified: the console, canonical Rust, and vendored SDK agree (`["eligibility_anchor\|eligibility_cert", amm, pool]` under scanner; `["pool_registry\|salvage_receipt", pool]` under vault — vault PDAs take only the pool seed) | **No console change needed** — the console matches the canonical code; the audit brief's `SalvageReceipt` seed example was inconsistent. Canonical Rust/SDK remain authoritative | Correct the brief, not the console |
| **O7 — Jupiter dust threshold reference** | 5.3 | **Canonical constant re-verified: 666,666 lamports** (`grave-vault/src/constants.rs` `DEFAULT_JUPITER_DUST_THRESHOLD_LAMPORTS`; byte-identical in vendored `VAULT_PROTOCOL_CONFIG_DEFAULTS.jupiterDustThresholdLamports`; the live-config decode path and the estimator already use 666,666; the console's own estimator tests pin it). The spec-vs-live table still displays the 10,000 figure at `protocol.tsx` (specCheck row "jupiter dust threshold") — **left untouched by instruction** | Reclassified owner-gated in the Phase-2 authorization: "verify the canonical constant and report the proposed correction separately for approval" — done here; "do not silently modify protocol economics" — not modified | One-line correction: the specCheck reference becomes `"666,666 lamports" / "666666"` (or read `VAULT_PROTOCOL_CONFIG_DEFAULTS`), plus the audit's optional pin test binding every specCheck reference to the SDK defaults constants. Ready to apply on approval |
| **O8 — Multi-pool claims** | §6.3 of audit | Not touched | Claims architecture change is out of scope; one sealed artifact per deployment remains the documented behavior | Documented scope limitation stands pending owner decision |

Also **not** done (Section 6/7 restrictions): no fixture-to-live substitution, no new admin/pause/config-update/attestation/salvage interface, no UI/UX redesign (branding, palette, typography, layouts, navigation, styling, animations all untouched — the only presentation changes are the four audit-mandated honesty corrections: A1 labels, A5 score cell/header, A6 footer copy, B2 cluster badge states), no vendored SDK edits (git working tree confirms `vendor/` untouched; sha256 pins pass), no companion-repo files modified.

---

## D. Lifecycle technical design (design only — NOT implemented)

Per Section 4 of the authorization, the complete design is delivered as
**`docs/lifecycle-integration-design.md`** (included in the docs-only delivery PR #12; the code
changes themselves remain uncommitted working-tree edits — see the Delivery note in the header).
It addresses all fifteen required points and explicitly covers the additional
states. Summary of the design's decisions (full detail — the explicit account-read model, the
deterministic derivation order, the classification truth table, the failure matrix, and the test
plan — in the document):

1. **Accounts read (per pool):** GraveScanner `EligibilityAnchor` + `EligibilityCert`; GraveVault `PoolRegistry` + `SalvageReceipt`; plus one shared live `getEpochInfo` (already shipped by `protocolLive.fetchEpochTelemetry`). Each account owns exactly one lifecycle fact; no fact is ever derived from absence of a successful read.
2. **Canonical SDK only:** PDA derivation via `eligibilityAnchorPda` / `eligibilityCertPda` / `poolRegistryPda` / `salvageReceiptPda` and decoding via the discriminator-asserting `decodeEligibilityAnchor` / `decodeEligibilityCert` / `decodePoolRegistry` / `decodeSalvageReceipt` from the vendored, sha256-pinned canonical SDK. The console hand-builds no seeds and transcribes no layouts.
3. **Fact ownership:** anchor owns Phase-1 (firstEligibleEpoch, invalidated, bitmap); cert owns expiry (expiresAt) and invalidation is anchor-owned; registry existence owns "salvaged" (init-once at salvage); receipt is optional settlement detail; the live epoch owns the gap math.
4. **Read strategy:** per selected pool on sheet open + manual refresh — no table-wide fan-out (rationale: RPC load, the no-polling discipline, the two precedents in the codebase, and blast-radius containment). Table rows remain snapshot-backed `"discovered"`; only the sheet's lifecycle panel consumes chain truth. A batched table-wide option is described for a future owner decision and kept out of scope.
5. **Commitment:** `confirmed` (matches the claims precedent); route-executed server-side (`/api/gy/lifecycle`, Node runtime) so the SDK's `node:crypto` never enters the browser; the client re-validates the payload (preservation requirement); query parameters strictly validated.
6. **Explicit read statuses (no nullable reads):** every account read is an `AccountRead` union — `present` / `absent` / `unavailable` / `corrupt` / `owner-mismatch` — applied to anchor, cert, registry and receipt alike; only a clean `null` lookup maps to `absent` (accounts are init-once), and the epoch and clock reads carry explicit statuses too (`EpochRead` / `TimeRead`). Anything that is not a clean null is never "absent".
7. **RPC failures / partial reads:** per-fact status — readable facts render with their explicit status, invalid reads render `unavailable` / `corrupt` / `owner-mismatch` with a redacted reason; states requiring an invalid read degrade to `unavailable` rather than being fabricated from a half-read, a corrupt read, or a wrong-owner read.
8. **Malformed / misowned accounts:** owner validation runs BEFORE decoding. Wrong `owner` program → the explicit `owner-mismatch` status (expected vs actual owner carried verbatim) — **never treated as absent**, never decoded, classified fail-closed like any invalid read, and surfaced as an identity-misconfiguration diagnostic; discriminator mismatch or truncation → `corrupt`; no partial decode; last good state never mutated by an invalid read.
9. **Stale-read protection:** per-pool-key monotonic sequence numbers; a response applies only if its pool key matches the current selection and its seq is the newest — rapid open/close cannot let a slow response for a previously-opened pool overwrite the current view (same discipline as the tx reconciler).
10. **Certificate expiry:** from the cert's own on-chain `expiresAt` (i64 unix seconds) vs a successfully read current time passed as an explicit clock read; if the clock read is unavailable, the expiry classification degrades to `unavailable` — expiry is never guessed. The TTL countdown re-derives client-side from that value without re-fetching.
11. **Invalidation:** only `anchor.invalidated` (multisig-only `invalidate_anchor` on-chain) — the console can never manufacture it; it takes precedence in display even if a later cert exists.
12. **Salvaged:** a valid, correctly owned, decoded `PoolRegistry` (init-once at `salvage_pool`) is the terminal fact and outranks everything else; receipt detail displayed alongside — its absence or an unavailable receipt read after the registry exists renders as partial/unknown detail, never an error hiding the settlement. An unavailable, corrupt, or owner-mismatched registry read proves neither settlement nor non-settlement and is never treated as absent.
13. **Unavailable vs confirmed:** `unavailable` is a first-class, reason-carrying outcome kept OUT of the `PoolState` filter vocabulary; `discovered` requires the registry, anchor and cert reads to be each **definitively** `absent`; the console never collapses "could not read" into "not anchored", an invalid read (corrupt / owner-mismatch) into absence, or an unavailable epoch/clock into a numeric value.
14. **Model representation:** `PoolState` extends additively with `"anchored"`, `"re-evaluation-window-reached"`, `"certificate-expired"`, `"invalidated"` (finding 5.8); `POOL_STATE_META` gains the four labels; the stepper maps them (invalidated → the failed path's red bar). The derivation is a pure `LifecycleState` union produced by a pure, total function from an explicit `LifecycleReads` input (`AccountRead`/`EpochRead`/`TimeRead` — no nullable reads).
15. **Consumers:** one `LifecycleState` + raw decoded facts feed the sheet panel, badge and stepper from a single object so display cannot drift from derivation; the existing six-state filter tabs keep their current semantics (table rows stay snapshot-backed; lifecycle filters become meaningful only with the deferred table-wide option — never silently redefined).

**Boundary preservation:** GraveScanner remains the eligibility authority — `anchored` (with its separate `EpochProgress` object) and `re-evaluation-window-reached` report the scanner's own Phase-1 record against the epoch clock and assert nothing about eligibility: the window means only that GraveScanner may perform the next evaluation, not that the pool passed all six criteria, is eligible, has a certificate, is certified, or is authorized for salvage; GraveVault remains the settlement authority; the console evaluates nothing, signs nothing, infers nothing from the indexer snapshot, and the design's anti-inference pin (test 7) enforces that feeding it no successful on-chain reads yields `unavailable`, never a lifecycle state.

**Deliberately out of scope:** LaunchPrice reads (C2 stays pending), any write path, any criteria evaluation, indexer schema work (O3), and any behavior before the owner records the NS-3 deployment (O2) — until then every read honestly degrades to `unavailable` at the config-not-found layer.

**Status: the design is delivered for O4 review. No lifecycle reads, no `PoolState` extension, and no stepper/filter changes are implemented.**

---

## E. Test and build results (exact commands, actual results)

All commands run from the repository root of the **local audit clone** after the final edit — i.e. against the local implementation described in §B, **not** against the contents of PR #12 (documentation-only; the suite does not cover documentation).

| # | Command (verbatim) | Result |
| --- | --- | --- |
| 1 | `bun run typecheck` | `$ tsc --noEmit` — exit 0, no errors |
| 2 | `bun run lint` | `$ eslint .` — exit 0, no warnings |
| 3 | `bun test` | **322 pass / 0 fail**, 1,639 expect() calls, 20 files (~0.45 s) |
| 4 | `bun run build` | `next build` — exit 0; routes: `/`, `/api/gy/claims`, `/api/gy/fleet`, `/api/gy/snapshot` (+ static assets) |
| 5 | `bun audit` | `No vulnerabilities found` |
| 6 | `bun test src/lib/gy/__tests__/sdkVendored.test.ts` | 15/15 — all seven vendored files' sha256 byte-pins, live-cluster PDA pins, golden claim-instruction vector pass (SDK untouched) |
| 7 | Per-finding suites | snapshot 19/19 · estimator 13/13 · criteria 15/15 · format 15/15 · reference 5/5 · protocolRpc 20/20 |

**New test count by finding:** A1 → +6 · A2 → +4 · A3 → +8 · A4 → +5 · A5 → +2 · B1+B2 → +20. Total +45 (277 → 322). No existing test was modified except where its imports had to track a moved table (none — no assertions changed).

---

## F. Preservation verification

Each item from the Phase-2 preservation list, with the evidence that it remains intact:

- **Four-state artifact transport envelopes; fail-closed parsing; wall-clock freshness; cached/stale honesty; client-side revalidation** — `snapshotTransport.ts`, `fleetTransport.ts`, `claimsTransport.ts`, `claimsSource.ts` untouched (git diff empty for all four); their batteries pass unchanged (33 transport tests re-run green). A1 touched only the mapping function downstream of the parser.
- **Snapshot provenance & SHA-256 fingerprinting** — `poolFromSnapshot` still carries `snapshotFingerprint` / `snapshotMeta` verbatim; the fingerprint provenance tests pass.
- **C1/C3 observational criteria behavior; C2–C6 pending pins** — `snapshotCriteriaOf` untouched; the parser still rejects any non-`pending` C2/C4/C5/C6; A3 touched only `criteriaOf` (the fixture-path evaluator), and the honest-state invariant was *strengthened* (missing evidence → pending).
- **Canonical SDK derivation and account decoding; vendored SDK integrity** — `vendor/` byte-identical (git clean; 15 sha256/golden pins pass). The console still implements no competing derivation or Merkle math.
- **Live protocol configuration reads; 40/40/20 presentation; indefinite LP claims semantics; Merkle proof verification; holder-specific claim privacy** — `claimsOnchain.ts`, `claimsContract.ts`, `claims.tsx` untouched; claims batteries (65 tests incl. hardening) pass.
- **Claim transaction simulation, wallet approval, ClaimRecord reconciliation, `confirmation-unknown`, duplicate-submission protections, existing wallet signing boundaries** — `lib/gy/tx/` and `claims.tsx` untouched; txMachine/txPrepare/txReconcile batteries pass. No new signer, instruction, or authority path was introduced anywhere in this phase (the only instruction built in the console remains `claim_lp_proceeds`).
- **Read-only authority and oracle displays; existing fleet event vocabulary and fail-closed handling** — `protocolOps.ts`, `fleetContract.ts`, `fleet.tsx`, `overview.tsx` untouched; their batteries pass.
- **No fixtures promoted to live data; no fixture disguised as live; no admin/pause/config-update/attestation/salvage interface added** — the diff contains no new route, no new write path, no new key material; `grep` over the diff shows no new `signer`/`signTransaction` usage; the shell's new cluster check is read-only `getGenesisHash`.
- **Do not expose credentials** — new display surfaces redact (`redactRpcEndpoint` strips query strings/userinfo, tested with `not.toContain` secret assertions); error reasons in `fetchGenesisHash`/pulse never embed the endpoint.
- **Environment separation** — no new env variable introduced (B1 explicitly reuses the documented one); `.env.example` updated to match reality; no `.env` committed.

---

## G. Remaining risks

1. **The lifecycle gap stands (High, unchanged, by instruction).** Real pools still cannot leave "discovered"; the central operational question remains answerable only from fixtures until O4 is decided and §D is implemented. The design is ready; nothing else was authorized to move.
2. **O7 remains visibly wrong.** The spec-vs-live table still cites the 10,000-lamports dust default against a live 666,666 config, training operators to ignore "≠ spec". The correction is one line and pre-verified (§C) but requires owner approval under the authorization's terms.
3. **O2/O3 cross-repo drift persists.** NS-3 deployment status (`deployedAt: null` vs the acceptance record) and the collapsed evidence vocabulary (verified / no-swap-in-scan / incomplete → two states) are owner-gated; both are documented with ready-to-execute proposals (§C).
4. **CSP `unsafe-inline` and broad `connect-src`** (audit 5.14, informational) remain as documented accepted tradeoffs — pre-mainnet hardening items, unchanged by this phase.
5. **Cluster verification is advisory.** B2 makes the misconfiguration *visible* (badge + wallet menu) but does not block reads on a non-devnet endpoint; the pulse still fails closed via NS-3 identity. A hard "refuse to operate on unverified cluster" gate would be a behavior change beyond the finding's scope and is flagged for the owner.
6. **One-page-load genesis read.** The identity is cached for the session (module singleton); a cluster switch mid-session (endpoint can't change without reload in practice) is out of scope; a re-check button can be added with the O4 lifecycle work if wanted.
7. **Test-architecture gap (inherited).** All honesty invariants remain lib-level; component/DOM tests still do not exist, so JSX-level regressions (e.g. the new badge states) are covered only by type-checking and review. The audit lists this as gap #4; it remains open.

---

## H. Final assessment

**Improved but not yet fully aligned — and not yet ready for a re-audit against an ALIGNED target.**

- **What moved (verified):** the one real display defect (5.1) is fixed with artifact-backed regression proof; the estimator can no longer be misled by display strings (5.11) nor treat missing activity evidence as inactivity (5.10, with live-config thresholds); the vault instruction reference is complete and CI-pinned (5.9); snapshot pools no longer render fabricated scores (5.13); the footer describes the actual mixed-data architecture (5.7); RPC reads share one documented, credential-redacting configuration surface (5.4); and the cluster badge now reflects a verified genesis hash instead of an assertion (5.5). Every correction carries focused behavioral regression tests; the full gate reproduced green locally (322/322, typecheck, lint, build, 0 audit findings, SDK pins intact).
- **What still stands between the console and full alignment:** the lifecycle (5.2/5.8) — designed (§D), not implemented, pending O4; the indexer evidence-status vocabulary (5.6/O3), cross-repo and owner-gated; the NS-3 deployment-status reconciliation (5.12/O2); the O7 dust-reference correction (verified, awaiting approval); and the O1/O5 documentation decisions.
- **Per the mandate:** no claim of full alignment is made on the strength of passing tests alone, and no Mainnet-readiness claim is made. The repository is positioned for an ALIGNED verdict at the next audit once the O4-approved lifecycle implementation and the owner-gated items above land.

**Implementation stops here. The code change set remains uncommitted in the local audit working tree — complete, verified, and reversible; no code has been committed, pushed, merged, or deployed. Only this report and the design document are delivered, as docs-only PR #12, per owner instruction.**
