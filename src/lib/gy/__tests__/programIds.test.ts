// Program-ID regression guard — Task 3.2 (P3-A).
//
// The console previously shipped the FROZEN DR-001 static-reference IDs
// (2026-10-09 deployment, authority key dead) as if they were the live
// NS-2 devnet programs. These tests pin the current deployment from
// graveyield-protocol docs/DEVNET.md and independently re-derive the two
// ProtocolConfig PDAs from the pinned program IDs, so:
//   - any accidental reversion to the retired IDs fails the negative pins;
//   - any hand-edit of a PDA string that is not the honest derivation of
//     ["protocol_config"] under its program fails the derivation check.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import { PROGRAM_IDS, RETIRED_PROGRAM_IDS } from "../data";

// Authoritative current devnet deployment — NS-2 / DR-001 refresh,
// 2026-10-25 (graveyield-protocol docs/DEVNET.md, sdk/src/client.ts).
const EXPECTED = {
  graveScanner: "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54",
  graveVault: "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg",
  scannerConfigPda: "Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD",
  vaultConfigPda: "hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS",
  deployedAt: "2026-10-25",
} as const;

// The frozen DR-001 static reference (authority dead, historical only).
const RETIRED = {
  graveScanner: "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
  graveVault: "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
} as const;

describe("PROGRAM_IDS — NS-2 devnet deployment", () => {
  test("pins the exact current program IDs and deployment date", () => {
    expect(PROGRAM_IDS.graveScanner).toBe(EXPECTED.graveScanner);
    expect(PROGRAM_IDS.graveVault).toBe(EXPECTED.graveVault);
    expect(PROGRAM_IDS.deployedAt).toBe(EXPECTED.deployedAt);
  });

  test("config PDAs are the honest derivation of [\"protocol_config\"]", async () => {
    const scanner = new PublicKey(EXPECTED.graveScanner);
    const vault = new PublicKey(EXPECTED.graveVault);
    const [scannerPda, scannerBump] = await PublicKey.findProgramAddress(
      [Buffer.from("protocol_config")],
      scanner,
    );
    const [vaultPda, vaultBump] = await PublicKey.findProgramAddress(
      [Buffer.from("protocol_config")],
      vault,
    );
    // DEVNET.md: both config PDAs landed at bump 255 on the NS-2 refresh.
    expect(scannerBump).toBe(255);
    expect(vaultBump).toBe(255);
    // String-typed locals: the pinned constants are `as const` literals.
    const pinnedScannerPda: string = PROGRAM_IDS.scannerConfigPda;
    const pinnedVaultPda: string = PROGRAM_IDS.vaultConfigPda;
    expect(pinnedScannerPda).toBe(scannerPda.toBase58());
    expect(pinnedVaultPda).toBe(vaultPda.toBase58());
  });

  test("every address decodes as a valid 32-byte pubkey", () => {
    for (const addr of [
      PROGRAM_IDS.graveScanner,
      PROGRAM_IDS.graveVault,
      PROGRAM_IDS.scannerConfigPda,
      PROGRAM_IDS.vaultConfigPda,
    ]) {
      const pk = new PublicKey(addr);
      expect(pk.toBase58()).toBe(addr); // canonical base58 round-trip
    }
  });

  test("the retired DR-001 IDs are pinned and NOT in use", () => {
    // If these strings ever change, that is a deliberate re-pin of the
    // historical reference — it must be reviewed, never silent.
    expect(RETIRED_PROGRAM_IDS.graveScanner).toBe(RETIRED.graveScanner);
    expect(RETIRED_PROGRAM_IDS.graveVault).toBe(RETIRED.graveVault);
    // Negative guards: the live constants must never drift back.
    expect(PROGRAM_IDS.graveScanner).not.toBe(RETIRED.graveScanner);
    expect(PROGRAM_IDS.graveVault).not.toBe(RETIRED.graveVault);
    expect(PROGRAM_IDS.scannerConfigPda).not.toBe("GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu");
    expect(PROGRAM_IDS.vaultConfigPda).not.toBe("2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU");
    expect(PROGRAM_IDS.deployedAt).not.toBe("2026-10-09");
  });
});
