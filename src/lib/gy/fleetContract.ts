// Fleet trail CONTRACT — isomorphic, artifact-free (P4.3 fleet ingestion).
//
// Everything in this module is pure: it validates and maps the salvor
// fleet's JSONL trails without reading files, fetching URLs, or importing
// fixtures. That makes it safe to import from client code (the Fleet view
// re-validates every transport payload with the exact same fail-closed gate
// the server used) and from server-side transport code alike.
//
// The contract mirrors the WRITER, byte for byte — salvor-bots
// @graveyield/fleet-core src/events.ts (FleetEvent) and @graveyield/fleet-ops
// src/alerts.ts (Alert). The vocabularies below are transcriptions of the
// upstream unions, never inventions; a parser that "accepts anything" would
// let a drifted or fabricated trail render as fleet truth.
//
// What the fleet actually writes into FLEET_STATE_DIR (verified against
// fleet-ops/src/cli.ts wireFleet()):
//   monitor-events.jsonl — the Monitor's FleetEvent trail (one JSON object
//                          per line, append-only; created at process start).
//   alerts.jsonl         — Alert objects (created lazily on the FIRST alert;
//                          its absence is therefore a legal empty state, not
//                          an error).
// The Scout's own trail is separate upstream (SCOUT_REPORT_FILE, default
// unset) and is not part of this ingestion premise.
//
// Contract rules (mirroring snapshotContract.ts):
//   - FAIL-CLOSED: any missing/invalid required field, unknown vocabulary
//     value, or non-scalar alert context throws FleetError. A broken trail
//     can never silently render as fleet data.
//   - WHOLE-ARTIFACT rejection: one bad line rejects the entire file. An
//     append-only trail is the fleet's record; serving a partial record "as
//     if" it were complete would be fabrication by omission. (A torn tail
//     write is a real integrity problem and is reported as corrupt, not
//     skipped.)
//   - Freshness is imposed by the console, not self-stamped: the trail has
//     no freshness header of its own, so the budget defaults below and is
//     env-overridable server-side; it always rides in the transport
//     envelope so the client can re-evaluate it against the wall clock.

import type { DataState } from "./types";

export type { DataState };

/* ── Upstream vocabulary (transcribed from fleet-core/src/events.ts) ── */

/** fleet-core FleetEventType — the vocabulary of the whole fleet's wire log. */
export type FleetEventType =
  // consumption
  | "opportunity-received"
  | "opportunity-duplicate"
  | "opportunity-rejected"
  // revalidation
  | "revalidated"
  | "revalidation-rejected"
  // coordination
  | "lease-acquired"
  | "lease-renewed"
  | "lease-denied"
  | "lease-released"
  // economics
  | "economic-pass"
  | "economic-reject"
  // execution
  | "prepared"
  | "simulated"
  | "simulation-failed"
  | "submitted"
  | "confirmed"
  | "execution-failed"
  | "reported"
  // monitor
  | "monitor-observation"
  | "monitor-anomaly"
  | "monitor-reconciled"
  | "monitor-mismatch"
  // lifecycle / ops
  | "cycle-start"
  | "cycle-end"
  | "info"
  | "error";

/** fleet-core FailureClass — stable names the Monitor keys diagnostics on. */
export type FleetFailureClass =
  | "transient-rpc"
  | "transient-route"
  | "transient-blockhash"
  | "stale-opportunity"
  | "stale-anchor"
  | "cert-expired"
  | "cert-missing"
  | "anchor-missing"
  | "criteria-failed"
  | "state-changed"
  | "missing-accounts"
  | "economic-insufficient"
  | "economic-unresolvable"
  | "risk-cap-exceeded"
  | "lease-conflict"
  | "charter-refusal"
  | "simulation-failed"
  | "route-failure"
  | "snapshot-incomplete"
  | "submission-failed"
  | "unsupported"
  | "config-invalid"
  | "unknown";

/** fleet-core ExecutionState — executor lifecycle states. */
export type FleetExecutionState =
  | "received"
  | "duplicate-suppressed"
  | "revalidating"
  | "rejected-stale"
  | "rejected-economics"
  | "lease-waiting"
  | "preparing"
  | "simulating"
  | "simulation-failed"
  | "ready"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed-terminal"
  | "reported";

