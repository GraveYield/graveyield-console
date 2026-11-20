# Console snapshot contract — schemaVersion 2 (D-01 M1-sourcing extension)

The GraveYield console renders pool data from an artifact produced by the
grave-indexer (`grave-indexer console-snapshot`, src/cli.ts →
`buildConsoleSnapshot`). This document defines the ConsoleSnapshot
**schemaVersion 2** contract: what the fields mean, what the console
validates, what it rejects, the v1 policy, and how the producer/consumer
pair stays in lockstep across two repositories.

- Producer: `GraveYield/grave-indexer` — `src/consoleSnapshot.ts` (builder),
  `src/consoleSnapshotParse.ts` (**normative fail-closed reader**, the source
  of truth for what "valid" means).
- Consumer: `GraveYield/graveyield-console` — `src/lib/gy/snapshotContract.ts`
  (`parseSnapshot`), `snapshotSource.ts` / `snapshotTransport.ts` (transport
  envelope), `snapshot.ts` (committed artifact binding).

## Version policy — strict v2-only (explicit decision)

The console accepts **only** `schemaVersion: 2`. This is a deliberate
decision (Option A), made because no verified operational requirement for a
v1-reading console exists:

- A **v1 artifact is rejected** with an actionable error that says exactly
  what to do (`Regenerate the artifact with a schema-v2 grave-indexer …`).
  It is **never silently reinterpreted as v2** — v1 lacks
  `coinMint`/`pcMint`/`m1Sourcing` and `counts.m1SourcingRejected`, so a
  reinterpretation would be unsound, and a v1 payload can never enter a
  sourcing-verified flow.
- A **missing, string-typed, or future schemaVersion** is rejected the same
  way ("this console accepts only schemaVersion 2").
- There is no dual validator, no v1 backfill, no v2-field synthesis for old
  artifacts. If a v1-reading deployment is ever genuinely required, that is
  a new, separately-reviewed decision (Option B: two independent
  validators, v1 never treated as sourcing-verified) — not a silent fallback.

Consequence for operators: **the console cannot consume v1 artifacts.** If
`/api/gy/snapshot` reports `corrupt / PARSE_FAILED` with a
`schemaVersion 1` reason, the serving artifact was produced by a
pre-v2 indexer — regenerate it (see below).

## The artifact (schemaVersion 2)

Top-level key set (exhaustive — unknown **and** missing keys are rejected):

| key | type / rule |
| --- | --- |
| `schemaVersion` | literal `2` |
| `generatedAtUnixMs` | positive finite number |
| `cluster` | `"mainnet-beta"` \| `"devnet"` |
| `indexerGitHead` | string \| `null` |
| `provenance` | `source` (`"raydium-v4-gpa"`), `endpointKind` (`public-rpc`\|`private-rpc`), `slotLowerBound` ≤ `slotUpperBound`, `ordering` (pinned `"ascending base58 pool address (reproducible)"`), `fingerprintPolicy` |
| `freshness` | `{ maxAgeMs: > 0 }` |
| `counts` | `rawAccounts`, `parsedPools`, `supportedWsolPairs`, `m1SourcingRejected`, `enriched` — all non-negative integers |
| `failures` | array of `{ stage, reason, pool? }` (pool optional, stage/reason required) |
| `thresholds` | `{ inactivitySeconds, minTvlLamports }` — exact u64 decimal strings |
| `pools` | array of pool records (below) |

Per-pool key set (exhaustive): `address`, `ammProgramId`, `coinMint`,
`pcMint`, `baseMint`, `quoteMint`, `lpMint`, `wsolSide`, `m1Sourcing`,
`wsolReserveLamports`, `memecoinReserveRaw`, `memecoinDecimals`,
`lpSupplyRaw`, `lastSwap` (`null` or `{ unixTs, slot, signature }`),
`criteria`, `fingerprint`, `fetchedAtUnixMs`. All pubkey fields are base58;
all amounts are exact u64 decimal strings (never numbers — JS loses
precision above 2^53); `memecoinDecimals` ∈ [0, 255].

## WSOL sourcing semantics (the v2 addition, D-01 / GY-M1-ODR-001 §3)

The indexer's M1 sourcing gate admits only pools whose WSOL side is the
**quote side** (Raydium `pc_mint`), with a non-WSOL memecoin on `coin_mint`.
Every pool that reaches the artifact has passed that predicate on-chain
facts, and the artifact carries the machine-checkable acceptance:

```
"m1Sourcing": { "eligible": true, "wsolSide": "pc_mint", "reason": null }
```

The console validates the sourcing fields **exactly as strictly as the
producer asserts them**:

- `coinMint` must be **non-WSOL** (WSOL on coin_mint is the rejected side —
  such pools appear in `failures[]` under stage `"m1-sourcing"`, never in
  `pools[]`);
- `pcMint` must be the **canonical WSOL mint**
  (`So11111111111111111111111111111111111111112` — one definition, shared
  with `estimator.ts`; the console keeps no second WSOL constant);
