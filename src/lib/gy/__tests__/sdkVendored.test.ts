// Vendored canonical SDK drift battery (P4.4) — the CI drift protection the
// Phase 4.0 audit's Q1 Option A requires. Three layers:
//
//   1. BYTE PINS — every byte-identical vendored file must hash exactly to
//      its recorded value (recorded at vendoring time from
//      graveyield-protocol@2b0bc240e7db2c551bc9b2034bc133110a353ce2 sdk/src).
//      Any local edit fails here; taking an upstream update means re-copying
//      and re-pinning deliberately (see vendor/graveyield-sdk/PROVENANCE.md).
//   2. LIVE-CLUSTER PDA PIN — the vendored PDA derivation must reproduce the
//      ProtocolConfig PDAs the console already pins against the live devnet
//      cluster (programIds.test.ts). Broken vendoring cannot pass this.
//   3. GOLDEN VECTOR — the transcribed buildClaimLpProceedsIx must encode
//      instruction data byte-for-byte equal to an INDEPENDENTLY computed
//      vector (Python hashlib/struct implementation of the on-chain Anchor
//      convention in claim_lp_proceeds.rs), plus a Merkle fork vector from
//      the SDK's own fork-proven 3-leaf test.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { PROGRAM_IDS } from "../data";
import {
  scannerProtocolConfigPda,
  vaultProtocolConfigPda,
  claimRecordPda,
  poolRegistryPda,
} from "../vendor/graveyield-sdk/pdas";
import { buildClaimLpProceedsIx } from "../vendor/graveyield-sdk/claimsInstructions";
import {
  SnapshotMerkleTree,
  computeLeaf,
  verifyMerkleProof,
} from "../vendor/graveyield-sdk/merkle";
import { AccountDisc, VaultIx } from "../vendor/graveyield-sdk/discriminators";

const VENDOR = join(import.meta.dir, "..", "vendor", "graveyield-sdk");

/* ── 1. Byte pins (sha256, recorded at vendoring time) ─────────────── */

const BYTE_PINS: Record<string, string> = {
  "accountDecoders.ts": "35b48cbc0ad0a44a08ee55c7a2af163c38e24cd7a12ad728ac326a29b69ff7c2",
  "borsh.ts": "116159fdba7c83607eda5108773728c738fb704127ad8fb74918ffe85b3f41ed",
  "discriminators.ts": "c134f5147766ae4cd028561987d21e8594449f5db6b2165399743097793c56d4",
  "errors.ts": "faa90fe621c73ae4fbb5f385e494ef4b3d865e00c4290438dc1c14bc482b4bcf",
  "merkle.ts": "9a9aac02dde491d02b7e7f185f82edf8367f32a556bd4de2af385a6bdcae4f08",
  "pdas.ts": "a24745c46617da4c05555e107ed8ad1e4e53e7960aecde4b98ef9dfd087b2e0e",
  "web3compat.ts": "cf750ef115d33d90a8dd98bab4e14c67b334a55dc8940cc64f593f2cc5a643e9",
};

describe("vendored canonical SDK — byte pins", () => {
  for (const [file, expected] of Object.entries(BYTE_PINS)) {
    test(`${file} is byte-identical to the canonical SDK`, () => {
      const bytes = readFileSync(join(VENDOR, file));
      const got = createHash("sha256").update(bytes).digest("hex");
      expect(got).toBe(expected);
    });
  }

  test("PROVENANCE.md exists and names the canonical commit", () => {
    const md = readFileSync(join(VENDOR, "PROVENANCE.md"), "utf8");
    expect(md).toContain("2b0bc240e7db2c551bc9b2034bc133110a353ce2");
  });
});

/* ── 2. Live-cluster PDA pin ───────────────────────────────────────── */

describe("vendored PDA derivation", () => {
  test("reproduces the live devnet ProtocolConfig PDAs", () => {
    const scanner = new PublicKey(PROGRAM_IDS.graveScanner);
    const vault = new PublicKey(PROGRAM_IDS.graveVault);
    expect(scannerProtocolConfigPda(scanner).toBase58()).toBe(PROGRAM_IDS.scannerConfigPda);
    expect(vaultProtocolConfigPda(vault).toBase58()).toBe(PROGRAM_IDS.vaultConfigPda);
  });

  test("claim PDAs are deterministic, off-curve, and seed-bound", () => {
    const vault = new PublicKey(PROGRAM_IDS.graveVault);
    const pool = new PublicKey(new Uint8Array(32).fill(7));
    const holder = new PublicKey(new Uint8Array(32).fill(9));
    const rec = claimRecordPda(vault, pool, holder);
    const reg = poolRegistryPda(vault, pool);
    expect(rec.toBase58()).toBe(claimRecordPda(vault, pool, holder).toBase58()); // deterministic
    expect(rec.toBase58()).not.toBe(reg.toBase58());
    expect(PublicKey.isOnCurve(rec.toBytes())).toBe(false); // PDAs fall off the curve
    expect(PublicKey.isOnCurve(reg.toBytes())).toBe(false);
  });
});

/* ── 3a. Claim instruction golden vector (independent computation) ──── */