/** fleet-ops AlertSeverity. */
export type FleetAlertSeverity = "info" | "warn" | "critical";

export const FLEET_EVENT_TYPES: readonly FleetEventType[] = [
  "opportunity-received",
  "opportunity-duplicate",
  "opportunity-rejected",
  "revalidated",
  "revalidation-rejected",
  "lease-acquired",
  "lease-renewed",
  "lease-denied",
  "lease-released",
  "economic-pass",
  "economic-reject",
  "prepared",
  "simulated",
  "simulation-failed",
  "submitted",
  "confirmed",
  "execution-failed",
  "reported",
  "monitor-observation",
  "monitor-anomaly",
  "monitor-reconciled",
  "monitor-mismatch",
  "cycle-start",
  "cycle-end",
  "info",
  "error",
];

export const FLEET_FAILURE_CLASSES: readonly FleetFailureClass[] = [
  "transient-rpc",
  "transient-route",
  "transient-blockhash",
  "stale-opportunity",
  "stale-anchor",
  "cert-expired",
  "cert-missing",
  "anchor-missing",
  "criteria-failed",
  "state-changed",
  "missing-accounts",
  "economic-insufficient",
  "economic-unresolvable",
  "risk-cap-exceeded",
  "lease-conflict",
  "charter-refusal",
  "simulation-failed",
  "route-failure",
  "snapshot-incomplete",
  "submission-failed",
  "unsupported",
  "config-invalid",
  "unknown",
];

export const FLEET_EXECUTION_STATES: readonly FleetExecutionState[] = [
  "received",
  "duplicate-suppressed",
  "revalidating",
  "rejected-stale",
  "rejected-economics",
  "lease-waiting",
  "preparing",
  "simulating",
  "simulation-failed",
  "ready",
  "submitting",
  "submitted",
  "confirmed",
  "failed-terminal",
  "reported",
];

export const FLEET_ALERT_SEVERITIES: readonly FleetAlertSeverity[] = ["info", "warn", "critical"];

/* ── Parsed shapes ──────────────────────────────────────────────────── */

/** One fleet-core FleetEvent as written to monitor-events.jsonl. */
export interface FleetTrailEvent {
  /** Epoch ms (upstream makeEvent stamps Date.now()). */
  tsMs: number;
  /** Emitting bot id ("fleet-ops" for the Monitor trail, executor ids when operators enable them). */
  botId: string;
  type: FleetEventType;
  /** Canonical opportunity identity key when pool-scoped. */
  identityKey?: string;
  /** Base58 pool address (duplicate of the identity tail for grep-ability). */
  pool?: string;
  /** Executor lifecycle state at emit time, when applicable. */
  state?: FleetExecutionState;
  /** Stable failure class for failure-carrying events. */
  failureClass?: FleetFailureClass;
  /** Free-form structured payload — arbitrary JSON object upstream. */
  data?: Record<string, unknown>;
}

/** One fleet-ops Alert as written to alerts.jsonl. */
export interface FleetAlert {
  /** Stable machine code, e.g. "scout-cycle-failed". */
  code: string;
  severity: FleetAlertSeverity;
  message: string;
  /** Epoch ms when the alert was raised. */
  atMs: number;
  /** Structured context — scalars/null only, per the upstream Alert type. */
  context: Record<string, string | number | boolean | null>;
  /** true when this raise was suppressed by the upstream dedup window. */
  suppressed: boolean;
}

/** The parsed, validated state-dir content. Line order is preserved —
 * the file's append order IS the artifact's truth (no re-sorting, which
 * could hide clock-skewed writers or a tampered file). */
export interface FleetState {
  events: FleetTrailEvent[];
  alerts: FleetAlert[];
  counts: { eventLines: number; alertLines: number };
}

export class FleetError extends Error {
  constructor(message: string) {
    super(`fleet: ${message}`);
    this.name = "FleetError";
  }
}

