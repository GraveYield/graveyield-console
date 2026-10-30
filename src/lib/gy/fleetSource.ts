// Fleet state source resolver (P4.3 fleet ingestion) — server-side logic.
//
// Ingestion premise (Phase 4.0 audit Q3): the salvor fleet writes its JSONL
// trails into FLEET_STATE_DIR (fleet-ops); the console ingests that state
// directory when it is deployed with access to it — the self-hosted /
// Docker topology. Unlike the snapshot artifact there is no HTTPS publisher
// for fleet trails upstream today, so the only honest source is the mounted
// directory; inventing a URL publisher would be scope fabrication. With no
// source configured the resolver answers the first-class "unavailable"
// state — it never falls back to simulated fixtures.
//
// Files read from GY_FLEET_STATE_PATH (verified against fleet-ops/src/cli.ts):
//   monitor-events.jsonl — REQUIRED (fleet-ops creates it at process start)
//   alerts.jsonl         — OPTIONAL (created lazily on the first alert; its
//                          absence is a legal zero-alerts state, not an error)
//
// Pull-only and fail-closed: the resolver never writes trails, never polls,
// and maps every failure onto one of four explicit artifact states
// (valid | stale | missing | corrupt). Transport-level failures (unreadable
// dir, absent trail, I/O error) are "missing"; contract-level rejections
// (bad JSON, vocabulary violations, non-scalar alert context, future-dated
// trail, oversized files) are "corrupt". Neither can ever yield dataState
// "real".
//
// All I/O is injected (readFile / statSize), which keeps this module pure
// enough to unit-test every state without a filesystem — see
// __tests__/fleetTransport.test.ts.

import { statSync } from "node:fs";

import {
  FLEET_DEFAULT_MAX_AGE_MS,
  fleetFreshness,
  fleetState,
  newestTrailTsMs,
  parseFleetAlertJsonl,
  parseFleetEventJsonl,
  FLEET_CLOCK_SKEW_TOLERANCE_MS,
  type FleetState,
} from "./fleetContract";
import {
  fleetStaleReason,
  transportDataState,
  type FleetReasonCode,
  type FleetSourceKind,
  type FleetTransportPayload,
} from "./fleetTransport";

/** Default hard cap per trail file: the monitor trail is small today; 8 MiB
 * is generous headroom and bounds parse memory. */
export const DEFAULT_MAX_TRAIL_BYTES = 8 * 1024 * 1024;

export interface FleetSourceEnv {
  GY_FLEET_STATE_PATH?: string | null;
  /** Freshness budget override (ms, positive integer). Unset → the default. */
  GY_FLEET_MAX_AGE_MS?: string | null;
}

export interface FleetSourceDeps {
  nowMs: number;
  readFile: (path: string) => Promise<Uint8Array>;
  /** Best-effort size probe; null when the stat fails (read is still attempted). */
  statSize: (path: string) => Promise<number | null>;
  /** Directory probe for the configured state path. Defaults to the real
   * filesystem (statSync); injectable so unit tests need no real dirs. */
  isDir?: (path: string) => boolean;
  maxBytes?: number;
  maxAgeMs?: number;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

/** Parse the freshness-budget env; invalid values are rejected, not guessed. */
export function parseMaxAgeMs(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const v = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(v) || v <= 0 || String(v) !== raw.trim()) return null;
  return v;
}

