// Console snapshot loader — the COMMITTED ARTIFACT binding (P3-A Task 3.1).
// The artifact is produced by `grave-indexer console-snapshot` (typed,
// secret-free, provenance-backed) and committed as src/lib/gy/snapshot.json.
//
// The contract itself (parseSnapshot, freshness math, UI mapping) lives in
// snapshotContract.ts — artifact-free and isomorphic, so the server transport
// (src/lib/gy/snapshotSource.ts, /api/gy/snapshot) and the client hydration
// path can reuse the exact same fail-closed gate without pulling the
// committed artifact into their bundle. Import THIS module only when you want
// the build-time committed artifact (tests, legacy fixture consumers).
//
// Contract rules:
//   - FAIL-CLOSED: any missing/invalid required field throws SnapshotError
//     at load time. A broken artifact can never silently render as data.
//   - The committed artifact itself is part of the test battery: if the
//     indexer-side contract drifts, the console test suite goes red here.
//   - P4.1 Step 1: the Graveyard no longer consumes this module at runtime —
//     it reads /api/gy/snapshot, which resolves a live artifact source
//     (GY_SNAPSHOT_URL or GY_SNAPSHOT_PATH). The committed artifact remains
//     the contract test seed and a local-development source.

import rawSnapshot from "./snapshot.json";

export {
  parseSnapshot,
  snapshotFreshness,
  snapshotDataState,
  poolFromSnapshot,
  snapshotPools,
  snapshotCriteriaOf,
  SnapshotError,
  SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS,
} from "./snapshotContract";
export type {
  ConsoleSnapshot,
  SnapshotPool,
  SnapshotCriteria,
  SnapshotLastSwap,
  PendingCriterion,
} from "./snapshotContract";
export type { DataState } from "./snapshotContract";

import { parseSnapshot, type ConsoleSnapshot } from "./snapshotContract";

/** The committed artifact — validated once at module load; failure is loud. */
export const SNAPSHOT: ConsoleSnapshot = parseSnapshot(rawSnapshot);

/** The raw committed payload, for tests that exercise validation paths. */
export const RAW_SNAPSHOT: unknown = rawSnapshot;
