// Port of salvor-bots/fleet-core/src/estimator.ts (FLEET-M1) to the console.
// Same integer-only economics chain — no floating point touches a
// monetary quantity. Inputs are the pool-side facts the estimator consumes.

export interface EstimatorPoolInputs {
  coinReserve: bigint;
  pcReserve: bigint;
  lpSupply: bigint;
  coinMint: string;
  pcMint: string;
  wsolMint: string;
}

export interface EstimatorConfigInputs {
  salvorShareBps: number;
  maxSlippageBps: number;
  jupiterDustThresholdLamports: bigint;
}

export interface EstimatorCostInputs {
  priorityFeeBudgetLamports: bigint;
  signatureCount: number;
  frontedRentLamports: bigint;
  expectedFailureCostLamports?: bigint;
  lamportsPerSignature?: bigint;
}

export interface EconomicEstimate {
  status: "ok" | "reject";
  reason?: string;
  memecoinOut?: bigint;
  directWsolOut?: bigint;
  grossProceedsWsolLamports?: bigint;
  salvorGrossShareLamports?: bigint;
  costs?: {
    priorityFeeBudget: bigint;
    baseFees: bigint;
    frontedRent: bigint;
    expectedFailureCost: bigint;
    total: bigint;
  };
  netProfitLamports?: bigint;
  breakEvenGrossWsolLamports?: bigint;
  minQuoteOutputLamports?: bigint;
  effectiveSlippageBps?: number;
  swapLegBelowDust?: boolean;
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Exact port of estimateSalvageEconomics — proportional withdraw →
 * route conversion → D6 dust skip → live-share split → costs → break-even.
 */
export function estimateSalvageEconomics(opts: {
  pool: EstimatorPoolInputs;
  /** Memecoin → WSOL quote (input amount in memecoin base units, WSOL out in lamports). */
  quoteInAmount: bigint;
  quoteOutLamports: bigint;
  salvorLpAmount: bigint;
  config: EstimatorConfigInputs;
  costs: EstimatorCostInputs;
  slippageBpsOverride?: number | null;
  minNetProfitLamports: bigint;
}): EconomicEstimate {
  const { pool, config, costs } = opts;
  const BPS = 10_000n;

  if (pool.lpSupply === 0n) return reject("lp supply is zero — pool is beyond salvage");
  if (opts.salvorLpAmount === 0n) return reject("salvor holds no LP to burn");
  if (opts.salvorLpAmount > pool.lpSupply) return reject("salvor LP exceeds live supply");
  if (config.salvorShareBps <= 0) return reject("salvor share is 0 bps — never salvageable");

  // Orientation: exactly one WSOL side (the 7019 guard), derived not assumed.
  const coinIsWsol = pool.coinMint === pool.wsolMint;
  const pcIsWsol = pool.pcMint === pool.wsolMint;
  if (coinIsWsol === pcIsWsol) return reject("pool does not have exactly one WSOL side (7019 shape)");
  const memecoinReserve = coinIsWsol ? pool.pcReserve : pool.coinReserve;
  const wsolReserve = coinIsWsol ? pool.coinReserve : pool.pcReserve;

  // 1–2. Proportional withdraw (Raydium V4 remove-liquidity is linear).
  const burn = opts.salvorLpAmount;
  const memecoinOut = (memecoinReserve * burn) / pool.lpSupply;
  const directWsolOut = (wsolReserve * burn) / pool.lpSupply;

  // 3. Route conversion; below dust the on-chain leg is skipped (D6).
  let convertedWsol = 0n;
  let swapLegBelowDust = false;
  if (memecoinOut > 0n) {
    if (opts.quoteInAmount === 0n || opts.quoteOutLamports === 0n)
      return reject("route quote is empty — no executable conversion");
    if (opts.quoteInAmount > memecoinReserve) return reject("route quote input exceeds memecoin reserve");
    convertedWsol = (memecoinOut * opts.quoteOutLamports) / opts.quoteInAmount;
  }
  if (convertedWsol < config.jupiterDustThresholdLamports) {
    swapLegBelowDust = true;
    convertedWsol = 0n;
  }

  // 4. Gross proceeds + live salvor share.
  const grossProceeds = directWsolOut + convertedWsol;
  const salvorShare = (grossProceeds * BigInt(config.salvorShareBps)) / BPS;

  // 5. Costs — integers only.
  const perSignature = costs.lamportsPerSignature ?? 5_000n;
  const baseFees = perSignature * BigInt(Math.max(1, costs.signatureCount));
  const expectedFailureCost = costs.expectedFailureCostLamports ?? 0n;
  const totalCosts =
    costs.priorityFeeBudgetLamports + baseFees + costs.frontedRentLamports + expectedFailureCost;
  const netProfit = salvorShare - totalCosts;

  const shareBps = BigInt(config.salvorShareBps);
  const breakEvenGross =
    (totalCosts * BPS + shareBps - 1n) / (shareBps === 0n ? 1n : shareBps);

  const effectiveSlippageBps =
    opts.slippageBpsOverride !== undefined && opts.slippageBpsOverride !== null
      ? Math.min(opts.slippageBpsOverride, config.maxSlippageBps)
      : config.maxSlippageBps;
  const minQuoteOutput = (convertedWsol * BigInt(BPS - BigInt(effectiveSlippageBps))) / BPS;

  const estimate: EconomicEstimate = {
    status: "ok",
    memecoinOut,
    directWsolOut,
    grossProceedsWsolLamports: grossProceeds,
    salvorGrossShareLamports: salvorShare,
    costs: {
      priorityFeeBudget: costs.priorityFeeBudgetLamports,
      baseFees,
      frontedRent: costs.frontedRentLamports,
      expectedFailureCost,
      total: totalCosts,
    },
    netProfitLamports: netProfit,
    breakEvenGrossWsolLamports: breakEvenGross,
    minQuoteOutputLamports: minQuoteOutput,
    effectiveSlippageBps,
    swapLegBelowDust,
  };
  if (netProfit < opts.minNetProfitLamports) {
    estimate.reason = `net below operator minimum ${opts.minNetProfitLamports.toString()}`;
  }
  return estimate;
}

function reject(reason: string): EconomicEstimate {
  return { status: "reject", reason };
}

/**
 * Build the estimator's pool inputs from a UI Pool row (audit finding 5.11).
 *
 * The 7019 orientation guard compares MINT IDENTITIES — which must be real,
 * full mint addresses. A row's `baseSymbol` is a shortened DISPLAY label
 * (`mint:So11…1112` style) and can never be a mint address; passing it only
 * worked by accident (it could never equal wsolMint) and would silently
 * flip orientation if the label ever became one. Snapshot rows therefore
 * pass the snapshot's real memecoin mint (`snapshotMints.memecoinMint`,
 * orientation-independent by construction); fixture rows keep the
 * symbol-label passthrough (display-only rows, labeled simulated).
 *
 * Reserve interpretation is unchanged: `baseReserve` is the memecoin side
 * and `quoteReserveLamports` the WSOL side (the 7019 shape this console
 * models) — so "coin" carries the memecoin mint and "pc" WSOL.
 */
export function estimatorPoolInputs(pool: import("./types").Pool): EstimatorPoolInputs {
  return {
    coinReserve: pool.baseReserve,
    pcReserve: pool.quoteReserveLamports,
    lpSupply: BigInt(pool.lpSupply),
    coinMint: pool.snapshotMints ? pool.snapshotMints.memecoinMint : pool.baseSymbol,
    pcMint: WSOL_MINT,
    wsolMint: WSOL_MINT,
  };
}

/**
 * Optional live thresholds for criteriaOf (audit finding 5.10) — derived
 * from the GraveScanner ProtocolConfig the console already reads live
 * (protocolLive.fetchProtocolPulse → ScannerConfigLive), mirroring the
 * canonical on-chain evaluator's inputs. Every field is optional and
 * FAIL-SAFE: a missing, non-finite, or non-positive override falls back to
 * the canonical default below rather than poisoning a comparison with NaN.
 * A u64 config value read as a decimal string coerces with Number() — safe
 * for seconds/bps thresholds (far below 2^53).
 */
export interface CriteriaThresholdOverrides {
  /** Scanner ProtocolConfig `inactivity_seconds` (C1). Default 7,776,000 (90 days). */
  inactivitySeconds?: number;
  /** Scanner ProtocolConfig `price_collapse_bps` (C2). Default 9,900. */
  priceCollapseBps?: number;
  /** Scanner ProtocolConfig `min_tvl_lamports` (C3). Default 500,000,000 (0.5 SOL). */
  minTvlLamports?: bigint | number;
  /** Scanner ProtocolConfig `lp_burn_dust_threshold` (C4 DISPLAY ONLY). Default 1,000. */
  lpBurnDustThreshold?: bigint | number;
  /** C6 MIN_EPOCH_CONFIRMATION. Default 2. */
  minEpochConfirmation?: number;
}

/** Canonical spec defaults (grave-scanner criteria.rs / ProtocolConfig defaults). */
export const CRITERIA_THRESHOLDS_DEFAULTS = {
  inactivitySeconds: 7_776_000, // 90 days
  priceCollapseBps: 9_900,
  minTvlLamports: 500_000_000n, // 0.5 SOL
  lpBurnDustThreshold: 1_000n,
  minEpochConfirmation: 2,
} as const;

/** Fail-safe coercion: a broken/absent override falls back to the default. */
function thresholdOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Fail-safe bigint coercion (lamports-scale thresholds): non-finite,
 * negative, or fractional inputs fall back to the default, never NaN. */
function bigintOr(v: bigint | number | undefined, fallback: bigint): bigint {
  if (typeof v === "bigint") return v > 0n ? v : fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return BigInt(Math.floor(v));
  return fallback;
}

/**
 * Six-criteria evaluation for UI display — mirrors the spec §4 table.
 *
 * P4.2 (audit D6): the current epoch is an EXPLICIT input, never a baked-in
 * constant. The C6 epoch gap is only computed when the caller can name the
 * epoch it is evaluating against; `null` (or an omitted argument at runtime)
 * fails closed to a "pending" C6 with an explicit "current epoch
 * unavailable" value — a stale hardcoded epoch can never manufacture a
 * pass/fail, and the gap is never fabricated. Callers derive the epoch from
 * a truthful source (live getEpochInfo telemetry in the shell, or the test's
 * own named epoch); snapshot-backed rows never reach this function's C6 —
 * the indexer pins C6 "pending" upstream (snapshotCriteriaOf).
 *
 * Audit finding 5.10 (fail-closed activity evidence): `lastSwapUnix <= 0`
 * (or non-finite) means the activity evidence is UNAVAILABLE — the
 * indexer recorded no verified last swap — and must never establish
 * inactivity. The canonical on-chain evaluator never sees a zero timestamp
 * (the attestation gate rejects it, scanner error 6028), so a zero here
 * maps to C1 "pending · unavailable", exactly like snapshotCriteriaOf
 * renders missing evidence. Missing evidence never becomes a passing
 * criterion. Valid timestamps keep the integer-exact elapsed calculation.
 */
export function criteriaOf(
  pool: import("./types").Pool,
  now: number,
  currentEpoch: number | null,
  thresholds?: CriteriaThresholdOverrides,
): import("./types").Criterion[] {
  const inactivitySeconds = thresholdOr(thresholds?.inactivitySeconds, CRITERIA_THRESHOLDS_DEFAULTS.inactivitySeconds);
  const priceCollapseBps = thresholdOr(thresholds?.priceCollapseBps, CRITERIA_THRESHOLDS_DEFAULTS.priceCollapseBps);
  const minTvlLamports = bigintOr(thresholds?.minTvlLamports, CRITERIA_THRESHOLDS_DEFAULTS.minTvlLamports);
  const lpBurnDust = bigintOr(thresholds?.lpBurnDustThreshold, CRITERIA_THRESHOLDS_DEFAULTS.lpBurnDustThreshold);
  const minEpochConfirmation = thresholdOr(
    thresholds?.minEpochConfirmation,
    CRITERIA_THRESHOLDS_DEFAULTS.minEpochConfirmation,
  );

  // `now` is Date.now() (milliseconds); pool.lastSwapUnix is unix SECONDS.
  // The unit normalization is done here — a mixed-unit subtraction once
  // made C1 pass unconditionally (caught by the estimator battery).
  // lastSwapUnix <= 0 (or non-finite) is UNAVAILABLE evidence, never a
  // valid swap time — a zero would otherwise produce a huge elapsed value
  // and silently pass C1 (finding 5.10).
  const activityAvailable = Number.isFinite(pool.lastSwapUnix) && pool.lastSwapUnix > 0;
  const daysSinceSwap = activityAvailable
    ? Math.floor((now - pool.lastSwapUnix * 1000) / 86_400_000)
    : null;
  // Integer-exact: elapsed milliseconds vs seconds×1000 — no float division
  // enters the comparison (preserves the original boundary semantics).
  const c1Pass = activityAvailable && now - pool.lastSwapUnix * 1000 >= inactivitySeconds * 1000;
  const c2Pass = pool.collapseBps >= priceCollapseBps;
  const c3Pass = pool.quoteReserveLamports >= minTvlLamports;
  const c4Pass = !pool.lpBurned;
  const c5Pass = !pool.lpLocked;
  // D6 fail-closed: the gap exists only when BOTH ends of the subtraction
  // are known. No default epoch — a hardcoded constant here once evaluated
  // every pool against a number that could silently rot (audit D6).
  const knownEpoch = typeof currentEpoch === "number" && Number.isFinite(currentEpoch);
  const epochGap =
    pool.anchorEpoch === null || !knownEpoch ? null : (currentEpoch as number) - pool.anchorEpoch;
  const c6Pass = epochGap !== null && epochGap >= minEpochConfirmation;

  return [
    {
      id: "C1",
      name: "Trading inactivity",
      detail: "≥ 90 days since last swap. Evidence: 112-byte oracle-signed last-swap attestation verified in-transaction.",
      threshold: `≥ ${Math.floor(inactivitySeconds / 86_400)} days`,
      state: daysSinceSwap === null ? "pending" : c1Pass ? "pass" : "fail",
      value: daysSinceSwap === null ? "unavailable" : `${daysSinceSwap} days`,
    },
    {
      id: "C2",
      name: "Price collapse from launch",
      detail: "≥ 99% below the oracle-attested launch price (quote-per-base immediately before the first swap, init-once).",
      threshold: `≥ ${priceCollapseBps.toLocaleString()} bps`,
      state: pool.state === "discovered" ? "pending" : c2Pass ? "pass" : "fail",
      value: `${pool.collapseBps.toLocaleString()} bps`,
    },
    {
      id: "C3",
      name: "Minimum residual TVL",
      detail: "Quote-side vault balance must still clear the floor — a derelict pool must hold value worth settling.",
      threshold: `≥ ${Number(minTvlLamports) / 1e9} SOL`,
      state: c3Pass ? "pass" : "fail",
      value: `${Number(pool.quoteReserveLamports) / 1e9} SOL`,
    },
    {
      id: "C4",
      name: "LP supply not burned",
      detail: "LP mint supply must exceed the burn-dust threshold — nothing left to withdraw otherwise.",
      threshold: `supply > ${Number(lpBurnDust).toLocaleString()} LP`,
      state: c4Pass ? "pass" : "fail",
      value: pool.lpBurned ? "burned" : `${pool.lpSupply.toLocaleString()} LP`,
    },
    {
      id: "C5",
      name: "LP not locked",
      detail: "Zero locked LP — one locked smallest unit fails the pool. UNCX Raydium V4 marker checked in-transaction.",
      threshold: "locked = 0",
      state: c5Pass ? "pass" : "fail",
      value: pool.lpLocked ? "locked (UNCX marker)" : "no lock",
    },
    {
      id: "C6",
      name: "Multi-epoch confirmation",
      detail: "Phase 1 stamps the anchor; phase 2 can only certify ≥ 2 consecutive epochs later with an identical criteria bitmap.",
      threshold: `≥ ${minEpochConfirmation} epochs`,
      state: pool.anchorEpoch === null ? "pending" : epochGap === null ? "pending" : c6Pass ? "pass" : "pending",
      value:
        pool.anchorEpoch === null
          ? "no anchor"
          : epochGap === null
            ? "current epoch unavailable"
            : `${Math.max(0, epochGap)} / ${minEpochConfirmation} epochs`,
    },
  ];
}
