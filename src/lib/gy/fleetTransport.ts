// Fleet trail TRANSPORT types + client-side hydration (P4.3 fleet ingestion).
//
// The /api/gy/fleet route resolves the salvor fleet's state dir
// (FLEET_STATE_DIR topology — see fleetSource.ts) and answers with this
// envelope. Four artifact states exist and are ALWAYS explicit:
//
//   valid    — both trails parsed, contract-clean, inside the freshness
//              budget (an empty monitor trail is valid: "no events yet")
//   stale    — parsed, contract-clean, but the newest trail line is older
//              than the budget (data is served, but can never be presented
//              as fresh)
//   missing  — no source configured, or the trails could not be transported
//              (unreadable dir, absent monitor trail, I/O failure)
//   corrupt  — bytes arrived but fail the fail-closed contract (bad JSON,
//              vocabulary violation, non-scalar alert context, future-dated
//              trail, oversized file)
//
// The client MUST treat this envelope as untrusted: hydrateFleetPayload()
// re-runs the full fail-closed parsers (fleetContract) on every line of any
// fleet payload before a single byte of it is rendered, re-derives the
// newest-timestamp freshness verdict, and refuses any envelope whose
// dataState does not match its artifactState. That is the same second
// application of the same fail-closed contract the snapshot transport uses:
// a stale or invalid trail can never be rendered as fresh fleet data.

import {
  FLEET_CLOCK_SKEW_TOLERANCE_MS,
  FLEET_DEFAULT_MAX_AGE_MS,
  fleetFreshness,
  fleetState,
  newestTrailTsMs,
  parseFleetAlert,
  parseFleetTrailEvent,
  type FleetState,
} from "./fleetContract";
import { transportDataState, type ArtifactState } from "./snapshotTransport";
import type { DataState } from "./types";

/** Machine-readable cause for non-valid fleet states (null when valid/stale). */
export type FleetReasonCode =
  | "NO_SOURCE_CONFIGURED"
  | "READ_FAILED"
  | "TRAIL_ABSENT"
  | "OVERSIZE"
  | "PARSE_FAILED"
  | "FUTURE_TRAIL_TS"
  | "MALFORMED_ENVELOPE";

/** Where the route attempted to load the fleet state from. */
export type FleetSourceKind = "path" | "none";

/** Fleet transport envelope — the diagnostic half of the response (no payload). */
export interface FleetTransport {
  artifactState: ArtifactState;
  /** honest UI-facing mapping: valid→real, stale→stale, missing/corrupt→unavailable */
  dataState: DataState;
  /** human-readable explanation, always present for missing/corrupt/stale */
  reason: string | null;
  reasonCode: FleetReasonCode | null;
  source: { kind: FleetSourceKind; uri: string | null };
  /** server clock at evaluation time (unix ms) — the client's "checked at" */
  checkedAtUnixMs: number;
  /** now − newest trail line; null only for an empty (fresh-verdict "empty") trail */
  ageMs: number | null;
  maxAgeMs: number;
  /** newest tsMs/atMs in the trail; null when empty */
  newestTsMs: number | null;
}

/** Full route payload: the envelope plus the trails when one was served. */
export interface FleetTransportPayload extends FleetTransport {
  /** present ONLY for valid | stale — always null for missing | corrupt */
  fleet: FleetState | null;
}

/** Shared stale explanation — one wording for the resolver and the display path. */
export function fleetStaleReason(ageMs: number, maxAgeMs: number): string {
  return `Fleet trail age ${ageMs} ms since its newest line exceeds the ${maxAgeMs} ms freshness budget — data is served as stale, never as fresh.`;
}

/**
 * P4.2 semantics applied to the fleet trail — display-time freshness
 * re-evaluation. Freshness is a function of the wall clock, not of the
 * moment the payload happened to be fetched: a payload that classified
 * "valid/real" at fetch time degrades to "stale" once the client's clock
 * passes the budget. The clock only moves forward, so this can degrade
 * (valid→stale) but never upgrade (stale→valid) — a re-freshened trail
 * requires a real re-fetch. An empty trail has no timestamp to age and
 * keeps its verdict (the clock cannot invent one).
 */
