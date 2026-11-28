// D4 claims verification battery — producer/consumer schema compatibility,
// stable-pointer identity, stale/cached non-actionability, and on-chain
// binding. Companion to the grave-indexer D4 publication (PR: claims
// stable-pointer contract mirrored in claimsStablePointer.ts).
//
/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { SnapshotMerkleTree } from "../vendor/graveyield-sdk/merkle";

import {
  parseAndVerifyDistributionFromText,
  parseDistributionArtifact,
  walletClaimView,
  type RegistryFacts,
} from "../claimsContract";
import { claimsBytesToPayload } from "../claimsSource";
import {
  parseClaimsStablePointer,
  verifyClaimsPointerMatchesBytes,
  ClaimsPointerError,
  CLAIMS_POINTER_SCHEMA,
} from "../claimsStablePointer";
import { effectiveClaimsState, hydrateClaimsPayload, type ClaimsTransportPayload } from "../claimsTransport";
import { resolveClaimsStablePointer } from "../claimsStablePointerResolver";
import { enforceActionableClaimsSourcePolicy } from "../claimsSource";
import { parseAndVerifyDistributionFromText as _p } from "../claimsContract";
void _p;

function pk(byte: number): PublicKey {
  const b = new Uint8Array(32);
  b[0] = byte;
  return new PublicKey(b);
}
function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

const OWNERS = [pk(0x11), pk(0x22)];
const BALANCES = [1_000n, 2_000n];
const TREE = SnapshotMerkleTree.fromEntries(OWNERS.map((o, i) => ({ owner: o, lpBalance: BALANCES[i]! })));
const POOL = pk(0x42).toBase58();
const AMM = pk(0x43).toBase58();
const MINT = pk(0x44).toBase58();
const UNCX = "GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo";
const SLOT = 331_902_118;

function artifactText(overrides: Record<string, unknown> = {}): string {
  const doc = {
    format_version: 2,
    pool_address: POOL,
    amm_program_id: AMM,
    lp_mint: MINT,
    snapshot_slot: SLOT,
    lp_total_supply_at_snapshot: 3_000,
    merkle_root: hex(TREE.root()),
    leaf_count: 2,
    tree_depth: 1,
    entries: OWNERS.map((o, i) => ({
      owner: o.toBase58(),
      lp_balance: Number(BALANCES[i]),
      leaf: hex(TREE.leaf(i)!),
      proof: TREE.proof(i)!.map((p) => hex(p)),
    })),
    reconciliation: { enumerated_total: 3_000, entries_total: 3_000, sink_exclusions_total: 0 },
    exclusions: [],
    locked: { lock_records_seen: 0, total_locked: 0, attributions: [], custody: null },
    provenance: {
      sink_ledger: null,
      lock_evidence: {
        source: "rpc",
        program_id: UNCX,
        commitment: "confirmed",
        anchor_slot: SLOT,
        records_seen: 0,
        total_locked: 0,
      },
    },
    ...overrides,
  };
  return JSON.stringify(doc);
}

function registry(): RegistryFacts {
  return {
    merkleRoot: hex(TREE.root()),
    ammProgramId: AMM,
    lpTotalSupplyAtSnapshot: 3_000n,
    lpHolderPoolTotalLamports: 1_000_000n,
  };
}