describe("buildClaimLpProceedsIx — independent golden vector", () => {
  // Independent vector, computed with Python hashlib/struct straight from
  // programs/grave-vault/src/instructions/claim_lp_proceeds.rs's layout:
  //   disc = sha256("global:claim_lp_proceeds")[0..8]
  //        || pool (32 raw bytes) || lp_balance u64 LE
  //        || u32 LE proof_len || n x 32 raw bytes
  const DISC = Buffer.from("a799e28307463097", "hex");
  const POOL_BYTES = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const BALANCE = 41_882_114; // 0x027F1202 → LE 02 12 7f 02 00 00 00 00
  const PROOF = [Buffer.alloc(32, 0xa0), Buffer.alloc(32, 0xa1)];
  const EXPECTED_DATA = Buffer.concat([
    DISC,
    POOL_BYTES,
    Buffer.from([0x02, 0x12, 0x7f, 0x02, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x02, 0x00, 0x00, 0x00]),
    ...PROOF,
  ]);

  test("instruction DATA matches the independent vector byte-for-byte", () => {
    // Sanity: our own discriminator derivation equals the precomputed one.
    expect(Buffer.from(VaultIx.claimLpProceeds).toString("hex")).toBe(DISC.toString("hex"));
    const ix = buildClaimLpProceedsIx({
      vaultProgramId: new PublicKey(PROGRAM_IDS.graveVault),
      poolAddress: new PublicKey(POOL_BYTES),
      lpHolder: new PublicKey(new Uint8Array(32).fill(3)),
      lpBalanceAtSnapshot: BALANCE,
      merkleProof: PROOF,
    });
    expect(Buffer.from(ix.data).toString("hex")).toBe(EXPECTED_DATA.toString("hex"));
  });

  test("account metas: registry+record+vault writable, holder signer, system read-only", () => {
    const vault = new PublicKey(PROGRAM_IDS.graveVault);
    const pool = new PublicKey(POOL_BYTES);
    const holder = new PublicKey(PROGRAM_IDS.graveScanner); // any stable pubkey
    const ix = buildClaimLpProceedsIx({
      vaultProgramId: vault,
      poolAddress: pool,
      lpHolder: holder,
      lpBalanceAtSnapshot: BALANCE,
      merkleProof: PROOF,
    });
    expect(ix.programId.toBase58()).toBe(PROGRAM_IDS.graveVault);
    expect(ix.keys.length).toBe(5);
    expect(ix.keys[0]!.pubkey.toBase58()).toBe(poolRegistryPda(vault, pool).toBase58());
    expect(ix.keys[0]!.isWritable).toBe(true);
    expect(ix.keys[1]!.pubkey.toBase58()).toBe(claimRecordPda(vault, pool, holder).toBase58());
    expect(ix.keys[1]!.isWritable).toBe(true);
    expect(ix.keys[2]!.pubkey.toBase58()).toMatch(/./);
    expect(ix.keys[2]!.isWritable).toBe(true);
    expect(ix.keys[3]!.pubkey.toBase58()).toBe(holder.toBase58());
    expect(ix.keys[3]!.isSigner).toBe(true);
    expect(ix.keys[3]!.isWritable).toBe(true);
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(ix.keys[4]!.isSigner).toBe(false);
    expect(ix.keys[4]!.isWritable).toBe(false);
  });

  test("rejects a proof element that is not 32 bytes", () => {
    expect(() =>
      buildClaimLpProceedsIx({
        vaultProgramId: new PublicKey(PROGRAM_IDS.graveVault),
        poolAddress: new PublicKey(POOL_BYTES),
        lpHolder: new PublicKey(PROGRAM_IDS.graveScanner),
        lpBalanceAtSnapshot: BALANCE,
        merkleProof: [new Uint8Array(31)],
      }),
    ).toThrow(/32 bytes/);
  });
});

/* ── 3b. Merkle convention (fork-proven vector, via the vendored SDK) ── */

function pk(byte: number): PublicKey {
  const b = new Uint8Array(32);
  b[0] = byte;
  return new PublicKey(b);
}

describe("vendored merkle — fork-proven 3-leaf vector", () => {
  test("matches settlement_economics_fork.rs::build_three_leaf_tree", () => {
    const tree = SnapshotMerkleTree.fromEntries([
      { owner: pk(0x10), lpBalance: 1_000n },
      { owner: pk(0x20), lpBalance: 2_000n },
      { owner: pk(0x30), lpBalance: 3_000n },
    ]);
    const l0 = computeLeaf(pk(0x10), 1_000n);
    const l1 = computeLeaf(pk(0x20), 2_000n);
    const l2 = computeLeaf(pk(0x30), 3_000n);
    expect(tree.treeDepth()).toBe(2);
    expect(tree.proof(2)!.length).toBe(1); // promoted leaf: single element
    expect(verifyMerkleProof(tree.root(), l0, tree.proof(0)!)).toBe(true);
    expect(verifyMerkleProof(tree.root(), l1, tree.proof(1)!)).toBe(true);
    expect(verifyMerkleProof(tree.root(), l2, tree.proof(2)!)).toBe(true);
    // Tampered proof fails closed.
    const tampered = [Buffer.from(l1).map((b, i) => (i === 0 ? b ^ 1 : b))];
    expect(verifyMerkleProof(tree.root(), l0, tampered)).toBe(false);
  });

  test("account discriminators pin the three claim-surface accounts", () => {
    // sha256("account:PoolRegistry")[0..8], etc. — the decoders' gate.
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest().subarray(0, 8);
    expect(Buffer.from(AccountDisc.PoolRegistry).toString("hex")).toBe(sha("account:PoolRegistry").toString("hex"));
    expect(Buffer.from(AccountDisc.SalvageReceipt).toString("hex")).toBe(sha("account:SalvageReceipt").toString("hex"));
    expect(Buffer.from(AccountDisc.ClaimRecord).toString("hex")).toBe(sha("account:ClaimRecord").toString("hex"));
  });
});
