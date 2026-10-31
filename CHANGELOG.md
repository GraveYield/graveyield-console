# Changelog

All notable changes to graveyield-console are documented here. Dates are UTC.
Commit identity convention: all GraveYield engineering commits are authored as sethoshi.eth.

## [Unreleased]

### LP Claims integration — 2026-10-31 (P4.4)

The LP Claims view is wired to actual snapshot, Merkle distribution, and on-chain claim data. The simulated fixture era of this view (demo wallets, invented roots, a toast that said "Simulated claim") is gone. Still devnet-only; the one new transaction path is the protocol's own `claim_lp_proceeds`, signed exclusively by the connected wallet.

- **Canonical SDK vendored — no competing Merkle or claim math** (`src/lib/gy/vendor/graveyield-sdk/` + `PROVENANCE.md`): the Phase 4.0 audit's Q1 Option A landed. Seven SDK files are vendored **byte-identical** to `graveyield-protocol`@`2b0bc24` (`borsh`, `discriminators`, `web3compat`, `pdas`, `merkle`, `accountDecoders`, `errors`) and sha256-pinned by `__tests__/sdkVendored.test.ts` — any local edit fails CI, upstream updates are a deliberate re-pin. `claimsInstructions.ts` transcribes `buildClaimLpProceedsIx` verbatim (the canonical file top-level-imports `@solana/spl-token`, which this tree intentionally lacks — the audit kept `bigint-buffer` out); its wire encoding is pinned to an **independently computed golden vector** (Python hashlib/struct of the on-chain Anchor layout) plus account-meta assertions and the live-cluster PDA pins. Account derivation, claim instruction construction, and every proof-related operation call the canonical SDK; the console implements none of them. Four one-line `.js` resolution shims keep Turbopack/bun/tsc in agreement (documented; no logic). The vendored tree is server-only (Node runtime, `node:crypto`); the browser imports none of it.
- **Distribution artifact transport** (`claimsSource.ts`, `/api/gy/claims`): the sealed `SnapshotArtifact` (grave-snapshotter, format_version 1 — transcribed from `snapshotter/src/artifact.rs`) arrives via `GY_CLAIMS_URL` (HTTPS artifact store) or `GY_CLAIMS_PATH` (mounted volume) — the two established topologies. Pull-only, `force-dynamic` + `no-store`, four-state envelope (valid/stale/missing/corrupt with the honest real/stale/unavailable mapping). The contract gate is schema **and integrity**: the whole tree re-derives through the canonical SDK `SnapshotMerkleTree` (root, every leaf, every proof, reconciliation identity) — the console-side mirror of `artifact.rs::verify_integrity`. serde's u64-as-JSON-number precision hazard is defused by that gate: any balance that did not round-trip exactly changes the hashes and fails closed. Freshness: a sealed distribution has no wall clock, so the console stamps the check and imposes the budget (`GY_CLAIMS_MAX_AGE_MS`, default 7 days) — the client re-evaluates against its own clock, degrading but never upgrading.
- **On-chain settlement reads** (`claimsOnchain.ts`): live devnet `PoolRegistry`, `SalvageReceipt`, `ClaimRecord` and `lp_holder_pool_vault` reads through the canonical SDK decoders + PDAs. Every section fails independently to an explicit null + error string. A failed ClaimRecord read is fail-closed — it must never read as "never claimed", so it blocks the claimable path. The "distribution epoch" row derives from the registry's `salvagedAtSlot` with the live `getEpochInfo` `slotsInEpoch`, or renders the slot with an unavailable epoch — never a fabricated epoch number.
- **The claim state machine** (`claimsContract.walletClaimView`) — the owner's vocabulary exactly: `claimed` (on-chain `ClaimRecord` = the canonical paid evidence; checked FIRST, a chain fact that survives artifact unavailability) / `no-claim-record` (registry absent — nothing found) / `snapshot-unavailable` (artifact missing/corrupt, registry read failed, or artifact root ≠ on-chain root — eligibility UNKNOWN, never conflated with ineligible) / `wallet-not-eligible` (root-bound distribution, wallet holds no leaf) / `proof-unavailable` (leaf present, proof fails against the on-chain root — defense-in-depth beyond the whole-artifact gate) / `claimable` (proof verified against the ON-CHAIN registry root through the SDK; expected amount from the normative `claim_lp_proceeds.rs` formula — u128 intermediate, integer-division floor — labeled "expected, final amount determined on-chain at claim time").
- **Non-expiring semantics preserved**: nothing models a deadline; the UI states that the distribution stays claimable indefinitely and that `claim_lp_proceeds` is live even under emergency pause. No expiry logic anywhere in the pipeline.
- **Privacy by construction**: the per-holder entry set (other wallets' balances and proofs) never leaves the server. The route serves the privacy-stripped projection (root, counts, reconciliation — no rows) plus, for the queried wallet, that wallet's own row; the client hydrator structurally rejects any "projection" carrying per-holder rows. Any address may be queried (the data is public on-chain), but the console surfaces only the queried wallet's detail — never a holder directory. The demo fixture wallets are deleted from `data.ts` along with the `ClaimPosition` type.
- **Claim transaction lifecycle — honest at every step** (`claims.tsx`): the SDK-prepared instruction arrives serialized (prepared = unsigned, nothing promised); submission goes through the wallet-adapter (`sendTransaction`), status renders `transaction prepared` → `submitted — awaiting confirmation` (never worded as paid) → `confirmed` ONLY after the client itself re-reads the `ClaimRecord` PDA (server-derived by the canonical SDK) from devnet → `failed` (with "no lamports moved" wording). Explorer link when a signature exists; bounded confirmation loop, no silent polling. A proof existing or a transaction being prepared can never display as paid.
- **UI rebuilt** (`claims.tsx`): provenance banner (four states + cached holding, same D5 semantics as Graveyard/Fleet); sealed-distribution card (root, epoch/slot, claimants, tree depth, supply, reconciliation identity, integrity badge); on-chain settlement card (registry PDA, salvage reference + salvor, root cross-check badge matching artifact↔chain, LP bucket totals, vault lamports, receipt); wallet lookup (connected wallet one-click or pasted address, per-state cards with reasons, expected/claimed/remaining amounts, prepared-claim signing). Shell badge updated: claims are no longer listed as simulated.
- **Tests** — new batteries (suite 138 → 199; 15 + 22 + 24 new): `sdkVendored.test.ts` (byte pins, live-cluster PDA pins, golden vector, fork-proven Merkle vector, discriminator pins), `claimsContract.test.ts` (parser + integrity fail-closed sweep: foreign version, duplicate/zero/unordered entries, tampered root/leaf/proof/balance, broken reconciliation identities, the SDK tree builder as byte-order authority against a string-order-divergent pair, privacy projection, normative-math vectors incl. u128-scale, the full state machine incl. claimed-first and unreadable-record fail-closed), `claimsTransport.test.ts` (resolver four states, budget env parsing, corrupt with distinct codes, hydration double gate incl. privacy-poisoning and future-check rejection, wall-clock degradation, cached precedence).
- **Dependency hygiene**: a minimatch advisory (GHSA-g3hv-75wg-m249, published after the P4 dependency pass) broke the zero-findings gate — overrides moved to `minimatch >=11.0.1` with its required `brace-expansion ^5` (the same flattening trade-off the P4 audit recorded; eslint/tsc/build/test functionally verified green).
- **Docs** — `docs/claims-integration.md` (data planes, vendoring contract, env, state vocabulary, privacy, operator flow), `.env.example` claims section, README per-view honesty rewrite + project structure.
- Unchanged by design: protocol economics, eligibility thresholds, criteria honesty, snapshot/fleet transports, the estimator, devnet-only scope, no signature-free submission, no mainnet work.

### Fleet-state ingestion — 2026-10-31 (P4.3)

The Salvor Fleet view no longer renders simulated bot cards. It ingests the salvor fleet's real operational trails from the fleet-ops `FLEET_STATE_DIR` (the Phase 4.0 audit's Q3 premise: fleet ingestion is built on verified deployment access to that state directory), through the same fail-closed four-state discipline the snapshot transport established. Still devnet-operations-only: no transaction path was added, nothing polls, nothing writes to the state dir.