describe("D4: claims contract — producer/consumer schema compatibility", () => {
  test("a D2 claims-grade v2 artifact (full provenance) parses and verifies", () => {
    const a = parseAndVerifyDistributionFromText(artifactText());
    expect(a.formatVersion).toBe(2);
    expect(a.provenance.lockEvidence.programId).toBe(UNCX);
    expect(a.provenance.sinkLedger).toBeNull();
    expect(a.exclusions).toEqual([]);
  });

  test("a legacy v1 artifact (no v2 fields) fails closed at the schema gate", () => {
    const v1 = JSON.parse(artifactText()) as Record<string, unknown>;
    v1.format_version = 1;
    delete v1.exclusions;
    delete v1.locked;
    delete v1.provenance;
    expect(() => parseDistributionArtifact(v1)).toThrow(/format_version 1/);
    // Through the full bytes gate → corrupt, never rendered.
    const res = claimsBytesToPayload(new TextEncoder().encode(JSON.stringify(v1)), {
      nowMs: 1_800_000_000_000,
      checkedAtUnixMs: 1_800_000_000_000,
      source: { kind: "url", uri: null },
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(res.payload.artifactState).toBe("corrupt");
    expect(res.artifact).toBeNull();
  });

  test("missing provenance / wrong UNCX program / anchor-slot drift fail closed", () => {
    const noProv = JSON.parse(artifactText()) as Record<string, unknown>;
    delete noProv.provenance;
    expect(() => parseDistributionArtifact(noProv)).toThrow(/provenance is REQUIRED/);
    const badProgram = JSON.parse(artifactText()) as Record<string, unknown>;
    const prov = badProgram.provenance as Record<string, unknown>;
    const le = prov.lock_evidence as Record<string, unknown>;
    le.program_id = pk(0x99).toBase58();
    expect(() => parseDistributionArtifact(badProgram)).toThrow(/lock_evidence.program_id/);
    const badAnchor = JSON.parse(artifactText()) as Record<string, unknown>;
    ((badAnchor.provenance as Record<string, unknown>).lock_evidence as Record<string, unknown>).anchor_slot = SLOT + 1;
    expect(() => parseDistributionArtifact(badAnchor)).toThrow(/anchor_slot/);
    const badSource = JSON.parse(artifactText()) as Record<string, unknown>;
    ((badSource.provenance as Record<string, unknown>).lock_evidence as Record<string, unknown>).source = "file";
    expect(() => parseDistributionArtifact(badSource)).toThrow(/lock_evidence.source/);
  });

  test("a u64 above 2^53 is represented EXACTLY and unsafe representations are refused", () => {
    // (a) An exact u64 above 2^53, carried as an exact bigint (the shape the
    // Node ≥ 21 exact-parse reviver produces in production), must assert as
    // the exact expected bigint.
    const exact = 9_223_372_036_854_775_807n;
    const a = parseDistributionArtifact({
      format_version: 2, pool_address: POOL, amm_program_id: AMM, lp_mint: MINT,
      snapshot_slot: 1, lp_total_supply_at_snapshot: exact,
      merkle_root: "0".repeat(64), leaf_count: 1, tree_depth: 0,
      entries: [{ owner: pk(0x71).toBase58(), lp_balance: exact, leaf: "0".repeat(64), proof: [] }],
      reconciliation: { enumerated_total: exact, entries_total: exact, sink_exclusions_total: 0 },
      exclusions: [], locked: { lock_records_seen: 0, total_locked: 0, attributions: [], custody: null },
      provenance: { sink_ledger: null, lock_evidence: { source: "rpc", program_id: UNCX, commitment: "confirmed", anchor_slot: 1, records_seen: 0, total_locked: 0 } },
    });
    expect(a.lpTotalSupplyAtSnapshot).toBe(exact);
    expect(a.entries[0]!.lpBalance).toBe(exact);
    // (b) The rounded value a naive JSON.parse produces is NOT a safe
    // integer and is refused — never trusted.
    const rounded = 9223372036854776000 as unknown as bigint;
    expect(() =>
      parseDistributionArtifact({
        format_version: 2, pool_address: POOL, amm_program_id: AMM, lp_mint: MINT,
        snapshot_slot: 1, lp_total_supply_at_snapshot: rounded,
        merkle_root: "0".repeat(64), leaf_count: 0, tree_depth: 0,
        entries: [], reconciliation: { enumerated_total: rounded, entries_total: 0, sink_exclusions_total: 0 },
        exclusions: [], locked: { lock_records_seen: 0, total_locked: 0, attributions: [], custody: null },
        provenance: { sink_ledger: null, lock_evidence: { source: "rpc", program_id: UNCX, commitment: "confirmed", anchor_slot: 1, records_seen: 0, total_locked: 0 } },
      }),
    ).toThrow(/exact|non-negative|safe|integer/i);
  });

  test("a rounded / negative / u64-overflow representation is REFUSED (review: strict u64)", () => {
    // The float-rounded value a naive JSON.parse produces:
    const rounded = 9223372036854776000;
    expect(Number.isSafeInteger(rounded)).toBe(false);
    expect(() =>
      parseDistributionArtifact({
        format_version: 2,
        pool_address: POOL, amm_program_id: AMM, lp_mint: MINT,
        snapshot_slot: 1, lp_total_supply_at_snapshot: rounded,
        merkle_root: "0".repeat(64), leaf_count: 0, tree_depth: 0,
        entries: [], reconciliation: { enumerated_total: rounded, entries_total: 0, sink_exclusions_total: 0 },
        exclusions: [], locked: { lock_records_seen: 0, total_locked: 0, attributions: [], custody: null },
        provenance: { sink_ledger: null, lock_evidence: { source: "rpc", program_id: UNCX, commitment: "confirmed", anchor_slot: 1, records_seen: 0, total_locked: 0 } },
      }),
    ).toThrow(/exact|non-negative|u64/i);
    // Negative:
    expect(() =>
      parseDistributionArtifact({
        format_version: 2, pool_address: POOL, amm_program_id: AMM, lp_mint: MINT,
        snapshot_slot: 1, lp_total_supply_at_snapshot: -5,
        merkle_root: "0".repeat(64), leaf_count: 0, tree_depth: 0,
        entries: [], reconciliation: { enumerated_total: -5, entries_total: 0, sink_exclusions_total: 0 },
        exclusions: [], locked: { lock_records_seen: 0, total_locked: 0, attributions: [], custody: null },
        provenance: { sink_ledger: null, lock_evidence: { source: "rpc", program_id: UNCX, commitment: "confirmed", anchor_slot: 1, records_seen: 0, total_locked: 0 } },
      }),
    ).toThrow(/non-negative|negative|integer/i);
    // Above 2^64-1 (exact bigint from raw source text):
    expect(() =>
      parseDistributionArtifact({ format_version: 2, snapshot_slot: 18446744073709551616n } as unknown as Record<string, unknown>),
    ).toThrow();
  });
});

describe("D4: claims stable pointer (consumer-side identity)", () => {
  function pointerJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      pointerSchema: CLAIMS_POINTER_SCHEMA,
      stableRef: "claims-artifact-prod",
      versionedTag: "claims-artifact-prod-20261127T000000Z-aaaaaaaaaaaa",
      sourceCommit: "a".repeat(40),
      publishedAtUnixMs: 1_800_000_000_000,
      artifact: { name: "claims-artifact.json", sha256: "b".repeat(64), byteLength: 10 },
      manifest: { name: "claims-artifact-manifest.json", sha256: "c".repeat(64), byteLength: 2 },
      checksum: { name: "claims-artifact.sha256", sha256: "d".repeat(64), byteLength: 71 },
      artifactSchemaVersion: 2,
      pool: POOL,
      lpMint: MINT,
      snapshotSlot: SLOT,
      merkleRoot: hex(TREE.root()),
      producer: { identity: "grave-snapshotter-cli", version: "1" },
      previousVersionedTag: null,
      previousTagObjectSha: null,
      ...overrides,
    });
  }

  test("a well-formed claims pointer parses strictly", () => {
    const p = parseClaimsStablePointer(pointerJson());
    expect(p.pointerSchema).toBe(CLAIMS_POINTER_SCHEMA);
    expect(p.versionedTag.startsWith("claims-artifact-prod-")).toBe(true);
  });

  test("unknown keys, foreign schema, wrong tag namespace, and incoherent previous-pointer refuse", () => {
    const obj = JSON.parse(pointerJson()) as Record<string, unknown>;
    obj.extra = 1;
    expect(() => parseClaimsStablePointer(JSON.stringify(obj))).toThrow();
    const foreign = JSON.parse(pointerJson({ pointerSchema: "graveyield.console-snapshot-stable-pointer.v1" }));
    expect(() => parseClaimsStablePointer(foreign)).toThrow();
    const wrongTag = JSON.parse(pointerJson({ versionedTag: "console-snapshot-prod-20261127T000000Z-aaaaaaaaaaaa" }));
    expect(() => parseClaimsStablePointer(wrongTag)).toThrow();
    const incoherent = JSON.parse(pointerJson({ previousVersionedTag: "claims-artifact-prod-20261126T000000Z-bbbbbbbbbbbb" }));
    expect(() => parseClaimsStablePointer(incoherent)).toThrow();
  });

  test("digest or byte-length mismatch refuses the bytes", () => {
    const p = parseClaimsStablePointer(pointerJson({ artifact: { name: "claims-artifact.json", sha256: "b".repeat(64), byteLength: 5 } }));
    const bytes = new TextEncoder().encode("12345");
    // wrong digest AND wrong length: both paths must refuse
    expect(() => verifyClaimsPointerMatchesBytes({ pointer: p, artifactBytes: bytes, manifestBytes: new TextEncoder().encode("{}"), checksumBytes: new TextEncoder().encode("x") })).toThrow(ClaimsPointerError);
    const pOk = parseClaimsStablePointer(pointerJson({
      artifact: { name: "claims-artifact.json", sha256: "b".repeat(64), byteLength: 5 },
      checksum: { name: "claims-artifact.sha256", sha256: "d".repeat(64), byteLength: 1 },
    }));
    expect(() => verifyClaimsPointerMatchesBytes({ pointer: pOk, artifactBytes: bytes, manifestBytes: new TextEncoder().encode("{}"), checksumBytes: new TextEncoder().encode("x") })).toThrow(/sha256/);
  });
});

