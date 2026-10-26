// Console snapshot loader — fail-closed reader for the indexer's
// ConsoleSnapshotV1 artifact (P3-A Task 3.1). The artifact is produced by
// `grave-indexer console-snapshot` (typed, secret-free, provenance-backed)
// and committed as src/lib/gy/snapshot.json.
//
// Contract rules:
//   - FAIL-CLOSED: any missing/invalid required field throws SnapshotError
//     at load time. A broken artifact can never silently render as data.
//   - The committed artifact itself is part of the test battery: if the
//     indexer-side contract drifts, the console test suite goes red here.
//   - Data states are explicit and honest end to end:
//       real        — from the snapshot, within its freshness budget
//       stale       — from the snapshot, past the freshness budget
//       unavailable — the indexer recorded the field as not derivable
//                     (e.g. last-swap failures) — never rendered as zero
//       simulated   — fixture data (data.ts), labelled by the shell badge
//   - Criteria honesty: only C1/C3 are evaluated upstream. C2/C4/C5/C6 are
//     hard-pinned "pending" by the indexer; the loader refuses any other
//     value so a future index cannot quietly invent evaluations.

import { shortAddr } from "./format";
import type { Pool } from "./types";
import rawSnapshot from "./snapshot.json";

export type DataState = "real" | "cached" | "stale" | "unavailable" | "simulated";

export type PendingCriterion = "pending";

export interface SnapshotCriteria {
  c1Inactivity: "pass" | "fail" | "pending";
  c3MinTvl: "pass" | "fail" | "pending";
  c2PriceCollapse: PendingCriterion;
  c4LpBurned: PendingCriterion;
  c5LpLocked: PendingCriterion;
  c6MultiEpoch: PendingCriterion;
}

export interface SnapshotLastSwap {
  unixTs: number;
  slot: number;
  signature: string;
}

export interface SnapshotPool {
  address: string;
  ammProgramId: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  wsolSide: { memecoinMint: string; coinIsWsol: boolean };
  /** u64 exact decimal strings — never numbers. */
  wsolReserveLamports: string;
  memecoinReserveRaw: string;
  memecoinDecimals: number;
  lpSupplyRaw: string;
  lastSwap: SnapshotLastSwap | null;
  criteria: SnapshotCriteria;
  fingerprint: string;
  fetchedAtUnixMs: number;
}

export interface ConsoleSnapshot {
  schemaVersion: 1;
  generatedAtUnixMs: number;
  cluster: string;
  indexerGitHead: string | null;
  provenance: {
    source: string;
    endpointKind: string;
    slotLowerBound: number;
    slotUpperBound: number;
    ordering: string;
    fingerprintPolicy: string;
  };
  freshness: { maxAgeMs: number };
  counts: { rawAccounts: number; parsedPools: number; supportedWsolPairs: number; enriched: number };
  failures: { stage: string; pool?: string; reason: string }[];
  thresholds: { inactivitySeconds: string; minTvlLamports: string };
  pools: SnapshotPool[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(`snapshot: ${message}`);
    this.name = "SnapshotError";
  }
}

const U64_RE = /^[0-9]+$/;
const U64_MAX = "18446744073709551615";
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new SnapshotError(`${what} must be a non-empty string`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new SnapshotError(`${what} must be a finite number`);
  return v;
}

function u64str(v: unknown, what: string): string {
  if (typeof v !== "string" || !U64_RE.test(v) || (v.length > 1 && v[0] === "0")) {
    throw new SnapshotError(`${what} must be an exact u64 decimal string, got ${JSON.stringify(v)}`);
  }
  // Numeric range check: compare by length first, then lexicographically.
  if (v.length > U64_MAX.length || (v.length === U64_MAX.length && v > U64_MAX)) {
    throw new SnapshotError(`${what} exceeds u64 range`);
  }
  return v;
}

function pubkey(v: unknown, what: string): string {
  const s = str(v, what);
  if (!PUBKEY_RE.test(s)) throw new SnapshotError(`${what} is not a base58 pubkey`);
  return s;
}

function criterionState(v: unknown, what: string): "pass" | "fail" | "pending" {
  if (v !== "pass" && v !== "fail" && v !== "pending") {
    throw new SnapshotError(`${what} must be pass|fail|pending`);
  }
  return v;
}

function pendingOnly(v: unknown, what: string): PendingCriterion {
  if (v !== "pending") throw new SnapshotError(`${what} must be "pending" (not derivable upstream)`);
  return "pending";
}

