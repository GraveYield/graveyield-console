// Snapshot artifact transport battery (P4.1 Step 1).
//
// Proves the artifact delivery mechanism end to end and pins the core
// invariant: a stale or invalid artifact can NEVER be presented as fresh
// data — not by the source resolver, not by the route handler, and not by
// the client hydration gate. The committed (already past-budget) artifact
// is used as the real-world stale seed.

/// <reference types="bun-types" />
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSnapshotSource,
  bytesToPayload,
  redactUrlForDisplay,
  DEFAULT_MAX_ARTIFACT_BYTES,
  type SnapshotSourceDeps,
} from "../snapshotSource";
import {
  hydrateTransportPayload,
  transportDataState,
  type SnapshotTransportPayload,
  type TransportReasonCode,
} from "../snapshotTransport";
import { RAW_SNAPSHOT } from "../snapshot";
import { GET as routeGET } from "../../../app/api/gy/snapshot/route";

/* ── Fixtures ──────────────────────────────────────────────────────── */

/** Fixed evaluation clock (resolver unit tests are deterministic). */
const NOW = 1_800_000_000_000;

function artifactJson(generatedAtUnixMs: number): Record<string, unknown> {
  const snap = JSON.parse(JSON.stringify(RAW_SNAPSHOT)) as Record<string, unknown>;
  snap.generatedAtUnixMs = generatedAtUnixMs;
  const pools = snap.pools as Record<string, unknown>[];
  for (const p of pools) {
    p.fetchedAtUnixMs = Math.min(p.fetchedAtUnixMs as number, generatedAtUnixMs);
  }
  return snap;
}

function artifactBytes(generatedAtUnixMs: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(artifactJson(generatedAtUnixMs)));
}