export function effectiveFleetState(
  payload: FleetTransportPayload,
  nowMs: number,
): FleetTransportPayload {
  const fleet = payload.fleet;
  if (fleet === null) return payload; // missing/corrupt — nothing to age
  const freshness = fleetFreshness(fleet, nowMs, payload.maxAgeMs);
  if (freshness.verdict === "empty") {
    return payload.ageMs === null ? payload : { ...payload, ageMs: null };
  }
  const fresh = freshness.verdict === "fresh";
  const newestTsMs = newestTrailTsMs(fleet);
  if (fresh === (payload.artifactState === "valid")) {
    // Same verdict — only the reported age moves with the clock.
    return { ...payload, ageMs: freshness.ageMs, newestTsMs };
  }
  if (fresh) {
    // Defensive: only reachable with a hand-built payload whose state
    // disagreed with its own budget (hydrate forbids this on the wire).
    return {
      ...payload,
      artifactState: "valid",
      dataState: "real",
      reason: null,
      reasonCode: null,
      ageMs: freshness.ageMs,
      newestTsMs,
    };
  }
  return {
    ...payload,
    artifactState: "stale",
    dataState: "stale",
    reason: fleetStaleReason(freshness.ageMs ?? 0, payload.maxAgeMs),
    reasonCode: null,
    ageMs: freshness.ageMs,
    newestTsMs,
  };
}

/**
 * P4.2 (audit D5) semantics for the fleet view — assign the "cached"
 * DataState when the latest refresh failed but a last-good payload is held.
 * Precedence is one-directional: past-budget trails still read "stale"
 * (the stronger claim), failed states still read "unavailable"; "cached"
 * replaces "real" only.
 */
export function asCachedFleetDisplay(
  payload: FleetTransportPayload,
  nowMs: number,
): FleetTransportPayload {
  const aged = effectiveFleetState(payload, nowMs);
  if (aged.fleet === null) return aged; // unavailable stays unavailable
  if (aged.dataState === "real") return { ...aged, dataState: "cached" };
  return aged; // stale stays stale; nothing else can be held as last-good
}

/**
 * The Fleet view's display derivation as one pure, tested rule (mirror of
 * resolveDisplayPayload). page.tsx applies it against the current clock on
 * every render (no network, no polling):
 *
 *   1. the latest check carried a trail → display it, freshness
 *      re-evaluated now (valid-at-fetch degrades to stale when the budget
 *      lapses mid-session);
 *   2. the latest check carried no trail (failed transport, rejected
 *      payload, missing/corrupt trails) but a last-good payload is held →
 *      display that, marked cached (staleness still wins);
 *   3. nothing ever served → null (honest unavailable state).
 */
export function resolveDisplayFleetPayload(
  latest: FleetTransportPayload | null,
  lastGood: FleetTransportPayload | null,
  nowMs: number,
): FleetTransportPayload | null {
  if (latest !== null && latest.fleet !== null) return effectiveFleetState(latest, nowMs);
  if (lastGood !== null) return asCachedFleetDisplay(lastGood, nowMs);
  return null;
}

export const FLEET_REASON_CODES: readonly FleetReasonCode[] = [
  "NO_SOURCE_CONFIGURED",
  "READ_FAILED",
  "TRAIL_ABSENT",
  "OVERSIZE",
  "PARSE_FAILED",
  "FUTURE_TRAIL_TS",
  "MALFORMED_ENVELOPE",
];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Client-side gate for the route payload. Returns null (→ render
 * "unavailable") unless the envelope is well-formed AND internally
 * consistent AND its fleet payload re-parses through the same fail-closed
 * parsers the server used, with the freshness verdict re-derived from the
 * re-validated lines themselves. This is what makes "stale trail rendered
 * as fresh fleet data" structurally impossible in the UI layer.
 */