/** Parse and fully validate an untyped snapshot payload. Throws SnapshotError. */
export function parseSnapshot(raw: unknown): ConsoleSnapshot {
  if (!isObj(raw)) throw new SnapshotError("root must be an object");
  if (raw.schemaVersion !== 1) throw new SnapshotError(`schemaVersion must be 1, got ${JSON.stringify(raw.schemaVersion)}`);
  const generatedAtUnixMs = num(raw.generatedAtUnixMs, "generatedAtUnixMs");
  if (generatedAtUnixMs <= 0) throw new SnapshotError("generatedAtUnixMs must be positive");

  const cluster = str(raw.cluster, "cluster");
  const indexerGitHead = raw.indexerGitHead === null ? null : str(raw.indexerGitHead, "indexerGitHead");

  if (!isObj(raw.provenance)) throw new SnapshotError("provenance must be an object");
  const prov = raw.provenance;
  const provenance = {
    source: str(prov.source, "provenance.source"),
    endpointKind: str(prov.endpointKind, "provenance.endpointKind"),
    slotLowerBound: num(prov.slotLowerBound, "provenance.slotLowerBound"),
    slotUpperBound: num(prov.slotUpperBound, "provenance.slotUpperBound"),
    ordering: str(prov.ordering, "provenance.ordering"),
    fingerprintPolicy: str(prov.fingerprintPolicy, "provenance.fingerprintPolicy"),
  };
  if (provenance.slotLowerBound > provenance.slotUpperBound) {
    throw new SnapshotError("provenance slot bounds inverted");
  }

  if (!isObj(raw.freshness)) throw new SnapshotError("freshness must be an object");
  const maxAgeMs = num(raw.freshness.maxAgeMs, "freshness.maxAgeMs");
  if (maxAgeMs <= 0) throw new SnapshotError("freshness.maxAgeMs must be positive");

  if (!isObj(raw.counts)) throw new SnapshotError("counts must be an object");
  const counts = {
    rawAccounts: num(raw.counts.rawAccounts, "counts.rawAccounts"),
    parsedPools: num(raw.counts.parsedPools, "counts.parsedPools"),
    supportedWsolPairs: num(raw.counts.supportedWsolPairs, "counts.supportedWsolPairs"),
    enriched: num(raw.counts.enriched, "counts.enriched"),
  };

  if (!Array.isArray(raw.failures)) throw new SnapshotError("failures must be an array");
  const failures = raw.failures.map((f, i) => {
    if (!isObj(f)) throw new SnapshotError(`failures[${i}] must be an object`);
    return {
      stage: str(f.stage, `failures[${i}].stage`),
      pool: f.pool === undefined ? undefined : str(f.pool, `failures[${i}].pool`),
      reason: str(f.reason, `failures[${i}].reason`),
    };
  });

  if (!isObj(raw.thresholds)) throw new SnapshotError("thresholds must be an object");
  const thresholds = {
    inactivitySeconds: u64str(raw.thresholds.inactivitySeconds, "thresholds.inactivitySeconds"),
    minTvlLamports: u64str(raw.thresholds.minTvlLamports, "thresholds.minTvlLamports"),
  };

  if (!Array.isArray(raw.pools)) throw new SnapshotError("pools must be an array");
  const pools = raw.pools.map((p, i): SnapshotPool => {
    if (!isObj(p)) throw new SnapshotError(`pools[${i}] must be an object`);
    const address = pubkey(p.address, `pools[${i}].address`);
    let lastSwap: SnapshotLastSwap | null = null;
    if (p.lastSwap !== null) {
      if (!isObj(p.lastSwap)) throw new SnapshotError(`pools[${i}].lastSwap must be null or an object`);
      const ls = p.lastSwap;
      const unixTs = num(ls.unixTs, `pools[${i}].lastSwap.unixTs`);
      const slot = num(ls.slot, `pools[${i}].lastSwap.slot`);
      const signature = str(ls.signature, `pools[${i}].lastSwap.signature`);
      if (unixTs <= 0 || slot <= 0) throw new SnapshotError(`pools[${i}].lastSwap timestamps must be positive`);
      lastSwap = { unixTs, slot, signature };
    }
    if (!isObj(p.wsolSide)) throw new SnapshotError(`pools[${i}].wsolSide must be an object`);
    if (!isObj(p.criteria)) throw new SnapshotError(`pools[${i}].criteria must be an object`);
    const fetchedAtUnixMs = num(p.fetchedAtUnixMs, `pools[${i}].fetchedAtUnixMs`);
    if (fetchedAtUnixMs <= 0) throw new SnapshotError(`pools[${i}].fetchedAtUnixMs must be positive`);
    return {
      address,
      ammProgramId: pubkey(p.ammProgramId, `pools[${i}].ammProgramId`),
      baseMint: pubkey(p.baseMint, `pools[${i}].baseMint`),
      quoteMint: pubkey(p.quoteMint, `pools[${i}].quoteMint`),
      lpMint: pubkey(p.lpMint, `pools[${i}].lpMint`),
      wsolSide: {
        memecoinMint: pubkey(p.wsolSide.memecoinMint, `pools[${i}].wsolSide.memecoinMint`),
        coinIsWsol: typeof p.wsolSide.coinIsWsol === "boolean" ? p.wsolSide.coinIsWsol : (() => { throw new SnapshotError(`pools[${i}].wsolSide.coinIsWsol must be boolean`); })(),
      },
      wsolReserveLamports: u64str(p.wsolReserveLamports, `pools[${i}].wsolReserveLamports`),
      memecoinReserveRaw: u64str(p.memecoinReserveRaw, `pools[${i}].memecoinReserveRaw`),
      memecoinDecimals: num(p.memecoinDecimals, `pools[${i}].memecoinDecimals`),
      lpSupplyRaw: u64str(p.lpSupplyRaw, `pools[${i}].lpSupplyRaw`),
      lastSwap,
      criteria: {
        c1Inactivity: criterionState(p.criteria.c1Inactivity, `pools[${i}].criteria.c1Inactivity`),
        c3MinTvl: criterionState(p.criteria.c3MinTvl, `pools[${i}].criteria.c3MinTvl`),
        c2PriceCollapse: pendingOnly(p.criteria.c2PriceCollapse, `pools[${i}].criteria.c2PriceCollapse`),
        c4LpBurned: pendingOnly(p.criteria.c4LpBurned, `pools[${i}].criteria.c4LpBurned`),
        c5LpLocked: pendingOnly(p.criteria.c5LpLocked, `pools[${i}].criteria.c5LpLocked`),
        c6MultiEpoch: pendingOnly(p.criteria.c6MultiEpoch, `pools[${i}].criteria.c6MultiEpoch`),
      },
      fingerprint: str(p.fingerprint, `pools[${i}].fingerprint`),
      fetchedAtUnixMs,
    };
  });
  if (pools.length !== counts.enriched) {
    throw new SnapshotError(`counts.enriched (${counts.enriched}) != pools.length (${pools.length})`);
  }

  return {
    schemaVersion: 1,
    generatedAtUnixMs,
    cluster,
    indexerGitHead,
    provenance,
    freshness: { maxAgeMs },
    counts,
    failures,
    thresholds,
    pools,
  };
}

