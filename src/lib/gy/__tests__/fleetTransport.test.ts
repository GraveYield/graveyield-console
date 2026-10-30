// Fleet ingestion battery (P4.3) — the fleet-trail analogue of the snapshot
// transport tests. Core invariant, same as 4.1/4.2: a stale, missing,
// corrupt or future-dated trail can NEVER present as fresh fleet data, and
// the Fleet view never falls back to simulated fixtures.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

import {
  FLEET_DEFAULT_MAX_AGE_MS,
  fleetFreshness,
  fleetState,
  parseFleetAlert,
  parseFleetAlertJsonl,
  parseFleetTrailEvent,
  parseFleetEventJsonl,
  newestTrailTsMs,
  type FleetEventType,
} from "../fleetContract";
import { resolveFleetSource } from "../fleetSource";
import {
  asCachedFleetDisplay,
  effectiveFleetState,
  hydrateFleetPayload,
  resolveDisplayFleetPayload,
  type FleetTransportPayload,
} from "../fleetTransport";

/* ── Fixtures (shape-verified against salvor-bots fleet-core/fleet-ops) ── */

const NOW = 1_800_000_000_000;
const MAX_AGE = FLEET_DEFAULT_MAX_AGE_MS; // 30 min

function eventJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tsMs: NOW - 60_000,
    botId: "fleet-ops",
    type: "monitor-observation",
    data: { observed: "cycle-start" },
    ...overrides,
  };
}

function alertJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "monitor-stale-opportunity",
    severity: "warn",
    message: "Monitor diagnostic: stale-opportunity",
    atMs: NOW - 120_000,
    context: { identityKey: "op|conservative|3nQfBvKzTc1ZderL1ctGRVxY9pUmWj7HQSbTGvpF4K2S" },
    suppressed: false,
    ...overrides,
  };
}

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** A resolver env + deps over in-memory files (dir probe injected). */
function memFs(
  files: Record<string, string>,
  isDir: (p: string) => boolean = (p) => p === DIR,
) {
  const encoder = new TextEncoder();
  return {
    readFile: async (p: string): Promise<Uint8Array> => {
      if (!(p in files)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return encoder.encode(files[p]);
    },
    statSize: async (p: string): Promise<number | null> =>
      p in files ? encoder.encode(files[p]).byteLength : null,
    isDir,
  };
}

const DIR = "/srv/graveyield/fleet-state";

async function resolveWith(files: Record<string, string>, env: { GY_FLEET_STATE_PATH?: string | null; GY_FLEET_MAX_AGE_MS?: string | null } = { GY_FLEET_STATE_PATH: DIR }): Promise<FleetTransportPayload> {
  return resolveFleetSource(env, { nowMs: NOW, ...memFs(files) });
}

function freshPayload(overrides: Record<string, unknown> = {}): FleetTransportPayload {
  const fleet = fleetState([parseFleetTrailEvent(eventJson())], [parseFleetAlert(alertJson())]);
  return {
    artifactState: "valid",
    dataState: "real",
    reason: null,
    reasonCode: null,
    source: { kind: "path", uri: DIR },
    checkedAtUnixMs: NOW,
    ageMs: 60_000,
    maxAgeMs: MAX_AGE,
    newestTsMs: NOW - 60_000,
    fleet,
    ...overrides,
  };
}

/* ── Line parsers ───────────────────────────────────────────────────── */

describe("fleetContract line parsers", () => {
  test("accepts a well-formed FleetEvent (full and minimal)", () => {
    const full = parseFleetTrailEvent(
      eventJson({
        identityKey: "op|conservative|3nQf",
        pool: "3nQfBvKzTc1ZderL1ctGRVxY9pUmWj7HQSbTGvpF4K2S",
        state: "confirmed",
        failureClass: undefined,
      }),
    );
    expect(full.botId).toBe("fleet-ops");
    expect(full.state).toBe("confirmed");
    expect(full.pool).toStartWith("3nQf");

    const minimal = parseFleetTrailEvent({ tsMs: 1, botId: "scout", type: "cycle-start" });
    expect(minimal.identityKey).toBeUndefined();
    expect(minimal.data).toBeUndefined();
  });

  test("accepts the full upstream event vocabulary", () => {
    const types: FleetEventType[] = [
      "opportunity-received", "opportunity-duplicate", "opportunity-rejected",
      "revalidated", "revalidation-rejected", "lease-acquired", "lease-renewed",
      "lease-denied", "lease-released", "economic-pass", "economic-reject",
      "prepared", "simulated", "simulation-failed", "submitted", "confirmed",
      "execution-failed", "reported", "monitor-observation", "monitor-anomaly",
      "monitor-reconciled", "monitor-mismatch", "cycle-start", "cycle-end",
      "info", "error",
    ];
    for (const type of types) {
      expect(parseFleetTrailEvent(eventJson({ type })).type).toBe(type);
    }
  });

  test("rejects unknown vocabulary, bad timestamps, empty ids, non-object data", () => {
    expect(() => parseFleetTrailEvent(eventJson({ type: "salvage" }))).toThrow(/fleet vocabulary/);
    expect(() => parseFleetTrailEvent(eventJson({ state: "flying" }))).toThrow(/fleet vocabulary/);
    expect(() => parseFleetTrailEvent(eventJson({ failureClass: "act-of-god" }))).toThrow(/fleet vocabulary/);
    expect(() => parseFleetTrailEvent(eventJson({ tsMs: 0 }))).toThrow(/positive integer/);
    expect(() => parseFleetTrailEvent(eventJson({ tsMs: -5 }))).toThrow(/positive integer/);
    expect(() => parseFleetTrailEvent(eventJson({ tsMs: Number.NaN }))).toThrow(/positive integer/);
    expect(() => parseFleetTrailEvent(eventJson({ tsMs: 1.5 }))).toThrow(/positive integer/);
    expect(() => parseFleetTrailEvent(eventJson({ botId: "" }))).toThrow(/non-empty string/);
    expect(() => parseFleetTrailEvent(eventJson({ botId: null }))).toThrow(/non-empty string/);
    expect(() => parseFleetTrailEvent(eventJson({ data: "not-an-object" }))).toThrow(/must be an object/);
    expect(() => parseFleetTrailEvent(eventJson({ identityKey: null }))).toThrow(/non-empty string/);
    expect(() => parseFleetTrailEvent([1, 2, 3])).toThrow(/must be an object/);
  });

  test("accepts a well-formed Alert and rejects severity/context violations", () => {
    const alert = parseFleetAlert(alertJson({ suppressed: true }));
    expect(alert.suppressed).toBe(true);
    expect(parseFleetAlert(alertJson({ suppressed: undefined })).suppressed).toBe(false);

    expect(() => parseFleetAlert(alertJson({ severity: "page" }))).toThrow(/fleet vocabulary/);
    expect(() => parseFleetAlert(alertJson({ code: "" }))).toThrow(/non-empty string/);
    expect(() => parseFleetAlert(alertJson({ message: 42 }))).toThrow(/non-empty string/);
    expect(() => parseFleetAlert(alertJson({ atMs: "now" }))).toThrow(/positive integer/);
    expect(() => parseFleetAlert(alertJson({ context: { nested: { deep: 1 } } }))).toThrow(/not a scalar\/null/);
    expect(() => parseFleetAlert(alertJson({ context: { arr: [1] } }))).toThrow(/not a scalar\/null/);
    expect(() => parseFleetAlert(alertJson({ suppressed: "no" }))).toThrow(/boolean/);
  });

  test("JSONL: parses multi-line files, tolerates the trailing newline, rejects one bad line with its number", () => {
    const good = jsonl([eventJson(), eventJson({ tsMs: NOW - 61_000, type: "cycle-end" })]);
    expect(parseFleetEventJsonl(good)).toHaveLength(2);
    expect(parseFleetEventJsonl("")).toHaveLength(0);
    expect(parseFleetEventJsonl("\n\n")).toHaveLength(0);
    expect(parseFleetAlertJsonl(jsonl([alertJson()]))).toHaveLength(1);

    const corrupt = jsonl([eventJson()]) + "{not json}\n";
    expect(() => parseFleetEventJsonl(corrupt)).toThrow(/line 2.*not valid JSON/);
    const badVocab = jsonl([eventJson(), eventJson({ type: "made-up" })]);
    expect(() => parseFleetEventJsonl(badVocab)).toThrow(/line 2/);
    const badAlert = jsonl([alertJson(), alertJson({ suppressed: 1 })]);
    expect(() => parseFleetAlertJsonl(badAlert)).toThrow(/line 2/);
  });

  test("freshness: boundary is inclusive; empty trails refuse an invented age", () => {
    const fleet = fleetState([parseFleetTrailEvent(eventJson())], []);
    expect(fleetFreshness(fleet, NOW - 60_000 + MAX_AGE, MAX_AGE).verdict).toBe("fresh");
    expect(fleetFreshness(fleet, NOW - 60_000 + MAX_AGE + 1, MAX_AGE).verdict).toBe("stale");
    expect(fleetFreshness(fleet, NOW, MAX_AGE).ageMs).toBe(60_000);
    expect(newestTrailTsMs(fleet)).toBe(NOW - 60_000);

    const alertNewer = fleetState([parseFleetTrailEvent(eventJson())], [parseFleetAlert(alertJson({ atMs: NOW - 30_000 }))]);
    expect(newestTrailTsMs(alertNewer)).toBe(NOW - 30_000); // alerts participate in freshness

    const empty = fleetState([], []);
    expect(fleetFreshness(empty, NOW, MAX_AGE).verdict).toBe("empty");
    expect(fleetFreshness(empty, NOW, MAX_AGE).ageMs).toBeNull();
    expect(newestTrailTsMs(empty)).toBeNull();
  });
});

/* ── Source resolver ────────────────────────────────────────────────── */

describe("fleetSource resolver", () => {
  test("no source configured → missing / NO_SOURCE_CONFIGURED, no payload", async () => {
    const p = await resolveFleetSource({ GY_FLEET_STATE_PATH: null }, { nowMs: NOW, ...memFs({}) });
    expect(p.artifactState).toBe("missing");
    expect(p.reasonCode).toBe("NO_SOURCE_CONFIGURED");
    expect(p.dataState).toBe("unavailable");
    expect(p.fleet).toBeNull();
    expect(p.source.kind).toBe("none");
    expect(p.reason).toContain("GY_FLEET_STATE_PATH");
  });

  test("dir reachable but monitor trail ENOENT → missing / TRAIL_ABSENT (injected I/O path)", async () => {
    // memFs's default dir probe reports DIR as an existing directory, so
    // the guard passes and the missing trail file surfaces TRAIL_ABSENT —
    // this is not the fleet's FLEET_STATE_DIR (or the fleet never ran here).
    const p = await resolveWith({});
    expect(p.artifactState).toBe("missing");
    expect(p.reasonCode).toBe("TRAIL_ABSENT");
    expect(p.dataState).toBe("unavailable");
    expect(p.fleet).toBeNull();
  });

  test("a path that is not a readable directory → missing / READ_FAILED", async () => {
    const p = await resolveFleetSource(
      { GY_FLEET_STATE_PATH: DIR },
      { nowMs: NOW, ...memFs({}, () => false) },
    );
    expect(p.artifactState).toBe("missing");
    expect(p.reasonCode).toBe("READ_FAILED");
    expect(p.reason).toContain("not a readable directory");
    expect(p.fleet).toBeNull();
  });

  test("dir present but monitor-events.jsonl absent → missing / TRAIL_ABSENT (exercises the real statSync guard)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "gy-fleet-"));
    try {
      // Real dir, but no trail files at all → the is-dir guard passes and
      // the monitor-trail read hits ENOENT → TRAIL_ABSENT.
      const p = await resolveFleetSource(
        { GY_FLEET_STATE_PATH: dir },
        {
          nowMs: NOW,
          readFile: async (path) => {
            const e = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
            e.code = "ENOENT";
            throw e;
          },
          statSize: async () => null,
        },
      );
      expect(p.artifactState).toBe("missing");
      expect(p.reasonCode).toBe("TRAIL_ABSENT");
      expect(p.reason).toContain("fleet-ops creates it at process start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh trails → valid / real; alerts.jsonl absence is a legal zero state", async () => {
    const p = await resolveWith({ [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson(), eventJson({ tsMs: NOW - 90_000, type: "cycle-end" })]) });
    expect(p.artifactState).toBe("valid");
    expect(p.dataState).toBe("real");
    expect(p.reason).toBeNull();
    expect(p.fleet?.counts).toEqual({ eventLines: 2, alertLines: 0 });
    expect(p.fleet?.alerts).toHaveLength(0);
    expect(p.newestTsMs).toBe(NOW - 60_000);
    expect(p.ageMs).toBe(60_000);
    expect(p.maxAgeMs).toBe(MAX_AGE);
  });

  test("alerts-only staleness counts: a newer alert than events refreshes the verdict", async () => {
    const p = await resolveWith({
      [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson({ tsMs: NOW - 29 * 60_000 })]),
      [`${DIR}/alerts.jsonl`]: jsonl([alertJson({ atMs: NOW - 10_000 })]),
    });
    expect(p.artifactState).toBe("valid");
    expect(p.newestTsMs).toBe(NOW - 10_000);
  });

  test("trail past its budget → stale / stale, served but flagged", async () => {
    const p = await resolveWith({
      [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson({ tsMs: NOW - MAX_AGE - 60_000 })]),
    });
    expect(p.artifactState).toBe("stale");
    expect(p.dataState).toBe("stale");
    expect(p.reason).toContain("never as fresh");
    expect(p.fleet).not.toBeNull();
  });

  test("invalid env budget falls back to the default, never to a guess", async () => {
    const files = { [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson({ tsMs: NOW - 45 * 60_000 })]) };
    const bad = await resolveWith(files, { GY_FLEET_STATE_PATH: DIR, GY_FLEET_MAX_AGE_MS: "sixty minutes" });
    expect(bad.maxAgeMs).toBe(MAX_AGE);
    expect(bad.artifactState).toBe("stale"); // 45 min > 30 min default
    const ok = await resolveWith(files, { GY_FLEET_STATE_PATH: DIR, GY_FLEET_MAX_AGE_MS: "3600000" });
    expect(ok.maxAgeMs).toBe(3_600_000);
    expect(ok.artifactState).toBe("valid"); // inside the operator's 1 h budget
  });

  test("oversize trails → corrupt / OVERSIZE", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    const p = await resolveWith({ [`${DIR}/monitor-events.jsonl`]: big });
    expect(p.artifactState).toBe("corrupt");
    expect(p.reasonCode).toBe("OVERSIZE");
    expect(p.fleet).toBeNull();
  });

  test("corrupt line → corrupt / PARSE_FAILED with line detail, no payload", async () => {
    const p = await resolveWith({
      [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson()]) + "{\"tsMs\":1}\n",
      [`${DIR}/alerts.jsonl`]: jsonl([alertJson()]),
    });
    expect(p.artifactState).toBe("corrupt");
    expect(p.reasonCode).toBe("PARSE_FAILED");
    expect(p.reason).toContain("line 2");
    expect(p.fleet).toBeNull();
  });

  test("future-dated trail → corrupt / FUTURE_TRAIL_TS (can never classify fresh forever)", async () => {
    const p = await resolveWith({
      [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson({ tsMs: NOW + 10 * 60_000 })]),
    });
    expect(p.artifactState).toBe("corrupt");
    expect(p.reasonCode).toBe("FUTURE_TRAIL_TS");
    expect(p.fleet).toBeNull();
  });

  test("alerts.jsonl present but unreadable (non-ENOENT) → missing / READ_FAILED (fail-closed, not zero)", async () => {
    const p = await resolveFleetSource(
      { GY_FLEET_STATE_PATH: DIR },
      {
        nowMs: NOW,
        readFile: async (path) => {
          if (path.endsWith("alerts.jsonl")) {
            const e = new Error("EACCES: denied") as NodeJS.ErrnoException;
            e.code = "EACCES";
            throw e;
          }
          return new TextEncoder().encode(jsonl([eventJson()]));
        },
        statSize: async () => 100,
        isDir: () => true,
      },
    );
    expect(p.artifactState).toBe("missing");
    expect(p.reasonCode).toBe("READ_FAILED");
    expect(p.reason).toContain("Alerts trail");
  });
});