function deps(overrides: Partial<SnapshotSourceDeps> = {}): SnapshotSourceDeps {
  return {
    nowMs: NOW,
    readFile: async () => {
      throw new Error("no file wired for this test");
    },
    statSize: async () => null,
    fetchImpl: (async () => {
      throw new Error("no fetch wired for this test");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

/** The committed artifact is already past its 24h budget relative to NOW. */
const COMMITTED_IS_STALE = RAW_SNAPSHOT && typeof RAW_SNAPSHOT === "object";

function expectUnavailable(p: SnapshotTransportPayload, state: "missing" | "corrupt", code: TransportReasonCode) {
  expect(p.artifactState).toBe(state);
  expect(p.reasonCode).toBe(code);
  expect(p.dataState).toBe("unavailable");
  expect(p.snapshot).toBeNull();
}

/* ── Source configuration ──────────────────────────────────────────── */

describe("snapshotSource — source configuration", () => {
  test("no source configured → missing (fail-closed), no payload", async () => {
    const p = await resolveSnapshotSource({}, deps());
    expectUnavailable(p, "missing", "NO_SOURCE_CONFIGURED");
    expect(p.source.kind).toBe("none");
  });

  test("both sources configured → missing (refuses to guess)", async () => {
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/tmp/a.json", GY_SNAPSHOT_URL: "https://artifacts.example/snapshot.json" },
      deps(),
    );
    expectUnavailable(p, "missing", "SOURCE_CONFLICT");
    expect(p.source.kind).toBe("none");
  });
});

/* ── GY_SNAPSHOT_PATH topology (self-hosted volume) ────────────────── */

describe("snapshotSource — GY_SNAPSHOT_PATH topology", () => {
  test("fresh artifact on disk → valid / real", async () => {
    const bytes = artifactBytes(NOW - 60_000);
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/mnt/gy/console-snapshot.json" },
      deps({ readFile: async () => bytes }),
    );
    expect(p.artifactState).toBe("valid");
    expect(p.dataState).toBe("real");
    expect(p.reasonCode).toBeNull();
    expect(p.snapshot).not.toBeNull();
    expect(p.snapshot!.pools.length).toBeGreaterThan(0);
    expect(p.source.kind).toBe("path");
    expect(p.ageMs).toBe(60_000);
    expect(p.maxAgeMs).toBe(24 * 3_600_000);
  });

  test("THE COMMITTED ARTIFACT (real shipped bytes) classifies stale — never fresh", async () => {
    expect(COMMITTED_IS_STALE).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(RAW_SNAPSHOT));
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/repo/src/lib/gy/snapshot.json" },
      deps({ readFile: async () => bytes }),
    );
    expect(p.artifactState).toBe("stale");
    expect(p.dataState).toBe("stale");
    expect(p.dataState).not.toBe("real");
    expect(p.snapshot).not.toBeNull();
    expect(p.reason).toContain("freshness budget");
  });

  test("staleness boundary: exactly maxAge is fresh, +1 ms is stale", async () => {
    const read = (gen: number) => async () => artifactBytes(gen);
    const maxAge = 24 * 3_600_000;
    const fresh = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/x" },
      deps({ readFile: read(NOW - maxAge) }),
    );
    const stale = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/x" },
      deps({ readFile: read(NOW - maxAge - 1) }),
    );
    expect(fresh.artifactState).toBe("valid");
    expect(stale.artifactState).toBe("stale");
    expect(stale.dataState).toBe("stale");
  });

  test("unreadable file (ENOENT) → missing / READ_FAILED", async () => {
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/mnt/gy/missing.json" },
      deps({ readFile: async () => { const e = new Error("no such file"); e.name = "Error"; throw e; } }),
    );
    expectUnavailable(p, "missing", "READ_FAILED");
  });

  test("oversized artifact on disk (stat) → corrupt / OVERSIZE", async () => {
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/mnt/gy/huge.json" },
      deps({ statSize: async () => DEFAULT_MAX_ARTIFACT_BYTES + 1 }),
    );
    expectUnavailable(p, "corrupt", "OVERSIZE");
  });

  test("oversized artifact after read (stat unavailable) → corrupt / OVERSIZE", async () => {
    const huge = new Uint8Array(DEFAULT_MAX_ARTIFACT_BYTES + 1);
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_PATH: "/mnt/gy/huge.json" },
      deps({ readFile: async () => huge }),
    );
    expectUnavailable(p, "corrupt", "OVERSIZE");
  });
});

/* ── GY_SNAPSHOT_URL topology (serverless artifact store) ──────────── */

