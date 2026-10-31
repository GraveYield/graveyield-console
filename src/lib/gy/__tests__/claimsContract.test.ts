// Claims contract battery (P4.4) — artifact parsing, SDK integrity gate, the
// wallet claim state machine, and the normative claimable math. Core
// invariants:
//   - A tampered artifact (any field: root, leaf, proof, balance,
//     reconciliation, order) can NEVER pass parse + integrity.
//   - The state machine distinguishes exactly the owner's vocabulary and
//     never conflates "unknown" with "ineligible", "prepared" with "paid",
//     or "proof exists" with "claim confirmed".
//   - The claimable math mirrors claim_lp_proceeds.rs exactly (u128
//     intermediate, integer-division floor).

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import {
  DISTRIBUTION_FORMAT_VERSION,
  ClaimsError,
  entryForWallet,
  expectedClaimAmountLamports,
  parseDistributionArtifact,
  publicDistribution,
  verifyDistributionIntegrity,
  walletClaimView,
  type DistributionArtifact,
  type RegistryFacts,
} from "../claimsContract";
import { SnapshotMerkleTree } from "../vendor/graveyield-sdk/merkle";

/* ── Fixture — a real sealed artifact built THROUGH the canonical SDK ── */

function pk(byte: number): PublicKey {
  const b = new Uint8Array(32);
  b[0] = byte;
  return new PublicKey(b);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

const OWNERS = [pk(0x11), pk(0x22), pk(0x33)]; // ascending bytes
const BALANCES = [1_000n, 2_000n, 3_000n];
const TREE = SnapshotMerkleTree.fromEntries(
  OWNERS.map((o, i) => ({ owner: o, lpBalance: BALANCES[i]! })),
);

const POOL = pk(0x42).toBase58();
const AMM = pk(0x43).toBase58();
const MINT = pk(0x44).toBase58();
const SUPPLY = 6_000n; // Σ balances (no sinks in the fixture)
const REGISTRY_ROOT = hex(TREE.root());
const REGISTRY_TOTAL = 5_000_000n; // LP-holder bucket lamports at salvage

function artifactJson(): Record<string, unknown> {
  return {
    format_version: DISTRIBUTION_FORMAT_VERSION,
    pool_address: POOL,
    amm_program_id: AMM,
    lp_mint: MINT,
    snapshot_slot: 331_902_118,
    lp_total_supply_at_snapshot: Number(SUPPLY),
    merkle_root: REGISTRY_ROOT,
    leaf_count: 3,
    tree_depth: 2,
    entries: OWNERS.map((o, i) => ({
      owner: o.toBase58(),
      lp_balance: Number(BALANCES[i]),
      leaf: hex(TREE.leaf(i)!),
      proof: TREE.proof(i)!.map((p) => hex(p)),
    })),
    reconciliation: {
      enumerated_total: Number(SUPPLY),
      entries_total: Number(SUPPLY),
      sink_exclusions_total: 0,
    },
  };
}

function parseOk(): DistributionArtifact {
  const a = parseDistributionArtifact(artifactJson());
  verifyDistributionIntegrity(a); // must never throw on the honest fixture
  return a;
}

const REGISTRY: RegistryFacts = {
  merkleRoot: REGISTRY_ROOT,
  lpTotalSupplyAtSnapshot: SUPPLY,
  lpHolderPoolTotalLamports: REGISTRY_TOTAL,
};

function viewFor(wallet: string, overrides: Partial<Parameters<typeof walletClaimView>[0]> = {}) {
  return walletClaimView({
    wallet,
    artifact: parseOk(),
    registry: REGISTRY,
    registryAbsent: false,
    registryError: null,
    claimRecord: null,
    claimRecordError: false,
    vaultProgramId: pk(0x55).toBase58(),
    ...overrides,
  } as Parameters<typeof walletClaimView>[0]);
}

/* ── Parser + integrity ─────────────────────────────────────────────── */

describe("parseDistributionArtifact + verifyDistributionIntegrity", () => {
  test("the honest fixture parses and passes SDK integrity", () => {
    expect(() => parseOk()).not.toThrow();
    const a = parseOk();
    expect(a.leafCount).toBe(3);
    expect(a.lpTotalSupplyAtSnapshot).toBe(SUPPLY);
  });

  test("rejects a foreign format_version", () => {
    const raw = artifactJson();
    raw.format_version = 2;
    expect(() => parseDistributionArtifact(raw)).toThrow(/format_version/);
  });

  test("rejects empty entries and leaf_count mismatch", () => {
    const raw = artifactJson();
    raw.leaf_count = 4;
    expect(() => parseDistributionArtifact(raw)).toThrow(/leaf_count/);
    const raw2 = artifactJson();
    raw2.entries = [];
    raw2.leaf_count = 0;
    expect(() => parseDistributionArtifact(raw2)).toThrow(/no legitimate empty root/);
  });

  test("rejects duplicate owners, zero balances, and unordered entries", () => {
    const dup = artifactJson();
    (dup.entries as Record<string, unknown>[])[1]!.owner = (dup.entries as Record<string, unknown>[])[0]!.owner;
    expect(() => parseDistributionArtifact(dup)).toThrow(/duplicate owner/);

    const zero = artifactJson();
    (zero.entries as Record<string, unknown>[])[1]!.lp_balance = 0;
    expect(() => parseDistributionArtifact(zero)).toThrow(/strictly positive/);

    const unordered = artifactJson();
    (unordered.entries as Record<string, unknown>[]) = [(unordered.entries as Record<string, unknown>[])[1]!, (unordered.entries as Record<string, unknown>[])[0]!, (unordered.entries as Record<string, unknown>[])[2]!];
    expect(() => parseDistributionArtifact(unordered)).toThrow(/ascending-owner order/);
  });

  test("rejects a tampered root, leaf, proof, or balance through SDK integrity", () => {
    const root = artifactJson();
    (root.merkle_root as string) = "0".repeat(64);
    const a1 = parseDistributionArtifact(root);
    expect(() => verifyDistributionIntegrity(a1)).toThrow(/root does not derive/);

    const leaf = artifactJson();
    const entries = leaf.entries as Record<string, unknown>[];
    (entries[0]!.leaf as string) = "0".repeat(64);
    const a2 = parseDistributionArtifact(leaf);
    expect(() => verifyDistributionIntegrity(a2)).toThrow(/leaf mismatch/);

    const proof = artifactJson();
    const p0 = (proof.entries as Record<string, unknown>[])[0]!.proof as string[];
    p0[0] = "0".repeat(64);
    const a3 = parseDistributionArtifact(proof);
    expect(() => verifyDistributionIntegrity(a3)).toThrow(/proof mismatch/);

    // A tampered balance changes the leaf preimage — with the reconciliation
    // totals kept Σ-consistent (so the parser's arithmetic gate passes), the
    // re-derived leaf no longer matches the persisted leaf. THIS is also the
    // net that catches float64 precision loss on huge u64 balances.
    const balance = artifactJson();
    const be = balance.entries as Record<string, unknown>[];
    (be[0]!.lp_balance as number) = 1_001;
    const rec = balance.reconciliation as Record<string, unknown>;
    rec.entries_total = Number(SUPPLY) + 1;
    rec.enumerated_total = Number(SUPPLY) + 1;
    (balance.lp_total_supply_at_snapshot as number) = Number(SUPPLY) + 1; // supply agrees too
    const a4 = parseDistributionArtifact(balance);
    // A changed balance re-derives a different tree — integrity fails closed
    // (the root check fires first; the leaf check covers per-entry drift).
    // THIS is the net that catches float64 precision loss on huge u64
    // balances: whatever perturbs a balance, the hashes no longer re-derive.
    expect(() => verifyDistributionIntegrity(a4)).toThrow(/root does not derive|leaf mismatch/);
  });

  test("rejects broken reconciliation identities", () => {
    const badSum = artifactJson();
    (badSum.reconciliation as Record<string, unknown>).entries_total = 1;
    expect(() => parseDistributionArtifact(badSum)).toThrow(/Σ persisted balances/);

    const badIdentity = artifactJson();
    (badIdentity.reconciliation as Record<string, unknown>).sink_exclusions_total = 5;
    expect(() => parseDistributionArtifact(badIdentity)).toThrow(/entries \+ sinks != enumerated/);

    const badSupply = artifactJson();
    const badRec = badSupply.reconciliation as Record<string, unknown>;
    badRec.sink_exclusions_total = 1; // identity holds: 6000 + 1 = 6001
    badRec.enumerated_total = Number(SUPPLY) + 1;
    expect(() => parseDistributionArtifact(badSupply)).toThrow(/enumerated_total != lp_total_supply_at_snapshot/);
  });

  test("the SDK tree builder is the byte-order authority — string order is not enough", () => {
    // Find a real (a, b) pair whose base58 STRING order disagrees with pubkey
    // BYTE order (the SDK documents a few-percent probability per pair; the
    // snapshotter hit this in FLEET-M0 audit F7). Build a 2-entry artifact in
    // the string-ascending order with correctly re-derived leaves/proofs, so
    // ONLY the ordering semantics is under test: the schema layer accepts the
    // string-ascending set, and the tree builder — the byte-order authority —
    // rejects it; the contract turns that into a fail-closed ClaimsError.
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed;
    };
    const keys: PublicKey[] = [];
    while (keys.length < 300) {
      const b = new Uint8Array(32);
      for (let k = 0; k < 32; k++) b[k] = next() & 0xff;
      keys.push(new PublicKey(b));
    }
    let pair: [PublicKey, PublicKey] | null = null;
    outer: for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i]!;
        const b = keys[j]!;
        const strAsc = a.toBase58() < b.toBase58();
        const byteAsc = Buffer.compare(Buffer.from(a.toBytes()), Buffer.from(b.toBytes())) < 0;
        if (strAsc !== byteAsc) {
          pair = strAsc ? [a, b] : [b, a]; // string-ascending order
          break outer;
        }
      }
    }
    if (pair === null) return; // vacuous environment — no divergent pair found
    const [first, second] = pair;
    // Canonical (BYTE-sorted) tree — the leaves/proofs the artifact would
    // carry if it had been sealed honestly over this two-holder set.
    const byteSorted = Buffer.compare(Buffer.from(first!.toBytes()), Buffer.from(second!.toBytes())) < 0
      ? [first!, second!]
      : [second!, first!];
    const balA = 1_000n;
    const balB = 2_000n;
    const tree2 = SnapshotMerkleTree.fromEntries([
      { owner: byteSorted[0]!, lpBalance: balA },
      { owner: byteSorted[1]!, lpBalance: balB },
    ]);
    const leafOf = new Map<string, string>([
      [byteSorted[0]!.toBase58(), hex(tree2.leaf(0)!)],
      [byteSorted[1]!.toBase58(), hex(tree2.leaf(1)!)],
    ]);
    const proofOf = new Map<string, string[]>([
      [byteSorted[0]!.toBase58(), tree2.proof(0)!.map((p) => hex(p))],
      [byteSorted[1]!.toBase58(), tree2.proof(1)!.map((p) => hex(p))],
    ]);
    const raw = {
      format_version: DISTRIBUTION_FORMAT_VERSION,
      pool_address: POOL,
      amm_program_id: AMM,
      lp_mint: MINT,
      snapshot_slot: 1,
      lp_total_supply_at_snapshot: 3_000,
      merkle_root: hex(tree2.root()),
      leaf_count: 2,
      tree_depth: tree2.treeDepth(),
      // Entries in STRING-ascending order — each with its own correct
      // leaf/proof. Only the ORDER is wrong.
      entries: [first!, second!].map((o) => ({
        owner: o.toBase58(),
        lp_balance: o === byteSorted[0] ? 1_000 : 2_000,
        leaf: leafOf.get(o.toBase58()),
        proof: proofOf.get(o.toBase58()),
      })),
      reconciliation: { enumerated_total: 3_000, entries_total: 3_000, sink_exclusions_total: 0 },
    };
    // The set is string-ascending → the schema gate passes. If string order
    // disagreed with byte order, the tree builder MUST reject (fail-closed).
    const artifact = parseDistributionArtifact(raw);
    expect(() => verifyDistributionIntegrity(artifact)).toThrow(/tree builder rejected/);
  });
});

