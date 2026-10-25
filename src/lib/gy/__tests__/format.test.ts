// Display formatters — the only place lamports may meet a float, and only
// for rendering. Grouped/short forms are pinned exactly.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import {
  fmtSol,
  fmtNum,
  shortAddr,
  fmtDuration,
  fmtDays,
  fmtUtcClock,
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