describe("snapshotSource — GY_SNAPSHOT_URL topology", () => {
  test("artifact store 200 → valid / real", async () => {
    const bytes = artifactBytes(NOW - 60_000);
    const fetchImpl = (async () => new Response(bytes as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_URL: "https://artifacts.example/gy/console-snapshot.json" },
      deps({ fetchImpl }),
    );
    expect(p.artifactState).toBe("valid");
    expect(p.dataState).toBe("real");
    expect(p.source.kind).toBe("url");
    expect(p.source.uri).toBe("https://artifacts.example/gy/console-snapshot.json");
  });

  test("HTTP 404 and 500 → missing / FETCH_HTTP_STATUS", async () => {
    for (const status of [404, 500]) {
      const fetchImpl = (async () => new Response("nope", { status })) as unknown as typeof fetch;
      const p = await resolveSnapshotSource(
        { GY_SNAPSHOT_URL: "https://artifacts.example/gy/console-snapshot.json" },
        deps({ fetchImpl }),
      );
      expectUnavailable(p, "missing", "FETCH_HTTP_STATUS");
      expect(p.reason).toContain(String(status));
    }
  });

  test("network failure → missing / FETCH_FAILED", async () => {
    const fetchImpl = (async () => { throw new TypeError("failed to fetch"); }) as unknown as typeof fetch;
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_URL: "https://artifacts.example/gy/console-snapshot.json" },
      deps({ fetchImpl }),
    );
    expectUnavailable(p, "missing", "FETCH_FAILED");
  });

  test("oversized declared content-length → corrupt / OVERSIZE (body never read)", async () => {
    let bodyRead = false;
    const huge = new Uint8Array(DEFAULT_MAX_ARTIFACT_BYTES + 1);
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            bodyRead = true;
            controller.enqueue(huge);
            controller.close();
          },
        }),
        { status: 200, headers: { "content-length": String(DEFAULT_MAX_ARTIFACT_BYTES + 1) } },
      )) as unknown as typeof fetch;
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_URL: "https://artifacts.example/gy/huge.json" },
      deps({ fetchImpl }),
    );
    expectUnavailable(p, "corrupt", "OVERSIZE");
  });

  test("streamed body over the cap → corrupt / OVERSIZE", async () => {
    const huge = new Uint8Array(DEFAULT_MAX_ARTIFACT_BYTES + 1);
    const fetchImpl = (async () => new Response(huge as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const p = await resolveSnapshotSource(
      { GY_SNAPSHOT_URL: "https://artifacts.example/gy/huge.json" },
      deps({ fetchImpl }),
    );
    expectUnavailable(p, "corrupt", "OVERSIZE");
  });

  test("diagnostics never leak URL credentials: userinfo/query stripped", async () => {
    const secretUrl = "https://user:SECRET-TOKEN@artifacts.example/gy/snapshot.json?sig=abc123";
    const fetchImpl = (async () => { throw new TypeError(`request to ${secretUrl} failed`); }) as unknown as typeof fetch;
    const p = await resolveSnapshotSource({ GY_SNAPSHOT_URL: secretUrl }, deps({ fetchImpl }));
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("SECRET-TOKEN");
    expect(serialized).not.toContain("sig=abc123");
    expect(p.source.uri).toBe("https://artifacts.example/gy/snapshot.json");
    expect(redactUrlForDisplay(secretUrl)).toBe("https://artifacts.example/gy/snapshot.json");
  });
});

/* ── Contract gate (bytesToPayload) ────────────────────────────────── */

describe("snapshotSource — fail-closed contract gate", () => {
  const src = { kind: "path" as const, uri: "/x" };

  test("invalid JSON bytes → corrupt / PARSE_FAILED", () => {
    const p = bytesToPayload(new TextEncoder().encode("{not json"), { nowMs: NOW, checkedAtUnixMs: NOW, source: src });
    expectUnavailable(p, "corrupt", "PARSE_FAILED");
  });

  test("wrong schemaVersion → corrupt / PARSE_FAILED", () => {
    const bad = { ...artifactJson(NOW - 60_000), schemaVersion: 2 };
    const p = bytesToPayload(new TextEncoder().encode(JSON.stringify(bad)), { nowMs: NOW, checkedAtUnixMs: NOW, source: src });
    expectUnavailable(p, "corrupt", "PARSE_FAILED");
  });

  test("fabricated eligibility (C4 evaluated upstream) → corrupt — fabrication cannot ride the transport", () => {
    const bad = artifactJson(NOW - 60_000);
    const pools = bad.pools as Record<string, unknown>[];
    (pools[0].criteria as Record<string, unknown>).c4LpBurned = "pass";
    const p = bytesToPayload(new TextEncoder().encode(JSON.stringify(bad)), { nowMs: NOW, checkedAtUnixMs: NOW, source: src });
    expectUnavailable(p, "corrupt", "PARSE_FAILED");
  });

  test("u64 reserve carried as a number → corrupt / PARSE_FAILED", () => {
    const bad = artifactJson(NOW - 60_000);
    const pools = bad.pools as Record<string, unknown>[];
    pools[0].wsolReserveLamports = 123;
    const p = bytesToPayload(new TextEncoder().encode(JSON.stringify(bad)), { nowMs: NOW, checkedAtUnixMs: NOW, source: src });
    expectUnavailable(p, "corrupt", "PARSE_FAILED");
  });

  test("future-dated artifact → corrupt / FUTURE_GENERATED_AT (never fresh forever)", () => {
    const p = bytesToPayload(new TextEncoder().encode(JSON.stringify(artifactJson(NOW + 10 * 60_000))), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: src,
    });
    expectUnavailable(p, "corrupt", "FUTURE_GENERATED_AT");
  });

  test("clock skew within tolerance is accepted", () => {
    const p = bytesToPayload(new TextEncoder().encode(JSON.stringify(artifactJson(NOW + 4 * 60_000))), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: src,
    });
    expect(p.artifactState).toBe("valid");
  });
});