/* ── Privacy projection ─────────────────────────────────────────────── */

describe("publicDistribution — privacy projection", () => {
  test("carries no per-holder rows of any kind", () => {
    const pub = publicDistribution(parseOk()) as unknown as Record<string, unknown>;
    for (const forbidden of ["entries", "holders", "leafs", "proofs"]) {
      expect(pub[forbidden]).toBeUndefined();
    }
    expect(pub.integrity).toBe("verified");
    expect(pub.merkleRoot).toBe(REGISTRY_ROOT);
  });

  test("entryForWallet serves only the queried wallet's row", () => {
    const a = parseOk();
    const mine = entryForWallet(a, OWNERS[1]!.toBase58());
    expect(mine?.lpBalance).toBe(2_000n);
    expect(entryForWallet(a, pk(0x99).toBase58())).toBeNull();
  });
});

/* ── Normative claimable math ───────────────────────────────────────── */

describe("expectedClaimAmountLamports — mirrors claim_lp_proceeds.rs", () => {
  test("exact integer division (floor), u128 intermediate", () => {
    // 5_000_000 * 2_000 / 6_000 = 1_666_666.67 → floors to 1_666_666
    expect(expectedClaimAmountLamports(5_000_000n, 2_000n, 6_000n)).toBe(1_666_666n);
    // No-remainder case divides exactly.
    expect(expectedClaimAmountLamports(6_000n, 2_000n, 6_000n)).toBe(2_000n);
    // u128-scale operands must not overflow (u64::MAX-ish inputs).
    const big = (1n << 64n) - 1n;
    expect(expectedClaimAmountLamports(big, big, big)).toBe(big);
  });

  test("rejects zero supply and zero balance (on-chain parity)", () => {
    expect(() => expectedClaimAmountLamports(1n, 1n, 0n)).toThrow(/positive/);
    expect(() => expectedClaimAmountLamports(1n, 0n, 1n)).toThrow(/positive/);
  });
});

