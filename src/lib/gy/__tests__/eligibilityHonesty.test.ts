// Eligibility visualization honesty battery (P4.2 — audit D5/D6).
//
// Pins the two honesty properties the audit demanded:
//
//   D5 — every DataState value is actually assignable, and the display path
//        can never upgrade what the transport refused: an artifact that is
//        stale, missing or corrupt can never present as fresh, even when a
//        failed refresh leaves the last good copy on screen ("cached"), and
//        even when the session clock runs past the artifact's own freshness
//        budget while it is being displayed.
//
//   D6 — the C6 epoch gap is computed only from an explicitly provided
//        current epoch; with no epoch the criterion fails closed to
//        "pending · current epoch unavailable" and the gap is never
//        fabricated from a baked-in constant.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

import { bytesToPayload } from "../snapshotSource";
import {
  asCachedDisplay,
  effectiveTransportState,
  hydrateTransportPayload,
  resolveDisplayPayload,
  staleReason,
  transportDataState,
  type SnapshotTransportPayload,
} from "../snapshotTransport";
import { RAW_SNAPSHOT } from "../snapshot";
import { criteriaOf } from "../estimator";
import type { Pool } from "../types";

/* ── Fixtures ──────────────────────────────────────────────────────── */

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const MAX_AGE_MS = 24 * 3_600_000; // the committed artifact's freshness budget

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

function payloadAt(generatedAtUnixMs: number, nowMs: number): SnapshotTransportPayload {
  return bytesToPayload(artifactBytes(generatedAtUnixMs), {
    nowMs,
    checkedAtUnixMs: nowMs,
    source: { kind: "path", uri: "/mnt/gy/console-snapshot.json" },
  });
}

const D6_POOL: Pool = {
  address: "POOL1111111111111111111111111111111111111111",
  baseSymbol: "MEME",
  quoteSymbol: "WSOL",
  amm: "Raydium V4",
  quoteReserveLamports: 600_000_000n,
  baseReserve: 1_000_000n,
  baseDecimals: 6,
  lpSupply: 10_000_000,
  lastSwapUnix: Math.floor((NOW - 91 * DAY_MS) / 1000),
  collapseBps: 9_900,
  lpBurned: false,
  lpLocked: false,
  state: "certification-ready",
  score: 0.8,
  anchorEpoch: 798,
  certExpiresAt: null,
};

function c6(pool: Pool, currentEpoch: number | null) {
  return criteriaOf(pool, NOW, currentEpoch).find((c) => c.id === "C6")!;
}

/* ── D5: display-time freshness re-evaluation ─────────────────────── */

describe("effectiveTransportState — freshness is a function of the wall clock", () => {
  test("a valid payload stays valid while inside its own budget; the reported age moves", () => {
    const fetched = payloadAt(NOW - 60_000, NOW);
    expect(fetched.artifactState).toBe("valid");
    expect(fetched.dataState).toBe("real");

    const later = effectiveTransportState(fetched, NOW + 5 * 60_000);
    expect(later.artifactState).toBe("valid");
    expect(later.dataState).toBe("real");
    // generatedAt is NOW − 60 s; at NOW + 5 min the age is exactly 6 min.
    expect(later.ageMs).toBe(6 * 60_000);
    expect(later.reason).toBeNull();
  });

  test("D5 invariant: a valid-at-fetch artifact degrades to stale the moment its budget lapses", () => {
    const fetched = payloadAt(NOW - 60_000, NOW);
    const pastBudget = NOW - 60_000 + MAX_AGE_MS + 1;
    const aged = effectiveTransportState(fetched, pastBudget);
    expect(aged.artifactState).toBe("stale");
    expect(aged.dataState).toBe("stale");
    expect(aged.reason).toBe(staleReason(aged.ageMs!, MAX_AGE_MS));
    expect(aged.snapshot).not.toBeNull(); // data still served — flagged, not hidden
  });

  test("budget boundary matches the transport's own ≤ semantics (exactly maxAge is still fresh)", () => {
    const fetched = payloadAt(NOW - 60_000, NOW);
    const atBoundary = NOW - 60_000 + MAX_AGE_MS;
    expect(effectiveTransportState(fetched, atBoundary).dataState).toBe("real");
    expect(effectiveTransportState(fetched, atBoundary + 1).dataState).toBe("stale");
  });

  test("a stale payload never upgrades — the clock only moves forward", () => {
    const stale = payloadAt(NOW - MAX_AGE_MS - 1, NOW);
    expect(stale.artifactState).toBe("stale");
    const muchLater = effectiveTransportState(stale, NOW + 30 * DAY_MS);
    expect(muchLater.artifactState).toBe("stale");
    expect(muchLater.dataState).toBe("stale");
    expect(muchLater.ageMs!).toBeGreaterThan(stale.ageMs!);
  });

  test("missing/corrupt payloads carry nothing to age — returned untouched", () => {
    const missing = bytesToPayload(new TextEncoder().encode("not-json"), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: { kind: "path", uri: "/mnt/gy/console-snapshot.json" },
    });
    expect(missing.artifactState).toBe("corrupt");
    expect(effectiveTransportState(missing, NOW + DAY_MS)).toBe(missing);
  });
});