describe("D4: stale/cached claims data is informational-only", () => {
  function payloadWithClaim(artifactState: "valid" | "stale"): ClaimsTransportPayload {
    return {
      artifactState,
      dataState: artifactState === "valid" ? "real" : "stale",
      reason: null,
      reasonCode: null,
      source: { kind: "url", uri: null },
      checkedAtUnixMs: 1_800_000_000_000,
      ageMs: 0,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      distribution: {
        formatVersion: 2,
        poolAddress: POOL,
        ammProgramId: AMM,
        lpMint: MINT,
        snapshotSlot: SLOT,
        lpTotalSupplyAtSnapshot: "3000",
        merkleRoot: hex(TREE.root()),
        leafCount: 2,
        treeDepth: 1,
        reconciliation: { enumeratedTotal: "3000", entriesTotal: "3000", sinkExclusionsTotal: "0" },
        integrity: "verified",
      },
      onchain: null,
      wallet: {
        wallet: OWNERS[0]!.toBase58(),
        poolAddress: POOL,
        claimRecordPda: null,
        state: "claimable",
        reason: null,
        entry: { lpBalanceAtSnapshot: "1000", leaf: hex(TREE.leaf(0)!), proof: TREE.proof(0)!.map((p) => hex(p)) },
        proofStatus: "verified",
        claimRecord: null,
        claimableLamports: "100",
        claimedLamports: "0",
        remainingLamports: "100",
        preparedClaim: { programId: "x", keys: [], data: "Yg==" },
        amountNote: null,
      },
    };
  }

  test("freshness degradation strips the prepared claim instruction", () => {
    const aged = effectiveClaimsState(payloadWithClaim("valid"), 1_800_000_000_000 + 8 * 24 * 60 * 60 * 1000);
    expect(aged.artifactState).toBe("stale");
    expect(aged.wallet?.preparedClaim).toBeNull();
    expect(aged.wallet?.state).toBe("claimable"); // informational row remains
    expect(aged.wallet?.claimableLamports).not.toBeNull();
  });

  test("the hydration gate refuses a stale envelope that still carries a prepared claim", () => {
    const dishonest = payloadWithClaim("stale");
    expect(hydrateClaimsPayload(JSON.parse(JSON.stringify(dishonest)), 1_800_000_000_100)).toBeNull();
    // And a valid envelope with a prepared claim hydrates fine.
    expect(hydrateClaimsPayload(JSON.parse(JSON.stringify(payloadWithClaim("valid"))), 1_800_000_000_100)).not.toBeNull();
  });
});

