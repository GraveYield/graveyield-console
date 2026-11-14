// Six-criteria evaluation logic (spec §4 table) — boundary behavior.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import { criteriaOf } from "../estimator";
import type { Pool } from "../types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed "now"
/* P4.2 (audit D6): the current epoch is an explicit criteriaOf argument.
   800 is an arbitrary named test epoch — nothing in the estimator owns an
   epoch constant anymore, so every C6 case below is expressed relative to
   NOW_EPOCH. */
const NOW_EPOCH = 800;

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
  anchorEpoch: 798,
  certExpiresAt: null,
  ...over,
});

const states = (p: Pool, currentEpoch: number | null = NOW_EPOCH) =>
  Object.fromEntries(criteriaOf(p, NOW, currentEpoch).map((c) => [c.id, c.state]));

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

  test("C6 pending until anchored and ≥ 2 epochs of gap (explicit current epoch)", () => {
    expect(states(pool({ anchorEpoch: null })).C6).toBe("pending");
    // gap = NOW_EPOCH - anchor: 1 → pending, 2 → pass, 5 → pass.
    expect(states(pool({ anchorEpoch: NOW_EPOCH - 1 })).C6).toBe("pending");
    expect(states(pool({ anchorEpoch: NOW_EPOCH - 2 })).C6).toBe("pass");
    expect(states(pool({ anchorEpoch: NOW_EPOCH - 5 })).C6).toBe("pass");
    const c6 = criteriaOf(pool({ anchorEpoch: NOW_EPOCH - 5 }), NOW, NOW_EPOCH).find(
      (c) => c.id === "C6",
    );
    expect(c6?.value).toBe("5 / 2 epochs");
  });

  test("D6 fail-closed: unknown current epoch keeps C6 pending — the gap is never fabricated", () => {
    const anchored = pool({ anchorEpoch: 798 });
    const c6 = criteriaOf(anchored, NOW, null).find((c) => c.id === "C6");
    expect(c6?.state).toBe("pending");
    expect(c6?.value).toBe("current epoch unavailable");
    // Runtime robustness: an omitted argument must behave like null, never
    // resurrect a baked-in epoch default.
    const omitted = criteriaOf(anchored, NOW, undefined as unknown as null).find(
      (c) => c.id === "C6",
    );
    expect(omitted?.state).toBe("pending");
    expect(omitted?.value).toBe("current epoch unavailable");
    // Non-integer / non-finite epochs are equally unusable.
    expect(
      criteriaOf(anchored, NOW, Number.NaN).find((c) => c.id === "C6")?.state,
    ).toBe("pending");
  });
});

/* ── Fail-closed activity evidence (audit finding 5.10) ─────────────────
 * The canonical on-chain evaluator never sees a zero last-swap timestamp —
 * the oracle attestation gate rejects it (scanner error 6028). The console
 * criteriaOf must honor the same invariant: missing/unavailable activity
 * evidence can never establish inactivity, so C1 fails CLOSED to "pending"
 * instead of computing a huge elapsed value from a zero timestamp. */