/* ── D5: the "cached" holding state ────────────────────────────────── */

describe("asCachedDisplay — the last good artifact survives a failed refresh, honestly labeled", () => {
  test("fresh last-good artifact is held as cached, never as real", () => {
    const lastGood = payloadAt(NOW - 60_000, NOW);
    const held = asCachedDisplay(lastGood, NOW + 10_000);
    expect(held.dataState).toBe("cached");
    expect(held.artifactState).toBe("valid"); // the artifact's own verdict is preserved
    expect(held.snapshot).not.toBeNull();
  });

  test("staleness wins: a cached artifact past its budget still reads stale", () => {
    const lastGood = payloadAt(NOW - 60_000, NOW);
    const held = asCachedDisplay(lastGood, NOW - 60_000 + MAX_AGE_MS + 1);
    expect(held.dataState).toBe("stale");
    expect(held.artifactState).toBe("stale");
  });

  test("a failed state is never relabeled cached", () => {
    const corrupt = bytesToPayload(new TextEncoder().encode("###"), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: { kind: "path", uri: "/mnt/gy/console-snapshot.json" },
    });
    expect(asCachedDisplay(corrupt, NOW).dataState).toBe("unavailable");
  });
});

/* ── D5: the page's display derivation, end to end over the wire ───── */

describe("resolveDisplayPayload — stale/invalid artifacts can never present as fresh", () => {
  test("fresh latest check wins and reads real", () => {
    const latest = payloadAt(NOW - 60_000, NOW);
    const older = payloadAt(NOW - 3 * DAY_MS, NOW);
    const display = resolveDisplayPayload(latest, older, NOW);
    expect(display?.dataState).toBe("real");
  });

  test("stale latest check is displayed stale — even with a payload also held as last-good", () => {
    const latest = payloadAt(NOW - MAX_AGE_MS - 1, NOW);
    const lastGood = payloadAt(NOW - 2 * DAY_MS, NOW); // 2d old — past the 24h budget as well
    const display = resolveDisplayPayload(latest, lastGood, NOW);
    expect(display?.dataState).toBe("stale");
  });

  test("failed latest check (unreachable → null) falls back to the held artifact as cached", () => {
    const lastGood = payloadAt(NOW - 60_000, NOW);
    const display = resolveDisplayPayload(null, lastGood, NOW + 10_000);
    expect(display?.dataState).toBe("cached");
    expect(display?.artifactState).toBe("valid");
  });

  test("malformed transport payload (hydration null) falls back to cached — never to silence", () => {
    const lastGood = payloadAt(NOW - 60_000, NOW);
    // What the browser would hold after a successful earlier check.
    const wireEnvelope = JSON.parse(
      JSON.stringify({
        ...lastGood,
        snapshot: lastGood.snapshot,
      }),
    ) as unknown;
    const rehydrated = hydrateTransportPayload(wireEnvelope, NOW);
    expect(rehydrated).not.toBeNull();
    const display = resolveDisplayPayload(null, rehydrated, NOW + 10_000);
    expect(display?.dataState).toBe("cached");
  });

  test("missing/corrupt latest check falls back to the held artifact as cached", () => {
    const lastGood = payloadAt(NOW - 60_000, NOW);
    const corrupt = bytesToPayload(new TextEncoder().encode("###"), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: { kind: "path", uri: "/mnt/gy/console-snapshot.json" },
    });
    const display = resolveDisplayPayload(corrupt, lastGood, NOW + 10_000);
    expect(display?.dataState).toBe("cached");
    expect(display?.snapshot).not.toBeNull();
  });

  test("nothing ever served → null (the honest unavailable state)", () => {
    expect(resolveDisplayPayload(null, null, NOW)).toBeNull();
  });

  test("sweep: across every failed-wire outcome the display dataState is never real", () => {
    const lastGood = payloadAt(NOW - 60_000, NOW);
    const staleLatest = payloadAt(NOW - MAX_AGE_MS - 1, NOW);
    const corruptLatest = bytesToPayload(new TextEncoder().encode("###"), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: { kind: "path", uri: "/mnt/gy/console-snapshot.json" },
    });
    const scenarios: [string, SnapshotTransportPayload | null][] = [
      ["unreachable (null latest)", null],
      ["stale latest", staleLatest],
      ["corrupt latest", corruptLatest],
    ];
    for (const [name, latest] of scenarios) {
      for (const at of [NOW + 1_000, NOW + 3_600_000, NOW + MAX_AGE_MS + 1, NOW + 30 * DAY_MS]) {
        const display = resolveDisplayPayload(latest, lastGood, at);
        expect(display, name).not.toBeNull();
        expect(["stale", "cached", "unavailable"], `${name} @ ${at}`).toContain(display!.dataState);
        expect(display!.dataState === "real", `${name} @ ${at} must not read real`).toBe(false);
      }
    }
  });

  test("future-dated artifacts are rejected upstream, so the display path can never see one", () => {
    // The display math clamps negative ages; the reason it can never be
    // exploited into an eternal "fresh" is that both the resolver and the
    // hydration gate refuse future-dated generatedAt outright.
    const future = bytesToPayload(artifactBytes(NOW + 10 * 60_000), {
      nowMs: NOW,
      checkedAtUnixMs: NOW,
      source: { kind: "path", uri: "/mnt/gy/console-snapshot.json" },
    });
    expect(future.artifactState).toBe("corrupt");
    expect(future.reasonCode).toBe("FUTURE_GENERATED_AT");
    // The client-side gate refuses the same artifact riding a hand-built envelope.
    expect(hydrateTransportPayload({ artifactState: "valid", dataState: "real" }, NOW)).toBeNull();
  });
});

