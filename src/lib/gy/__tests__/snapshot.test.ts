// Snapshot loader tests — the committed artifact must parse, fail-closed
// validation must reject every malformed shape, and the honest-labelling
// contract (pending criteria, unavailable last-swap, no fabricated score)
// must hold end to end.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import {
  parseSnapshot,
  snapshotFreshness,
  snapshotDataState,
  snapshotPools,
  poolFromSnapshot,
  SNAPSHOT,
  RAW_SNAPSHOT,
  SnapshotError,
  type ConsoleSnapshot,
} from "../snapshot";

const GENERATED_AT = SNAPSHOT.generatedAtUnixMs;
const MAX_AGE = SNAPSHOT.freshness.maxAgeMs;

/** Deep-clone the committed artifact and mutate it into a malformed shape. */
function corrupt(mutate: (snap: Record<string, unknown>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(RAW_SNAPSHOT)) as Record<string, unknown>;
  mutate(copy);
  return copy;
}

describe("snapshot loader — committed artifact", () => {
  test("the committed snapshot.json parses and is internally consistent", () => {
    const snap = SNAPSHOT;
    expect(snap.schemaVersion).toBe(1);
    expect(snap.cluster).toBe("mainnet-beta");
    expect(snap.pools.length).toBe(snap.counts.enriched);
    expect(snap.pools.length).toBeGreaterThan(0);
    // Canonical ordering survives the artifact boundary.
    const addresses = snap.pools.map((p) => p.address);
    expect(addresses).toEqual([...addresses].sort());
    // Honest criteria: nothing is ever pre-evaluated for C2/C4/C5/C6.
    for (const p of snap.pools) {
      expect(p.criteria.c2PriceCollapse).toBe("pending");
      expect(p.criteria.c4LpBurned).toBe("pending");
      expect(p.criteria.c5LpLocked).toBe("pending");
      expect(p.criteria.c6MultiEpoch).toBe("pending");
    }
    // Secret-free by construction.
    const json = JSON.stringify(snap);
    expect(json).not.toContain("http");
  });

  test("freshness math honors the artifact's own budget", () => {
    expect(snapshotFreshness(SNAPSHOT, GENERATED_AT + MAX_AGE)).toBe("fresh");
    expect(snapshotFreshness(SNAPSHOT, GENERATED_AT + MAX_AGE + 1)).toBe("stale");
    expect(snapshotDataState(SNAPSHOT, GENERATED_AT + 1)).toBe("real");
    expect(snapshotDataState(SNAPSHOT, GENERATED_AT + MAX_AGE + 1)).toBe("stale");
  });

  test("poolFromSnapshot maps real quantities without fabrication", () => {
    const pool = poolFromSnapshot(SNAPSHOT.pools[0], SNAPSHOT);
    expect(pool.address).toBe(SNAPSHOT.pools[0].address);
    expect(pool.amm).toBe("Raydium V4");
    expect(pool.quoteSymbol).toBe("WSOL");
    expect(pool.baseSymbol.startsWith("mint:")).toBe(true);
    expect(pool.quoteReserveLamports).toBe(BigInt(SNAPSHOT.pools[0].wsolReserveLamports));
    expect(pool.baseReserve).toBe(BigInt(SNAPSHOT.pools[0].memecoinReserveRaw));
    expect(pool.baseDecimals).toBe(SNAPSHOT.pools[0].memecoinDecimals);
    expect(pool.lpSupply).toBe(Number(BigInt(SNAPSHOT.pools[0].lpSupplyRaw)));
    // Truthful lifecycle + score: discovered, never a fabricated score.
    expect(pool.state).toBe("discovered");
    expect(pool.score).toBe(0);
    expect(pool.anchorEpoch).toBeNull();
    expect(pool.certExpiresAt).toBeNull();
    // Criteria honesty rides along (C1/C3 states on the Pool; the full
    // pending-pinned criteria remain on the snapshot record).
    expect(pool.snapshotCriteria!.c1Inactivity).toBe(SNAPSHOT.pools[0]!.criteria.c1Inactivity);
    expect(pool.snapshotCriteria!.c3MinTvl).toBe(SNAPSHOT.pools[0]!.criteria.c3MinTvl);
    expect(SNAPSHOT.pools[0]!.criteria.c4LpBurned).toBe("pending");
    expect(SNAPSHOT.pools[0]!.criteria.c5LpLocked).toBe("pending");
  });

  test("lastSwap unavailable maps to 0 with an explanatory note — never as a real zero", () => {
    const withoutSwap = SNAPSHOT.pools.find((p) => p.lastSwap === null);
    if (!withoutSwap) return; // artifact happens to have full coverage
    const pool = poolFromSnapshot(withoutSwap, SNAPSHOT);
    expect(pool.lastSwapUnix).toBe(0);
    expect(pool.note).toContain("unavailable");
  });

  test("snapshotPools preserves the canonical order", () => {
    const pools = snapshotPools(SNAPSHOT);
    expect(pools.map((p) => p.address)).toEqual(SNAPSHOT.pools.map((p) => p.address));
  });
});

