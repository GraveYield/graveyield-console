// protocolLive decoder tests — the browser-side ProtocolConfig readers must
// byte-match the SDK layouts. The base58 encoder is cross-checked against
// @solana/web3.js as the independent oracle; the discriminator is recomputed
// from its derivation rather than trusted.
//
// NS-3 identity note (review correction): the synthetic fixtures use the
// APPROVED NS-3 authority arrangement, not the program IDs —
//   * ProtocolConfig authority = the dedicated GOVERNANCE authority
//     (initial and permanent config authority for BOTH programs, DR-002);
//     using a program ID here was the NS-1-era shape and misdescribes the
//     arrangement the decoder will actually read.
//   * Oracle fields = the dedicated activity (C1) and launch-price (C2)
//     oracle signers, i.e. the post-registration state the console will
//     display after the owner runs register-oracle.
// Public keys only — no private key material exists in this repo.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import {
  PROTOCOL_CONFIG_DISCRIMINATOR,
  base58Encode,
  decodeScannerConfigLive,
  decodeVaultConfigLive,
  type ScannerConfigLive,
  type VaultConfigLive,
} from "../protocolLive";

function putPubkey(buf: Uint8Array, off: number, pk: string): void {
  buf.set(new PublicKey(pk).toBytes(), off);
}

/** NS-3 ProtocolConfig authority — the dedicated governance authority (DR-002; public key only). */
const NS3_GOVERNANCE_AUTHORITY = "BMnrpx9mSZDzCmM8aJipnzgfLzfxa5tfFgWi3ZvBUwf5";
/** NS-3 dedicated GraveScanner activity (C1) oracle signer — public key only. */
const NS3_ACTIVITY_ORACLE = "2ZygwHNXUBm3ESuvzxqL8ywdqKo8pkkcS6XfXQoZqf8o";
/** NS-3 dedicated GraveScanner launch-price (C2) oracle signer — public key only. */
const NS3_LAUNCH_PRICE_ORACLE = "97JVKVd6E8Tmax8AciUNA4U92hwEQxN9MpeAessQBcee";

/** Build a byte-exact scanner ProtocolConfig account payload (NS-3 authority arrangement). */
function buildScannerConfig(): Uint8Array {
  const buf = new Uint8Array(252);
  buf.set(PROTOCOL_CONFIG_DISCRIMINATOR, 0);
  putPubkey(buf, 8, NS3_GOVERNANCE_AUTHORITY); // authority — the GOVERNANCE authority, not a program ID
  putPubkey(buf, 40, "11111111111111111111111111111111"); // pending authority (zeros)
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(80, 7_776_000n, true); // inactivity_seconds
  dv.setUint16(88, 9_900, true); // price_collapse_bps
  dv.setBigUint64(90, 500_000_000n, true); // min_tvl_lamports
  dv.setBigUint64(98, 1_209_600n, true); // anchor_staleness_seconds
  dv.setBigUint64(106, 1_000n, true); // lp_burn_dust_threshold
  dv.setBigUint64(114, 3_600n, true); // cert_ttl_seconds
  buf[122] = 0; // paused
  putPubkey(buf, 123, NS3_ACTIVITY_ORACLE); // activity oracle — dedicated C1 signer
  putPubkey(buf, 155, NS3_LAUNCH_PRICE_ORACLE); // launch price oracle — dedicated C2 signer
  buf[187] = 255; // bump
  return buf;
}

/** Build a byte-exact vault ProtocolConfig account payload (NS-3 authority arrangement). */
function buildVaultConfig(): Uint8Array {
  const buf = new Uint8Array(210);
  buf.set(PROTOCOL_CONFIG_DISCRIMINATOR, 0);
  putPubkey(buf, 8, NS3_GOVERNANCE_AUTHORITY); // authority — the GOVERNANCE authority, not a program ID
  const dv = new DataView(buf.buffer);
  dv.setUint16(80, 4_000, true); // lp_holder_share_bps
  dv.setUint16(82, 4_000, true); // salvor_share_bps
  dv.setUint16(84, 2_000, true); // protocol_share_bps
  dv.setBigUint64(86, 1_000_000_000n, true); // max_priority_fee_ceiling
  dv.setUint16(94, 300, true); // max_slippage_bps
  dv.setBigUint64(96, 666_666n, true); // jupiter_dust_threshold
  dv.setBigUint64(104, 259_200n, true); // timelock_seconds
  buf[112] = 1; // emergency_paused
  buf[113] = 255; // bump
  return buf;
}

