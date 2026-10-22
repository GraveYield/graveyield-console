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
}

export interface Bot {
  id: string;
  name: string;
  pkg: string;
  role: string;
  description: string;
  mode: "dry-run" | "live" | "read-only";
  status: "nominal" | "standby" | "watching";
  stats: { label: string; value: string }[];
  events: BotEvent[];
}

export interface BotEvent {
  id: number;
  ts: string;
  bot: string;
  kind: "discovery" | "evaluation" | "attestation" | "lifecycle" | "economics" | "settlement" | "guard" | "alert";
  text: string;
  level: "info" | "ok" | "warn";
}

export interface ClaimPosition {
  poolAddress: string;
  poolLabel: string;
  holder: string;
  /** LP balance at snapshot (raw). */
  balanceAtSnapshot: number;
  /** Holder share of the pool's LP supply at snapshot, in bps. */
  shareBps: number;
  /** Claimable lamports from lp_holder_pool_vault. */
  claimableLamports: bigint;
  claimed: boolean;
  proofDepth: number;
  root: string;
}

export interface Invariant {
  id: string;
  title: string;
  detail: string;
  enforcement: "bytecode" | "multisig" | "process";
  error?: string;
}
