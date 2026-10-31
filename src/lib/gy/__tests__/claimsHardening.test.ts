// Claims hardening battery (security review 2026-10-31, F1/F2).
//
// Invariants pinned here:
//   1. A base58-SHAPED string is not a pubkey. The ?wallet= gate
//      (canonicalQueryWallet) must reject regex-passing strings that do not
//      decode to exactly 32 bytes — they previously reached `new PublicKey`
//      unguarded and 500'd the route once a distribution artifact was
//      configured, breaking the route's "invalid wallet → wallet: null"
//      promise and its "every outcome answers 200" rule.
//   2. Every artifact pubkey (pool_address, amm_program_id, lp_mint,
//      entries[].owner) is validated through the REAL PublicKey constructor
//      at the schema gate — the Merkle integrity gate does not cover the
//      first three, so a crafted artifact must die as corrupt (PARSE_FAILED),
//      never crash the route.
//   3. The envelope stays honest end to end: such artifacts map to
//      artifactState "corrupt" / dataState "unavailable" with NO payload —
//      and nothing in the resolution path throws.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import {
  canonicalQueryWallet,
  parseDistributionArtifact,
  ClaimsError,
} from "../claimsContract";
import { claimsBytesToPayload } from "../claimsSource";
import type { ClaimsSourceKind } from "../claimsTransport";

const VALID_PROGRAM_ID = "CuQZesHk8eHvaoNTFiTr1hUjfVKGCqDZHTTe8HkJAo54"; // GraveScanner
const VALID_VAULT_ID = "Bd5smhQgMrvcRw9j659MNTKySpBJsKZLBKtinCAGs7rg"; // GraveVault
const SYSTEM_PROGRAM = "11111111111111111111111111111111"; // 32 zero bytes — valid, canonical
/** 32 × '2' passes /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ but decodes to 23 bytes. */
const SHAPE_NOT_A_KEY = "2".repeat(32);

function hexRepeat(b: string): string {
  return b.repeat(32);
}

/** A minimal artifact that passes the schema gate (integrity is separate). */
function validRawArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    pool_address: VALID_PROGRAM_ID,
    amm_program_id: VALID_VAULT_ID,
    lp_mint: SYSTEM_PROGRAM,
    snapshot_slot: 100,
    lp_total_supply_at_snapshot: 1000,
    merkle_root: hexRepeat("aa"),
    leaf_count: 1,
    tree_depth: 0,
    entries: [{ owner: VALID_VAULT_ID, lp_balance: 1000, leaf: hexRepeat("bb"), proof: [] }],
    reconciliation: { enumerated_total: 1000, entries_total: 1000, sink_exclusions_total: 0 },
    ...overrides,
  };
}

describe("claims hardening / canonicalQueryWallet (F1)", () => {
  test("a real, canonical pubkey passes through unchanged", () => {
    expect(canonicalQueryWallet(VALID_PROGRAM_ID)).toBe(VALID_PROGRAM_ID);
    expect(canonicalQueryWallet(VALID_VAULT_ID)).toBe(VALID_VAULT_ID);
    expect(canonicalQueryWallet(SYSTEM_PROGRAM)).toBe(SYSTEM_PROGRAM);
  });

  test("null / undefined / empty → null (no wallet queried)", () => {
    expect(canonicalQueryWallet(null)).toBe(null);
    expect(canonicalQueryWallet(undefined)).toBe(null);
    expect(canonicalQueryWallet("")).toBe(null);
  });

  test("regex-failing garbage → null, never echoed", () => {
    expect(canonicalQueryWallet("not a wallet")).toBe(null);
    expect(canonicalQueryWallet("0x1234567890abcdef1234567890abcdef12345678")).toBe(null); // 0 not in alphabet
    expect(canonicalQueryWallet(`${VALID_PROGRAM_ID}x`)).toBe(null); // 45 chars
  });

  test("SHAPE-NOT-A-KEY: regex passes, PublicKey does not — rejected, never thrown on", () => {
    expect(SHAPE_NOT_A_KEY).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(canonicalQueryWallet(SHAPE_NOT_A_KEY)).toBe(null);
  });

  test("the gate is the ONLY path in: the route can no longer see an invalid wallet", () => {
    // Every value the route would forward is either a valid canonical key or
    // null — downstream `new PublicKey(wallet)` calls are unreachable-throws.
    for (const raw of [null, "", "garbage", SHAPE_NOT_A_KEY, VALID_PROGRAM_ID]) {
      const w = canonicalQueryWallet(raw);
      if (w !== null) {
        // A value that survived the gate must construct cleanly.
        expect(() => new PublicKey(w)).not.toThrow();
      }
    }
  });
});

describe("claims hardening / artifact pubkey gate (F2)", () => {
  test("a valid-shaped artifact passes the schema gate", () => {
    expect(() => parseDistributionArtifact(validRawArtifact())).not.toThrow();
  });

  test("pool_address that is base58-shaped but not a key → ClaimsError (was: latent 500)", () => {
    // The Merkle integrity gate does NOT cover pool_address — the schema gate
    // is the only defense, so it must use the real constructor.
    expect(() => parseDistributionArtifact(validRawArtifact({ pool_address: SHAPE_NOT_A_KEY }))).toThrow(
      /pool_address.*not a valid Solana public key/,
    );
  });

  test("amm_program_id and lp_mint get the same real-key gate", () => {
    expect(() => parseDistributionArtifact(validRawArtifact({ amm_program_id: SHAPE_NOT_A_KEY }))).toThrow(
      /amm_program_id/,
    );
    expect(() => parseDistributionArtifact(validRawArtifact({ lp_mint: SHAPE_NOT_A_KEY }))).toThrow(/lp_mint/);
  });

  test("an entry owner that is base58-shaped but not a key → ClaimsError", () => {
    const bad = validRawArtifact({
      entries: [{ owner: SHAPE_NOT_A_KEY, lp_balance: 1000, leaf: hexRepeat("bb"), proof: [] }],
    });
    expect(() => parseDistributionArtifact(bad)).toThrow(/entries\[0\].owner/);
  });

  test("end to end: such artifacts map to corrupt/unavailable with NO payload — nothing throws", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(validRawArtifact({ pool_address: SHAPE_NOT_A_KEY })));
    let payload!: ReturnType<typeof claimsBytesToPayload>["payload"];
    expect(() => {
      payload = claimsBytesToPayload(bytes, {
        nowMs: 1_000_000,
        checkedAtUnixMs: 1_000_000,
        source: { kind: "url" as ClaimsSourceKind, uri: null },
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      }).payload;
    }).not.toThrow();
    expect(payload.artifactState).toBe("corrupt");
    expect(payload.dataState).toBe("unavailable");
    expect(payload.distribution).toBe(null);
    expect(payload.reasonCode).toBe("PARSE_FAILED");
  });

  test("ClaimsError keeps its namespace (fail-closed contract class)", () => {
    expect(new ClaimsError("x").name).toBe("ClaimsError");
  });
});