/* ── Envelope invariants + client hydration ─────────────────────────── */

describe("fleet envelope invariants", () => {
  test("sweep: dataState is always the honest mapping of artifactState; real ⟺ valid", async () => {
    const outcomes: FleetTransportPayload[] = [
      await resolveFleetSource({ GY_FLEET_STATE_PATH: null }, { nowMs: NOW, ...memFs({}) }),
      await resolveWith({}),
      await resolveWith({ [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson()]) }),
      await resolveWith({ [`${DIR}/monitor-events.jsonl`]: jsonl([eventJson({ tsMs: NOW - MAX_AGE - 1 })]) }),
      await resolveWith({ [`${DIR}/monitor-events.jsonl`]: "garbage\n" }),
    ];
    for (const p of outcomes) {
      expect(p.dataState).toBe(
        p.artifactState === "valid" ? "real" : p.artifactState === "stale" ? "stale" : "unavailable",
      );
      expect((p.dataState === "real") === (p.artifactState === "valid")).toBe(true);
      if (p.artifactState === "missing" || p.artifactState === "corrupt") {
        expect(p.fleet).toBeNull();
      }
    }
  });
});

describe("hydrateFleetPayload (client gate)", () => {
  test("round-trips a valid payload through re-parsing", () => {
    const payload = freshPayload();
    const hydrated = hydrateFleetPayload(JSON.parse(JSON.stringify(payload)), NOW);
    expect(hydrated).not.toBeNull();
    expect(hydrated?.fleet?.counts.eventLines).toBe(1);
    expect(hydrated?.newestTsMs).toBe(NOW - 60_000);
  });

  test("refuses malformed envelopes and dishonest mappings", () => {
    expect(hydrateFleetPayload(null, NOW)).toBeNull();
    expect(hydrateFleetPayload("nope", NOW)).toBeNull();
    expect(hydrateFleetPayload({ ...JSON.parse(JSON.stringify(freshPayload())), artifactState: "stale" }, NOW)).toBeNull();
    expect(hydrateFleetPayload({ ...JSON.parse(JSON.stringify(freshPayload())), dataState: "stale" }, NOW)).toBeNull();
    expect(hydrateFleetPayload({ ...JSON.parse(JSON.stringify(freshPayload())), checkedAtUnixMs: 0 }, NOW)).toBeNull();
    expect(hydrateFleetPayload({ ...JSON.parse(JSON.stringify(freshPayload())), source: { kind: "url", uri: "x" } }, NOW)).toBeNull();
    expect(hydrateFleetPayload({ ...JSON.parse(JSON.stringify(freshPayload())), maxAgeMs: 0 }, NOW)).toBeNull();
  });

  test("failed states may not carry a payload", () => {
    const missing = { artifactState: "missing", dataState: "unavailable", reason: "r", reasonCode: "READ_FAILED", source: { kind: "none", uri: null }, checkedAtUnixMs: NOW, ageMs: null, maxAgeMs: MAX_AGE, newestTsMs: null, fleet: freshPayload().fleet };
    expect(hydrateFleetPayload(missing, NOW)).toBeNull();
    const clean = { ...missing, fleet: null };
    const ok = hydrateFleetPayload(clean, NOW);
    expect(ok?.artifactState).toBe("missing");
    expect(ok?.fleet).toBeNull();
  });

  test("tampered trail lines are re-parsed and refused — the client trusts only its own parse", () => {
    const payload = JSON.parse(JSON.stringify(freshPayload())) as Record<string, unknown>;
    const fleet = payload.fleet as Record<string, unknown>;
    fleet.events = [{ tsMs: 1, botId: "ghost", type: "salvage-everything" }];
    payload.fleet = fleet;
    expect(hydrateFleetPayload(payload, NOW)).toBeNull();
  });

  test("counts/newest inconsistencies are refused", () => {
    const payload = JSON.parse(JSON.stringify(freshPayload())) as Record<string, unknown>;
    const fleet = payload.fleet as Record<string, unknown>;
    fleet.counts = { eventLines: 99, alertLines: 0 };
    payload.fleet = fleet;
    expect(hydrateFleetPayload(payload, NOW)).toBeNull();

    const payload2 = JSON.parse(JSON.stringify(freshPayload())) as Record<string, unknown>;
    payload2.newestTsMs = 1;
    expect(hydrateFleetPayload(payload2, NOW)).toBeNull();
  });

  test("future-dated payloads are refused; staleness verdict must match the payload's own budget", () => {
    const future = JSON.parse(JSON.stringify(freshPayload({ checkedAtUnixMs: NOW }))) as Record<string, unknown>;
    const fleet = future.fleet as Record<string, unknown>;
    fleet.events = [eventJson({ tsMs: NOW + 30 * 60_000 })];
    fleet.counts = { eventLines: 1, alertLines: 1 };
    future.fleet = fleet;
    future.newestTsMs = NOW + 30 * 60_000;
    expect(hydrateFleetPayload(future, NOW)).toBeNull();

    const mislabeled = JSON.parse(JSON.stringify(freshPayload())) as Record<string, unknown>;
    const fleet2 = mislabeled.fleet as Record<string, unknown>;
    fleet2.events = [eventJson({ tsMs: NOW - MAX_AGE - 5_000 })];
    mislabeled.fleet = fleet2;
    mislabeled.newestTsMs = NOW - MAX_AGE - 5_000;
    // envelope claims valid, payload is stale by its own budget → refused
    expect(hydrateFleetPayload(mislabeled, NOW)).toBeNull();
  });
});

