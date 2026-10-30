// Snapshot artifact source resolver (P4.1 Step 1) — server-side logic.
//
// Answers the P4.1 transport question: WHERE does a deployed console obtain
// the indexer's ConsoleSnapshotV1 artifact? Two supported topologies, both
// resolved at request time, neither assuming a persistent local directory:
//
//   1. GY_SNAPSHOT_PATH — self-hosted / Docker: the operator mounts the
//      indexer's output volume and points the env at console-snapshot.json.
//   2. GY_SNAPSHOT_URL  — serverless (e.g. Vercel): the indexer (or its CI)
//      publishes the artifact to an HTTPS artifact store (GitHub Release
//      asset, R2/S3 object, any GET endpoint); the console pulls it.
//
// Exactly one source may be configured. The resolver is pull-only and
// fail-closed: it never writes artifacts, never polls, and maps every
// failure onto one of four explicit artifact states (valid | stale |
// missing | corrupt) — transport-level failures (unreadable, HTTP errors,
// network) are "missing", contract-level rejections (bad JSON, schema
// violations, fabricated criteria, future-dated or oversized artifacts)
// are "corrupt". Neither can ever yield dataState "real".
//
// All I/O is injected (readFile / statSize / fetchImpl), which keeps this
// module pure enough to unit-test every state without a filesystem or
// network — see __tests__/snapshotSource.test.ts.

import {
  parseSnapshot,
  snapshotFreshness,
  SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS,
  type ConsoleSnapshot,
} from "./snapshotContract";
import {
  transportDataState,
  staleReason,
  type SnapshotTransportPayload,
  type SnapshotSourceKind,
} from "./snapshotTransport";

/** Default hard cap for artifact size: the artifact is ~15 KB today; 8 MiB is generous headroom. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** Default timeout for the artifact-store GET. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface SnapshotSourceEnv {
  GY_SNAPSHOT_PATH?: string | null;
  GY_SNAPSHOT_URL?: string | null;
}

export interface SnapshotSourceDeps {
  nowMs: number;
  readFile: (path: string) => Promise<Uint8Array>;
  /** Best-effort size probe; null when the stat fails (read is still attempted). */
  statSize: (path: string) => Promise<number | null>;
  fetchImpl: typeof fetch;
  maxBytes?: number;
  fetchTimeoutMs?: number;
}

