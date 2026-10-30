// Console snapshot CONTRACT — artifact-free, isomorphic (P4.1 Step 1).
//
// Everything in this module is pure: it validates and maps ConsoleSnapshotV1
// payloads without reading files, fetching URLs, or importing the committed
// artifact. That makes it safe to import from client code (the Graveyard
// re-validates every transport payload with the exact same fail-closed gate
// the server used) and from server-side transport code alike.
//
// The build-time committed artifact binding lives in snapshot.ts, which
// re-exports this module. Import from there only when you actually want the
// committed snapshot.json pulled into your bundle.
//
// Contract rules (unchanged since P3-A 3.1):
//   - FAIL-CLOSED: any missing/invalid required field throws SnapshotError.
//     A broken artifact can never silently render as data.
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
import type { Criterion, DataState, Pool } from "./types";

export type { DataState };

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

/**
 * Clock-skew tolerance for artifact timestamps. A generatedAt further in the
 * future than this is rejected by the transport (see snapshotSource.ts) — a
 * future-dated artifact would otherwise classify as fresh forever.
 */
export const SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/**
 * Map a snapshot pool onto the console's UI Pool type. Snapshotted pools are
 * truthfully in the "discovered" state; score is NOT fabricated (0) —
 * snapshot-mode views must sort by real quantities (TVL, last activity).
 * C2/C4/C5/C6 ride along as pending via `snapshotCriteria`.
 */
export function poolFromSnapshot(p: SnapshotPool, snap: ConsoleSnapshot): Pool {
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
    snapshotCriteria: { c1Inactivity: p.criteria.c1Inactivity, c3MinTvl: p.criteria.c3MinTvl },
    snapshotFingerprint: p.fingerprint,
    snapshotMeta: {
      generatedAtUnixMs: snap.generatedAtUnixMs,
      maxAgeMs: snap.freshness.maxAgeMs,
      fetchedAtUnixMs: p.fetchedAtUnixMs,
    },
    snapshotReserves: {
      wsolReserveLamports: p.wsolReserveLamports,
      memecoinReserveRaw: p.memecoinReserveRaw,
      lpSupplyRaw: p.lpSupplyRaw,
      lastSwap: p.lastSwap,
    },
  };
}

/** All snapshot pools mapped to UI pools, in the artifact's canonical order. */
export function snapshotPools(snap: ConsoleSnapshot): Pool[] {
  return snap.pools.map((p) => poolFromSnapshot(p, snap));
}

/**
 * Six-criteria rows for snapshot pools. Mirrors estimator.criteriaOf()'s
 * shape and thresholds, but the states come from the snapshot's honest
 * evaluation: C1/C3 as derived upstream, C2/C4/C5/C6 always "pending".
 */
export function snapshotCriteriaOf(pool: Pool, now: number, snap: ConsoleSnapshot): Criterion[] {
  const sc = pool.snapshotCriteria;
  if (!sc) throw new SnapshotError("snapshotCriteriaOf requires a snapshot-backed pool");
  const inactivityDays = Number(BigInt(snap.thresholds.inactivitySeconds) / 86_400n);
  const minTvlSol = Number(BigInt(snap.thresholds.minTvlLamports)) / 1e9;
  const daysSinceSwap =
    pool.lastSwapUnix > 0 ? Math.floor((now - pool.lastSwapUnix * 1000) / 86_400_000) : null;
  return [
    {
      id: "C1",
      name: "Trading inactivity",
      detail:
        "≥ 90 days since last swap. Evidence: indexer-derived from Raydium V4 history in the snapshot — the oracle-signed attestation is a later pipeline step.",
      threshold: `≥ ${inactivityDays} days`,
      state: sc.c1Inactivity,
      value: daysSinceSwap === null ? "unavailable" : `${daysSinceSwap} days`,
    },
    {
      id: "C2",
      name: "Price collapse from launch",
      detail:
        "Requires the oracle-attested launch price (init-once LaunchPrice PDA). Not derivable from this snapshot — pending, never estimated.",
      threshold: "≥ 9,900 bps",
      state: "pending",
      value: "not attested",
    },
    {
      id: "C3",
      name: "Minimum residual TVL",
      detail:
        "Quote-side (WSOL) vault balance must still clear the floor. Snapshot value read live from the pool's vault token account.",
      threshold: `≥ ${minTvlSol} SOL`,
      state: sc.c3MinTvl,
      value: `${Number(pool.quoteReserveLamports) / 1e9} SOL`,
    },
    {
      id: "C4",
      name: "LP supply not burned",
      detail:
        "Requires the original-supply baseline / burn-dust comparison. Snapshot carries the raw LP supply only — pending, never guessed.",
      threshold: "supply > dust threshold",
      state: "pending",
      value: `${pool.lpSupply.toLocaleString()} LP (raw)`,
    },
    {
      id: "C5",
      name: "No locked LP",
      detail:
        "Requires locker introspection (UNCX marker PDA) — LOCKER-002 keeps off-chain locker evidence out of v1. Pending.",
      threshold: "no locks",
      state: "pending",
      value: "not introspected",
    },
    {
      id: "C6",
      name: "Multi-epoch confirmation",
      detail:
        "Requires an on-chain EligibilityAnchor epoch gap (Phase 1 → Phase 2). No anchor exists for a discovered pool — pending.",
      threshold: "≥ 2 epochs",
      state: "pending",
      value: "no anchor",
    },
  ];
}
