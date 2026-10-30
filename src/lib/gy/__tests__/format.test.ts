// Display formatters — the only place lamports may meet a float, and only
// for rendering. Grouped/short forms are pinned exactly.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import { resolvePools } from "../data";
import { criteriaOf } from "../estimator";

import {
  fmtSol,
  fmtNum,
  shortAddr,
  fmtDuration,
  fmtDays,
  fmtUtcClock,
  formatCollapseCell,
  formatIdleDaysCell,
  POOL_STATE_META,
} from "../format";

describe("fmtSol", () => {
  test("converts lamports at the last moment", () => {
    expect(fmtSol(1_500_000_000n)).toBe("1.5");
    expect(fmtSol(0n)).toBe("0");
    expect(fmtSol(1_234_567_890n, 4)).toBe("1.2346"); // rounds at maxFrac
    expect(fmtSol(500_000_000n)).toBe("0.5");
  });
});

describe("fmtNum", () => {
  test("groups thousands and honors maxFrac", () => {
    expect(fmtNum(1234567.891, 2)).toBe("1,234,567.89");
    expect(fmtNum(42)).toBe("42");
  });
});

describe("shortAddr", () => {
  test("head…tail with ellipsis; short strings pass through", () => {
    const a = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54";
    expect(shortAddr(a)).toBe("CuQZ…Ao54");
    expect(shortAddr(a, 6, 6)).toBe("CuQZes…kJAo54");
    expect(shortAddr("short")).toBe("short");
    expect(shortAddr("0123456789", 4, 4)).toBe("0123…6789");
  });
});

describe("fmtDuration", () => {
  test("expired for zero/negative; padded h/m/s branches", () => {
    expect(fmtDuration(0)).toBe("expired");
    expect(fmtDuration(-1)).toBe("expired");
    expect(fmtDuration(59_000)).toBe("59s");
    expect(fmtDuration(61_000)).toBe("1m 01s");
    expect(fmtDuration(3_600_000)).toBe("1h 00m");
    expect(fmtDuration((3 * 3600 + 5 * 60) * 1000)).toBe("3h 05m");
  });
});

describe("fmtDays", () => {
  test("years split at 365 with remainder", () => {
    expect(fmtDays(364)).toBe("364d");
    expect(fmtDays(365)).toBe("1y");
    expect(fmtDays(366)).toBe("1y 1d");
    expect(fmtDays(730)).toBe("2y");
  });
});

describe("fmtUtcClock", () => {
  test("UTC components, zero-padded, no locale drift", () => {
    expect(fmtUtcClock(new Date(Date.UTC(2026, 9, 25, 7, 8, 9)))).toBe("07:08:09");
    expect(fmtUtcClock(new Date(Date.UTC(2026, 9, 25, 23, 59, 5)))).toBe("23:59:05");
  });
});

describe("POOL_STATE_META", () => {
  test("every console pool state has display metadata", () => {
    for (const s of [
      "discovered",
      "filtered-out",
      "evaluated-ineligible",
      "waiting-epochs",
      "certification-ready",
      "certified",
      "salvaged",
    ]) {
      expect(POOL_STATE_META[s], `missing meta for state ${s}`).toBeDefined();
    }
  });
});

describe("formatIdleDaysCell (graveyard table Idle cell)", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0); // 2026-10-30 12:00:00 UTC, ms

  test("regression: lastSwapUnix 0 (activity not derivable) renders unavailable — never a fabricated day count", () => {
    // 11 of 12 committed snapshot pools carry lastSwap: null → mapped to 0.
    // The old cell math rendered these as ~20,754d.
    expect(formatIdleDaysCell(0, now)).toBe("unavailable");
    expect(formatIdleDaysCell(-5, now)).toBe("unavailable");
  });

  test("regression: unix-SECONDS input produces the correct day count (old cell subtracted seconds from Date.now())", () => {
    // Real committed snapshot row: lastSwap.unixTs = 1_759_460_872
    // (2025-10-03T05:47:52Z). The old math rendered ~20,715d; the correct
    // count to 2026-10-30 12:00 UTC is 392d.
    expect(formatIdleDaysCell(1_759_460_872, now)).toBe("392d");
  });

  test("clock skew clamps at zero days", () => {
    expect(formatIdleDaysCell(Math.floor(now / 1000), now)).toBe("0d");
  });

  test("Pool.lastSwapUnix contract: fixture resolver output is seconds, not ms", () => {
    // resolvePools() used to emit milliseconds, violating the documented
    // Pool contract and breaking estimator.criteriaOf's ×1000 C1 math for
    // every simulated row (C1 silently evaluated as fail).
    const pools = resolvePools();
    for (const p of pools) {
      // Unix seconds for any plausibly-current clock: 1.5e9 … 4e9
      // (ms values would be ≥ 1e12).
      expect(p.lastSwapUnix).toBeLessThan(4_000_000_000);
      expect(p.lastSwapUnix).toBeGreaterThan(1_500_000_000);
      // And the shared criteriaOf must see C1 as pass for the 98–268d-old
      // simulated swaps. (P4.2 D6: the current epoch is an explicit
      // argument — the fixture context has none to name, so null; C6 then
      // stays pending, which this C1 assertion is unaffected by.)
      const c1 = criteriaOf(p, Date.now(), null).find((c) => c.id === "C1");
      expect(c1?.state).toBe("pass");
    }
  });
});

describe("formatCollapseCell (graveyard table Collapse cell)", () => {
  test("regression: pending collapse renders an em-dash — never a fabricated 0.0%", () => {
    // Snapshot-derived rows pin collapseBps to 0 while C2 is pending
    // upstream; the old cell rendered that as 0.0%.
    expect(formatCollapseCell(0, true)).toBe("—");
    expect(formatCollapseCell(9_982, true)).toBe("—");
  });

  test("evaluated collapse renders percent at one decimal", () => {
    expect(formatCollapseCell(9_982, false)).toBe("99.8%");
    expect(formatCollapseCell(9_900, false)).toBe("99.0%");
    expect(formatCollapseCell(0, false)).toBe("0.0%");
  });
});