export function hydrateFleetPayload(
  json: unknown,
  nowMs: number,
): FleetTransportPayload | null {
  if (!isObj(json)) return null;
  const artifactState = json.artifactState;
  if (artifactState !== "valid" && artifactState !== "stale" && artifactState !== "missing" && artifactState !== "corrupt") {
    return null;
  }
  const dataState = json.dataState;
  if (dataState !== "real" && dataState !== "stale" && dataState !== "unavailable" && dataState !== "cached") return null;
  // Envelope honesty: on the wire the dataState must be exactly the mapping
  // promises ("cached" exists only client-side, as a display state).
  if (dataState !== transportDataState(artifactState)) return null;
  const checkedAtUnixMs = optFinite(json.checkedAtUnixMs);
  if (checkedAtUnixMs === null || checkedAtUnixMs <= 0) return null;
  const reasonCode = json.reasonCode;
  if (reasonCode !== null && !FLEET_REASON_CODES.includes(reasonCode as FleetReasonCode)) return null;
  const reason = json.reason === null ? null : optStr(json.reason);
  if (reason === undefined) return null;
  const src = json.source;
  if (!isObj(src)) return null;
  if (src.kind !== "path" && src.kind !== "none") return null;
  const uri = src.uri === null ? null : optStr(src.uri);
  if (uri === undefined) return null;
  const ageMs = json.ageMs === null ? null : optFinite(json.ageMs);
  if (ageMs === undefined) return null;
  const maxAgeMs = optFinite(json.maxAgeMs);
  if (maxAgeMs === null || maxAgeMs <= 0) return null;
  const newestTsMs = json.newestTsMs === null ? null : optFinite(json.newestTsMs);
  if (newestTsMs === undefined) return null;

  const transport: FleetTransport = {
    artifactState,
    dataState,
    reason,
    reasonCode: (reasonCode as FleetReasonCode) ?? null,
    source: { kind: src.kind, uri },
    checkedAtUnixMs,
    ageMs,
    maxAgeMs,
    newestTsMs,
  };

  const rawFleet = json.fleet;
  if (artifactState === "missing" || artifactState === "corrupt") {
    // No payload may ride along with a failed artifact.
    if (rawFleet !== null && rawFleet !== undefined) return null;
    return { ...transport, fleet: null };
  }

  // valid | stale: the payload MUST re-parse through the full contract —
  // the client never trusts the server's parse, only its own.
  if (!isObj(rawFleet)) return null;
  if (!Array.isArray(rawFleet.events) || !Array.isArray(rawFleet.alerts)) return null;
  try {
    const events = rawFleet.events.map((e, i) => parseFleetTrailEvent(e, `events[${i}]`));
    const alerts = rawFleet.alerts.map((a, i) => parseFleetAlert(a, `alerts[${i}]`));
    const fleet = fleetState(events, alerts);
    // Counts must match the arrays actually served.
    if (!isObj(rawFleet.counts)) return null;
    if (rawFleet.counts.eventLines !== fleet.counts.eventLines) return null;
    if (rawFleet.counts.alertLines !== fleet.counts.alertLines) return null;
    // The newest timestamp must be re-derived from the payload itself.
    const derivedNewest = newestTrailTsMs(fleet);
    if (derivedNewest !== transport.newestTsMs) return null;
    // A future-dated trail must never classify as fresh.
    if (derivedNewest !== null && derivedNewest > checkedAtUnixMs + FLEET_CLOCK_SKEW_TOLERANCE_MS) return null;
    // The staleness verdict must match the payload's own budget.
    const verdict = fleetFreshness(fleet, nowMs, transport.maxAgeMs).verdict;
    const fresh = verdict !== "stale"; // "empty" has no age; only "stale" contradicts valid
    if (fresh !== (artifactState === "valid")) return null;
    return { ...transport, fleet };
  } catch {
    return null;
  }
}

export { FLEET_DEFAULT_MAX_AGE_MS, transportDataState };
