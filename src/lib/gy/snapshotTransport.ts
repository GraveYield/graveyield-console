// Snapshot artifact TRANSPORT types + client-side hydration (P4.1 Step 1).
//
// The /api/gy/snapshot route resolves an indexer artifact from a configured
// source (GY_SNAPSHOT_URL or GY_SNAPSHOT_PATH) and answers with this
// envelope. Four artifact states exist and are ALWAYS explicit:
//
//   valid    — parsed, contract-clean, inside its freshness budget
//   stale    — parsed, contract-clean, past its freshness budget (data is
//              still served, but can never be presented as fresh)
//   missing  — no source configured, or the artifact could not be
//              transported (unreadable path, HTTP error, network failure)
//   corrupt  — bytes arrived but fail the fail-closed contract
//              (bad JSON, schema violation, fabricated criteria,
//              future-dated artifact, oversized payload)
//
// The client MUST treat this envelope as untrusted: hydrateTransportPayload()
// re-runs the full fail-closed parser (snapshotContract.parseSnapshot) on any
// snapshot payload before a single byte of it is rendered, and refuses any
// envelope whose dataState does not match its artifactState. That is the
// second half of the invariant tested in __tests__/snapshotTransport.test.ts:
// a stale or invalid artifact can never be rendered as fresh data.

import { parseSnapshot, type ConsoleSnapshot } from "./snapshotContract";
import type { DataState } from "./types";

/** The four artifact states the transport can report. */
export type ArtifactState = "valid" | "stale" | "missing" | "corrupt";

/** Machine-readable cause for non-valid states (null when valid/stale). */
export type TransportReasonCode =
  | "NO_SOURCE_CONFIGURED"
  | "SOURCE_CONFLICT"
  | "READ_FAILED"
  | "FETCH_HTTP_STATUS"
  | "FETCH_FAILED"
  | "OVERSIZE"
  | "PARSE_FAILED"
  | "FUTURE_GENERATED_AT"
  | "MALFORMED_ENVELOPE";

/** Where the route attempted to load the artifact from. */
export type SnapshotSourceKind = "path" | "url" | "none";

/** Transport envelope — the diagnostic half of the response (no payload). */
export interface SnapshotTransport {
  artifactState: ArtifactState;
  /** honest UI-facing mapping: valid→real, stale→stale, missing/corrupt→unavailable */
  dataState: DataState;
  /** human-readable explanation, always present for missing/corrupt/stale */
  reason: string | null;
  reasonCode: TransportReasonCode | null;
  source: { kind: SnapshotSourceKind; uri: string | null };
  /** server clock at evaluation time (unix ms) — the client's "checked at" */
  checkedAtUnixMs: number;
  ageMs: number | null;
  maxAgeMs: number | null;
}

/** Full route payload: the envelope plus the artifact when one was served. */
export interface SnapshotTransportPayload extends SnapshotTransport {
  /** present ONLY for valid | stale — always null for missing | corrupt */
  snapshot: ConsoleSnapshot | null;
}

/** Honest data-state mapping — single source of truth for UI badges. */
export function transportDataState(artifactState: ArtifactState): DataState {
  switch (artifactState) {
    case "valid":
      return "real";
    case "stale":
      return "stale";
    case "missing":
    case "corrupt":
      return "unavailable";
  }
}

export const TRANSPORT_REASON_CODES: readonly TransportReasonCode[] = [
  "NO_SOURCE_CONFIGURED",
  "SOURCE_CONFLICT",
  "READ_FAILED",
  "FETCH_HTTP_STATUS",
  "FETCH_FAILED",
  "OVERSIZE",
  "PARSE_FAILED",
  "FUTURE_GENERATED_AT",
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
 * consistent AND its snapshot payload re-parses through the same fail-closed
 * contract the server used. This is what makes "invalid artifact rendered as
 * fresh" structurally impossible in the UI layer.
 */
export function hydrateTransportPayload(
  json: unknown,
  nowMs: number,
): SnapshotTransportPayload | null {
  if (!isObj(json)) return null;
  const artifactState = json.artifactState;
  if (artifactState !== "valid" && artifactState !== "stale" && artifactState !== "missing" && artifactState !== "corrupt") {
    return null;
  }
  const dataState = json.dataState;
  if (dataState !== "real" && dataState !== "stale" && dataState !== "unavailable") return null;
  // Envelope honesty: the dataState must be exactly the mapping promises.
  if (dataState !== transportDataState(artifactState)) return null;
  const checkedAtUnixMs = optFinite(json.checkedAtUnixMs);
  if (checkedAtUnixMs === null || checkedAtUnixMs <= 0) return null;
  const reasonCode = json.reasonCode;
  if (reasonCode !== null && !TRANSPORT_REASON_CODES.includes(reasonCode as TransportReasonCode)) return null;
  const reason = json.reason === null ? null : optStr(json.reason);
  if (reason === undefined) return null;
  const src = json.source;
  if (!isObj(src)) return null;
  if (src.kind !== "path" && src.kind !== "url" && src.kind !== "none") return null;
  const uri = src.uri === null ? null : optStr(src.uri);
  if (uri === undefined) return null;
  const ageMs = json.ageMs === null ? null : optFinite(json.ageMs);
  if (ageMs === undefined) return null;
  const maxAgeMs = json.maxAgeMs === null ? null : optFinite(json.maxAgeMs);
  if (maxAgeMs === undefined) return null;

  const transport: SnapshotTransport = {
    artifactState,
    dataState,
    reason,
    reasonCode: (reasonCode as TransportReasonCode) ?? null,
    source: { kind: src.kind, uri },
    checkedAtUnixMs,
    ageMs,
    maxAgeMs,
  };

  const rawSnapshot = json.snapshot;
  if (artifactState === "missing" || artifactState === "corrupt") {
    // No payload may ride along with a failed artifact.
    if (rawSnapshot !== null && rawSnapshot !== undefined) return null;
    return { ...transport, snapshot: null };
  }

  // valid | stale: the payload MUST re-parse through the full contract —
  // the client never trusts the server's parse, only its own.
  try {
    const snapshot = parseSnapshot(rawSnapshot);
    // A future-dated artifact must never classify as fresh.
    if (snapshot.generatedAtUnixMs > checkedAtUnixMs + 5 * 60_000) return null;
    const fresh = nowMs - snapshot.generatedAtUnixMs <= snapshot.freshness.maxAgeMs;
    if (fresh !== (artifactState === "valid")) return null; // state must match the artifact's own budget
    return { ...transport, snapshot };
  } catch {
    return null;
  }
}
