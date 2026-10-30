// GraveYield console — protocol constants and simulated devnet-era telemetry.
//
// Every constant below is transcribed from the canonical sources:
//   - docs/PROTOCOL_SPEC.md §2–§4 (frozen architecture, six criteria)
//   - docs/whitepaper.md §3–§5 (criteria, 40/40/20, charter invariants)
//   - docs/error_codes.md (Scanner 6000–6034, Vault 7000–7022)
//   - docs/DEVNET.md (program IDs, NS-2 / DR-001 refresh of 2026-10-25)
//   - salvor-bots/README.md (the five-bot fleet)
// Pool telemetry and the Overview bot-event feed are SIMULATED fixtures;
// the top-bar badge says so. The Fleet view no longer consumes fixtures:
// since P4.3 it renders the salvor fleet's real FLEET_STATE_DIR trails
// through /api/gy/fleet (fleetContract/fleetTransport/fleetSource), or an
// honest unavailable state when no source is configured. No salvage has
// run on devnet yet — the salvaged-pool row exists to demonstrate the
// claims UI.

import type { BotEvent, ClaimPosition, Invariant, Pool } from "./types";

export const CLUSTER = "devnet" as const;

// Program IDs — NS-2 / DR-001 fresh devnet deployment (2026-10-25).
// Sources: graveyield-protocol docs/DEVNET.md, sdk/src/client.ts constants,
// and live-cluster verification (getAccountInfo on api.devnet.solana.com:
// both programs executable, both config PDAs owned by their programs,
// both bumps 255). The pre-refresh IDs (5JiCVx… / HUyoG5…) are the FROZEN
// DR-001 static reference — authority key dead, historical only; they must
// never reappear here (pinned by src/lib/gy/__tests__/programIds.test.ts).
export const PROGRAM_IDS = {
  graveScanner: "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54",
  graveVault: "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg",
  scannerConfigPda: "Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD",
  vaultConfigPda: "hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS",
  deployedAt: "2026-10-25",
} as const;

/** The frozen DR-001 static-reference deployment — must stay obsolete. */
export const RETIRED_PROGRAM_IDS = {
  graveScanner: "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
  graveVault: "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
} as const;

/** ProtocolConfig defaults (spec §4 + D-sets). */
export const CONFIG = {
  inactivitySeconds: 7_776_000, // C1 — 90 days
  priceCollapseBps: 9_900, // C2 — ≥99%
  minTvlLamports: 500_000_000n, // C3 — 0.5 SOL
  lpBurnDustThreshold: 1_000, // C4 — raw LP units
  minEpochConfirmation: 2, // C6 — consecutive epochs
  certTtlSeconds: 3_600, // 1 hour, floor 600s
  anchorStalenessSeconds: 1_209_600, // 14 days, floor 6 days
  sharesBps: { lpHolders: 4_000, salvor: 4_000, protocol: 2_000 },
  protocolShareCeilingBps: 2_000,
  maxSlippageBps: 300,
  timelockHours: 72,
  noticeDays: 7,
  emergencyTimelockHours: 24,
  postMortemDays: 5,
  multisig: "Squads v4 · 3-of-5 (→ 4-of-7 post-audit)",
} as const;

/** Research headline numbers (Ghost Pools WP-2026-001r4 / landing page). */
export const RESEARCH = {
  strandedSolanaBase: "$1.10B",
  strandedAllChainsBase: "$2.17B",
  strandedRange: "$0.86B – $5.4B",
  inventoryGrowth: "$400M / month",
  solanaTokensSince2024: "12M+",
} as const;

