// Claims transport battery (P4.4) — the source resolver and the client-side
// hydration gate. Core invariant, same as 4.1/4.2/4.3: a stale, missing,
// corrupt or integrity-failed distribution can NEVER present as fresh/real
// data, and a payload that fails client-side re-validation renders as
// unavailable — never as claims data.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import { SnapshotMerkleTree } from "../vendor/graveyield-sdk/merkle";
import {
  DEFAULT_CLAIMS_MAX_AGE_MS,
  claimsBytesToPayload,
  parseClaimsMaxAgeMs,
  resolveClaimsSource,
} from "../claimsSource";
import {
  asCachedClaimsDisplay,
  claimsTransportDataState,
  effectiveClaimsState,
  hydrateClaimsPayload,
  resolveDisplayClaimsPayload,
} from "../claimsTransport";
import { PublicKey } from "@solana/web3.js";

/* ── Fixture — a sealed artifact built through the canonical SDK ────── */

function pk(byte: number): PublicKey {
  const b = new Uint8Array(32);
  b[0] = byte;
  return new PublicKey(b);
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const TREE = SnapshotMerkleTree.fromEntries([
  { owner: pk(0x11), lpBalance: 1_000n },
  { owner: pk(0x22), lpBalance: 2_000n },
]);
const POOL = pk(0x42).toBase58();

function artifactJson(): Record<string, unknown> {
  return {
    format_version: 1,
    pool_address: POOL,
    amm_program_id: pk(0x43).toBase58(),
    lp_mint: pk(0x44).toBase58(),
    snapshot_slot: 331_902_118,
    lp_total_supply_at_snapshot: 3_000,
    merkle_root: hex(TREE.root()),
    leaf_count: 2,
    tree_depth: 1,
    entries: [
      { owner: pk(0x11).toBase58(), lp_balance: 1_000, leaf: hex(TREE.leaf(0)!), proof: TREE.proof(0)!.map((p) => hex(p)) },
      { owner: pk(0x22).toBase58(), lp_balance: 2_000, leaf: hex(TREE.leaf(1)!), proof: TREE.proof(1)!.map((p) => hex(p)) },
    ],
    reconciliation: { enumerated_total: 3_000, entries_total: 3_000, sink_exclusions_total: 0 },
  };
}

const NOW = 1_800_000_000_000;
const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/* ── Freshness-budget env parsing ───────────────────────────────────── */

describe("parseClaimsMaxAgeMs", () => {
  test("unset/empty → null (the default applies); garbage → null (rejected, not guessed)", () => {
    expect(parseClaimsMaxAgeMs(null)).toBeNull();
    expect(parseClaimsMaxAgeMs(undefined)).toBeNull();
    expect(parseClaimsMaxAgeMs("")).toBeNull();
    expect(parseClaimsMaxAgeMs("   ")).toBeNull();
    expect(parseClaimsMaxAgeMs("abc")).toBeNull();
    expect(parseClaimsMaxAgeMs("-5")).toBeNull();
    expect(parseClaimsMaxAgeMs("1.5")).toBeNull();
  });
  test("a positive integer passes through", () => {
    expect(parseClaimsMaxAgeMs("1234")).toBe(1234);
  });
});

/* ── Source resolver states ─────────────────────────────────────────── */

function deps(over: Partial<Parameters<typeof resolveClaimsSource>[1]> = {}) {
  return {
    nowMs: NOW,
    readFile: async () => bytes(artifactJson()),
    statSize: async () => null,
    fetchImpl: (async () => new Response(JSON.stringify(artifactJson()), { status: 200 })) as unknown as typeof fetch,
    ...over,
  } as Parameters<typeof resolveClaimsSource>[1];
}

describe("resolveClaimsSource — four artifact states", () => {
  test("no source configured → missing / unavailable, honest reason", async () => {
    const r = await resolveClaimsSource({}, deps());
    expect(r.payload.artifactState).toBe("missing");
    expect(r.payload.dataState).toBe("unavailable");
    expect(r.payload.reasonCode).toBe("NO_SOURCE_CONFIGURED");
    expect(r.artifact).toBeNull();
  });

  test("both sources configured → SOURCE_CONFLICT", async () => {
    const r = await resolveClaimsSource(
      { GY_CLAIMS_PATH: "/a", GY_CLAIMS_URL: "https://x" },
      deps(),
    );
    expect(r.payload.reasonCode).toBe("SOURCE_CONFLICT");
    expect(r.payload.dataState).toBe("unavailable");
  });

  test("unreadable path → missing; valid path → real with privacy-stripped projection", async () => {
    const bad = await resolveClaimsSource(
      { GY_CLAIMS_PATH: "/gone/artifact.json" },
      deps({ readFile: async () => { throw new Error("EACCES"); } }),
    );
    expect(bad.payload.artifactState).toBe("missing");
    expect(bad.payload.reasonCode).toBe("READ_FAILED");

    const good = await resolveClaimsSource({ GY_CLAIMS_PATH: "/mnt/dist.json" }, deps());
    expect(good.payload.artifactState).toBe("valid");
    expect(good.payload.dataState).toBe("real");
    expect(good.artifact).not.toBeNull();
    // Privacy: the projection carries counts, never rows.
    const d = good.payload.distribution!;
    expect(d.leafCount).toBe(2);
    expect((d as unknown as Record<string, unknown>).entries).toBeUndefined();
  });

  test("HTTP failure and network failure → missing", async () => {
    const http = await resolveClaimsSource(
      { GY_CLAIMS_URL: "https://x/artifact.json" },
      deps({ fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch }),
    );
    expect(http.payload.artifactState).toBe("missing");
    expect(http.payload.reasonCode).toBe("FETCH_HTTP_STATUS");

    const net = await resolveClaimsSource(
      { GY_CLAIMS_URL: "https://x/artifact.json" },
      deps({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch }),
    );
    expect(net.payload.reasonCode).toBe("FETCH_FAILED");
  });

  test("oversize transport cap → corrupt (OVERSIZE)", async () => {
    const r = await resolveClaimsSource(
      { GY_CLAIMS_PATH: "/mnt/dist.json" },
      deps({ maxBytes: 10 }),
    );
    expect(r.payload.artifactState).toBe("corrupt");
    expect(r.payload.reasonCode).toBe("OVERSIZE");
  });

  test("invalid JSON / schema violation / integrity failure → corrupt with distinct codes", async () => {
    const badJson = await resolveClaimsSource(
      { GY_CLAIMS_PATH: "/mnt/dist.json" },
      deps({ readFile: async () => new TextEncoder().encode("{not json") }),
    );
    expect(badJson.payload.reasonCode).toBe("PARSE_FAILED");

    const badSchema = await resolveClaimsSource(
      { GY_CLAIMS_PATH: "/mnt/dist.json" },
      deps({ readFile: async () => bytes({ format_version: 9 }) }),
    );
    expect(badSchema.payload.reasonCode).toBe("PARSE_FAILED");
    expect(badSchema.payload.reason).toMatch(/format_version/);

    const tampered = artifactJson();
    (tampered.merkle_root as string) = "0".repeat(64);
    const badIntegrity = await resolveClaimsSource(
      { GY_CLAIMS_PATH: "/mnt/dist.json" },
      deps({ readFile: async () => bytes(tampered) }),
    );
    expect(badIntegrity.payload.reasonCode).toBe("INTEGRITY_FAILED");
    expect(badIntegrity.payload.dataState).toBe("unavailable"); // corrupt is never real
  });
});

/* ── bytesToPayload — direct contract gate ──────────────────────────── */

describe("claimsBytesToPayload", () => {
  const source = { kind: "path" as const, uri: "/mnt/dist.json" };

  test("valid bytes → verified distribution attached, artifact handed to the route", () => {
    const r = claimsBytesToPayload(bytes(artifactJson()), { nowMs: NOW, checkedAtUnixMs: NOW, source, maxAgeMs: DEFAULT_CLAIMS_MAX_AGE_MS });
    expect(r.payload.artifactState).toBe("valid");
    expect(r.payload.distribution?.integrity).toBe("verified");
    expect(r.payload.distribution?.merkleRoot).toBe(hex(TREE.root()));
    expect(r.artifact?.entries.length).toBe(2);
  });

  test("the parsed artifact retains exact BigInt balances for the claim math", () => {
    const r = claimsBytesToPayload(bytes(artifactJson()), { nowMs: NOW, checkedAtUnixMs: NOW, source, maxAgeMs: 1000 });
    expect(r.artifact?.entries[1]?.lpBalance).toBe(2_000n);
    expect(r.artifact?.reconciliation.entriesTotal).toBe(3_000n);
  });
});

/* ── Client hydration gate ──────────────────────────────────────────── */

function validPayloadJson(): Record<string, unknown> {
  return {
    artifactState: "valid",
    dataState: "real",
    reason: null,
    reasonCode: null,
    source: { kind: "path", uri: "/mnt/dist.json" },
    checkedAtUnixMs: NOW,
    ageMs: 0,
    maxAgeMs: DEFAULT_CLAIMS_MAX_AGE_MS,
    distribution: {
      formatVersion: 1,
      poolAddress: POOL,
      ammProgramId: pk(0x43).toBase58(),
      lpMint: pk(0x44).toBase58(),
      snapshotSlot: 331_902_118,
      lpTotalSupplyAtSnapshot: "3000",
      merkleRoot: hex(TREE.root()),
      leafCount: 2,
      treeDepth: 1,
      reconciliation: { enumeratedTotal: "3000", entriesTotal: "3000", sinkExclusionsTotal: "0" },
      integrity: "verified",
    },
    onchain: null,
    wallet: {
      wallet: pk(0x11).toBase58(),
      poolAddress: POOL,
      state: "claimable",
      reason: null,
      entry: { lpBalanceAtSnapshot: "1000", leaf: hex(TREE.leaf(0)!), proof: TREE.proof(0)!.map((p) => hex(p)) },
      proofStatus: "verified",
      claimRecord: null,
      claimableLamports: "1000",
      claimedLamports: "0",
      remainingLamports: "1000",
      preparedClaim: {
        programId: pk(0x50).toBase58(),
        keys: [{ pubkey: pk(0x51).toBase58(), isSigner: false, isWritable: true }],
        data: "AAA=",
      },
      amountNote: "final amount determined on-chain at claim time",
    },
  };
}

describe("hydrateClaimsPayload — client-side fail-closed gate", () => {
  test("a clean payload hydrates with its projections", () => {
    const p = hydrateClaimsPayload(validPayloadJson(), NOW);
    expect(p).not.toBeNull();
    expect(p?.distribution?.leafCount).toBe(2);
    expect(p?.wallet?.state).toBe("claimable");
    expect(p?.wallet?.preparedClaim?.data).toBe("AAA=");
  });

  test("envelope dishonesty (dataState ≠ the mapping's promise) → null", () => {
    const bad = { ...validPayloadJson(), dataState: "stale" };
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("a failed state carrying a distribution → null (no payload may ride along)", () => {
    const bad = { ...validPayloadJson(), artifactState: "corrupt" };
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("a distribution projection carrying per-holder rows → rejected (privacy)", () => {
    const bad = validPayloadJson();
    (bad.distribution as Record<string, unknown>).entries = [{ owner: "x" }];
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("integrity claim other than verified → rejected", () => {
    const bad = validPayloadJson();
    (bad.distribution as Record<string, unknown>).integrity = "none";
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("unknown wallet state vocabulary → rejected", () => {
    const bad = validPayloadJson();
    (bad.wallet as Record<string, unknown>).state = "paid";
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("present-but-invalid onchain half poisons the envelope (fail-closed)", () => {
    const bad = { ...validPayloadJson(), onchain: { checkedAtUnixMs: "not-a-number" } };
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("a future-dated check timestamp → rejected (never fresh)", () => {
    const bad = validPayloadJson();
    (bad.checkedAtUnixMs as number) = NOW + 10 * 60_000;
    expect(hydrateClaimsPayload(bad, NOW)).toBeNull();
  });

  test("missing artifact states may carry onchain/wallet but never a distribution", () => {
    const missing = {
      ...validPayloadJson(),
      artifactState: "missing",
      dataState: "unavailable",
      distribution: null,
      reason: "No distribution source configured",
    };
    const p = hydrateClaimsPayload(missing, NOW);
    expect(p).not.toBeNull();
    expect(p?.distribution).toBeNull();
  });
});

/* ── Wall-clock freshness + cached holding (D5) ─────────────────────── */

describe("effectiveClaimsState / resolveDisplayClaimsPayload / asCachedClaimsDisplay", () => {
  test("transportDataState mapping is honest", () => {
    expect(claimsTransportDataState("valid")).toBe("real");
    expect(claimsTransportDataState("stale")).toBe("stale");
    expect(claimsTransportDataState("missing")).toBe("unavailable");
    expect(claimsTransportDataState("corrupt")).toBe("unavailable");
  });

  test("a valid payload degrades to stale past its budget — never upgrades", () => {
    const good = hydrateClaimsPayload(validPayloadJson(), NOW)!;
    const aged = effectiveClaimsState(good, NOW + DEFAULT_CLAIMS_MAX_AGE_MS + 1);
    expect(aged.artifactState).toBe("stale");
    expect(aged.dataState).toBe("stale");
    expect(aged.reason).toMatch(/freshness budget/);
    // And the reverse direction cannot happen:
    const re = effectiveClaimsState(aged, NOW);
    expect(re.artifactState).toBe("stale");
  });

  test("within the budget the payload stays real", () => {
    const good = hydrateClaimsPayload(validPayloadJson(), NOW)!;
    const still = effectiveClaimsState(good, NOW + 1_000);
    expect(still.dataState).toBe("real");
  });

  test("a failed refresh holds the last good payload as cached; staleness wins", () => {
    const good = hydrateClaimsPayload(validPayloadJson(), NOW)!;
    const cached = asCachedClaimsDisplay(good, NOW + 1_000);
    expect(cached.dataState).toBe("cached");
    const cachedStale = asCachedClaimsDisplay(good, NOW + DEFAULT_CLAIMS_MAX_AGE_MS + 1);
    expect(cachedStale.dataState).toBe("stale");
  });

  test("resolveDisplayClaimsPayload: latest good → latest; latest failed → cached; nothing → null", () => {
    const good = hydrateClaimsPayload(validPayloadJson(), NOW)!;
    const failed = { ...good, artifactState: "missing" as const, dataState: "unavailable" as const, distribution: null };
    expect(resolveDisplayClaimsPayload(good, null, NOW)?.distribution).not.toBeNull();
    expect(resolveDisplayClaimsPayload(failed, good, NOW)?.dataState).toBe("cached");
    expect(resolveDisplayClaimsPayload(failed, null, NOW)).toBeNull();
  });
});