/** Redact a configured URL for every diagnostic surface: no userinfo, no query (signed URLs), no fragment. */
export function redactUrlForDisplay(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function scrubUrl(text: string, rawUrl: string): string {
  return text.split(rawUrl).join("<url>");
}

export async function resolveSnapshotSource(
  env: SnapshotSourceEnv,
  deps: SnapshotSourceDeps,
): Promise<SnapshotTransportPayload> {
  const nowMs = deps.nowMs;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const checkedAtUnixMs = nowMs;

  const unavailable = (
    artifactState: "missing" | "corrupt",
    reasonCode: NonNullable<SnapshotTransportPayload["reasonCode"]>,
    reason: string,
    source: { kind: SnapshotSourceKind; uri: string | null },
  ): SnapshotTransportPayload => ({
    artifactState,
    dataState: transportDataState(artifactState),
    reason,
    reasonCode,
    source,
    checkedAtUnixMs,
    ageMs: null,
    maxAgeMs: null,
    snapshot: null,
  });

  const path = env.GY_SNAPSHOT_PATH?.trim() ? env.GY_SNAPSHOT_PATH.trim() : null;
  const url = env.GY_SNAPSHOT_URL?.trim() ? env.GY_SNAPSHOT_URL.trim() : null;

  if (path && url) {
    return unavailable(
      "missing",
      "SOURCE_CONFLICT",
      "Both GY_SNAPSHOT_PATH and GY_SNAPSHOT_URL are configured — set exactly one artifact source.",
      { kind: "none", uri: null },
    );
  }
  if (!path && !url) {
    return unavailable(
      "missing",
      "NO_SOURCE_CONFIGURED",
      "No snapshot source configured — set GY_SNAPSHOT_URL (HTTPS artifact store; recommended for serverless deploys) or GY_SNAPSHOT_PATH (indexer output volume; self-hosted).",
      { kind: "none", uri: null },
    );
  }

  // ── Transport ────────────────────────────────────────────────────────
  let bytes: Uint8Array;
  let source: { kind: SnapshotSourceKind; uri: string | null };

  if (path) {
    source = { kind: "path", uri: path };
    const size = await deps.statSize(path).catch(() => null);
    if (size !== null && size > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Artifact on disk is ${size} bytes — over the ${maxBytes}-byte transport cap.`, source);
    }
    try {
      bytes = await deps.readFile(path);
    } catch (e) {
      return unavailable("missing", "READ_FAILED", `Snapshot file could not be read (${errText(e)}).`, source);
    }
    if (bytes.byteLength > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Artifact read ${bytes.byteLength} bytes — over the ${maxBytes}-byte transport cap.`, source);
    }
  } else {
    const displayUrl = redactUrlForDisplay(url as string);
    source = { kind: "url", uri: displayUrl };
    const rawUrl = url as string;
    let res: Response;
    try {
      res = await deps.fetchImpl(rawUrl, {
        redirect: "follow",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return unavailable("missing", "FETCH_FAILED", `Artifact store request failed (${scrubUrl(errText(e), rawUrl)}).`, source);
    }
    if (!res.ok) {
      return unavailable("missing", "FETCH_HTTP_STATUS", `Artifact store answered HTTP ${res.status} — the artifact is not retrievable at the configured URL.`, source);
    }
    const contentLength = res.headers.get("content-length");
    const declared = contentLength === null ? null : Number(contentLength);
    if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Artifact store declares ${declared} bytes — over the ${maxBytes}-byte transport cap.`, source);
    }
    // Stream the body under the cap (chunked responses declare no length).
    try {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("response body is empty");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            void reader.cancel();
            return unavailable("corrupt", "OVERSIZE", `Artifact stream exceeded the ${maxBytes}-byte transport cap.`, source);
          }
          chunks.push(value);
        }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      bytes = merged;
    } catch (e) {
      return unavailable("missing", "FETCH_FAILED", `Artifact body could not be read (${scrubUrl(errText(e), rawUrl)}).`, source);
    }
  }

  // ── Contract gate (shared with the client hydration path) ────────────
  return bytesToPayload(bytes, {
    nowMs,
    checkedAtUnixMs,
    source,
  });
}

/** Decode, JSON-parse and fail-closed-validate raw artifact bytes into a transport payload. */
export function bytesToPayload(
  bytes: Uint8Array,
  ctx: { nowMs: number; checkedAtUnixMs: number; source: { kind: SnapshotSourceKind; uri: string | null } },
): SnapshotTransportPayload {
  const unavailable = (
    artifactState: "corrupt",
    reasonCode: NonNullable<SnapshotTransportPayload["reasonCode"]>,
    reason: string,
  ): SnapshotTransportPayload => ({
    artifactState,
    dataState: transportDataState(artifactState),
    reason,
    reasonCode,
    source: ctx.source,
    checkedAtUnixMs: ctx.checkedAtUnixMs,
    ageMs: null,
    maxAgeMs: null,
    snapshot: null,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    return unavailable("corrupt", "PARSE_FAILED", `Artifact is not valid JSON (${errText(e)}).`);
  }

  let snap: ConsoleSnapshot;
  try {
    snap = parseSnapshot(parsed);
  } catch (e) {
    return unavailable("corrupt", "PARSE_FAILED", `Artifact rejected by the fail-closed contract: ${errText(e)}`);
  }

  if (snap.generatedAtUnixMs > ctx.nowMs + SNAPSHOT_CLOCK_SKEW_TOLERANCE_MS) {
    return unavailable(
      "corrupt",
      "FUTURE_GENERATED_AT",
      "Artifact generatedAt is in the future beyond clock-skew tolerance — refusing to serve it as fresh.",
    );
  }

  const fresh = snapshotFreshness(snap, ctx.nowMs) === "fresh";
  const ageMs = Math.max(0, ctx.nowMs - snap.generatedAtUnixMs);
  const maxAgeMs = snap.freshness.maxAgeMs;
  return {
    artifactState: fresh ? "valid" : "stale",
    dataState: fresh ? "real" : "stale",
    reason: fresh ? null : staleReason(ageMs, maxAgeMs),
    reasonCode: null,
    source: ctx.source,
    checkedAtUnixMs: ctx.checkedAtUnixMs,
    ageMs,
    maxAgeMs,
    snapshot: snap,
  };
}