describe("D4: on-chain registry binding in the wallet state machine", () => {
  function view(registryOverrides: Partial<RegistryFacts>) {
    const a = parseAndVerifyDistributionFromText(artifactText());
    return walletClaimView({
      wallet: OWNERS[0]!.toBase58(),
      artifact: a,
      registry: { ...registry(), ...registryOverrides },
      registryAbsent: false,
      registryError: null,
      claimRecord: null,
      claimRecordError: false,
      vaultProgramId: pk(0x55).toBase58(),
    });
  }
  test("amm-program mismatch → snapshot-unavailable (no prepared claim)", () => {
    const v = view({ ammProgramId: pk(0x77).toBase58() });
    expect(v.state).toBe("snapshot-unavailable");
    expect(v.preparedClaim).toBeNull();
  });
  test("supply-pin mismatch → snapshot-unavailable (no prepared claim)", () => {
    const v = view({ lpTotalSupplyAtSnapshot: 3_001n });
    expect(v.state).toBe("snapshot-unavailable");
    expect(v.preparedClaim).toBeNull();
  });
  test("root mismatch → snapshot-unavailable; a matching registry yields claimable", () => {
    expect(view({ merkleRoot: "f".repeat(64) }).state).toBe("snapshot-unavailable");
    expect(view({}).state).toBe("claimable");
    expect(view({}).preparedClaim).not.toBeNull();
  });
});


