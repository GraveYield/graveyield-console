// Economic estimator battery for the console port (FLEET-M1 lineage).
// The console signature is flat (quote in/out + LP amount inline, rejects
// carry `reason` strings) — these vectors pin the console surface AND the
// integer economics shared with salvor-bots/fleet-core's estimator.test.ts.
// Lamports and base units are bigint end to end; no float may touch them.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import {
  estimateSalvageEconomics,
  WSOL_MINT,
  type EstimatorPoolInputs,
} from "../estimator";

// A healthy derelict fixture: 10M LP supply; salvor burns 1M (10%).
const POOL: EstimatorPoolInputs = {
  coinReserve: 1_000_000n, // memecoin, coin side
  pcReserve: 5_000_000_000n, // 5 WSOL, pc side
  lpSupply: 10_000_000n,
  coinMint: "MEME11111111111111111111111111111111111111",
  pcMint: WSOL_MINT,
  wsolMint: WSOL_MINT,
};
const ROUTE = { quoteInAmount: 1_000_000n, quoteOutLamports: 4_000_000_000n }; // 1 meme → 4 WSOL
const CONFIG = {
  salvorShareBps: 4_000,
  maxSlippageBps: 300,
  jupiterDustThresholdLamports: 666_666n,
};
const COSTS_ZERO = {
  priorityFeeBudgetLamports: 0n,
  signatureCount: 1,
  frontedRentLamports: 0n,
  lamportsPerSignature: 0n,
};
const COSTS_BASE_FEE = {
  priorityFeeBudgetLamports: 0n,
  signatureCount: 1,
  frontedRentLamports: 0n,
}; // 1 × 5_000 lamports default

const run = (over: Partial<Parameters<typeof estimateSalvageEconomics>[0]> = {}) =>
  estimateSalvageEconomics({
    pool: POOL,
    quoteInAmount: ROUTE.quoteInAmount,
    quoteOutLamports: ROUTE.quoteOutLamports,
    salvorLpAmount: 1_000_000n,
    config: CONFIG,
    costs: COSTS_ZERO,
    minNetProfitLamports: 0n,
    ...over,
  });

describe("estimateSalvageEconomics (console port)", () => {
  test("proportional withdraw + route conversion + live 40% share (integer exact)", () => {
    const est = run();
    expect(est.status).toBe("ok");
    // memecoin out = 10% of 1M = 100_000 base units.
    expect(est.memecoinOut).toBe(100_000n);
    // direct WSOL = 10% of 5 WSOL = 500_000_000 lamports.
    expect(est.directWsolOut).toBe(500_000_000n);
    // converted = (100_000 × 4_000_000_000) / 1_000_000 = 400_000_000.
    expect(est.grossProceedsWsolLamports).toBe(900_000_000n);
    // salvor share 40% = 360_000_000.
    expect(est.salvorGrossShareLamports).toBe(360_000_000n);
    expect(est.netProfitLamports).toBe(360_000_000n);
  });

  test("the default base fee (5_000 lamports per signature) is priced in", () => {
    const est = run({ costs: COSTS_BASE_FEE });
    expect(est.costs?.baseFees).toBe(5_000n);
    expect(est.netProfitLamports).toBe(359_995_000n);
  });

  test("break-even gross and min-output floor are integer-exact", () => {
    const est = run({
      costs: {
        priorityFeeBudgetLamports: 100_000n,
        signatureCount: 2,
        frontedRentLamports: 50_000n,
        lamportsPerSignature: 5_000n,
        expectedFailureCostLamports: 10_000n,
      },
    });
    expect(est.status).toBe("ok");
    // costs = 100_000 + 2×5_000 + 50_000 + 10_000 = 170_000.
    expect(est.costs?.total).toBe(170_000n);
    // break-even gross = ceil(170_000 × 10_000 / 4_000) = 425_000.
    expect(est.breakEvenGrossWsolLamports).toBe(425_000n);
    // floor = 400_000_000 × (10_000−300)/10_000 = 388_000_000.
    expect(est.minQuoteOutputLamports).toBe(388_000_000n);
    expect(est.effectiveSlippageBps).toBe(300);
  });

  test("strategy slippage override tightens below the config max, never widens", () => {
    const tighter = run({ slippageBpsOverride: 100 });
    expect(tighter.effectiveSlippageBps).toBe(100);
    expect(tighter.minQuoteOutputLamports).toBe(396_000_000n);

    const widened = run({ slippageBpsOverride: 5_000 });
    expect(widened.effectiveSlippageBps).toBe(300);
  });

  test("net below the operator minimum keeps status ok but carries the reason", () => {
    const est = run({
      costs: {
        priorityFeeBudgetLamports: 500_000_000n,
        signatureCount: 1,
        frontedRentLamports: 0n,
      },
    });
    expect(est.status).toBe("ok");
    expect(est.reason).toContain("net below operator minimum");
  });

  test("dust: conversion below the dust threshold is excluded from proceeds and flagged", () => {
    const est = run({
      quoteInAmount: 1_000_000n,
      quoteOutLamports: 5_000_000n, // 10% → 500_000 lamports < 666_666 dust
    });
    expect(est.status).toBe("ok");
    expect(est.swapLegBelowDust).toBe(true);
    expect(est.grossProceedsWsolLamports).toBe(500_000_000n);
    expect(est.minQuoteOutputLamports).toBe(0n);
  });

  test("mirror orientation (WSOL on the coin side) prices identically", () => {
    const est = run({
      pool: {
        ...POOL,
        coinMint: WSOL_MINT,
        pcMint: POOL.coinMint,
        coinReserve: POOL.pcReserve,
        pcReserve: POOL.coinReserve,
      },
    });
    expect(est.status).toBe("ok");
    expect(est.grossProceedsWsolLamports).toBe(900_000_000n);
  });

  test("rejects: no WSOL side, zero supply, zero LP, LP > supply, zero share", () => {
    expect(
      run({ pool: { ...POOL, pcMint: "USDC11111111111111111111111111111111111111" } }).reason,
    ).toContain("7019");
    expect(run({ pool: { ...POOL, lpSupply: 0n } }).status).toBe("reject");
    expect(run({ salvorLpAmount: 0n }).status).toBe("reject");
    expect(run({ salvorLpAmount: 10_000_001n }).status).toBe("reject");
    expect(run({ config: { ...CONFIG, salvorShareBps: 0 } }).status).toBe("reject");
  });

  test("rejects: empty route quote when the memecoin leg exists", () => {
    expect(run({ quoteInAmount: 0n, quoteOutLamports: 0n }).status).toBe("reject");
  });
});