- `baseMint` must equal `coinMint`, `quoteMint` must equal `pcMint` (the
  builder's documented aliasing);
- `m1Sourcing` must be exactly the triple above — `eligible: false`, any
  other `wsolSide`, or a non-null `reason` rejects the artifact: a pool that
  did not pass the D-01 gate can never be in the pool list;
- `wsolSide` must agree with the orientation: `coinIsWsol === false` and
  `wsolSide.memecoinMint === coinMint`.

Any deviation rejects the whole artifact (`SnapshotError` → `corrupt` /
`PARSE_FAILED` envelope) — fail-closed, deterministic, with the offending
field named in the reason.

## Counts consistency (drift is a rejection)

- `counts.enriched === pools.length`;
- `counts.m1SourcingRejected ≤ counts.supportedWsolPairs`;
- `pools.length ≤ supportedWsolPairs − m1SourcingRejected` (enrichment
  failures may shrink the emitted list, never grow it);
- the number of `failures[]` entries with stage `"m1-sourcing"` equals
  `counts.m1SourcingRejected`, each carries a pool address, and no pool
  appears more than once there.

A count that drifts from the records it summarizes can never render as a
trustworthy total.

## Validation / rejection behaviour in the console

- Server: `resolveSnapshotSource` / `bytesToPayload` (`snapshotSource.ts`)
  parse every artifact before serving; a violation maps to the honest
  envelope `corrupt / unavailable / PARSE_FAILED` with the exact
  `SnapshotError` reason, and nothing rides along (`snapshot: null`). A
  future-dated artifact is refused as `FUTURE_GENERATED_AT`; a stale one is
  served but flagged — never presented as fresh.
- Client: `hydrateTransportPayload` (`snapshotTransport.ts`) re-runs the
  same fail-closed parser on any payload before a single byte is rendered —
  the client never trusts the server's parse.
- UI: a corrupt artifact renders the "snapshot corrupt / unavailable" state
  with the transport reason. It never crashes the app and never renders as
  data. The Protocol view surfaces `counts` (including
  `m1SourcingRejected`) and per-stage `failures` verbatim.

The console is **not** a new eligibility authority: schema validation here
proves the artifact is well-formed, internally consistent, and claims the
provenance it carries. GraveScanner remains the on-chain authority for
eligibility; nothing in this contract adds holder-level or cryptographic
guarantees.

## Regenerating a v1 artifact (operator path)

```
grave-indexer console-snapshot --data-dir <dir>   # emits <dir>/console-snapshot.json (schemaVersion 2)
```

Run it against a schema-v2 indexer build (PR #4 or later) with your own RPC;
then point the console at the output via `GY_SNAPSHOT_PATH` (self-hosted)
or publish it and set `GY_SNAPSHOT_URL` (serverless). See
`docs/snapshot-transport.md` for the transport topology.

## Producer/consumer lockstep (cross-repo mechanism)

There is **no shared npm package, JSON Schema file, or generated-types
artifact** between the two repositories — nothing to install, nothing to
drift silently. The contract is held together by four legs, all required:

1. **Normative reader** — indexer `src/consoleSnapshotParse.ts`. Any
   question about what "valid" means is answered there first.
2. **Consumer mirror** — console `snapshotContract.ts` re-implements the
   same rules (same key sets, sourcing validations, counts invariants) with
   deterministic `SnapshotError` messages. Its negative battery mirrors the
   reader's tests.
3. **Serializer-generated fixture + digest pin** — the committed
   `src/lib/gy/snapshot.json` is generated by the REAL indexer serializer
   (`buildConsoleSnapshot`), and
   `src/lib/gy/snapshot-fixture/PROVENANCE.md` pins the producer
   commit and the fixture sha256. `__tests__/snapshotV2Compat.test.ts`
   re-computes the digest and runs the fixture through the console's parser
   and full consumption path — drift in either direction fails the suite.
4. **Regeneration procedure** — documented in PROVENANCE.md
   (`src/lib/gy/snapshot-fixture/generate-fixture.ts`), executable
   against any sibling indexer checkout.

Any future schema change MUST bump `schemaVersion` and update all four legs
in the same review. A consumer must never silently reinterpret an artifact
it was not built for, and a producer must never ship a shape its normative
reader does not accept.

## Rollout / deployment order (no v2 into a v1-only console)

1. Ship this console (v2-accepting) first — it still accepts nothing but
   v2, so it is safe behind the next step.
2. Produce and verify a REAL v2 artifact end-to-end: serve it via
   `GY_SNAPSHOT_PATH`/`GY_SNAPSHOT_URL` and confirm
   `/api/gy/snapshot` answers `valid` (or `stale` past budget — both mean
   the contract gate passed) with the sourcing fields intact.
3. Confirm no environment points a v2-emitting indexer at an old
   v1-only console: a v1-only consumer would classify every v2 artifact
   `corrupt`. Deploy the console upgrade **before** switching indexer
   artifact output to v2 in any shared environment.
4. Only then enable v2 production emission on the indexer side.

If the console cannot be upgraded in some environment, the indexer's v2
rollout stays blocked for that environment — explicitly recorded in the
indexer's reader header note rather than papered over.