/* ── D5: the honest mapping stays total over the DataState vocabulary ── */

describe("DataState vocabulary is fully exercised (audit D5)", () => {
  test("transport mapping covers real/stale/unavailable; cached/simulated are assigned elsewhere", () => {
    expect(transportDataState("valid")).toBe("real");
    expect(transportDataState("stale")).toBe("stale");
    expect(transportDataState("missing")).toBe("unavailable");
    expect(transportDataState("corrupt")).toBe("unavailable");
    // cached: assigned by asCachedDisplay (this file) on failed-refresh fallback.
    const held = asCachedDisplay(payloadAt(NOW - 1_000, NOW), NOW);
    expect(held.dataState).toBe("cached");
    // simulated: assigned by the fixture layer (data.ts POOLS render paths),
    // badged by the shell — out of the snapshot transport's scope.
  });
});

/* ── D6: the C6 epoch gap is never fabricated ──────────────────────── */

describe("criteriaOf C6 — explicit epoch contract (audit D6)", () => {
  test("gap computed only when the caller names the current epoch", () => {
    expect(c6({ ...D6_POOL, anchorEpoch: 798 }, 800).state).toBe("pass"); // gap 2
    expect(c6({ ...D6_POOL, anchorEpoch: 798 }, 800).value).toBe("2 / 2 epochs");
    expect(c6({ ...D6_POOL, anchorEpoch: 799 }, 800).state).toBe("pending"); // gap 1
    expect(c6({ ...D6_POOL, anchorEpoch: 796 }, 800).state).toBe("pass"); // gap 4
  });

  test("null / omitted / unusable epoch → pending with an explicit value, gap never invented", () => {
    for (const bad of [null, undefined, Number.NaN] as unknown as (number | null)[]) {
      const crit = c6(D6_POOL, bad as number | null);
      expect(crit.state).toBe("pending");
      expect(crit.value).toBe("current epoch unavailable");
    }
  });

  test("no anchor → pending 'no anchor' regardless of epoch knowledge", () => {
    expect(c6({ ...D6_POOL, anchorEpoch: null }, 800).state).toBe("pending");
    expect(c6({ ...D6_POOL, anchorEpoch: null }, 800).value).toBe("no anchor");
    expect(c6({ ...D6_POOL, anchorEpoch: null }, null).value).toBe("no anchor");
  });

  test("the estimator owns no epoch constant — source grep is part of the contract", () => {
    // If a future edit reintroduces a baked-in epoch (e.g. `713 -`), this
    // test fails and forces the explicit-argument contract back.
    const src = readFileSync(new URL("../estimator.ts", import.meta.url), "utf8");
    expect(/713\s*-\s*\w*\.?anchorEpoch/.test(src)).toBe(false);
  });
});