/* ── The wallet claim state machine ─────────────────────────────────── */

describe("walletClaimView — the owner's claim-state vocabulary", () => {
  const W = OWNERS[1]!.toBase58(); // in the leaf set, balance 2_000
  const OUTSIDE = pk(0x99).toBase58(); // not in the leaf set

  test("claimable: leaf + verified proof + no record → expected amount + prepared claim", () => {
    const v = viewFor(W);
    expect(v.state).toBe("claimable");
    expect(v.proofStatus).toBe("verified");
    expect(v.claimableLamports).toBe("1666666"); // 5_000_000 * 2_000 / 6_000
    expect(v.claimedLamports).toBe("0");
    expect(v.remainingLamports).toBe("1666666");
    expect(v.preparedClaim).not.toBeNull();
    expect(v.amountNote).toMatch(/final amount is determined on-chain/);
  });

  test("claimed: the on-chain ClaimRecord is the paid evidence — checked FIRST", () => {
    const v = viewFor(W, {
      claimRecord: {
        pda: "Rec1111111111111111111111111111111111111111",
        amountLamports: "1666666",
        lpBalanceAtSnapshot: "2000",
        claimedAtSlot: "331999999",
        claimedAtTs: 1_800_000_000_000,
      },
    });
    expect(v.state).toBe("claimed");
    expect(v.claimedLamports).toBe("1666666");
    expect(v.remainingLamports).toBe("0");
    expect(v.preparedClaim).toBeNull(); // no claim is prepared for a claimed wallet
  });

  test("claimed wins even when the artifact is unusable (chain fact first)", () => {
    const v = viewFor(W, {
      artifact: null,
      claimRecord: {
        pda: "Rec1111111111111111111111111111111111111111",
        amountLamports: "1666666",
        lpBalanceAtSnapshot: "2000",
        claimedAtSlot: "331999999",
        claimedAtTs: null,
      },
    });
    expect(v.state).toBe("claimed");
  });

  test("no-claim-record: registry absent on-chain → nothing found", () => {
    const v = viewFor(OUTSIDE, { registryAbsent: true, registry: null });
    expect(v.state).toBe("no-claim-record");
    expect(v.reason).toMatch(/No claim record found/);
  });

  test("snapshot-unavailable: artifact missing → eligibility UNKNOWN, not ineligible", () => {
    const v = viewFor(OUTSIDE, { artifact: null });
    expect(v.state).toBe("snapshot-unavailable");
    expect(v.reason).toMatch(/Snapshot unavailable/);
  });

  test("snapshot-unavailable: registry read failed → unknown, with the error carried", () => {
    const v = viewFor(W, { registry: null, registryError: "rpc http 503" });
    expect(v.state).toBe("snapshot-unavailable");
    expect(v.reason).toMatch(/rpc http 503/);
  });

  test("snapshot-unavailable: artifact root ≠ on-chain root → unbound proofs refused", () => {
    const v = viewFor(W, { registry: { ...REGISTRY, merkleRoot: "f".repeat(64) } });
    expect(v.state).toBe("snapshot-unavailable");
    expect(v.reason).toMatch(/does not match/);
  });

  test("wallet-not-eligible: healthy distribution, wallet holds no leaf", () => {
    const v = viewFor(OUTSIDE);
    expect(v.state).toBe("wallet-not-eligible");
    expect(v.reason).toMatch(/no leaf/);
    expect(v.preparedClaim).toBeNull();
  });

  test("proof-unavailable: leaf present but proof fails against the on-chain root", () => {
    // Tamper ONLY this entry's persisted proof (integrity would fail on the
    // whole artifact — simulate the defense-in-depth per-entry check by
    // handing the machine a verified-marked artifact whose entry was
    // mutated after verification).
    const a = parseOk();
    const entry = a.entries[1]!;
    a.entries[1] = { ...entry, proof: entry.proof.map((p) => "0".repeat(64)) };
    const v = walletClaimView({
      wallet: W,
      artifact: a,
      registry: REGISTRY,
      registryAbsent: false,
      registryError: null,
      claimRecord: null,
      claimRecordError: false,
      vaultProgramId: pk(0x55).toBase58(),
    });
    expect(v.state).toBe("proof-unavailable");
    expect(v.proofStatus).toBe("failed");
    expect(v.claimableLamports).toBeNull();
    expect(v.preparedClaim).toBeNull();
  });

  test("claimRecordError blocks the claimable path (unreadable ≠ never claimed)", () => {
    const v = viewFor(W, { claimRecordError: true });
    expect(v.state).toBe("snapshot-unavailable");
    expect(v.reason).toMatch(/claim record could not be read/);
  });

  test("the state machine never returns claimable without a prepared instruction", () => {
    const v = viewFor(W);
    if (v.state === "claimable") {
      expect(v.preparedClaim).not.toBeNull();
    }
    const outside = viewFor(OUTSIDE);
    if (outside.state === "claimable") throw new Error("outside wallet rendered claimable");
  });
});