/** Fictional-but-shaped pool telemetry. Cert/anchor times resolve client-side. */
export const POOLS: Pool[] = [
  {
    address: "3nQfBvKzTc1ZderL1ctGRVxY9pUmWj7HQSbTGvpF4K2S",
    baseSymbol: "GRVE",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 4_812_345_678n,
    baseReserve: 9_214_500_000_000n,
    baseDecimals: 6,
    lpSupply: 98_412_771,
    lastSwapUnix: 0, // resolved relative to client clock (see resolvePools)
    collapseBps: 9_982,
    lpBurned: false,
    lpLocked: false,
    state: "certified",
    score: 0.94,
    anchorEpoch: 708,
    certExpiresAt: 0, // client-relative: + 41 min
    note: "Cert inside TTL — salvage window open. Executor bots may certify-and-salvage atomically.",
  },
  {
    address: "9xKePmDQw2sALV1ctGRVh8Lc4nRbTzG3YqS5FkPnM6Vd",
    baseSymbol: "PHNTM",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 2_204_118_004n,
    baseReserve: 71_804_300_000_000n,
    baseDecimals: 9,
    lpSupply: 41_902_318,
    lastSwapUnix: 0,
    collapseBps: 9_958,
    lpBurned: false,
    lpLocked: false,
    state: "certification-ready",
    score: 0.88,
    anchorEpoch: 706,
    certExpiresAt: null,
    note: "≥2-epoch gap elapsed, no cert exists. An executor should submit phase 2 now.",
  },
  {
    address: "Fg7YtR2WbV1ctGRVkQmS4dP8nXhZc3KjL9sAeUyH5TqB",
    baseSymbol: "WRLET",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 1_640_000_000n,
    baseReserve: 640_100_000_000n,
    baseDecimals: 6,
    lpSupply: 22_404_512,
    lastSwapUnix: 0,
    collapseBps: 9_941,
    lpBurned: false,
    lpLocked: false,
    state: "certification-ready",
    score: 0.81,
    anchorEpoch: 705,
    certExpiresAt: null,
  },
  {
    address: "Ck2PmN8xQV1ctGRVdRwT5hJ7bFyG4sZ9uLe3KaXmP6HqA",
    baseSymbol: "SMTHG",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 3_118_940_215n,
    baseReserve: 88_402_900_000_000n,
    baseDecimals: 9,
    lpSupply: 65_118_904,
    lastSwapUnix: 0,
    collapseBps: 9_934,
    lpBurned: false,
    lpLocked: false,
    state: "waiting-epochs",
    score: 0.77,
    anchorEpoch: 711,
    certExpiresAt: null,
    note: "Anchor stamped at epoch 711. Phase 2 unlocks at epoch 713.",
  },
  {
    address: "Hd4RtB6yWV1ctGRVsKpN2mQ8cXjF3vLb5zTgUe9KwR2nM",
    baseSymbol: "ASHES",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 912_774_331n,
    baseReserve: 12_940_800_000_000n,
    baseDecimals: 6,
    lpSupply: 15_770_221,
    lastSwapUnix: 0,
    collapseBps: 9_971,
    lpBurned: false,
    lpLocked: false,
    state: "waiting-epochs",
    score: 0.72,
    anchorEpoch: 712,
    certExpiresAt: null,
  },
  {
    address: "Aq9ZxE1uWV1ctGRVbNfK4tH7dRmJ6pCy2sXgQh8LtV3kF",
    baseSymbol: "RELIC",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 5_402_118_774n,
    baseReserve: 140_882_000_000_000n,
    baseDecimals: 9,
    lpSupply: 88_041_552,
    lastSwapUnix: 0,
    collapseBps: 4_120, // re-floated — current ≥ launch ⇒ 0-ish collapse
    lpBurned: false,
    lpLocked: false,
    state: "evaluated-ineligible",
    score: 0.31,
    anchorEpoch: null,
    certExpiresAt: null,
    note: "Hard fail C2 — pool re-floated against its attested launch baseline. Never submitted.",
  },
  {
    address: "Mw3KjH5rTV1ctGRVxQdS8nB4fYg7uLp2eZcRa9WmXk6hD",
    baseSymbol: "DUSTY",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 88_402_119n, // 0.088 SOL < 0.5 SOL floor
    baseReserve: 2_118_000_000_000n,
    baseDecimals: 6,
    lpSupply: 4_118_774,
    lastSwapUnix: 0,
    collapseBps: 9_996,
    lpBurned: false,
    lpLocked: false,
    state: "evaluated-ineligible",
    score: 0.18,
    anchorEpoch: null,
    certExpiresAt: null,
    note: "Hard fail C3 — residual TVL below the 0.5 SOL floor. Proceeds cannot justify settlement.",
  },
  {
    address: "Tb6VcN2pWV1ctGRVhKmX9fD3rJs4wQy7uGe5RtZ8Lc1nA",
    baseSymbol: "CHOKE",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 2_880_412_667n,
    baseReserve: 61_229_000_000_000n,
    baseDecimals: 9,
    lpSupply: 51_882_040,
    lastSwapUnix: 0,
    collapseBps: 9_947,
    lpBurned: false,
    lpLocked: true, // UNCX Raydium V4 marker present
    state: "filtered-out",
    score: 0.0,
    anchorEpoch: null,
    certExpiresAt: null,
    note: "Hard fail C5 — locked LP cannot be withdrawn by the salvor. LOCKER-001 evidence: UNCX marker.",
  },
  {
    address: "Zr8FdS4qXV1ctGRVtLwN6hB9gKm2yTp3vJdQc7UmE4xH5R",
    baseSymbol: "VNISH",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 1_902_774_002n,
    baseReserve: 44_190_700_000_000n,
    baseDecimals: 6,
    lpSupply: 33_918_004,
    lastSwapUnix: 0,
    collapseBps: 9_968,
    lpBurned: false,
    lpLocked: false,
    state: "discovered",
    score: 0.69,
    anchorEpoch: null,
    certExpiresAt: null,
    note: "Fresh candidate — C2 pending launch-price recording, C6 starts at phase 1.",
  },
  {
    address: "Lp5GhJ8wYV1ctGRVnRtK2mF6dXs9vQb4zHc7Wa3UeP1kTm",
    baseSymbol: "MOONX",
    quoteSymbol: "WSOL",
    amm: "Raydium V4",
    quoteReserveLamports: 12_402_118_004n,
    baseReserve: 402_118_000_000_000n,
    baseDecimals: 6,
    lpSupply: 190_442_118,
    lastSwapUnix: 0,
    collapseBps: 9_990,
    lpBurned: false,
    lpLocked: false,
    state: "salvaged",
    score: 0.97,
    anchorEpoch: 701,
    certExpiresAt: null,
    note: "Settled. SalvageReceipt on chain — LP claims open against the snapshot root, no expiry.",
  },
];

