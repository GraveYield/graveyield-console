// SPDX-License-Identifier: Apache-2.0
//
// TRANSCRIBED VENDORED FILE — NOT byte-identical to the canonical SDK.
//
// This module carries GraveVault::claim_lp_proceeds instruction
// construction, transcribed VERBATIM from
// graveyield-protocol sdk/src/instructions.ts
//   (canonical commit 2b0bc240e7db2c551bc9b2034bc133110a353ce2,
//    `buildClaimLpProceedsIx` at lines 334-373 plus the account-meta /
//    pkBytes helpers at lines 46-61).
//
// WHY NOT THE WHOLE FILE: sdk/src/instructions.ts imports
// `@solana/spl-token` at module top level (for the salvage-side sweep_dust
// builder). The console tree deliberately carries no spl-token dependency —
// the P4 dependency-audit pass keeps `bigint-buffer` (its transitive risk)
// out of the lockfile, and `bun audit` must stay at zero findings. Claims
// need no token-program surface: `claim_lp_proceeds` moves native SOL via
// system_program only.
//
// DRIFT PROTECTION: this file is pinned by
// __tests__/sdkVendored.test.ts, which asserts the produced instruction
// DATA bytes against an independently computed golden vector (Python
// hashlib/struct implementation of the on-chain Anchor convention:
// discriminator = sha256("global:claim_lp_proceeds")[0..8] ||
// borsh(pool:32 || u64 LE || vec<u8[32]>)). Any transcription drift, or any
// edit to the canonical builder that changes its wire encoding, fails the
// console battery. When the canonical builder changes, re-transcribe here
// AND re-verify the golden vector against the on-chain layout in
// programs/grave-vault/src/instructions/claim_lp_proceeds.rs.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

import { writer } from "./borsh.js";
import { VaultIx } from "./discriminators.js";
import {
  claimRecordPda,
  lpHolderPoolVaultPda,
  poolRegistryPda,
} from "./pdas.js";

/** Helper: convert a PublicKey to an AccountMeta with `isSigner=false, isWritable=false`. */
function metaReadOnly(pubkey: PublicKey): AccountMeta {
  return { pubkey, isSigner: false, isWritable: false };
}
/** Helper: convert a PublicKey to a writable AccountMeta. */
function metaWritable(pubkey: PublicKey): AccountMeta {
  return { pubkey, isSigner: false, isWritable: true };
}
/** Helper: convert a PublicKey to a signer AccountMeta. */
function metaSigner(pubkey: PublicKey, writable = true): AccountMeta {
  return { pubkey, isSigner: true, isWritable: writable };
}

/** 32-byte raw of a PublicKey (for borsh writer). */
function pkBytes(p: PublicKey): Uint8Array {
  return p.toBytes();
}

/**
 * Build GraveVault::claim_lp_proceeds. The Merkle proof comes from the
 * snapshot artifact (`SnapshotResult.proofs[index]`).
 */
export function buildClaimLpProceedsIx(opts: {
  vaultProgramId: PublicKey;
  poolAddress: PublicKey;
  lpHolder: PublicKey;
  lpBalanceAtSnapshot: number | bigint;
  /** Sorted-pair Merkle proof — `proofs[index]` from the snapshot artifact. */
  merkleProof: ReadonlyArray<Uint8Array>;
}): TransactionInstruction {
  // borsh: disc(8) + pool_address(32) + lp_balance_at_snapshot(8) + vec<u8[32]>(4 + 32 * n)
  const proofLen = opts.merkleProof.length;
  const dataSize = 8 + 32 + 8 + 4 + 32 * proofLen;
  const w = writer(dataSize)
    .bytes(VaultIx.claimLpProceeds)
    .bytes(pkBytes(opts.poolAddress))
    .u64(opts.lpBalanceAtSnapshot);
  w.u32(proofLen);
  for (const elem of opts.merkleProof) {
    if (elem.length !== 32) {
      throw new Error(`merkle proof element must be 32 bytes (got ${elem.length})`);
    }
    w.bytes(elem);
  }
  const dataBytes = w.done();
  const keys: AccountMeta[] = [
    metaWritable(poolRegistryPda(opts.vaultProgramId, opts.poolAddress)),
    metaWritable(claimRecordPda(opts.vaultProgramId, opts.poolAddress, opts.lpHolder)),
    metaWritable(lpHolderPoolVaultPda(opts.vaultProgramId, opts.poolAddress)),
    metaSigner(opts.lpHolder),
    metaReadOnly(SystemProgram.programId),
  ];
  return new TransactionInstruction({
    programId: opts.vaultProgramId,
    keys,
    data: Buffer.from(dataBytes),
  });
}