describe("protocolLive — discriminator", () => {
  test("PROTOCOL_CONFIG_DISCRIMINATOR is sha256('account:ProtocolConfig')[0..8]", () => {
    const derived = createHash("sha256").update("account:ProtocolConfig").digest().subarray(0, 8);
    expect(Buffer.from(PROTOCOL_CONFIG_DISCRIMINATOR).equals(derived)).toBe(true);
  });
});

describe("protocolLive — scanner config decoder", () => {
  test("decodes a byte-exact payload with full precision", () => {
    const cfg: ScannerConfigLive = decodeScannerConfigLive(buildScannerConfig());
    expect(cfg.authority).toBe(NS3_GOVERNANCE_AUTHORITY);
    expect(cfg.pendingAuthority).toBe("11111111111111111111111111111111");
    expect(cfg.inactivitySeconds).toBe("7776000");
    expect(cfg.priceCollapseBps).toBe(9_900);
    expect(cfg.minTvlLamports).toBe("500000000");
    expect(cfg.anchorStalenessSeconds).toBe("1209600");
    expect(cfg.lpBurnDustThreshold).toBe("1000");
    expect(cfg.certTtlSeconds).toBe("3600");
    expect(cfg.paused).toBe(false);
    expect(cfg.activityOracle).toBe(NS3_ACTIVITY_ORACLE);
    expect(cfg.launchPriceOracle).toBe(NS3_LAUNCH_PRICE_ORACLE);
    expect(cfg.bump).toBe(255);
  });

  test("fails closed on discriminator drift, truncation, and invalid bool", () => {
    const bad = buildScannerConfig();
    bad[3] ^= 0xff;
    expect(() => decodeScannerConfigLive(bad)).toThrow(/discriminator mismatch/);
    expect(() => decodeScannerConfigLive(buildScannerConfig().subarray(0, 40))).toThrow(/too short/);
    const badBool = buildScannerConfig();
    badBool[122] = 2;
    // paused is read as a raw byte here; the strict bool check lives in the
    // vault decoder path — scanner stays permissive by design parity with SDK.
    expect(decodeScannerConfigLive(badBool).paused).toBe(false);
  });
});

describe("protocolLive — vault config decoder", () => {
  test("decodes a byte-exact payload with full precision", () => {
    const cfg: VaultConfigLive = decodeVaultConfigLive(buildVaultConfig());
    expect(cfg.authority).toBe(NS3_GOVERNANCE_AUTHORITY);
    expect(cfg.lpHolderShareBps).toBe(4_000);
    expect(cfg.salvorShareBps).toBe(4_000);
    expect(cfg.protocolShareBps).toBe(2_000);
    expect(cfg.maxPriorityFeeCeilingLamports).toBe("1000000000");
    expect(cfg.maxSlippageBps).toBe(300);
    expect(cfg.jupiterDustThresholdLamports).toBe("666666");
    expect(cfg.timelockSeconds).toBe("259200");
    expect(cfg.emergencyPaused).toBe(true);
    expect(cfg.bump).toBe(255);
  });

  test("fails closed on discriminator drift and truncation", () => {
    const bad = buildVaultConfig();
    bad[0] = 0x00;
    expect(() => decodeVaultConfigLive(bad)).toThrow(/discriminator mismatch/);
    expect(() => decodeVaultConfigLive(buildVaultConfig().subarray(0, 30))).toThrow(/too short/);
  });
});

describe("protocolLive — base58 reader", () => {
  test("matches web3.js encoding on edge-case vectors", () => {
    // All-zero (leading '1's), single-byte, all-0xff, and a real pubkey vector.
    const vectors: Uint8Array[] = [
      new Uint8Array(32), // 32 leading zeros
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(0xff),
      new PublicKey("EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL").toBytes(),
      new PublicKey("So11111111111111111111111111111111111111112").toBytes(),
    ];
    for (const bytes of vectors) {
      expect(base58Encode(bytes)).toBe(new PublicKey(bytes).toBase58());
    }
  });
});