export async function resolveFleetSource(
  env: FleetSourceEnv,
  deps: FleetSourceDeps,
): Promise<FleetTransportPayload> {
  const nowMs = deps.nowMs;
  const maxAgeMs = deps.maxAgeMs ?? parseMaxAgeMs(env.GY_FLEET_MAX_AGE_MS) ?? FLEET_DEFAULT_MAX_AGE_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_TRAIL_BYTES;
  const checkedAtUnixMs = nowMs;

  const unavailable = (
    artifactState: "missing" | "corrupt",
    reasonCode: FleetReasonCode,
    reason: string,
    kind: FleetSourceKind = "none",
    uri: string | null = null,
  ): FleetTransportPayload => ({
    artifactState,
    dataState: transportDataState(artifactState),
    reason,
    reasonCode,
    source: { kind, uri },
    checkedAtUnixMs,
    ageMs: null,
    maxAgeMs,
    newestTsMs: null,
    fleet: null,
  });

  const dir = env.GY_FLEET_STATE_PATH?.trim() ? env.GY_FLEET_STATE_PATH.trim() : null;
  if (!dir) {
    return unavailable(
      "missing",
      "NO_SOURCE_CONFIGURED",
      "No fleet state source configured — set GY_FLEET_STATE_PATH to the salvor fleet's FLEET_STATE_DIR (mounted volume; self-hosted deploys). Fleet data is withheld, never simulated.",
    );
  }

  // Guard against a file path (not a directory) being configured — the
  // contract ingests a state DIR with two documented files inside.
  let isDirectory: boolean;
  try {
    isDirectory = deps.isDir ? deps.isDir(dir) : statSync(dir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return unavailable(
      "missing",
      "READ_FAILED",
      `Fleet state path is not a readable directory: ${dir} — point GY_FLEET_STATE_PATH at the fleet-ops FLEET_STATE_DIR.`,
      "path",
      dir,
    );
  }

  const source = { kind: "path" as FleetSourceKind, uri: dir };
  const eventsPath = `${dir}/monitor-events.jsonl`;
  const alertsPath = `${dir}/alerts.jsonl`;

  // ── Transport: monitor trail (required) ──────────────────────────────
  const trailSize = await deps.statSize(eventsPath).catch(() => null);
  if (trailSize !== null && trailSize > maxBytes) {
    return unavailable("corrupt", "OVERSIZE", `Monitor trail is ${trailSize} bytes — over the ${maxBytes}-byte transport cap.`, "path", dir);
  }
  let eventBytes: Uint8Array;
  try {
    eventBytes = await deps.readFile(eventsPath);
  } catch (e) {
    if (isEnoent(e)) {
      return unavailable(
        "missing",
        "TRAIL_ABSENT",
        `The fleet state directory exists but ${eventsPath} is absent — fleet-ops creates it at process start; this is not the fleet's FLEET_STATE_DIR (or the fleet never ran here).`,
        "path",
        dir,
      );
    }
    return unavailable("missing", "READ_FAILED", `Monitor trail could not be read (${errText(e)}).`, "path", dir);
  }
  if (eventBytes.byteLength > maxBytes) {
    return unavailable("corrupt", "OVERSIZE", `Monitor trail read ${eventBytes.byteLength} bytes — over the ${maxBytes}-byte transport cap.`, "path", dir);
  }

  // ── Transport: alerts trail (optional — legal zero state) ────────────
  let alertBytes: Uint8Array | null;
  try {
    alertBytes = await deps.readFile(alertsPath);
    if (alertBytes.byteLength > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Alerts trail is ${alertBytes.byteLength} bytes — over the ${maxBytes}-byte transport cap.`, "path", dir);
    }
  } catch (e) {
    if (!isEnoent(e)) {
      // An alerts file that exists but cannot be read is a broken mount —
      // fail closed rather than pretending there are zero alerts.
      return unavailable("missing", "READ_FAILED", `Alerts trail could not be read (${errText(e)}).`, "path", dir);
    }
    alertBytes = null;
  }

  // ── Contract gate ────────────────────────────────────────────────────
  let fleet: FleetState;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const events = parseFleetEventJsonl(decoder.decode(eventBytes));
    const alerts = alertBytes === null ? [] : parseFleetAlertJsonl(decoder.decode(alertBytes));
    fleet = fleetState(events, alerts);
  } catch (e) {
    return unavailable(
      "corrupt",
      "PARSE_FAILED",
      `Fleet trail rejected by the fail-closed contract: ${errText(e)}`,
      "path",
      dir,
    );
  }

  const newestTsMs = newestTrailTsMs(fleet);
  if (newestTsMs !== null && newestTsMs > nowMs + FLEET_CLOCK_SKEW_TOLERANCE_MS) {
    return unavailable(
      "corrupt",
      "FUTURE_TRAIL_TS",
      "Fleet trail carries a timestamp in the future beyond clock-skew tolerance — refusing to serve it as fresh.",
      "path",
      dir,
    );
  }

  const freshness = fleetFreshness(fleet, nowMs, maxAgeMs);
  const fresh = freshness.verdict !== "stale"; // "empty" is not stale — there is no age
  const ageMs = freshness.ageMs;
  return {
    artifactState: fresh ? "valid" : "stale",
    dataState: transportDataState(fresh ? "valid" : "stale"),
    reason: fresh ? null : fleetStaleReason(ageMs ?? 0, maxAgeMs),
    reasonCode: null,
    source,
    checkedAtUnixMs,
    ageMs,
    maxAgeMs,
    newestTsMs,
    fleet,
  };
}