describe("criteriaOf — unavailable activity evidence never passes C1 (audit finding 5.10)", () => {
  test("lastSwapUnix = 0 is 'unavailable', never a 20,000-day pass", () => {
    const c1 = criteriaOf(pool({ lastSwapUnix: 0 }), NOW, NOW_EPOCH).find((c) => c.id === "C1")!;
    expect(c1.state).toBe("pending");
    expect(c1.value).toBe("unavailable");
    // The elapsed value is never fabricated from the zero timestamp.
    expect(c1.value).not.toContain("days");
  });

  test("negative timestamps are equally unavailable", () => {
    const c1 = criteriaOf(pool({ lastSwapUnix: -42 }), NOW, NOW_EPOCH).find((c) => c.id === "C1")!;
    expect(c1.state).toBe("pending");
    expect(c1.value).toBe("unavailable");
  });

  test("non-finite timestamps (NaN / Infinity) are unavailable", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const c1 = criteriaOf(pool({ lastSwapUnix: bad }), NOW, NOW_EPOCH).find((c) => c.id === "C1")!;
      expect(c1.state).toBe("pending");
      expect(c1.value).toBe("unavailable");
    }
  });

  test("valid recent activity still fails C1 — the guard never manufactures passes OR fails", () => {
    const c1 = criteriaOf(pool({ lastSwapUnix: Math.floor((NOW - 1 * DAY) / 1000) }), NOW, NOW_EPOCH).find(
      (c) => c.id === "C1",
    )!;
    expect(c1.state).toBe("fail");
    expect(c1.value).toBe("1 days");
  });

  test("boundary: exactly at the threshold passes; one second under fails (integer-exact)", () => {
    const threshold = 90 * DAY / 1000; // 7,776,000 s
    const pass = criteriaOf(pool({ lastSwapUnix: Math.floor(NOW / 1000) - threshold }), NOW, NOW_EPOCH).find(
      (c) => c.id === "C1",
    )!;
    expect(pass.state).toBe("pass");
    const fail = criteriaOf(pool({ lastSwapUnix: Math.floor(NOW / 1000) - threshold + 1 }), NOW, NOW_EPOCH).find(
      (c) => c.id === "C1",
    )!;
    expect(fail.state).toBe("fail");
  });

  test("thresholds derived from live config change the C1 boundary; broken values fall back to defaults", () => {
    // Live config: 1-hour inactivity (3600 s) — a 2-hour-old swap passes.
    const twoHoursAgo = Math.floor(NOW / 1000) - 7_200;
    const live = criteriaOf(pool({ lastSwapUnix: twoHoursAgo }), NOW, NOW_EPOCH, {
      inactivitySeconds: 3_600,
    }).find((c) => c.id === "C1")!;
    expect(live.state).toBe("pass");
    expect(live.threshold).toBe("≥ 0 days"); // 3600 s is sub-day; floor is honest
    // Default (no override): the same swap is 90-day-stale-fail... no — it
    // FAILS because 2 hours < 90 days.
    const def = criteriaOf(pool({ lastSwapUnix: twoHoursAgo }), NOW, NOW_EPOCH).find((c) => c.id === "C1")!;
    expect(def.state).toBe("fail");
    // Broken overrides (NaN / 0 / negative / non-finite) never poison the
    // comparison — they fall back to the canonical 90-day default.
    for (const broken of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const c1 = criteriaOf(pool({ lastSwapUnix: twoHoursAgo }), NOW, NOW_EPOCH, {
        inactivitySeconds: broken,
      }).find((c) => c.id === "C1")!;
      expect(c1.state).toBe("fail");
      expect(c1.threshold).toBe("≥ 90 days");
    }
  });

  test("C3/C6 thresholds honor live config values with fail-safe fallbacks", () => {
    // C3 with a live 1-SOL floor: 0.6 SOL fails (passes at the 0.5 default).
    expect(
      criteriaOf(pool({ quoteReserveLamports: 600_000_000n }), NOW, NOW_EPOCH, { minTvlLamports: 1_000_000_000n }).find(
        (c) => c.id === "C3",
      )!.state,
    ).toBe("fail");
    expect(
      criteriaOf(pool({ quoteReserveLamports: 600_000_000n }), NOW, NOW_EPOCH, { minTvlLamports: 0 }).find(
        (c) => c.id === "C3",
      )!.state,
    ).toBe("pass"); // broken override → canonical 0.5 SOL default
    // C6 with MIN_EPOCH_CONFIRMATION = 3: gap 2 is pending, gap 3 passes.
    expect(
      criteriaOf(pool({ anchorEpoch: NOW_EPOCH - 2 }), NOW, NOW_EPOCH, { minEpochConfirmation: 3 }).find(
        (c) => c.id === "C6",
      )!.state,
    ).toBe("pending");
    expect(
      criteriaOf(pool({ anchorEpoch: NOW_EPOCH - 3 }), NOW, NOW_EPOCH, { minEpochConfirmation: 3 }).find(
        (c) => c.id === "C6",
      )!.state,
    ).toBe("pass");
  });

  test("C4 semantics verified against the canonical evaluator (supply > dust_threshold, strict)", () => {
    // Canonical: criteria.rs — require!(lp_supply > thresholds.lp_burn_dust_threshold)
    // with ProtocolConfig lp_burn_dust_threshold default 1,000 (strict >).
    // The console models C4 via the lpBurned placeholder for fixture rows and
    // pins C4 "pending" upstream for snapshot rows (snapshotCriteriaOf); the
    // DISPLAYED threshold tracks the live config value without changing the
    // boolean state semantics.
    const c4 = criteriaOf(pool(), NOW, NOW_EPOCH, { lpBurnDustThreshold: 7_000n }).find((c) => c.id === "C4")!;
    expect(c4.threshold).toBe("supply > 7,000 LP");
    expect(c4.state).toBe("pass"); // lpBurned: false (boolean model unchanged)
    expect(criteriaOf(pool({ lpBurned: true }), NOW, NOW_EPOCH).find((c) => c.id === "C4")!.state).toBe("fail");
    // Default text still matches the canonical 1,000 default.
    expect(criteriaOf(pool(), NOW, NOW_EPOCH).find((c) => c.id === "C4")!.threshold).toBe("supply > 1,000 LP");
  });
});
