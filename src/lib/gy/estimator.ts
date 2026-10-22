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

/** Six-criteria evaluation for UI display — mirrors the spec §4 table. */
export function criteriaOf(
  pool: import("./types").Pool,
  now: number,
): import("./types").Criterion[] {
  const daysSinceSwap = Math.floor((now - pool.lastSwapUnix) / 86_400_000);
  const c1Pass = daysSinceSwap >= 90;
  const c2Pass = pool.collapseBps >= 9_900;
  const c3Pass = pool.quoteReserveLamports >= 500_000_000n;
  const c4Pass = !pool.lpBurned;
  const c5Pass = !pool.lpLocked;
  const epochGap = pool.anchorEpoch === null ? null : 713 - pool.anchorEpoch;
  const c6Pass = epochGap !== null && epochGap >= 2;

  return [
    {
      id: "C1",
      name: "Trading inactivity",
      detail: "≥ 90 days since last swap. Evidence: 112-byte oracle-signed last-swap attestation verified in-transaction.",
      threshold: "≥ 90 days",
      state: c1Pass ? "pass" : "fail",
      value: `${daysSinceSwap} days`,
    },
    {
      id: "C2",
      name: "Price collapse from launch",
      detail: "≥ 99% below the oracle-attested launch price (quote-per-base immediately before the first swap, init-once).",
      threshold: "≥ 9,900 bps",
      state: pool.state === "discovered" ? "pending" : c2Pass ? "pass" : "fail",
      value: `${pool.collapseBps.toLocaleString()} bps`,
    },
    {
      id: "C3",
      name: "Minimum residual TVL",
      detail: "Quote-side vault balance must still clear the floor — a derelict pool must hold value worth settling.",
      threshold: "≥ 0.5 SOL",
      state: c3Pass ? "pass" : "fail",
      value: `${Number(pool.quoteReserveLamports) / 1e9} SOL`,
    },
    {
      id: "C4",
      name: "LP supply not burned",
      detail: "LP mint supply must exceed the burn-dust threshold — nothing left to withdraw otherwise.",
      threshold: "supply > 1,000 LP",
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
      threshold: "≥ 2 epochs",
      state: pool.anchorEpoch === null ? "pending" : c6Pass ? "pass" : "pending",
      value: pool.anchorEpoch === null ? "no anchor" : `${Math.max(0, epochGap ?? 0)} / 2 epochs`,
    },
  ];
}
