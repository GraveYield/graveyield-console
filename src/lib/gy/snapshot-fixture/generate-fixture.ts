// Regenerates the console's committed snapshot fixture (src/lib/gy/snapshot.json)
// by calling the grave-indexer PRODUCTION serializer (`buildConsoleSnapshot`) —
// the exact code path that emits console-snapshot.json artifacts in
// `grave-indexer console-snapshot` (src/cli.ts). This is what makes the
// committed fixture a REAL producer artifact (bit-for-bit serializer output)
// rather than a hand-constructed object shaped like one.
//
// Deterministic: synthetic pubkeys, fixed timestamps, no RPC, no key
// material, no cluster traffic. The pools/vaults/failures are synthetic but
// the SERIALIZER is the production one — the fixture pins the artifact
// shape (schemaVersion 2, exhaustive key sets, D-01 sourcing fields, counts
// consistency) at the console boundary. See PROVENANCE.md next to this
// script for the pinned indexer SHA and the sha256 of the current fixture.
//
// Usage (run with bun or tsx; the indexer checkout must have its deps
// installed):
//
//   GY_INDEXER_CHECKOUT=/path/to/grave-indexer \
//     bun src/lib/gy/snapshot-fixture/generate-fixture.ts
//
// GY_INDEXER_CHECKOUT defaults to the conventional sibling checkout
// (../grave-indexer next to this repository). Output path can be
// overridden with the first CLI argument (default: the console's committed
// src/lib/gy/snapshot.json).

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

// ── Locate the producer checkout and the output file ─────────────────────
const indexerCheckout = resolve(
  process.env.GY_INDEXER_CHECKOUT ??
    fileURLToPath(new URL("../../../../../grave-indexer", import.meta.url)),
);
const outPath = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../snapshot.json", import.meta.url)),
);

// Dynamic imports of the PRODUCER module (resolved by URL so this script
// stays independent of any bundler/tsconfig coupling to the sibling repo).
const indexerSrc = (rel: string) =>
  pathToFileURL(resolve(indexerCheckout, rel)).href;

const { buildConsoleSnapshot }: any = await import(indexerSrc("src/consoleSnapshot.js"));
const { accountFingerprint }: any = await import(indexerSrc("src/provenance.js"));
const { buildAmmInfo, synth, WSOL_MINT }: any = await import(indexerSrc("test/fixtures.js"));

// ── Deterministic fixture corpus ─────────────────────────────────────────
const NOW_MS = Date.UTC(2026, 10, 1); // 2026-11-01T00:00:00Z — fixed, in the past
const THRESHOLDS = { inactivitySeconds: 7_776_000n, minTvlLamports: 500_000_000n }; // 90 d / 0.5 SOL

function makeRecord(seed: number): any {
  const data = buildAmmInfo(); // WSOL quoteMint (pc_mint), synthetic non-WSOL baseMint (coin_mint)
  const poolAddress = synth(seed);
  return {
    poolAddress,
    ammProgramId: synth(0x99),
    pool: {
      coinVault: synth(0x11),
      pcVault: synth(0x12),
      baseMint: synth(0x13 + seed), // synthetic non-WSOL coin_mint (varies per pool)
      quoteMint: WSOL_MINT, // pc_mint = canonical WSOL — the D-01 orientation
      lpMint: synth(0x14 + seed),
    },
    wsolSide: { memecoinMint: synth(0x13 + seed), coinIsWsol: false },
    raw: {
      mode: "full",
      dataLen: data.length,
      fingerprint: accountFingerprint(poolAddress, data),
      owner: synth(0x99).toBase58(),
    },
    provenance: {
      source: "raydium-v4-gpa",
      cluster: "mainnet-beta",
      endpointKind: "public-rpc",
      slotLowerBound: 100,
      slotUpperBound: 110,
      fetchedAtUnixMs: NOW_MS - 5_000,
    },
  };
}

function makeEnrichment(over: Partial<any> = {}): any {
  return {
    wsolReserveLamports: "600000000",
    memecoinReserveRaw: "1000000",
    memecoinDecimals: 6,
    lpSupplyRaw: "10000000",
    lastSwap: { unixTs: Math.floor(NOW_MS / 1000) - 8_000_000, slot: 42, signature: "5" + "a".repeat(86) },
    fetchedAtUnixMs: NOW_MS - 4_000,
    ...over,
  };
}

const a = makeRecord(1);
const b = makeRecord(2);
const enrichments = new Map([
  // A: inactive long enough (C1 pass) and TVL above the floor (C3 pass).
  [a.poolAddress.toBase58(), makeEnrichment()],
  // B: no derivable last swap (C1 pending — "unavailable", never zero)
  //    and reserve just under the floor (C3 fail).
  [b.poolAddress.toBase58(), makeEnrichment({ lastSwap: null, wsolReserveLamports: "499999999" })],
]);

const snap = buildConsoleSnapshot([a, b], enrichments, {
  generatedAtUnixMs: NOW_MS,
  cluster: "mainnet-beta",
  endpointKind: "public-rpc",
  indexerGitHead: null,
  maxAgeMs: 86_400_000, // the console's pinned 24 h refresh budget
  thresholds: THRESHOLDS,
  counts: { rawAccounts: 4, parsedPools: 3, supportedWsolPairs: 3, m1SourcingRejected: 1 },
  failures: [
    {
      stage: "m1-sourcing",
      pool: synth(0x21).toBase58(),
      reason: "wsol-on-coin-side — WSOL is coin_mint (base side) — M1 requires WSOL on pc_mint (quote side)",
    },
    { stage: "activity", pool: synth(0x22).toBase58(), reason: "signature scan limit reached" },
  ],
  slotLowerBound: 100,
  slotUpperBound: 110,
});

const json = JSON.stringify(snap, null, 2) + "\n";
writeFileSync(outPath, json, { encoding: "utf8" });
const digest = createHash("sha256").update(json, "utf8").digest("hex");
console.log("wrote", outPath);
console.log("sha256:", digest);
console.log("pools:", snap.pools.length, "| counts:", JSON.stringify(snap.counts));
console.log("generatedAt:", snap.generatedAtUnixMs, "=", new Date(snap.generatedAtUnixMs).toISOString());
for (const p of snap.pools) {
  console.log(
    `  pool ${p.address.slice(0, 8)}… coinMint ${p.coinMint.slice(0, 8)}… pcMint ${p.pcMint === WSOL_MINT.toBase58() ? "WSOL" : p.pcMint} C1=${p.criteria.c1Inactivity} C3=${p.criteria.c3MinTvl}`,
  );
}