/* ── Display rules (D5 semantics on the fleet view) ─────────────────── */

describe("fleet display rules", () => {
  test("wall clock degrades valid→stale mid-session; a stale verdict only deepens with time", () => {
    const payload = freshPayload(); // newest = NOW − 60s, budget 30 min
    const stillFresh = effectiveFleetState(payload, NOW + MAX_AGE - 60_000);
    expect(stillFresh.artifactState).toBe("valid");

    const degraded = effectiveFleetState(payload, NOW + MAX_AGE - 60_000 + 1);
    expect(degraded.artifactState).toBe("stale");
    expect(degraded.dataState).toBe("stale");
    expect(degraded.reason).toContain("never as fresh");

    // A wire-shaped stale payload (content past its own budget) stays
    // stale as the clock advances — age only grows, never reverses.
    const stale = freshPayload({
      artifactState: "stale",
      dataState: "stale",
      reason: "past budget",
      newestTsMs: NOW - MAX_AGE - 5_000,
      ageMs: MAX_AGE + 5_000,
      fleet: fleetState([parseFleetTrailEvent(eventJson({ tsMs: NOW - MAX_AGE - 5_000 }))], []),
    });
    const later = effectiveFleetState(stale, NOW + MAX_AGE);
    expect(later.artifactState).toBe("stale");
    expect(later.ageMs).toBe(2 * MAX_AGE + 5_000); // (NOW+MAX_AGE) − (NOW−MAX_AGE−5s)
  });

  test("empty trails keep their verdict — the clock cannot invent an age", () => {
    const empty = freshPayload({
      fleet: fleetState([], []),
      newestTsMs: null,
      ageMs: null,
    });
    const later = effectiveFleetState(empty, NOW + 3_600_000);
    expect(later.artifactState).toBe("valid");
    expect(later.ageMs).toBeNull();
  });

  test("cached precedence: latest failure holds the last good trail as cached; stale stays stale", () => {
    const lastGood = freshPayload();
    const display = resolveDisplayFleetPayload(null, lastGood, NOW + 1000);
    expect(display?.dataState).toBe("cached");

    // A held trail past its budget reads stale — the stronger claim wins.
    const oldGood = freshPayload();
    const staleDisplay = asCachedFleetDisplay(oldGood, NOW + MAX_AGE);
    expect(staleDisplay.dataState).toBe("stale");

    // Unavailable stays unavailable; nothing is ever upgraded to real.
    expect(resolveDisplayFleetPayload(null, null, NOW)).toBeNull();
    const failed: FleetTransportPayload = {
      ...freshPayload({ artifactState: "missing", dataState: "unavailable", reason: "x", reasonCode: "READ_FAILED", fleet: null, newestTsMs: null, ageMs: null }),
    };
    // A failed latest check with nothing held → no display payload; the
    // view's banner surfaces the raw latestTransport diagnostics instead.
    expect(resolveDisplayFleetPayload(failed, null, NOW)).toBeNull();
  });

  test("the latest check wins when it carries a trail; freshness follows the wall clock", () => {
    const latest = freshPayload({ checkedAtUnixMs: NOW + 500 });
    const lastGood = freshPayload();
    const display = resolveDisplayFleetPayload(latest, lastGood, NOW + 1000);
    expect(display?.checkedAtUnixMs).toBe(NOW + 500);
    expect(display?.dataState).toBe("real");
  });
});

/* ── Fixture-free Fleet view — source grep is part of the contract ──── */

describe("fleet view honesty (source grep)", () => {
  const fleetSrc = readFileSync(new URL("../../../components/gy/fleet.tsx", import.meta.url), "utf8");
  const pageSrc = readFileSync(new URL("../../../app/page.tsx", import.meta.url), "utf8");

  test("the Fleet view no longer imports the simulated fixtures", () => {
    expect(fleetSrc).not.toMatch(/from "@\/lib\/gy\/data"/);
    expect(fleetSrc).not.toMatch(/\bBOTS\b/);
    expect(fleetSrc).not.toMatch(/\bEVENT_GENERATOR\b/);
    // page.tsx must not feed the Fleet view fixture bots either.
    expect(pageSrc).not.toMatch(/<Fleet bots=/);
  });

  test("the view never fabricates status/mode vocabulary the trail does not carry", () => {
    // The old fixture cards claimed mode/status/standby telemetry.
    expect(fleetSrc).not.toMatch(/"dry-run"|"live"|"read-only"/);
    expect(fleetSrc).not.toMatch(/nominal|standby|watching/);
  });
});