- **Upstream contract audited, then transcribed — not invented** (`fleetContract.ts`, isomorphic): the parser accepts exactly what `salvor-bots` `@graveyield/fleet-ops` writes into `FLEET_STATE_DIR` — the Monitor's `monitor-events.jsonl` (`FleetEvent`: `tsMs`/`botId`/`type` + optional `identityKey`/`pool`/`state`/`failureClass`/`data`) and `alerts.jsonl` (`Alert`: `code`/`severity`/`message`/`atMs`/`context`/`suppressed`). The 26 event types, 23 failure classes, 15 execution states and 3 alert severities are transcriptions of the upstream unions; any other value throws `FleetError`. Alert context must be scalar/null — a nested object proves the trail was not written by the audited fleet-ops path. One bad line rejects the whole file (an append-only trail is the fleet's record; serving a partial one would be fabrication by omission). `alerts.jsonl` absence is a legal zero state (upstream creates it lazily on the first alert); `monitor-events.jsonl` absence means the dir is not the fleet's state dir at all (`TRAIL_ABSENT`).
- **`/api/gy/fleet` route + resolver** (`fleetSource.ts`): pull-only, `force-dynamic` + `no-store`, 200-with-envelope in every state. `GY_FLEET_STATE_PATH` (mounted `FLEET_STATE_DIR`, self-hosted) is the one supported source — there is deliberately no URL topology because no upstream publisher of fleet trails exists today; inventing one would be scope fabrication. No source configured → first-class `unavailable`, never a fixture fallback. 8 MiB/file cap, injected I/O for testability, freshness budget `GY_FLEET_MAX_AGE_MS` (default 30 min = 30× monitor sweep / 6× scout cycle cadence; invalid values are rejected, not guessed).
- **Envelope + client double gate** (`fleetTransport.ts`): mirrors the snapshot transport — `valid/stale/missing/corrupt` with the honest `real/stale/unavailable` mapping (`real ⟺ valid`, pinned by a sweep test), client-side re-validation through the same fail-closed parsers, envelope-consistency checks, re-derived newest-timestamp freshness, future-dated-trail rejection (`FUTURE_TRAIL_TS`), and the P4.2 display semantics: wall-clock degradation (`effectiveFleetState` — valid-at-fetch degrades to stale mid-session, never upgrades), cached holding on failed refresh (`asCachedFleetDisplay` / `resolveDisplayFleetPayload` — retention with honest labeling, stale stays stale).
- **Fleet view rewired** (`fleet.tsx`): provenance banner (fresh / stale / cached / unavailable / corrupt + checked-at, age-vs-budget, the route's reason, manual Refresh — "manual — no auto-polling"); an observer card whose every number is counted from the trail; verbatim event and alert logs (trail timestamps, types, severities, failure classes, suppressed flags — no re-interpretation into the old fake vocabulary); documented five-bot identity cards labeled **reference** with per-botId trail counts only. Removed by design: mode badges (dry-run/live/read-only), status words, and every fixture stat — none of it is derivable from the trail. The pre-P4.3 `BOTS` fixture is deleted from `data.ts`; the Overview's simulated activity feed remains, still labeled. A source grep in the new battery pins that the Fleet view cannot import the fixtures again and cannot re-acquire mode/status vocabulary.
- **Honest scoping recorded**: the Scout's own trail is upstream `SCOUT_REPORT_FILE` (default unset) and executor bots emit only when operator-enabled — the ingested state dir carries the Monitor's trail plus operator-enabled executors. An empty Scout card states exactly that fact (docs + UI attribution note); wiring `SCOUT_REPORT_FILE` is future work with its own verified contract.
- **Tests** — new fleet battery (`fleetTransport.test.ts`, 31 tests; suite 107 → 138): line parsers (full upstream vocabulary, every rejection class), JSONL whole-artifact rejection with line numbers, resolver states (no-source / not-a-dir / trail-absent (injected path + real tmpdir statSync guard) / fresh / stale / oversize / corrupt / future / unreadable-alerts fail-closed / budget-env validation), the `real ⟺ valid` sweep, hydration double-gate (tampered lines, count/newest inconsistencies, failed-states-carry-no-payload), wall-clock degradation with the exact boundary, cached precedence, empty-trail honesty, and the fixture-free source greps.
- **Docs** — `docs/fleet-ingestion.md` (the ingestion runbook: what the fleet writes, the state machine, the attribution note, operator steps, explicit out-of-scope), `.env.example` (fleet section), README per-view honesty updates, shell badge + nav hint.
- Unchanged by design: protocol economics, eligibility thresholds, estimator math, criteria honesty, snapshot transport, read-only/dry-run posture, devnet-only scope.

### Eligibility visualization honesty — 2026-10-31 (P4.2: audit D5/D6)

The two remaining DataState/epoch defects from the Phase 4.0 audit. Charter unchanged: no fabricated data, no protocol changes, no transaction submission, no mainnet work — the only new network call is a read-only `getEpochInfo`.

- **D5 — every DataState is now assignable, and nothing can upgrade what the transport refused:**
  - `cached` is finally a real state: when a manual refresh fails (transport unreachable, payload rejected, missing/corrupt artifact), the last good artifact stays on screen and is explicitly labeled **cached** — real observations from a previous successful check that the latest check could not reconfirm. Previously the failed refresh wiped the operator's data (`setTransport(null)`); retention with honest labeling is strictly more truthful than erasure. Precedence is one-directional: an artifact past its own budget still reads **stale** (the stronger claim); failed states stay **unavailable**.
  - Freshness now follows the wall clock, not the fetch moment: the display payload is re-evaluated against the current time on every render (`effectiveTransportState`, pure clock math on the already-validated payload — no network, no polling). A valid-at-fetch artifact degrades to **stale** the moment its own 24 h budget lapses mid-session; previously the "fresh" badge froze at fetch time forever.
  - The derivation is one pure, unit-tested rule (`resolveDisplayPayload` in `snapshotTransport.ts`); the banner grew a fifth display state (**snapshot cached**, with the last-good check time, the artifact's own fresh/stale verdict, and the latest failure reason) next to fresh/stale/unavailable/corrupt.
- **D6 — the fabricated epoch 713 is gone everywhere:**
  - `criteriaOf(pool, now, currentEpoch)` takes the current epoch as an explicit argument with no default; the C6 gap is computed only when both ends are known. Unknown epoch → **pending · current epoch unavailable** — a stale constant can never manufacture a pass/fail. Snapshot-backed rows were never affected (the indexer pins C6 pending upstream).
  - The shell's top-bar epoch telemetry (`713 · 62%`, previously three independent constants: `data.ts EPOCH`, a dead `graveyard.tsx EPOCHS_NOW`, and a hard-coded JSX literal) is now **live read-only `getEpochInfo` telemetry** fetched once per page load from the configured devnet RPC (`protocolLive.fetchEpochTelemetry`, fail-closed validation of the answer). Unreachable RPC renders *—* / *unavailable* — never a substitute number. No polling; `EPOCH` and the dead constant were deleted.
- **Tests** — new honesty battery (`eligibilityHonesty.test.ts`, 22 tests; suite 85 → 107): display-time freshness degradation and its ≤ boundary, one-way stale→valid impossibility, cached/stale/unavailable precedence, the full failed-wire sweep (unreachable / stale / corrupt × time) asserting the display dataState is never `real`, future-dated artifacts rejected upstream so the display math can never be exploited, the C6 explicit-epoch contract (null/omitted/NaN → pending, boundary gaps 1/2/5), and a source grep pinning that no baked-in epoch constant returns to the estimator.
- **Docs** — README data-honesty section gained the wall-clock freshness, cached-holding and live-epoch paragraphs.
- Unchanged by design: transport four-state envelope on the wire, eligibility thresholds, estimator economics, criteria honesty (C2/C4/C5/C6 pending-pinned), read-only/dry-run posture.

### Snapshot artifact transport + live data integration — 2026-10-31 (P4.1 Step 1)

The Graveyard no longer renders the build-time committed artifact; it reads a server-resolved snapshot source with an explicit, test-pinned four-state contract. Still devnet-operations-only: no transaction path was added, and nothing implies automatic real-time ingestion.

- **`/api/gy/snapshot` route** (`src/app/api/gy/snapshot/route.ts`) — `force-dynamic` + `Cache-Control: no-store`; answers `200` in every state with the state machine carried in the payload envelope. Pull-only: no polling, no artifact writes, no push acceptance.
- **Source resolution** (`src/lib/gy/snapshotSource.ts`) — answers the Phase 4.0 deployment question: `GY_SNAPSHOT_URL` (HTTPS artifact store — the supported topology for serverless deploys, which cannot assume a persistent local directory of indexer output) or `GY_SNAPSHOT_PATH` (indexer output volume, self-hosted). Exactly one source may be set: neither → `missing` / `NO_SOURCE_CONFIGURED` (a first-class honest state), both → `missing` / `SOURCE_CONFLICT`. 8 MiB transport cap, 10 s fetch timeout, credential-redacted diagnostics (URL userinfo/query are never echoed). Transport-level failures map to `missing`; contract-level rejections (invalid JSON, schema violations, fabricated criteria, non-u64 fields, future-dated `generatedAt`, oversize) map to `corrupt` — neither can ever carry `dataState: "real"`.
- **Contract/artifact split** — the fail-closed parser, freshness math and UI mapping moved to `snapshotContract.ts` (isomorphic, artifact-free); `snapshot.ts` re-exports them and binds the committed `snapshot.json`, which remains the contract test seed and a documented local-development source. Client code no longer pulls the committed artifact into its bundle.
- **Client hydration gate** (`src/lib/gy/snapshotTransport.ts`) — the browser re-validates every route payload through the same parser and enforces envelope consistency: `dataState` must equal the honest mapping of `artifactState`, failed states must carry no payload, and the staleness verdict must match the artifact's own budget. A stale or invalid artifact presented as fresh is structurally impossible (two independent applications of the same fail-closed contract).
- **Graveyard rewiring** — four-state provenance banner (fresh / stale / unavailable / corrupt) with the server checked-at time, age-vs-budget for stale, the route's diagnostic reason for failures, and a manual **Refresh** button ("manual — no auto-polling"). Without a contract-clean artifact the view renders a withheld-data state with fix-it instructions instead of a table; the pool detail sheet now consumes the route-served snapshot.
- **Tests** — new transport battery (`snapshotTransport.test.ts`, 34 tests; suite 51 → 85) proving the delivery mechanism end to end in both topologies, including the committed artifact (real past-budget bytes) classifying `stale` through resolver, route and hydration; an invariant sweep asserting `dataState === "real"` ⟺ `artifactState === "valid"`; staleness boundary, oversize, credential-redaction and route-handler cases.
- **Docs** — `docs/snapshot-transport.md` (the artifact delivery runbook: topologies, state machine, operator runbooks, explicit out-of-scope), `.env.example`, README accuracy updates.
- Unchanged by design: protocol economics, eligibility thresholds, estimator math, criteria honesty (C2/C4/C5/C6 pending-pinned), and the read-only/dry-run posture of every view.

### Hygiene + honesty — 2026-10-30 (P4.1 Step 0: audit remediation, owner-approved)

Charter: fix Phase 4.0 audit findings without touching protocol economics, eligibility thresholds, estimator economics, or any transaction behavior. No signing or submission path was added; the app remains read-only plus dry-run toasts.

Changes:

- **Graveyard honesty fix (audit D2)** — the desktop table's Idle and Collapse cells rendered unavailable data as values:
  - Idle: `lastSwapUnix === 0` (indexer recorded an activity-derivation failure; 11 of 12 committed snapshot pools) rendered as a fabricated ~20,754d. Now renders `unavailable` via `formatIdleDaysCell`.
  - Idle: the cell subtracted unix **seconds** from `Date.now()` (ms), inflating the one real snapshot row (`1_759_460_872` → ~20,715d instead of the correct 392d). Fixed by the same formatter.
  - Collapse: snapshot rows pin `collapseBps` to 0 while C2 is pending upstream; the cell rendered a fabricated `0.0%`. Now renders `—` for pending rows via `formatCollapseCell`.
  - `resolvePools()` (fixture layer) emitted **milliseconds** for `lastSwapUnix`, violating the documented `Pool` contract (unix seconds) that `estimator.criteriaOf` relies on — C1 silently evaluated as fail for every simulated row. Resolver now emits seconds; a contract test pins the unit.
  - Display decisions centralized in two pure, unit-tested formatters; six regression tests added (45 → 51). The pool detail sheet already handled both cases correctly and is unchanged.
- **Dead-dependency removal (audit D3)** — 35 of 85 `dependencies` entries removed after verifying zero references across the compiled tree, all configs, and build scripts (template leftovers such as `next-auth`, `next-intl`, `zustand`, `@tanstack/*`, `@mdxeditor/editor`, `@dnd-kit/*`, `framer-motion`, `react-markdown`, `react-syntax-highlighter`; plus hoisted transitive-name entries whose kept consumers remain covered by the untouched `overrides` block). Kept deliberately: `sharp` (`next/image` is used; prod image optimization), `postcss` (build chain + override target), and every package imported by a compiled shadcn/ui primitive. `bun audit` remains at **0 findings**; full gate re-run green (typecheck, lint, 51 tests, production build).
- **CI job-header comment corrected (audit D1 disposition)** — the `verify` job header still claimed "there is no unit test battery here — the production build IS the test", contradicting the `bun test` step in the same job (the battery exists since P3-A). Comment-only change.
  - Audit-record correction: the Phase 4.0 audit also reported the CI branch filters as corrupted (`branches: ain]`). Re-verification against the git object store shows the committed filters are correct (`branches: [main]`); the reported corruption was an audit-observation artifact, not a repository defect. No workflow trigger change was needed or made.
- **Documentation accuracy (audit D4)** — README updated to describe per-view data honesty (live pulse; real committed snapshot artifact with manual refresh; simulated fleet/claims/KPIs/actions), the lib/gy layer inventory, the unit-test battery in the dev commands, and `grave-indexer` in the related-repos list. Claims are scoped to what exists: no artifact-transport, fleet-ingestion, claims-integration, or transaction capability is asserted.

### Data integration — 2026-10-26 (P3-A backfill — documentation only; code shipped in commit 8d9dc3e)

Backfilling the changelog for the P3-A integration tasks that shipped without a changelog entry:

- **3.1 Snapshot artifact + fail-closed loader**: `src/lib/gy/snapshot.json` — a committed `ConsoleSnapshotV1` artifact produced by `grave-indexer console-snapshot` (real mainnet Raydium V4 corpus; 12 of 118 supported WSOL pairs enriched; provenance, slot bounds, freshness budget, recorded per-pool failures), parsed by `src/lib/gy/snapshot.ts` with exhaustive validation (schema key-set, u64-as-decimal-string, base58, count consistency, honest pending-pinned C2/C4/C5/C6) that throws at module load on any violation. Missing activity renders as unavailable-with-note, never zero.
- **3.2 Program-ID guard**: `programIds.test.ts` pins the NS-2 devnet program IDs (GraveScanner `CuQZ…Ao54`, GraveVault `Bd5s…s7rg`), independently re-derives both `protocol_config` PDAs (bump 255), and negative-pins the retired DR-001 identities.
- **3.3 Live protocol pulse**: `src/lib/gy/protocolLive.ts` — raw devnet JSON-RPC `getAccountInfo` for both programs and their `ProtocolConfig` PDAs, Anchor-discriminator-checked, byte-exact hand-rolled decoders pinned by `protocolLive.test.ts`, fail-soft per program (unavailable is never substituted with defaults).
- **3.5 Structural freshness validation** (HEAD commit): `snapshot.test.ts` pins `generatedAtUnixMs` skew bounds, the exact 24 h `maxAgeMs` budget, and per-pool fetch-time ordering.

### Build + reliability — 2026-10-25 (Phase 1: type gate enforced, first CI, template cleanup)

Charter: stabilize build and test workflows without changing product behavior or weakening security controls. No UI, economic-estimate, or security behavior was modified — TypeScript-level fixes only (type target, icon alias, branded wallet name), plus removal of verified-dead template scaffolding.

Changes:

- **TypeScript build-error bypass removed.** `next.config.ts` carried `typescript.ignoreBuildErrors: true` since the template was scaffolded: every production build to date compiled the tree WITHOUT type checking. Removed; `bun run typecheck` (`tsc --noEmit`) added as a standalone gate, and `next build` now fails on type errors (negative-tested: a deliberate type error exits 1 with TS2322).
- **Real errors the bypass was hiding — fixed, zero behavior change:**
  - `tsconfig.json` target ES2017 vs 62 BigInt-literal sites (claims/fleet/graveyard/overview/data/estimator) → target raised to ES2020. The Solana/wallet stack is BigInt-native; Next transpiles per browserslist, so shipped runtime output is unchanged. Stale incremental cache (`tsconfig.tsbuildinfo`) had been masking the mismatch.
  - `fleet.tsx`: lucide-react's `Bot` icon collided with the domain type `Bot` (`@/lib/gy/types`) — TS2300 duplicate identifier + TS2749 use-as-type. Icon aliased to `BotIcon`.
  - `shell.tsx`: wallet-picker callback took a plain `string` where the adapter's `select()` requires branded `WalletName` (TS2345). Parameter typed `WalletName`; callers already pass `w.adapter.name` (branded upstream) — no cast needed.
  - `noImplicitAny` re-enabled (strict was on but the flag was silently `false`): passes with zero errors on the current tree.
- **Template scaffolding removed (each verified unreferenced before deletion):** the template `Hello, world!` API route (`src/app/api/route.ts`, zero `/api` references in `src/`), the Prisma stack (`src/lib/db.ts` singleton with zero importers; `prisma/schema.prisma` with only template User/Post models, zero `prisma.<model>` usage, no migrations, no datasource config) with its dependencies and `db:*` scripts, and the unused `z-ai-web-dev-sdk` dependency. Package renamed from the verbatim template name `nextjs_tailwind_shadcn_ts` to `graveyield-console`.
- **First CI workflow** (`.github/workflows/ci.yml`): frozen-lockfile install → `tsc --noEmit` → eslint → production build (typecheck enforced) → `bun audit` kept merge-blocking at zero findings. No unit test battery exists (Phase 0 record); the production build is the test.

Post-change verification: `bun install` green; `typecheck` green; `lint` green; production build green (all routes prerendered); `bun audit` — no vulnerabilities found.

### Security — 2026-10-25 (dependency triage: fleet override treatment)

Baseline: this repository had never been dependency-triaged (static-review-only in the Phase 0 audit, commit e34b1df in graveyield-protocol). Toolchain is bun (bun.lock); the tree consumes `@solana/web3.js` 1.99.0 and the wallet-adapter family, which carries the same `web3.js → jayson → uuid / stream-json` transitive chain patched in salvor-bots (32e913a) and graveyield-protocol (69ac241).

Changes:

- Added bun-style top-level `overrides` to package.json, floors identical to the fleet block used in salvor-bots and graveyield-protocol:
  - `toml >= 5.0.1` — documented no-op in this tree: `@coral-xyz/anchor` is not a dependency here, so toml is absent. Kept for fleet-wide override parity so future anchor adoption inherits the safe floor.
  - `uuid >= 11.1.1` — unified the split resolution (direct `^11.1.0` → 11.1.0, transitive via jayson → 8.3.2 vulnerable) into a single `uuid@14.0.3`. GHSA-w5hq-g745-h8pq (missing buffer bounds check) closed. No source in `src/` imports uuid directly; consumer is jayson's `require('uuid').v4`, runtime-verified on the 14.x line by the salvor-bots triage.
  - `stream-json >= 3.6.0` — 1.9.1 → 3.7.0. The three stream-json GHSAs (528h-pc64-c93x, hqr4-qq8f-hg3x, mjw6-4jj6-33hc) closed. 3.7.0 is the exact resolution runtime-verified by the salvor-bots triage.
- `jayson` itself unchanged (4.3.0); only its transitive subgraph moved.
- `bigint-buffer` accepted-risk (GHSA-3gc7-fjrx-p6mg) does not apply here: no `@solana/spl-token` / `@solana/buffer-layout-utils` path exists in this tree.

Evidence:

- `bun audit`: 110 findings (5 critical, 57 high, 42 moderate, 6 low) → 106 (5 critical, 57 high, 38 moderate, 6 low). The delta is exactly the 4 closed web3.js→jayson-chain advisories (uuid ×1, stream-json ×3).
- `bun install --frozen-lockfile` reproduces clean after re-resolution.
- `bun run build` (Next 16) green on the patched resolutions.
- Full before/after audit listings retained out-of-repo as engagement evidence (console_audit_BASELINE / console_audit_AFTER-OVERRIDES, 2026-10-25).

### Security — 2026-10-25 (criticals pass: next + next-auth, owner-approved)

- Owner approved a follow-up pass scoped to the 5 critical advisories, all carried by direct dependencies. Manifest floors raised (bun update semantics) and lockfile re-resolved:
  - `next ^16.1.1 → ^16.4.3` (resolved 16.1.3 → 16.4.3; advisory fix floor ≥16.2.5). Closes 4× unauthenticated RCE: image-optimization AVIF (GHSA-2xp9-vwfh-vxw4), image-optimization SVG (GHSA-2464-fhr4-w9xw), `use cache` functions returning typed arrays (GHSA-673q-mjm6-r5xr), Windows-hosted servers (GHSA-p293-qw3h-jr36).
  - `next-auth ^4.24.11 → ^4.24.15` (resolved 4.24.13 → 4.24.15; fix floor ≥4.24.15). Closes the Auth.js email-normalizer homoglyph `@` bypass (GHSA-7rqj-j65f-68wh).
- Tree check: the only installed `next` is 16.4.3, single copy. The remaining `@next/eslint-plugin-next@16.1.3` pin under eslint-config-next is the ESLint plugin (not the framework), carries no RCE surface, and is not audit-flagged; untouched in this pass.
- Evidence: `bun audit` 106 (5 critical, 57 high, 38 moderate, 6 low) → **62 (0 critical, 41 high, 19 moderate, 2 low)** — the 44-finding delta is the entire advisory set attached to the old next/next-auth versions. `bun install --frozen-lockfile` green; `bun run build` on Next 16.4.3 green (all routes prerendered). Audit listing retained out-of-repo (console_audit_AFTER-CRITICALS, 2026-10-25).

### Security — 2026-10-25 (full register triage: 62 findings → 0, owner-approved)

- Owner approved triage of the entire remaining register ("patch all valid vulns"). Outcome: `bun audit` **62 (0 critical, 41 high, 19 moderate, 2 low) → 0**. Every finding was traced to its consuming chain and patched; no accepted risks remain in this tree.

Triage ledger (all 24 packages):

| Package | Vulnerable resolution | Chain | Fixed to | Mechanism |
|---|---|---|---|---|
| ajv | 6.12.6 | eslint › eslintrc | 6.15.0 | override `>=6.14.0 <7` |
| brace-expansion | 1.1.12 | minimatch (eslint tree) | 1.1.21 | override `>=1.1.17 <2` |
| minimatch | 3.1.2 | eslintrc, ts-estree, 4 more | 3.1.5 | override `>=3.1.3 <4` |
| picomatch | 2.3.1 | @parcel/watcher, tinyglobby/fdir, jest/micromatch | 2.3.2 | override `>=2.3.2 <3` |
| postcss | 8.5.6 (+ next's exact 8.5.23) | @tailwindcss/postcss, next | 8.5.31 | override `>=8.5.23 <9` |
| nanoid | 3.3.11 | postcss | 3.3.20 | override `>=3.3.16 <4` |
| prismjs | 1.27.0 (refractor `~1.27` pin) | react-syntax-highlighter, @lexical/code | 1.30.0 | override `>=1.30.0 <2` |
| js-yaml | 4.1.1 (mdxeditor exact pin) | @mdxeditor, eslintrc | 4.3.2 | override `>=4.1.2 <5` |
| source-map-js | 1.2.1 | postcss chains | 1.2.2 | override `>=1.2.2 <2` |
| lodash | 4.17.21 | recharts | 4.18.1 | override `>=4.17.23 <5` |
| lodash-es | 4.17.22 | @reactuses/core | 4.18.1 | override `>=4.17.23 <5` |
| js-cookie | 3.0.5 | @reactuses/core | 3.0.8 | override `>=3.0.6 <4` |
| flatted | 3.3.3 | eslint › flat-cache | 3.4.4 | override `>=3.4.0 <4` |
| diff | 5.2.0 | @mdxeditor › unidiff, uvu | 5.2.2 | override `>=5.2.2 <6` |
| @babel/core | 7.28.6 | react-native codegen, metro ×5, react-hooks | 7.29.7 | override `>=7.29.1 <8` |
| browserslist | 4.28.1 | @babel/helper-compilation-targets | 4.29.4 | override `>=4.28.7 <5` |
| baseline-browser-mapping | 2.9.15 | next, browserslist chains | 2.11.32 | override `>=2.11.0 <3` |
| @humanfs/node | 0.16.7 | eslint | 0.16.8 | override `>=0.16.8 <0.17` |
| defu | 6.1.4 | prisma › @prisma/config › c12/giget/rc9 | 6.1.7 | override `>=6.1.5 <7` |
| effect | 3.18.4 (exact pin) | prisma › @prisma/config | 3.22.4 | override `>=3.20.0 <4` |
| deepmerge-ts | 7.1.5 (exact pin) | prisma › @prisma/config | 8.0.2 | override `>=8.0.0 <9` — see note |
| zod | 4.3.5 | DIRECT + eslint-plugin-react-hooks union spec | 4.6.7 | re-resolution + override `>=4.6.6 <5` |
| next-intl | 4.7.0 | DIRECT | 4.14.9 | in-range re-resolution |
| sharp | 0.34.5 | DIRECT + next | 0.35.5 | manifest bump `^0.35.5` |

Notes and trade-offs:

- **deepmerge-ts is the only cross-major force** (7 → 8). Upstream validates it: `@prisma/config` 7.10.1 pins 8.0.2. Runtime-verified here via `bunx prisma generate` (green) on `@prisma/config` 6.19.2.
- **bun 1.3.14 ignores npm-style scoped (nested) overrides** — the tree flattens to single resolutions. Cross-major consumers now run the older-but-patched majors: `@typescript-eslint/typescript-estree` on minimatch 3.1.5 (spec was ^9.0.5), `@parcel/watcher` + `tinyglobby` on picomatch 2.3.2 (spec was ^4.0.3). Verified functionally: `bun run build` and `bun run lint` (exit 0) exercise ts-estree, tinyglobby globbing, and the full eslint chain. Recorded as an accepted functional trade-off; re-triage if eslint tooling misbehaves on minimatch/picomatch APIs.
- The fleet's three original floors (toml/uuid/stream-json) are unchanged and toml remains a documented no-op here (no anchor in tree).
- bigint-buffer accepted-risk (GHSA-3gc7-fjrx-p6mg) does not apply: no spl-token/buffer-layout-utils path exists.

Evidence:

- `bun audit`: **0 vulnerabilities** (final listing retained out-of-repo as console_audit_FINAL, 2026-10-25; earlier stages: baseline 110 → 106 after fleet overrides → 62 after criticals pass → 0).
- `bun install --frozen-lockfile` reproduces clean (1267 installs, no changes).
- `bunx prisma generate` green; `bun run build` (Next 16.4.3) green, all routes prerendered; `bun run lint` green (exit 0).