/** Relative time anchors resolved once per client session (hydration-safe). */
export const TIME_ANCHORS = {
  /** minutes from client t0 until the GRVE cert expires */
  certOneExpiryMinutes: 41,
  /** days ago for the most recent swap of each pool, keyed by index */
  lastSwapAgoDays: [214, 178, 191, 166, 121, 142, 205, 173, 98, 268],
} as const;

/** Resolve client-relative timestamps once per session. */
let t0: number | null = null;
export function resolvePools(): Pool[] {
  if (t0 === null) t0 = Date.now();
  return POOLS.map((p, i) => ({
    ...p,
    // Pool.lastSwapUnix is unix SECONDS per the type contract (the snapshot
    // loader stores seconds; estimator.criteriaOf normalizes ×1000). The
    // fixture resolver used to emit milliseconds, which quietly broke C1
    // evaluation for every simulated row and the graveyard idle-days cell.
    lastSwapUnix: Math.floor((t0 as number) / 1000 - TIME_ANCHORS.lastSwapAgoDays[i] * 86_400),
    certExpiresAt:
      p.state === "certified"
        ? (t0 as number) + TIME_ANCHORS.certOneExpiryMinutes * 60_000
        : p.certExpiresAt && p.certExpiresAt !== 0
          ? (t0 as number) + p.certExpiresAt * 1000
          : null,
  }));
}

/** P4.2 (audit D6): the fabricated `EPOCH` fixture constant was removed —
 * the console's current epoch is live `getEpochInfo` telemetry (see
 * protocolLive.ts), and criteriaOf takes the epoch as an explicit argument.
 * The per-pool anchorEpoch values below remain simulated fixture history. */