describe("snapshot loader — fail-closed validation", () => {
  test("rejects wrong schemaVersion", () => {
    expect(() => parseSnapshot(corrupt((s) => { s.schemaVersion = 2; }))).toThrow(SnapshotError);
  });

  test("rejects missing or malformed pools", () => {
    expect(() => parseSnapshot(corrupt((s) => { delete s.pools; }))).toThrow(SnapshotError);
    expect(() => parseSnapshot(corrupt((s) => { s.pools = []; s.counts = { ...(s.counts as object), enriched: 0 }; }))).not.toThrow();
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as object[];
          pools[0] = { ...(pools[0] as object), address: "not base58!!" };
        }),
      ),
    ).toThrow(SnapshotError);
  });

  test("rejects u64 fields carried as numbers or malformed strings", () => {
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as Record<string, unknown>[];
          pools[0].wsolReserveLamports = 123; // number — never allowed
        }),
      ),
    ).toThrow(SnapshotError);
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as Record<string, unknown>[];
          pools[0].lpSupplyRaw = "01"; // leading zero
        }),
      ),
    ).toThrow(SnapshotError);
  });

  test("rejects fabricated criteria — only pass|fail|pending and pending-only fields", () => {
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as Record<string, unknown>[];
          const criteria = pools[0].criteria as Record<string, unknown>;
          criteria.c4LpBurned = "pass"; // upstream cannot evaluate C4 — reject
        }),
      ),
    ).toThrow(SnapshotError);
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as Record<string, unknown>[];
          const criteria = pools[0].criteria as Record<string, unknown>;
          criteria.c1Inactivity = "maybe";
        }),
      ),
    ).toThrow(SnapshotError);
  });

  test("rejects inverted slot bounds and count mismatches", () => {
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const prov = s.provenance as Record<string, unknown>;
          prov.slotLowerBound = 200;
          prov.slotUpperBound = 100;
        }),
      ),
    ).toThrow(SnapshotError);
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          s.counts = { ...(s.counts as object), enriched: (s.pools as object[]).length + 1 };
        }),
      ),
    ).toThrow(SnapshotError);
  });

  test("rejects non-object lastSwap shapes and zero timestamps", () => {
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as Record<string, unknown>[];
          pools[0].lastSwap = { unixTs: 0, slot: 5, signature: "x".repeat(20) };
        }),
      ),
    ).toThrow(SnapshotError);
    expect(() =>
      parseSnapshot(
        corrupt((s) => {
          const pools = s.pools as Record<string, unknown>[];
          pools[0].lastSwap = { unixTs: 1_800_000_000, slot: 5 }; // missing signature
        }),
      ),
    ).toThrow(SnapshotError);
  });

  test("rejects a non-finite or negative freshness budget", () => {
    expect(() =>
      parseSnapshot(corrupt((s) => { s.freshness = { maxAgeMs: 0 }; })),
    ).toThrow(SnapshotError);
    expect(() =>
      parseSnapshot(corrupt((s) => { s.freshness = { maxAgeMs: -5 }; })),
    ).toThrow(SnapshotError);
  });
});
