# Committed snapshot fixture — provenance

`src/lib/gy/snapshot.json` is a **schemaVersion 2 console-snapshot artifact
produced by the real grave-indexer serializer** — the production
`buildConsoleSnapshot()` code path that `grave-indexer console-snapshot`
(src/cli.ts) uses to emit console-snapshot.json artifacts. It is NOT a
hand-constructed object shaped like the artifact.

## What is real, what is synthetic

- **Real:** the serializer, its fail-closed assertions, the exact JSON it
  emits (bit-for-bit). The fixture therefore pins the producer/consumer
  contract boundary: schemaVersion 2, the exhaustive key sets, the D-01
  M1-sourcing fields (`coinMint` non-WSOL / `pcMint` canonical WSOL /
  `m1Sourcing: { eligible: true, wsolSide: "pc_mint", reason: null }`),
  `counts.m1SourcingRejected`, the `failures[]` ↔ count consistency, exact
  u64 decimal strings, canonical pool ordering.
- **Synthetic (deliberately, and honestly labelled here):** pool addresses,
  mints, vault amounts and failure records are deterministic synthetic
  pubkeys/values (seeded via the indexer's test fixtures) with fixed
  timestamps. No Solana RPC was contacted, no cluster was read, no key
  material exists anywhere in the pipeline. **This fixture is a contract
  test seed and a local-development source — it is not real mainnet pool
  data and must never be deployed as a production artifact.** The previous
  (v1) committed artifact carried a real mainnet corpus; a v2 corpus
  requires a real indexer run, which is outside what offline work may do.
  Operators produce real artifacts with `grave-indexer console-snapshot`
  against their own RPC and serve them via GY_SNAPSHOT_URL / GY_SNAPSHOT_PATH.

## Pinned producer version

| field | value |
| --- | --- |
| repo | GraveYield/grave-indexer |
| commit | `21793db2418c0d4e0867ad2b5aa45c29d99b2a49` (feat/m1-wsol-quote-side-sourcing, PR #4 head) |
| serializer | `src/consoleSnapshot.ts` `buildConsoleSnapshot` |
| schemaVersion emitted | 2 |

## Current fixture digest

```
sha256(snapshot.json) = d1ceab2bf9bf79d2e7a267323c1235e96271761a9c3ce562b25483887b4904f7
```

The compat test (`src/lib/gy/__tests__/snapshotV2Compat.test.ts`) re-computes
this digest and fails if the committed fixture drifts without a deliberate
regeneration — an accidental contract change cannot slip through silently.

## Regeneration procedure

```sh
# from a grave-indexer checkout at the pinned SHA (deps installed), with the
# console as a sibling checkout:
cd /path/to/graveyield-console
GY_INDEXER_CHECKOUT=/path/to/grave-indexer \
  bun src/lib/gy/snapshot-fixture/generate-fixture.ts
# then update the sha256 line above and the pinned commit row.
```

The script is deterministic (fixed timestamps, seeded synthetic keys), so a
regeneration at the same pinned indexer SHA is bit-identical modulo the
indexer contract itself changing — which is exactly what the digest pin is
there to catch.

## Contract-sharing mechanism (producer ↔ consumer)

There is no shared npm package or JSON Schema artifact between the two
repositories. The contract is pinned by:

1. **Normative reader:** grave-indexer `src/consoleSnapshotParse.ts` — the
   fail-closed v2 reader, the source of truth for what "valid" means.
2. **Consumer mirror:** the console `src/lib/gy/snapshotContract.ts`
   `parseSnapshot()` — re-implements the same rules (same key sets, same
   sourcing validations, same counts invariants) against the console's own
   `SnapshotError`/transport envelope. Its negative battery mirrors the
   indexer reader's tests.
3. **Serializer-generated fixture + digest pin:** this fixture (produced by
   the real builder) plus the sha256 pin above — the compat test fails on
   drift in either direction.
4. **Regeneration procedure** documented here, executable against any
   sibling indexer checkout.

Any future schema change MUST bump schemaVersion and update all four legs
(indexer reader + console mirror + regenerated fixture + provenance) — a
consumer must never silently reinterpret an artifact it was not built for.