const initialEvents: BotEvent[] = [
  { id: 1, ts: "12:02:11", bot: "scout", kind: "discovery", text: "Cycle #412 — enumerated 1,284 Raydium V4 AmmInfo accounts (752-byte layout)", level: "info" },
  { id: 2, ts: "12:02:19", bot: "scout", kind: "evaluation", text: "Pre-filter: 37 candidates — 1,247 rejected (C1/C3/C4/C5 wide funnel)", level: "info" },
  { id: 3, ts: "12:03:02", bot: "scout", kind: "attestation", text: "C1 last-swap attestation issued for PHNTM — 112-byte wire, slot-fresh", level: "ok" },
  { id: 4, ts: "12:04:47", bot: "scout", kind: "lifecycle", text: "GRVE certificate live — expires_at in 41 min. Opportunity published (salvageable)", level: "ok" },
  { id: 5, ts: "12:05:30", bot: "conservative", kind: "economics", text: "Estimator: GRVE gross 4.31 SOL → salvor share 1.72 SOL, net +1.61 SOL after D3 fee plan", level: "ok" },
  { id: 6, ts: "12:06:12", bot: "sniper", kind: "economics", text: "Urgency batch reordered — GRVE cert expiry soonest, position #1", level: "info" },
  { id: 7, ts: "12:07:44", bot: "experimental", kind: "guard", text: "Dry-run enforced — sandbox fee budget cap 0.01 SOL per opportunity", level: "info" },
  { id: 8, ts: "12:09:03", bot: "monitor", kind: "settlement", text: "Receipt reconciliation MOONX: 40/40/20 exact — 4.98 / 4.98 / 2.49 SOL", level: "ok" },
  { id: 9, ts: "12:11:26", bot: "scout", kind: "lifecycle", text: "WRLET epoch gap elapsed — state → certification-ready", level: "ok" },
  { id: 10, ts: "12:13:58", bot: "scout", kind: "evaluation", text: "RELIC double-check: C2 hard fail (re-floated vs launch baseline) — never submitted", level: "warn" },
  { id: 11, ts: "12:15:09", bot: "scout", kind: "guard", text: "Charter guard: priority fee plan within on-chain ceiling — tx accepted for admission", level: "info" },
  { id: 12, ts: "12:17:41", bot: "monitor", kind: "alert", text: "Devnet oracles unpointed — attestation-signed submissions read-only until re-pointed", level: "warn" },
];

export const INITIAL_EVENTS: BotEvent[] = initialEvents;

/** Client-side generator pool — the Overview feed appends one of these every
 * few seconds. SIMULATED and labeled as such; the Fleet view does not read
 * it (P4.3 moved the Fleet view to real FLEET_STATE_DIR ingestion). */
export const EVENT_GENERATOR: Omit<BotEvent, "id" | "ts">[] = [
  { bot: "scout", kind: "discovery", text: "Cycle — getProgramAccounts scan complete, cache hit rate 98.4%", level: "info" },
  { bot: "scout", kind: "evaluation", text: "SMTHG reserves re-read — quote vault 3.12 SOL, still ≥ floor", level: "info" },
  { bot: "scout", kind: "lifecycle", text: "ASHES anchor epoch 712 — confirmation gap ticking (2 required)", level: "info" },
  { bot: "conservative", kind: "economics", text: "Estimator: PHNTM break-even gross 0.051 SOL — margin 41.6×", level: "ok" },
  { bot: "sniper", kind: "lifecycle", text: "Watching GRVE cert TTL — urgency score rising", level: "info" },
  { bot: "monitor", kind: "settlement", text: "lp_holder_pool_vault audit: unsweepable, debit path claim-only", level: "ok" },
  { bot: "scout", kind: "attestation", text: "C2 launch-price attestation verified — VNISH baseline 0.000418 WSOL", level: "ok" },
  { bot: "experimental", kind: "economics", text: "Sandbox trial: slippage override 250 bps (≤ config max 300)", level: "info" },
  { bot: "monitor", kind: "alert", text: "Anomaly sweep clean — 0 unverified receipts, 0 fee over-ceilings", level: "ok" },
  { bot: "scout", kind: "evaluation", text: "DUSTY re-check — C3 still below 0.5 SOL floor, remains out of scope", level: "warn" },
];


