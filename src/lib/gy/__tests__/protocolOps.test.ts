// P4.5 — protocolOps battery: the pure helpers behind the Protocol view's
// live operations — oracle presence/parity (facts only, never rotation
// claims) and the live-vs-spec config comparison.

import { describe, expect, test } from "bun:test";

import {
  isRegisteredPubkey,
  oracleParity,
  specCheck,
  specCheckTone,
  ZERO_PUBKEY_BASE58,
} from "../protocolOps";
import type { ScannerConfigLive, VaultConfigLive } from "../protocolLive";

const AUTH = "Authority11111111111111111111111111111111111";
const OTHER = "OtherKey111111111111111111111111111111111111";
const ORACLE_A = "OracleA111111111111111111111111111111111111";
const ORACLE_B = "OracleB111111111111111111111111111111111111";

function scanner(over: Partial<ScannerConfigLive> = {}): ScannerConfigLive {
  return {
    authority: AUTH,
    pendingAuthority: ZERO_PUBKEY_BASE58,
    inactivitySeconds: "7776000",
    priceCollapseBps: 9900,
    minTvlLamports: "500000000",
    anchorStalenessSeconds: "1209600",
    lpBurnDustThreshold: "1000",
    certTtlSeconds: "3600",
    paused: false,
    activityOracle: ORACLE_A,
    launchPriceOracle: ORACLE_A,
    bump: 255,
    ...over,
  };
}

function vault(over: Partial<VaultConfigLive> = {}): VaultConfigLive {
  return {
    authority: AUTH,
    lpHolderShareBps: 4000,
    salvorShareBps: 4000,
    protocolShareBps: 2000,
    maxPriorityFeeCeilingLamports: "3000000",
    maxSlippageBps: 300,
    jupiterDustThresholdLamports: "10000",
    timelockSeconds: "259200",
    emergencyPaused: false,
    bump: 255,
    ...over,
  };
}

describe("registered-key detection", () => {
  test("a zeroed 32-byte key is a placeholder, not a registered oracle", () => {
    expect(ZERO_PUBKEY_BASE58.length).toBe(32);
    expect(/^1+$/.test(ZERO_PUBKEY_BASE58)).toBe(true);
    expect(isRegisteredPubkey(ZERO_PUBKEY_BASE58)).toBe(false);
    expect(isRegisteredPubkey("")).toBe(false);
    expect(isRegisteredPubkey(OTHER)).toBe(true);
    expect(isRegisteredPubkey(null)).toBe(false);
    expect(isRegisteredPubkey(undefined)).toBe(false);
  });
});

describe("oracleParity — presence/parity as facts", () => {
  test("both oracles registered and equal to the authority (the documented devnet shape)", () => {
    const p = oracleParity(scanner({ activityOracle: AUTH, launchPriceOracle: AUTH }), vault());
    expect(p.activityEqualsScannerAuthority).toBe(true);
    expect(p.launchEqualsScannerAuthority).toBe(true);
    expect(p.activityEqualsLaunch).toBe(true);
    expect(p.crossProgramAuthorityEqual).toBe(true);
    expect(p.activityOracleRegistered).toBe(true);
    expect(p.launchOracleRegistered).toBe(true);
    expect(p.summary).toContain("both oracle keys are registered");
    expect(p.summary).toContain("both equal the scanner config authority");
    expect(p.summary).toContain("share one key");
    // The honesty boundary, in the sentence itself:
    expect(p.summary).toContain("authority-side process");
  });

  test("a zeroed oracle reads as unregistered — never as absent-from-config", () => {
    const p = oracleParity(scanner({ launchPriceOracle: ZERO_PUBKEY_BASE58 }), vault());
    expect(p.launchOracleRegistered).toBe(false);
    expect(p.summary).toContain("unregistered (zeroed) placeholder");
  });

  test("differing oracles are reported as differing — both directions stay facts", () => {
    const p = oracleParity(scanner({ launchPriceOracle: ORACLE_B }), vault({ authority: OTHER }));
    expect(p.activityEqualsLaunch).toBe(false);
    expect(p.crossProgramAuthorityEqual).toBe(false);
    expect(p.summary).toContain("differs from the scanner config authority");
  });

  test("an unavailable config read yields null comparisons — unknown, never false", () => {
    const p = oracleParity(null, null);
    expect(p.activityEqualsScannerAuthority).toBeNull();
    expect(p.launchEqualsScannerAuthority).toBeNull();
    expect(p.activityEqualsLaunch).toBeNull();
    expect(p.crossProgramAuthorityEqual).toBeNull();
    expect(p.activityOracleRegistered).toBeNull();
    expect(p.summary).toContain("unavailable");
  });
});

describe("specCheck — live-vs-spec classification", () => {
  test("match ignores display formatting (grouping commas, units)", () => {
    expect(specCheck("C1", "7,776,000 s (90 days)", "7776000", "7776000").status).toBe("match");
    expect(specCheck("shares", "4000 / 4000 / 2000 bps", "400040002000", "4000 / 4000 / 2000 bps").status).toBe("match");
  });

  test("differs is reported, never normalized away", () => {
    const r = specCheck("max slippage", "300 bps", "300", "150");
    expect(r.status).toBe("differs");
    expect(r.live).toBe("150");
    expect(specCheckTone(r.status)).toBe("warn");
  });

  test("unavailable keeps the reference visible and the live cell empty", () => {
    const r = specCheck("C1", "7,776,000 s (90 days)", "7776000", null);
    expect(r.status).toBe("unavailable");
    expect(r.live).toBeNull();
    expect(r.reference).toBe("7,776,000 s (90 days)");
    expect(specCheckTone(r.status)).toBe("muted");
  });

  test("match tones", () => {
    expect(specCheckTone("match")).toBe("ok");
  });
});