/* ── Freshness budget ───────────────────────────────────────────────── */

/**
 * Default freshness budget for the fleet trail. The fleet-ops defaults are
 * a Monitor sweep every 60 s and a Scout cycle every 5 min; the fleet's own
 * HealthRegistry calls a component stale past 3× its poll interval. 30 min
 * = 30× the monitor sweep and 6× the scout cycle — long enough that a
 * healthy quiet fleet is not flagged, short enough that a dead one cannot
 * masquerade as current. Server-overridable via GY_FLEET_MAX_AGE_MS.
 */
export const FLEET_DEFAULT_MAX_AGE_MS = 30 * 60_000;

/** Clock-skew tolerance for trail timestamps (mirrors the snapshot contract). */
export const FLEET_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/* ── Parsers ────────────────────────────────────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new FleetError(`${what} must be a non-empty string`);
  return v;
}

function posInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    throw new FleetError(`${what} must be a positive integer epoch-ms number`);
  }
  return v;
}

function optStr(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  return str(v, what);
}

function vocab<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new FleetError(`${what} is not part of the fleet vocabulary (${JSON.stringify(v)})`);
  }
  return v as T;
}

/** Parse and fully validate one untyped monitor-events.jsonl line. Throws FleetError. */
export function parseFleetTrailEvent(raw: unknown, what = "event"): FleetTrailEvent {
  if (!isObj(raw)) throw new FleetError(`${what} must be an object`);
  const event: FleetTrailEvent = {
    tsMs: posInt(raw.tsMs, `${what}.tsMs`),
    botId: str(raw.botId, `${what}.botId`),
    type: vocab(raw.type, FLEET_EVENT_TYPES, `${what}.type`),
  };
  const identityKey = optStr(raw.identityKey, `${what}.identityKey`);
  if (identityKey !== undefined) event.identityKey = identityKey;
  const pool = optStr(raw.pool, `${what}.pool`);
  if (pool !== undefined) event.pool = pool;
  if (raw.state !== undefined) event.state = vocab(raw.state, FLEET_EXECUTION_STATES, `${what}.state`);
  if (raw.failureClass !== undefined) {
    event.failureClass = vocab(raw.failureClass, FLEET_FAILURE_CLASSES, `${what}.failureClass`);
  }
  if (raw.data !== undefined) {
    if (!isObj(raw.data)) throw new FleetError(`${what}.data must be an object when present`);
    event.data = raw.data;
  }
  return event;
}

/** Parse and fully validate one untyped alerts.jsonl line. Throws FleetError. */
export function parseFleetAlert(raw: unknown, what = "alert"): FleetAlert {
  if (!isObj(raw)) throw new FleetError(`${what} must be an object`);
  if (raw.suppressed !== undefined && typeof raw.suppressed !== "boolean") {
    throw new FleetError(`${what}.suppressed must be a boolean`);
  }
  if (!isObj(raw.context)) throw new FleetError(`${what}.context must be an object`);
  const context: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw.context)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      context[k] = v;
    } else {
      // The upstream AlertManager stringifies bigints and String()s the
      // rest before writing — a nested object here means the trail was
      // not written by the audited fleet-ops code path.
      throw new FleetError(`${what}.context.${k} is not a scalar/null — not written by fleet-ops`);
    }
  }
  return {
    code: str(raw.code, `${what}.code`),
    severity: vocab(raw.severity, FLEET_ALERT_SEVERITIES, `${what}.severity`),
    message: str(raw.message, `${what}.message`),
    atMs: posInt(raw.atMs, `${what}.atMs`),
    context,
    suppressed: raw.suppressed === undefined ? false : raw.suppressed,
  };
}

