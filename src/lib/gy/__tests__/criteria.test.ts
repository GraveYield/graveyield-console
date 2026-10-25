// Six-criteria evaluation logic (spec §4 table) — boundary behavior.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import { criteriaOf } from "../estimator";
import type { Pool } from "../types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed "now"

const pool = (over: Partial<Pool> = {}): Pool => ({
  address: "POOL1111111111111111111111111111111111111111",
  baseSymbol: "MEME",
  quoteSymbol: "WSOL",
  amm: "Raydium V4",
  quoteReserveLamports: 600_000_000n,
  baseReserve: 1_000_000n,
  baseDecimals: 6,
  lpSupply: 10_000_000,
  lastSwapUnix: Math.floor((NOW - 91 * DAY) / 1000),
  collapseBps: 9_900,
  lpBurned: false,
  lpLocked: false,
  state: "certification-ready",
  score: 0.8,
  anchorEpoch: 700,
  certExpiresAt: null,
  ...over,
});

const states = (p: Pool) => Object.fromEntries(criteriaOf(p, NOW).map((c) => [c.id, c.state]));

describe("criteriaOf", () => {
  test("all pass on a fully-eligible derelict pool", () => {
    expect(states(pool())).toEqual({
      C1: "pass",
      C2: "pass",
      C3: "pass",
      C4: "pass",
      C5: "pass",
      C6: "pass",
    });
  });

  test("C1 boundary: 89 days fails, 90 days passes", () => {
    expect(
      states(pool({ lastSwapUnix: Math.floor((NOW - 89 * DAY) / 1000) })).C1,
    ).toBe("fail");
    expect(
      states(pool({ lastSwapUnix: Math.floor((NOW - 90 * DAY) / 1000) })).C1,
    ).toBe("pass");
  });

  test("C3 boundary: one lamport under the 0.5 SOL floor fails", () => {
    expect(states(pool({ quoteReserveLamports: 499_999_999n })).C3).toBe("fail");
    expect(states(pool({ quoteReserveLamports: 500_000_000n })).C3).toBe("pass");
  });

  test("C2 collapse below 9900 bps fails; discovered pools stay pending", () => {
    expect(states(pool({ collapseBps: 9_899 })).C2).toBe("fail");
    expect(states(pool({ state: "discovered", anchorEpoch: null })).C2).toBe("pending");
  });

  test("C4/C5 hard fails: burned or locked LP", () => {
    expect(states(pool({ lpBurned: true })).C4).toBe("fail");
    expect(states(pool({ lpLocked: true })).C5).toBe("fail");
  });

  test("C6 pending until anchored and ≥ 2 epochs of gap", () => {
    expect(states(pool({ anchorEpoch: null })).C6).toBe("pending");
    expect(states(pool({ anchorEpoch: 712 })).C6).toBe("pending");
    expect(states(pool({ anchorEpoch: 711 })).C6).toBe("pass");
  });
});
