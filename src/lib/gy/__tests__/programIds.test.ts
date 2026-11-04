// Program-ID regression guard — Task 3.2 (P3-A), NS-3 edition.
//
// The console previously shipped the FROZEN DR-001 static-reference IDs
// (2026-10-09 deployment, authority key dead) as if they were the live
// devnet programs (fixed at the NS-2 refresh), and the NS-3 sync now
// re-pins the constants to the ASSIGNED NS-3 identities. These tests pin
// the NS-3 assignment from graveyield-protocol docs/DEVNET.md and
// independently re-derive the two ProtocolConfig PDAs from the pinned
// program IDs, so:
//   - any accidental reversion to a retired ID (NS-1 OR NS-2) fails the
//     negative pins;
//   - any hand-edit of a PDA string that is not the honest derivation of
//     ["protocol_config"] under its program fails the derivation check;
//   - the pending-deployment state is explicit: NS-3 is assigned but NOT
//     deployed, so `deployedAt` is null until the owner's deployment is
//     recorded in docs/DEVNET.md.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import { PROGRAM_IDS, RETIRED_PROGRAM_IDS } from "../data";

// Authoritative NS-3 assignment — owner-generated, owner-held identities
// (graveyield-protocol docs/DEVNET.md NS-3 preparation record; the PDAs
// below are the pre-deployment derivations of ['protocol_config']).
const EXPECTED = {
  graveScanner: "EFJpKtWx5gDnc4Hh6GEEgPLUrPh377E4Nfic8jsJAQJL",
  graveVault: "7VxUGJNgi1bZ8x4rTtLBNdgLs9sCLmUTpVE3on1nshya",
  scannerConfigPda: "5PK9pz4FcmiWGG3h81WquD2QpwuEj2GeAXxLGGMJkKKe",
  vaultConfigPda: "5aocH2UAFixQneb5LzoNf2m3b92AUc9zFP6oWEh6Vnda",
} as const;

// Both historical generations are retired and must stay obsolete:
// NS-1 — frozen DR-001 static reference (authority key dead, 2026-10-09);
// NS-2 — DR-001 refresh (authority key permanently lost, 2026-10-25).
const RETIRED = {
  ns1: {
    graveScanner: "5JiCVxES6RYcrFGnFkqKyDmr7fc3EkYaSCbfgJq7zvNF",
    graveVault: "HUyoG5vUmYZJDjdBCxRLLAfm98vEXh63WL3pLARox3v6",
    scannerConfigPda: "GcdZJhCpg7sjgEEHTsoSkT2Pi83d8kP3NrTqdvMm2Bhu",
    vaultConfigPda: "2SCqqpEwKMuWnJWe7UQJTzFeDPif4jUPUspWKZdZ5vaU",
  },
  ns2: {
    graveScanner: "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54",
    graveVault: "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg",
    scannerConfigPda: "Fb6uvYyRAKFRCuab44imZ6YAVAEfGLoAPDxFpwVXQdiD",
    vaultConfigPda: "hyKk983fguE2CGA5Dx5TLKfBft1AJrm7CHoe1PTUipS",
  },
} as const;

describe("PROGRAM_IDS — NS-3 assignment (deployment pending)", () => {
  test("pins the exact assigned NS-3 program IDs", () => {
    expect(PROGRAM_IDS.graveScanner).toBe(EXPECTED.graveScanner);
    expect(PROGRAM_IDS.graveVault).toBe(EXPECTED.graveVault);
  });

  test("deployment state is explicitly PENDING (deployedAt null)", () => {
    // NS-3 is NOT deployed or initialized yet. Flipping this to a date is
    // a deliberate post-deployment act — it must happen together with the
    // docs/DEVNET.md signature record, never silently.
    expect(PROGRAM_IDS.deployedAt).toBeNull();
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
    // Canonical bump for a single 15-byte seed is 255 — same as NS-1/NS-2.
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

  test("both retired generations are pinned and NOT in use", () => {
    // If these strings ever change, that is a deliberate re-pin of the
    // historical records — it must be reviewed, never silent.
    expect(RETIRED_PROGRAM_IDS.ns1.graveScanner).toBe(RETIRED.ns1.graveScanner);
    expect(RETIRED_PROGRAM_IDS.ns1.graveVault).toBe(RETIRED.ns1.graveVault);
    expect(RETIRED_PROGRAM_IDS.ns2.graveScanner).toBe(RETIRED.ns2.graveScanner);
    expect(RETIRED_PROGRAM_IDS.ns2.graveVault).toBe(RETIRED.ns2.graveVault);
    // Negative guards: the live constants must never drift back to ANY
    // retired generation (IDs and config PDAs).
    const liveScanner: string = PROGRAM_IDS.graveScanner;
    const liveVault: string = PROGRAM_IDS.graveVault;
    const liveScannerPda: string = PROGRAM_IDS.scannerConfigPda;
    const liveVaultPda: string = PROGRAM_IDS.vaultConfigPda;
    for (const gen of [RETIRED.ns1, RETIRED.ns2]) {
      expect(liveScanner).not.toBe(gen.graveScanner);
      expect(liveVault).not.toBe(gen.graveVault);
      expect(liveScannerPda).not.toBe(gen.scannerConfigPda);
      expect(liveVaultPda).not.toBe(gen.vaultConfigPda);
    }
  });
});