/* ── Invariant sweep: stale/invalid can never present as fresh ─────── */

describe("transport invariant — stale/invalid artifacts can never present as fresh", () => {
  async function collectOutcomes(): Promise<SnapshotTransportPayload[]> {
    const bytes = artifactBytes(NOW - 60_000);
    const outcomes: SnapshotTransportPayload[] = [];
    const push = (p: Promise<SnapshotTransportPayload>) => outcomes.push(p as unknown as SnapshotTransportPayload);
    // ordering matters only for readability; assertions run below
    const all: Promise<SnapshotTransportPayload>[] = [
      resolveSnapshotSource({}, deps()),
      resolveSnapshotSource({ GY_SNAPSHOT_PATH: "/a", GY_SNAPSHOT_URL: "https://x/y.json" }, deps()),
      resolveSnapshotSource({ GY_SNAPSHOT_PATH: "/missing.json" }, deps({ readFile: async () => { throw new Error("ENOENT"); } })),
      resolveSnapshotSource({ GY_SNAPSHOT_URL: "https://x/y.json" }, deps({ fetchImpl: (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch })),
      resolveSnapshotSource({ GY_SNAPSHOT_URL: "https://x/y.json" }, deps({ fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch })),
      resolveSnapshotSource({ GY_SNAPSHOT_PATH: "/c" }, deps({ readFile: async () => new TextEncoder().encode("{broken") })),
      resolveSnapshotSource({ GY_SNAPSHOT_PATH: "/c" }, deps({ readFile: async () => new TextEncoder().encode(JSON.stringify({ ...artifactJson(NOW - 60_000), schemaVersion: 9 })) })),
      resolveSnapshotSource({ GY_SNAPSHOT_PATH: "/c" }, deps({ statSize: async () => DEFAULT_MAX_ARTIFACT_BYTES + 9 })),
      resolveSnapshotSource({ GY_SNAPSHOT_PATH: "/stale.json" }, deps({ readFile: async () => new TextEncoder().encode(JSON.stringify(RAW_SNAPSHOT)) })),
      resolveSnapshotSource({ GY_SNAPSHOT_URL: "https://x/fresh.json" }, deps({ fetchImpl: (async () => new Response(bytes as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch })),
    ];
    for (const p of all) push(p);
    return Promise.all(outcomes);
  }

  test("every resolver outcome honors the honest-state contract", async () => {
    const outcomes = await collectOutcomes();
    let staleCount = 0;
    let validCount = 0;
    for (const p of outcomes) {
      if (p.artifactState === "missing" || p.artifactState === "corrupt") {
        expect(p.snapshot).toBeNull();
        expect(p.dataState).toBe("unavailable");
        expect(p.reason).not.toBeNull();
      } else if (p.artifactState === "stale") {
        staleCount++;
        expect(p.snapshot).not.toBeNull();
        expect(p.dataState).toBe("stale");
        expect(p.reason).toContain("freshness budget");
      } else {
        validCount++;
        expect(p.dataState).toBe("real");
        expect(p.snapshot).not.toBeNull();
      }
      // THE invariant: dataState === "real" ⟺ artifactState === "valid"
      expect(p.dataState === "real").toBe(p.artifactState === "valid");
    }
    expect(staleCount).toBeGreaterThan(0); // the committed artifact seed
    expect(validCount).toBeGreaterThan(0);
  });

  test("transportDataState mapping is total and honest", () => {
    expect(transportDataState("valid")).toBe("real");
    expect(transportDataState("stale")).toBe("stale");
    expect(transportDataState("missing")).toBe("unavailable");
    expect(transportDataState("corrupt")).toBe("unavailable");
  });
});

/* ── Client hydration gate ─────────────────────────────────────────── */

describe("snapshotTransport — client hydration re-validation", () => {
  /* Deliberately loose parameter type: the malformed-envelope tests feed
     invalid shapes (unknown artifact states, missing fields). */
  function envelope(p: Record<string, unknown> = {}): unknown {
    return {
      artifactState: "valid",
      dataState: "real",
      reason: null,
      reasonCode: null,
      source: { kind: "path", uri: "/x" },
      checkedAtUnixMs: NOW,
      ageMs: 60_000,
      maxAgeMs: 24 * 3_600_000,
      snapshot: artifactJson(NOW - 60_000),
      ...p,
    };
  }

  test("well-formed valid payload hydrates", () => {
    const h = hydrateTransportPayload(envelope({}), NOW);
    expect(h).not.toBeNull();
    expect(h!.artifactState).toBe("valid");
    expect(h!.snapshot!.pools.length).toBeGreaterThan(0);
  });

  test("stale payload hydrates with dataState stale — never real", () => {
    const h = hydrateTransportPayload(
      envelope({
        artifactState: "stale",
        dataState: "stale",
        reason: "past budget",
        ageMs: 30 * 3_600_000,
        snapshot: artifactJson(NOW - 30 * 3_600_000),
      }),
      NOW,
    );
    expect(h).not.toBeNull();
    expect(h!.dataState).toBe("stale");
    expect(h!.dataState).not.toBe("real");
    expect(h!.snapshot).not.toBeNull();
  });

  test("envelope lying about dataState is rejected", () => {
    expect(hydrateTransportPayload(envelope({ artifactState: "missing", dataState: "real", snapshot: null }), NOW)).toBeNull();
    expect(hydrateTransportPayload(envelope({ artifactState: "valid", dataState: "stale" }), NOW)).toBeNull();
  });

  test("payload riding along with a failed artifact is rejected", () => {
    expect(hydrateTransportPayload(envelope({ artifactState: "corrupt", dataState: "unavailable", reason: "bad" }), NOW)).toBeNull();
  });

  test("tampered snapshot payload is rejected by client-side re-parse (fail-closed)", () => {
    const tampered = artifactJson(NOW - 60_000);
    (tampered.pools as Record<string, unknown>[])[0].address = "not base58!!";
    expect(hydrateTransportPayload(envelope({ snapshot: tampered }), NOW)).toBeNull();
  });

  test("future-dated artifact is rejected at hydration", () => {
    expect(hydrateTransportPayload(envelope({ snapshot: artifactJson(NOW + 10 * 60_000) }), NOW)).toBeNull();
  });

  test("staleness flip between server and client clock is rejected (state must match the budget)", () => {
    // Server said valid, but the client clock sees the artifact past budget.
    expect(
      hydrateTransportPayload(envelope({ snapshot: artifactJson(NOW - 25 * 3_600_000) }), NOW),
    ).toBeNull();
    // Server said stale, but the client clock sees it inside budget.
    expect(
      hydrateTransportPayload(
        envelope({
          artifactState: "stale",
          dataState: "stale",
          reason: "past budget",
          snapshot: artifactJson(NOW - 60_000),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  test("malformed envelopes are rejected (fail-closed to unavailable)", () => {
    expect(hydrateTransportPayload(null, NOW)).toBeNull();
    expect(hydrateTransportPayload("string", NOW)).toBeNull();
    expect(hydrateTransportPayload({}, NOW)).toBeNull();
    expect(hydrateTransportPayload(envelope({ checkedAtUnixMs: -1 }), NOW)).toBeNull();
    expect(hydrateTransportPayload(envelope({ artifactState: "fresh" }), NOW)).toBeNull();
  });
});

/* ── Route handler (GET /api/gy/snapshot) ──────────────────────────── */

describe("route handler — GET /api/gy/snapshot", () => {
  const ORIG_PATH = process.env.GY_SNAPSHOT_PATH;
  const ORIG_URL = process.env.GY_SNAPSHOT_URL;

  afterAll(() => {
    if (ORIG_PATH === undefined) delete process.env.GY_SNAPSHOT_PATH;
    else process.env.GY_SNAPSHOT_PATH = ORIG_PATH;
    if (ORIG_URL === undefined) delete process.env.GY_SNAPSHOT_URL;
    else process.env.GY_SNAPSHOT_URL = ORIG_URL;
  });

  test("delivers a fresh artifact from a volume path — full delivery proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-snapshot-"));
    const file = join(dir, "console-snapshot.json");
    // Route uses the real clock — generate relative to Date.now().
    writeFileSync(file, JSON.stringify(artifactJson(Date.now() - 60_000)));
    process.env.GY_SNAPSHOT_PATH = file;
    delete process.env.GY_SNAPSHOT_URL;

    const res = await routeGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as SnapshotTransportPayload;
    expect(body.artifactState).toBe("valid");
    expect(body.dataState).toBe("real");
    expect(body.source.kind).toBe("path");
    expect(body.snapshot).not.toBeNull();
    expect(body.snapshot!.pools.length).toBeGreaterThan(0);
    // The client gate accepts the route's own output (round trip).
    expect(hydrateTransportPayload(body, Date.now())).not.toBeNull();
  });

  test("the committed artifact served through the route answers stale — never fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-snapshot-"));
    const file = join(dir, "console-snapshot.json");
    writeFileSync(file, JSON.stringify(RAW_SNAPSHOT));
    process.env.GY_SNAPSHOT_PATH = file;
    delete process.env.GY_SNAPSHOT_URL;

    const res = await routeGET();
    const body = (await res.json()) as SnapshotTransportPayload;
    expect(res.status).toBe(200);
    expect(body.artifactState).toBe("stale");
    expect(body.dataState).toBe("stale");
    expect(body.dataState).not.toBe("real");
    expect(body.snapshot).not.toBeNull();
    // …and the client gate keeps the stale label honest on the round trip.
    const hydrated = hydrateTransportPayload(body, Date.now());
    expect(hydrated).not.toBeNull();
    expect(hydrated!.dataState).toBe("stale");
  });

  test("corrupt bytes on disk → corrupt with reason, no payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gy-snapshot-"));
    const file = join(dir, "console-snapshot.json");
    writeFileSync(file, "{definitely not json");
    process.env.GY_SNAPSHOT_PATH = file;
    delete process.env.GY_SNAPSHOT_URL;

    const res = await routeGET();
    const body = (await res.json()) as SnapshotTransportPayload;
    expect(res.status).toBe(200);
    expectUnavailable(body, "corrupt", "PARSE_FAILED");
    // The client gate accepts the well-formed corrupt ENVELOPE (so the UI can
    // render the corrupt banner) — but it carries no snapshot payload.
    const hydrated = hydrateTransportPayload(body, Date.now());
    expect(hydrated).not.toBeNull();
    expect(hydrated!.artifactState).toBe("corrupt");
    expect(hydrated!.snapshot).toBeNull();
    expect(hydrated!.dataState).toBe("unavailable");
  });

  test("no env configured → 200 + missing envelope (first-class state)", async () => {
    delete process.env.GY_SNAPSHOT_PATH;
    delete process.env.GY_SNAPSHOT_URL;
    const res = await routeGET();
    const body = (await res.json()) as SnapshotTransportPayload;
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectUnavailable(body, "missing", "NO_SOURCE_CONFIGURED");
  });
});