/** Parse one JSONL file's text; one bad line rejects the whole artifact. */
export function parseFleetEventJsonl(text: string): FleetTrailEvent[] {
  const events: FleetTrailEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue; // empty trailing line(s) from the final "\n"
    try {
      events.push(parseFleetTrailEvent(JSON.parse(line), `events line ${i + 1}`));
    } catch (e) {
      throw e instanceof FleetError
        ? e
        : new FleetError(`events line ${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return events;
}

/** Parse one alerts JSONL file's text; one bad line rejects the whole artifact. */
export function parseFleetAlertJsonl(text: string): FleetAlert[] {
  const alerts: FleetAlert[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      alerts.push(parseFleetAlert(JSON.parse(line), `alerts line ${i + 1}`));
    } catch (e) {
      throw e instanceof FleetError
        ? e
        : new FleetError(`alerts line ${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return alerts;
}

/** Assemble a validated FleetState; counts count parsed (non-empty) lines. */
export function fleetState(events: FleetTrailEvent[], alerts: FleetAlert[]): FleetState {
  return {
    events,
    alerts,
    counts: { eventLines: events.length, alertLines: alerts.length },
  };
}

/* ── Freshness ──────────────────────────────────────────────────────── */

/** Newest timestamp anywhere in the trail (events + alerts); null when empty. */
export function newestTrailTsMs(fleet: FleetState): number | null {
  let newest: number | null = null;
  for (const e of fleet.events) if (newest === null || e.tsMs > newest) newest = e.tsMs;
  for (const a of fleet.alerts) if (newest === null || a.atMs > newest) newest = a.atMs;
  return newest;
}

export interface FleetFreshness {
  /** "fresh" within budget, "stale" past it; "empty" for a contract-clean
   * trail with zero lines — there is no timestamp to age, and the console
   * refuses to invent one ("no events yet" is the honest sentence). */
  verdict: "fresh" | "stale" | "empty";
  /** now − newestTrailTsMs; null only when empty. */
  ageMs: number | null;
}

export function fleetFreshness(fleet: FleetState, nowMs: number, maxAgeMs: number): FleetFreshness {
  const newest = newestTrailTsMs(fleet);
  if (newest === null) return { verdict: "empty", ageMs: null };
  const ageMs = Math.max(0, nowMs - newest);
  return { verdict: ageMs <= maxAgeMs ? "fresh" : "stale", ageMs };
}

/* ── Documented fleet identity (reference, not telemetry) ────────────── */

/**
 * The five-bot fleet composition, transcribed from salvor-bots README.md —
 * static documentation of what the fleet IS. None of it is telemetry: no
 * mode badges, no status, no counters. Live numbers come only from the
 * ingested trail. The scout's own trail is upstream SCOUT_REPORT_FILE
 * (default unset) and executor bots emit only when operator-enabled, so a
 * bot with no trail events is the DOCUMENTED default, not a malfunction.
 */
export interface FleetBotIdentity {
  id: string;
  name: string;
  pkg: string;
  role: string;
  description: string;
}

export const FLEET_IDENTITY: FleetBotIdentity[] = [
  {
    id: "scout",
    name: "Scout",
    pkg: "@graveyield/scout",
    role: "Discovery · never salvages",
    description:
      "Discovery, candidate filtering, Phase-1 evaluation requests, anchor/cert lifecycle monitoring, opportunity publication. Never salvages.",
  },
  {
    id: "conservative",
    name: "Conservative",
    pkg: "@graveyield/conservative",
    role: "Reference executor",
    description:
      "The reference executor: stronger economics, tighter slippage, conservative fee share, dry-run by default.",
  },
  {
    id: "sniper",
    name: "Sniper",
    pkg: "@graveyield/sniper",
    role: "Latency-sensitive executor",
    description:
      "Urgency-ordered batches (soonest cert expiry first), tighter time windows, higher fee share — same safety gates as everyone else.",
  },
  {
    id: "experimental",
    name: "Experimental",
    pkg: "@graveyield/experimental",
    role: "Isolated strategy sandbox",
    description:
      "Isolated strategy sandbox: hard risk caps (fee budget, LP-position fraction), full event attribution, zero influence on the other bots.",
  },
  {
    id: "monitor",
    name: "Monitor / Risk",
    pkg: "@graveyield/monitor",
    role: "Read-only observer",
    description:
      "Observes the whole fleet, verifies confirmed salvages against the on-chain SalvageReceipt (40/40/20), detects anomalies. Read-only by construction: no keys, no builder, no submission path.",
  },
];
