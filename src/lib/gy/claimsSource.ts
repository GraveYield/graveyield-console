// Claims distribution-artifact source resolver (P4.4) — server-side logic.
//
// WHERE does a deployed console obtain the sealed snapshot/distribution
// artifact? The same two topologies as the indexer snapshot (P4.1), because
// the same deployment shapes exist:
//
//   1. GY_CLAIMS_PATH — self-hosted / Docker: the operator mounts the
//      snapshotter's output volume and points the env at the sealed
//      SnapshotArtifact JSON (grave-snapshotter-cli output).
//   2. GY_CLAIMS_URL  — serverless (e.g. Vercel): the salvage operator
//      publishes the sealed artifact to an HTTPS artifact store (GitHub
//      Release asset, R2/S3, any GET endpoint); the console pulls it.
//
// Exactly one source may be configured. Pull-only and fail-closed: the
// resolver never writes artifacts, never polls, and maps every failure onto
// the four explicit artifact states (valid | stale | missing | corrupt) —
// transport-level failures are "missing"; contract-level rejections (bad
// JSON, schema violations, integrity failures) are "corrupt". Neither can
// ever yield dataState "real".
//
// A sealed distribution has no self-stamped generation time (the writer is
// deterministic Rust with no wall clock): the console stamps the check time
// and imposes the freshness budget server-side (DEFAULT_CLAIMS_MAX_AGE_MS,
// env-overridable). The client re-evaluates against its own wall clock — the
// check can degrade (valid → stale) but never upgrade.
//
// The artifact is served ONLY through its privacy-stripped projection: the
// full per-holder entry set (other wallets' balances and proofs) stays behind
// the route. resolveClaimsSource hands the parsed artifact to the caller
// (the route) so the wallet state machine can run server-side.
//
// All I/O is injected (readFile / statSize / fetchImpl), keeping the module
// unit-testable without a filesystem or network — see
// __tests__/claimsTransport.test.ts.

import {
  claimsTransportDataState,
  type ClaimsReasonCode,
  type ClaimsSourceKind,
  type ClaimsTransportPayload,
} from "./claimsTransport";
import {
  parseDistributionArtifact,
  publicDistribution,
  verifyDistributionIntegrity,
  ClaimsError,
  type DistributionArtifact,
} from "./claimsContract";

/** Default hard cap for artifact size: a 47-holder artifact is ~40 KB; 8 MiB is generous headroom. */
export const DEFAULT_MAX_CLAIMS_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** Default timeout for the artifact-store GET. */
export const DEFAULT_CLAIMS_FETCH_TIMEOUT_MS = 10_000;
/**
 * Default freshness budget for the SEALED distribution. Unlike the indexer's
 * living snapshot, a sealed distribution is a historical record — its root is
 * bound to the on-chain PoolRegistry (the real anchor). The budget exists so
 * an abandoned artifact can never present as current: 7 days, env-overridable.
 */
export const DEFAULT_CLAIMS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClaimsSourceEnv {
  GY_CLAIMS_PATH?: string | null;
  GY_CLAIMS_URL?: string | null;
  /** Freshness budget override (ms, positive integer). Unset → the default. */
  GY_CLAIMS_MAX_AGE_MS?: string | null;
}

export interface ClaimsSourceDeps {
  nowMs: number;
  readFile: (path: string) => Promise<Uint8Array>;
  /** Best-effort size probe; null when the stat fails (read is still attempted). */
  statSize: (path: string) => Promise<number | null>;
  fetchImpl: typeof fetch;
  maxBytes?: number;
  maxAgeMs?: number;
  fetchTimeoutMs?: number;
}

/** What the resolver hands the route: the client-facing payload plus the
 * parsed artifact (server-side only) for the wallet state machine. */
export interface ClaimsResolution {
  payload: ClaimsTransportPayload;
  /** Non-null only when the artifact passed schema + SDK integrity. */
  artifact: DistributionArtifact | null;
}

/** Redact a configured URL for every diagnostic surface (mirrors snapshotSource). */
export function redactClaimsUrlForDisplay(rawUrl: string): string | null {
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

/** Parse the freshness-budget env; invalid values are rejected, not guessed. */
export function parseClaimsMaxAgeMs(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const v = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(v) || v <= 0 || String(v) !== raw.trim()) return null;
  return v;
}

