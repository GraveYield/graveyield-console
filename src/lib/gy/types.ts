// GraveYield console domain types.
// Vocabulary is normative per docs/glossary.md: salvage / salvor /
// derelict pool. Never "rescue", never "dead pool".

export type CriterionId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

export interface Criterion {
  id: CriterionId;
  name: string;
  detail: string;
  threshold: string;
  /** "pass" | "fail" | "pending" — pending means not yet evaluable (C2/C6 pre-anchor). */
  state: "pass" | "fail" | "pending";
  value: string;
}

export type PoolState =
  | "discovered"
  | "filtered-out"
  | "evaluated-ineligible"
  | "waiting-epochs"
  | "certification-ready"
  | "certified"
  | "salvaged";

export interface Pool {
  address: string;
  baseSymbol: string;
  quoteSymbol: string;
  amm: "Raydium V4";
  /** quote-side reserve in lamports (WSOL side). */
  quoteReserveLamports: bigint;
  baseReserve: bigint;
  baseDecimals: number;
  lpSupply: number;
  /** Unix seconds of the last swap (C1 evidence via activity oracle). */
  lastSwapUnix: number;
  /** Q64.64 launch price is attested; UI carries the collapse in bps. */
  collapseBps: number;
  lpBurned: boolean;
  lpLocked: boolean;
  state: PoolState;
  /** Scout score = inactivityMargin × tvlMargin × priceCollapseMargin. */
  score: number;
  /** Epoch when the EligibilityAnchor was stamped (C6 clock start). */
  anchorEpoch: number | null;
  /** Cert expiry (unix seconds) when state === "certified". */
  certExpiresAt: number | null;
  anchorInvalidated?: boolean;
  note?: string;
  /** Data provenance (P3-A): set when this row comes from the indexer snapshot. */
  dataSource?: DataState;
  /** Snapshot-backed criteria states — present only on snapshot rows. */
  snapshotCriteria?: SnapshotPoolCriteria;
  /** sha256 fingerprint of the pool account payload behind this row. */
  snapshotFingerprint?: string;
  /** Artifact provenance: generated-at (unix ms) + freshness budget (ms). */
  snapshotMeta?: { generatedAtUnixMs: number; maxAgeMs: number; fetchedAtUnixMs: number };
  /** Reserve detail as exact raw strings from the snapshot (no display rounding). */
  snapshotReserves?: {
    wsolReserveLamports: string;
    memecoinReserveRaw: string;
    lpSupplyRaw: string;
    lastSwap: { unixTs: number; slot: number; signature: string } | null;
  };
}

/** Data-state vocabulary used across the console (P3-A). */
export type DataState = "real" | "cached" | "stale" | "unavailable" | "simulated";

/**
 * Snapshot-backed criteria states (P3-A): the indexer can only evaluate C1
 * (inactivity age) and C3 (WSOL reserve floor) from on-chain facts. C2 needs
 * an attested launch price, C4 an original-supply baseline, C5 locker
 * adapters (LOCKER-002), C6 anchor epochs — those stay "pending" upstream.
 */
export interface SnapshotPoolCriteria {
  c1Inactivity: "pass" | "fail" | "pending";
  c3MinTvl: "pass" | "fail" | "pending";
}

/** BotEvent feeds the Overview's simulated fleet-activity feed (labeled as
 * such). The Fleet view does not use it: since P4.3 it renders the real
 * FLEET_STATE_DIR trails via fleetContract.ts (FleetTrailEvent/FleetAlert). */
export interface BotEvent {
  id: number;
  ts: string;
  bot: string;
  kind: "discovery" | "evaluation" | "attestation" | "lifecycle" | "economics" | "settlement" | "guard" | "alert";
  text: string;
  level: "info" | "ok" | "warn";
}


export interface Invariant {
  id: string;
  title: string;
  detail: string;
  enforcement: "bytecode" | "multisig" | "process";
  error?: string;
}