describe("D4 review: hydration honesty across ALL non-valid states", () => {
  function envelope(artifactState: "valid" | "stale" | "missing" | "corrupt"): Record<string, unknown> {
    const base = {
      artifactState,
      dataState: artifactState === "valid" ? "real" : artifactState === "stale" ? "stale" : "unavailable",
      reason: artifactState === "valid" ? null : "injected reason",
      reasonCode: artifactState === "valid" ? null : "FETCH_FAILED",
      source: { kind: "url", uri: null },
      checkedAtUnixMs: 1_800_000_000_000,
      ageMs: 0,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      distribution: {
        formatVersion: 2,
        poolAddress: POOL,
        ammProgramId: AMM,
        lpMint: MINT,
        snapshotSlot: SLOT,
        lpTotalSupplyAtSnapshot: "3000",
        merkleRoot: hex(TREE.root()),
        leafCount: 2,
        treeDepth: 1,
        reconciliation: { enumeratedTotal: "3000", entriesTotal: "3000", sinkExclusionsTotal: "0" },
        integrity: "verified",
      },
      wallet: {
        wallet: OWNERS[0]!.toBase58(),
        poolAddress: POOL,
        claimRecordPda: null,
        state: "claimable",
        reason: null,
        entry: { lpBalanceAtSnapshot: "1000", leaf: hex(TREE.leaf(0)!), proof: TREE.proof(0)!.map((p) => hex(p)) },
        proofStatus: "verified",
        claimRecord: null,
        claimableLamports: "100",
        claimedLamports: "0",
        remainingLamports: "100",
        preparedClaim: { programId: "prog", keys: [], data: "Yg==" },
        amountNote: null,
      },
    } as Record<string, unknown>;
    return base;
  }

  test("a STALE envelope carrying a prepared claim is refused", () => {
    expect(hydrateClaimsPayload(envelope("stale"), 1_800_000_000_100)).toBeNull();
  });
  test("a MISSING envelope carrying a prepared claim is refused", () => {
    expect(hydrateClaimsPayload(envelope("missing"), 1_800_000_000_100)).toBeNull();
  });
  test("a CORRUPT envelope carrying a prepared claim is refused", () => {
    expect(hydrateClaimsPayload(envelope("corrupt"), 1_800_000_000_100)).toBeNull();
  });
  test("a VALID envelope carrying a prepared claim hydrates", () => {
    expect(hydrateClaimsPayload(envelope("valid"), 1_800_000_000_100)).not.toBeNull();
  });
});
describe("D4 review: manifest verification in the resolver chain", () => {
  function sha(b: Uint8Array): string {
    return createHash("sha256").update(b).digest("hex");
  }
  function chain(opts?: { tamperManifestDigest?: boolean; tamperManifestIdentity?: boolean }) {
    const artifact = Buffer.from(artifactText(), "utf8");
    const manifestDoc = {
      manifestSchema: "graveyield.claims-artifact-manifest.v1",
      artifact: {
        asset: "claims-artifact.json",
        sha256: sha(artifact),
        byteLength: artifact.byteLength,
        formatVersion: 2,
        pool: POOL,
        lpMint: MINT,
        snapshotSlot: SLOT,
        merkleRoot: hex(TREE.root()),
        producer: { identity: "grave-snapshotter-cli", version: "1" },
      },
      sourceCommit: "a".repeat(40),
      publishedAtUnixMs: 1_800_000_000_000,
    };
    if (opts?.tamperManifestIdentity) {
      (manifestDoc.artifact as Record<string, unknown>).pool = pk(0x99).toBase58();
    }
    const manifest = Buffer.from(JSON.stringify(manifestDoc), "utf8");
    const artifactDigest = sha(artifact);
    const manifestDigest = opts?.tamperManifestDigest ? "f".repeat(64) : sha(manifest);
    const checksum = Buffer.from(artifactDigest + "  claims-artifact.json\n", "utf8");
    const checksumDigest = sha(checksum);
    const pointerDoc = {
      pointerSchema: "graveyield.claims-artifact-stable-pointer.v1",
      stableRef: "claims-artifact-prod",
      versionedTag: "claims-artifact-prod-20261127T000000Z-aaaaaaaaaaaa",
      sourceCommit: "a".repeat(40),
      publishedAtUnixMs: 1_800_000_000_000,
      artifact: { name: "claims-artifact.json", sha256: artifactDigest, byteLength: artifact.byteLength },
      manifest: { name: "claims-artifact-manifest.json", sha256: manifestDigest, byteLength: manifest.byteLength },
      checksum: { name: "claims-artifact.sha256", sha256: checksumDigest, byteLength: checksum.byteLength },
      artifactSchemaVersion: 2,
      pool: POOL,
      lpMint: MINT,
      snapshotSlot: SLOT,
      merkleRoot: hex(TREE.root()),
      producer: { identity: "grave-snapshotter-cli", version: "1" },
      previousVersionedTag: null,
      previousTagObjectSha: null,
    };
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https:\/\/[^/]+/, "");
      if (path.includes("/git/ref/tags/claims-artifact-prod")) {
        return Response.json({ object: { sha: "9".repeat(40), type: "tag" } });
      }
      if (path.includes("/git/tags/")) {
        return Response.json({ message: JSON.stringify(pointerDoc), object: { sha: "a".repeat(40), type: "commit" } });
      }
      if (path.includes("claims-artifact.json")) return new Response(artifact, { status: 200 });
      if (path.includes("claims-artifact-manifest.json")) return new Response(manifest, { status: 200 });
      if (path.includes("claims-artifact.sha256")) return new Response(checksum, { status: 200 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, pointerDoc };
  }

  test("a fully verified chain (artifact + manifest + checksum) resolves", async () => {
    const { fetchImpl } = chain();
    const r = await resolveClaimsStablePointer(
      { GY_CLAIMS_GITHUB_REPO: "o/r" },
      { fetchImpl },
    );
    expect(r.artifactSha256).toBe(sha(Buffer.from(artifactText(), "utf8")));
    expect(r.manifest.manifestSchema).toBe("graveyield.claims-artifact-manifest.v1");
    expect(r.manifest.artifact.merkleRoot).toBe(hex(TREE.root()));
  });

  test("a manifest digest mismatch refuses the chain (asset-integrity)", async () => {
    const { fetchImpl } = chain({ tamperManifestDigest: true });
    await expect(
      resolveClaimsStablePointer({ GY_CLAIMS_GITHUB_REPO: "o/r" }, { fetchImpl }),
    ).rejects.toThrow(/manifest sha256/);
  });

  test("a manifest identity mismatch (pool drift vs pointer) refuses the chain", async () => {
    const { fetchImpl } = chain({ tamperManifestIdentity: true });
    await expect(
      resolveClaimsStablePointer({ GY_CLAIMS_GITHUB_REPO: "o/r" }, { fetchImpl }),
    ).rejects.toThrow(/mismatch/);
  });

  test("the stable reference is FIXED: GY_CLAIMS_STABLE_REF cannot redirect the chain", async () => {
    const { fetchImpl } = chain();
    const urls: string[] = [];
    const recording = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await resolveClaimsStablePointer(
      { GY_CLAIMS_GITHUB_REPO: "o/r", GY_CLAIMS_STABLE_REF: "attacker-controlled-ref" } as Parameters<typeof resolveClaimsStablePointer>[0],
      { fetchImpl: recording },
    );
    expect(urls.some((u) => u.includes("/git/ref/tags/claims-artifact-prod"))).toBe(true);
    expect(urls.some((u) => u.includes("attacker-controlled-ref"))).toBe(false);
  });
});

describe("D4 review: production source enforcement", () => {
  function claimableView(): ReturnType<typeof walletClaimView> {
    return walletClaimView({
      wallet: OWNERS[0]!.toBase58(),
      artifact: parseAndVerifyDistributionFromText(artifactText()),
      registry: registry(),
      registryAbsent: false,
      registryError: null,
      claimRecord: null,
      claimRecordError: false,
      vaultProgramId: pk(0x55).toBase58(),
    });
  }
  test("stable-pointer source keeps the actionable claim", () => {
    const v = enforceActionableClaimsSourcePolicy(claimableView(), "stable-pointer");
    expect(v.state).toBe("claimable");
    expect(v.preparedClaim).not.toBeNull();
  });
  test("path and url sources are informational-only (preparedClaim stripped, honest note)", () => {
    for (const kind of ["path", "url"] as const) {
      const v = enforceActionableClaimsSourcePolicy(claimableView(), kind);
      expect(v.preparedClaim).toBeNull();
      expect(v.state).toBe("claimable");
      expect(v.amountNote).toMatch(/informational-only|stable pointer/);
    }
  });
});