export const CHARTER_INVARIANTS: Invariant[] = [
  { id: "INV-1", title: "The 20% share is a ceiling", detail: "A config update that tries to raise the protocol share is rejected. Governance may lower it — never raise it.", enforcement: "bytecode", error: "7005 · ProtocolShareExceedsCeiling" },
  { id: "INV-2", title: "The LP vault is unsweepable", detail: "lp_holder_pool_vault cannot be swept, closed or drained by any admin key. Only claim_lp_proceeds debits it.", enforcement: "bytecode", error: "7006 · LpHolderPoolUnsweepable" },
  { id: "INV-3", title: "Claims survive an emergency pause", detail: "Holders can always claim from a completed salvage — claim_lp_proceeds stays live while everything else is gated.", enforcement: "bytecode" },
  { id: "INV-4", title: "One settlement per pool, ever", detail: "PoolRegistry and SalvageReceipt are init-once on the same pool PDA. A second salvage_pool reverts before any lamports move.", enforcement: "bytecode" },
  { id: "INV-5", title: "72h timelock on parameter changes", detail: "All config updates queue through Squads v4 transaction buffers with a 72-hour timelock.", enforcement: "multisig" },
  { id: "INV-6", title: "7-day public notice on upgrades", detail: "Standard program upgrades carry a seven-day public notice period before execution.", enforcement: "process" },
  { id: "INV-7", title: "24h timelock + 5-day post-mortem", detail: "Emergency upgrades demand a 24-hour timelock and a public five-day post-mortem.", enforcement: "process" },
  { id: "INV-8", title: "Multisig custody, staged", detail: "Squads v4 3-of-5 at launch, scaling to 4-of-7 after the independent audit.", enforcement: "multisig" },
  { id: "INV-9", title: "No token, NFT, points, airdrop, or staking", detail: "At any layer, at any time. The protocol mints nothing and sells nothing.", enforcement: "process" },
  { id: "INV-10", title: "No discretion in distribution", detail: "Eligibility is six objective on-chain criteria; the split is a formula. The protocol takes none — the salvor takes none either.", enforcement: "process" },
];

/** Demo claim snapshot for the settled pool (simulated). */
export const CLAIM_SNAPSHOT = {
  poolAddress: "Lp5GhJ8wYV1ctGRVnRtK2mF6dXs9vQb4zHc7Wa3UeP1kTm",
  poolLabel: "MOONX / WSOL",
  vaultBalanceLamports: 12_470_118_044n, // 12.47 SOL in lp_holder_pool_vault
  root: "8fKd21qYbVxwR7mT4cE9sHj5NpU2aGz6XkL3wQrBvDyM",
  snapshotSlot: 331_902_118,
  holders: 47,
} as const;

export const DEMO_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export const CLAIM_POSITIONS: ClaimPosition[] = [
  {
    poolAddress: CLAIM_SNAPSHOT.poolAddress,
    poolLabel: CLAIM_SNAPSHOT.poolLabel,
    holder: DEMO_WALLET,
    balanceAtSnapshot: 41_882_114,
    shareBps: 219,
    claimableLamports: 273_095_585n,
    claimed: false,
    proofDepth: 6,
    root: CLAIM_SNAPSHOT.root,
  },
  {
    poolAddress: CLAIM_SNAPSHOT.poolAddress,
    poolLabel: CLAIM_SNAPSHOT.poolLabel,
    holder: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
    balanceAtSnapshot: 118_004_772,
    shareBps: 617,
    claimableLamports: 769_404_284n,
    claimed: false,
    proofDepth: 6,
    root: CLAIM_SNAPSHOT.root,
  },
  {
    poolAddress: CLAIM_SNAPSHOT.poolAddress,
    poolLabel: CLAIM_SNAPSHOT.poolLabel,
    holder: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJL",
    balanceAtSnapshot: 8_440_118,
    shareBps: 44,
    claimableLamports: 54_868_519n,
    claimed: true,
    proofDepth: 6,
    root: CLAIM_SNAPSHOT.root,
  },
];