export async function resolveClaimsSource(
  env: ClaimsSourceEnv,
  deps: ClaimsSourceDeps,
): Promise<ClaimsResolution> {
  const nowMs = deps.nowMs;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_CLAIMS_ARTIFACT_BYTES;
  const maxAgeMs = deps.maxAgeMs ?? parseClaimsMaxAgeMs(env.GY_CLAIMS_MAX_AGE_MS) ?? DEFAULT_CLAIMS_MAX_AGE_MS;
  const checkedAtUnixMs = nowMs;

  const unavailable = (
    artifactState: "missing" | "corrupt",
    reasonCode: ClaimsReasonCode,
    reason: string,
    source: { kind: ClaimsSourceKind; uri: string | null },
  ): ClaimsResolution => ({
    payload: {
      artifactState,
      dataState: claimsTransportDataState(artifactState),
      reason,
      reasonCode,
      source,
      checkedAtUnixMs,
      ageMs: null,
      maxAgeMs,
      distribution: null,
      onchain: null,
      wallet: null,
    },
    artifact: null,
  });

  const path = env.GY_CLAIMS_PATH?.trim() ? env.GY_CLAIMS_PATH.trim() : null;
  const url = env.GY_CLAIMS_URL?.trim() ? env.GY_CLAIMS_URL.trim() : null;

  if (path && url) {
    return unavailable(
      "missing",
      "SOURCE_CONFLICT",
      "Both GY_CLAIMS_PATH and GY_CLAIMS_URL are configured — set exactly one distribution source.",
      { kind: "none", uri: null },
    );
  }
  if (!path && !url) {
    return unavailable(
      "missing",
      "NO_SOURCE_CONFIGURED",
      "No distribution source configured — set GY_CLAIMS_URL (HTTPS artifact store; recommended for serverless deploys) or GY_CLAIMS_PATH (snapshotter output volume; self-hosted). Claim eligibility cannot be established without the sealed distribution.",
      { kind: "none", uri: null },
    );
  }

  // ── Transport ────────────────────────────────────────────────────────
  let bytes: Uint8Array;
  let source: { kind: ClaimsSourceKind; uri: string | null };

  if (path) {
    source = { kind: "path", uri: path };
    const size = await deps.statSize(path).catch(() => null);
    if (size !== null && size > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Distribution artifact on disk is ${size} bytes — over the ${maxBytes}-byte transport cap.`, source);
    }
    try {
      bytes = await deps.readFile(path);
    } catch (e) {
      return unavailable("missing", "READ_FAILED", `Distribution artifact could not be read (${errText(e)}).`, source);
    }
    if (bytes.byteLength > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Distribution artifact read ${bytes.byteLength} bytes — over the ${maxBytes}-byte transport cap.`, source);
    }
  } else {
    const rawUrl = url as string;
    const displayUrl = redactClaimsUrlForDisplay(rawUrl);
    source = { kind: "url", uri: displayUrl };
    let res: Response;
    try {
      res = await deps.fetchImpl(rawUrl, {
        redirect: "follow",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? DEFAULT_CLAIMS_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return unavailable("missing", "FETCH_FAILED", `Distribution store request failed (${scrubUrl(errText(e), rawUrl)}).`, source);
    }
    if (!res.ok) {
      return unavailable("missing", "FETCH_HTTP_STATUS", `Distribution store answered HTTP ${res.status} — the artifact is not retrievable at the configured URL.`, source);
    }
    const contentLength = res.headers.get("content-length");
    const declared = contentLength === null ? null : Number(contentLength);
    if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
      return unavailable("corrupt", "OVERSIZE", `Distribution store declares ${declared} bytes — over the ${maxBytes}-byte transport cap.`, source);
    }
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
            return unavailable("corrupt", "OVERSIZE", `Distribution stream exceeded the ${maxBytes}-byte transport cap.`, source);
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
      return unavailable("missing", "FETCH_FAILED", `Distribution body could not be read (${scrubUrl(errText(e), rawUrl)}).`, source);
    }
  }

  // ── Contract gate: schema → integrity (canonical SDK) → projection ───
  return claimsBytesToPayload(bytes, { nowMs, checkedAtUnixMs, source, maxAgeMs });
}

/** Decode, JSON-parse, fail-closed-validate + integrity-verify raw artifact bytes. */
export function claimsBytesToPayload(
  bytes: Uint8Array,
  ctx: {
    nowMs: number;
    checkedAtUnixMs: number;
    source: { kind: ClaimsSourceKind; uri: string | null };
    maxAgeMs: number;
  },
): ClaimsResolution {
  const unavailable = (
    reasonCode: ClaimsReasonCode,
    reason: string,
  ): ClaimsResolution => ({
    payload: {
      artifactState: "corrupt",
      dataState: claimsTransportDataState("corrupt"),
      reason,
      reasonCode,
      source: ctx.source,
      checkedAtUnixMs: ctx.checkedAtUnixMs,
      ageMs: null,
      maxAgeMs: ctx.maxAgeMs,
      distribution: null,
      onchain: null,
      wallet: null,
    },
    artifact: null,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    return unavailable("PARSE_FAILED", `Distribution artifact is not valid JSON (${errText(e)}).`);
  }

  let artifact: DistributionArtifact;
  try {
    artifact = parseDistributionArtifact(parsed);
  } catch (e) {
    const msg = e instanceof ClaimsError ? e.message : `${e instanceof Error ? e.message : String(e)}`;
    return unavailable("PARSE_FAILED", `Distribution artifact rejected by the fail-closed contract: ${msg}`);
  }

  // Integrity: the whole artifact re-derives through the canonical SDK tree.
  try {
    verifyDistributionIntegrity(artifact);
  } catch (e) {
    const msg = e instanceof ClaimsError ? e.message : `${e instanceof Error ? e.message : String(e)}`;
    return unavailable("INTEGRITY_FAILED", msg);
  }

  return {
    payload: {
      artifactState: "valid",
      dataState: claimsTransportDataState("valid"),
      reason: null,
      reasonCode: null,
      source: ctx.source,
      checkedAtUnixMs: ctx.checkedAtUnixMs,
      // Sealed record: verified at check time; the wall clock degrades it.
      ageMs: 0,
      maxAgeMs: ctx.maxAgeMs,
      // The artifact is served ONLY through its privacy-stripped projection —
      // the full entry set stays behind the route.
      distribution: publicDistribution(artifact),
      onchain: null,
      wallet: null,
    },
    artifact,
  };
}