/** "fresh" within the artifact's own freshness budget, "stale" past it. */
export function snapshotFreshness(snap: ConsoleSnapshot, nowMs: number): "fresh" | "stale" {
  return nowMs - snap.generatedAtUnixMs <= snap.freshness.maxAgeMs ? "fresh" : "stale";
}

/** Artifact-level data state for badges: real within budget, stale past it. */
export function snapshotDataState(snap: ConsoleSnapshot, nowMs: number): DataState {
  return snapshotFreshness(snap, nowMs) === "fresh" ? "real" : "stale";
}

/** The committed artifact — validated once at module load; failure is loud. */
export const SNAPSHOT: ConsoleSnapshot = parseSnapshot(rawSnapshot);

/** The raw committed payload, for tests that exercise validation paths. */
export const RAW_SNAPSHOT: unknown = rawSnapshot;

/**
 * Map a snapshot pool onto the console's UI Pool type. Snapshotted pools are
 * truthfully in the "discovered" state; score is NOT fabricated (0) —
 * snapshot-mode views must sort by real quantities (TVL, last activity).
 * C2/C4/C5/C6 ride along as pending via `snapshotCriteria`.
 */
export function poolFromSnapshot(p: SnapshotPool, snap: ConsoleSnapshot): Pool & { dataSource: DataState; snapshotCriteria: SnapshotCriteria; snapshotFingerprint: string } {
  const lpSupplyBig = BigInt(p.lpSupplyRaw);
  if (lpSupplyBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SnapshotError(`pool ${p.address}: lpSupplyRaw exceeds JS safe-integer range`);
  }
  const note = p.lastSwap
    ? undefined
    : "Last activity not derivable in this snapshot run — shown as unavailable, not zero.";
  return {
    address: p.address,
    // Truthful labels: the quote side is WSOL by the 7019 guard; the base
    // side is identified by its mint (symbols would require an off-chain
    // registry — none is trusted here).
    baseSymbol: `mint:${shortAddr(p.baseMint, 4, 4)}`,
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: BigInt(p.wsolReserveLamports),
    baseReserve: BigInt(p.memecoinReserveRaw),
    baseDecimals: p.memecoinDecimals,
    lpSupply: Number(lpSupplyBig),
    lastSwapUnix: p.lastSwap?.unixTs ?? 0,
    collapseBps: 0, // pending upstream — never rendered as a real value
    lpBurned: false, // placeholder for estimator math; REAL state is snapshotCriteria.c4LpBurned ("pending")
    lpLocked: false, // placeholder for estimator math; REAL state is snapshotCriteria.c5LpLocked ("pending")
    state: "discovered",
    score: 0, // not fabricated — snapshot views sort by real quantities
    anchorEpoch: null,
    certExpiresAt: null,
    note,
    dataSource: snapshotDataState(snap, Date.now()),
    snapshotCriteria: p.criteria,
    snapshotFingerprint: p.fingerprint,
  };
}

/** All snapshot pools mapped to UI pools, in the artifact's canonical order. */
export function snapshotPools(snap: ConsoleSnapshot): Array<ReturnType<typeof poolFromSnapshot>> {
  return snap.pools.map((p) => poolFromSnapshot(p, snap));
}
