// Stable-pointer snapshot resolver — server-side transport for the
// dedicated GitHub stable reference architecture (the owner-selected
// publication design in grave-indexer docs/SNAPSHOT_PUBLICATION.md §13.1).
//
// The production discovery mechanism is the dedicated git reference
// refs/tags/console-snapshot-prod — NOT the repository-wide "latest"
// release. Its annotated tag object's message is the stable-pointer JSON
// (graveyield.console-snapshot-stable-pointer.v1), which identifies ONE
// workflow-protected --latest=false versioned release (immutability by
// publisher-workflow convention + digest verification — NOT assumed to be a
// GitHub-enforced immutable release, which is a separate owner-enabled
// platform setting) and carries per-asset SHA-256
// digests + byte lengths. Resolution sequence (fail-closed at every step):
//
//   1. GET /repos/{repo}/git/ref/tags/{stableRef}      → tag-object sha
//   2. GET /repos/{repo}/git/tags/{tagObjectSha}        → annotated tag object
//   3. target type must be "commit", target sha must equal pointer.sourceCommit
//   4. parse the tag message as the stable pointer (strict schema)
//   5. fetch the three required assets from the VERSIONED release
//      (releases/download/{pointer.versionedTag}/...) — never from
//      /releases/latest/download/...
//   6. verify every asset's SHA-256 + byte length against the pointer
//   7. cross-check the provenance sidecar (tag + commit + digests)
//   8. enforce the completeness contract (no discovery/enrichment-completeness
//      failure markers, enriched count positive and sidecar-consistent)
//   9. run the existing schema-v2 fail-closed parser (snapshotSource.bytesToPayload)
//
// Every failure maps onto the existing four-state transport envelope
// (valid | stale | missing | corrupt) with an explicit resolver stage, so
// the caller can tell WHERE the chain failed: stable-ref lookup, annotated
// tag retrieval, pointer parsing/validation, versioned asset retrieval,
// asset integrity verification, snapshot schema validation, provenance or
// completeness validation, or network/timeout/upstream availability.
//
// No caching of any intermediate result: each request resolves the full
// chain, so a partially verified or corrupted artifact can never be
// served from a cache. Stale (past-freshness-budget) artifacts are served
// but flagged exactly like the legacy source — never presented as fresh.
//
// Every upstream response is consumed under a documented byte cap
// (DEFAULT_MAX_JSON_BYTES for API JSON, maxBytes for release assets):
// the body is streamed and byte-counted BEFORE any parsing, an oversized
// body is cancelled and rejected with a typed OVERSIZE failure — never
// silently truncated and parsed.
//
// Server-side only (node:crypto + fetch). The optional GitHub token is
// read from the environment by the route layer, never logged, and never
// reaches client code.

import {
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  STABLE_REF_DEFAULT,
  parsePublicationProvenance,
  parseStablePointer,
  sha256Hex,
  StablePointerError,
  StablePointerParseError,
  verifyRawArtifactCompleteness,
  verifyStablePointerMatchesArtifacts,
  type PublicationProvenance,
  type StablePointerV1,
} from "./stablePointer";
import { bytesToPayload, redactUrlForDisplay, resolveSnapshotSource, DEFAULT_MAX_ARTIFACT_BYTES, DEFAULT_FETCH_TIMEOUT_MS, type SnapshotSourceEnv } from "./snapshotSource";
import { transportDataState, type SnapshotTransportPayload, type SnapshotSourceKind, type SnapshotResolverStage } from "./snapshotTransport";

/** Server-side environment for the stable-pointer resolver. */
export interface StablePointerResolverEnv extends SnapshotSourceEnv {
  /** GitHub repository ("owner/repo") holding the stable ref and versioned releases. */
  GY_SNAPSHOT_GITHUB_REPO?: string | null;
  /** Stable reference name (default: console-snapshot-prod). */
  GY_SNAPSHOT_STABLE_REF?: string | null;
  /** GitHub API base (default https://api.github.com; override for tests/GHES). */
  GY_SNAPSHOT_GITHUB_API_BASE?: string | null;
  /** GitHub asset base (default https://github.com; override for tests). */
  GY_SNAPSHOT_GITHUB_ASSETS_BASE?: string | null;
  /**
   * OPTIONAL server-side GitHub token for authenticated reads (rate-limit
   * headroom). Server-only: never embedded in client code, never logged,
   * never echoed into any payload. Unauthenticated reads work on a public
   * repository under the standard API rate limit.
   */
  GY_SNAPSHOT_GITHUB_TOKEN?: string | null;
}

export interface StablePointerResolverDeps {
  nowMs: number;
  fetchImpl: typeof fetch;
  /** Hard cap per fetched asset (default 8 MiB — the artifact is ~15 KB today). */
  maxBytes?: number;
  /**
   * Hard cap per GitHub API JSON response (default DEFAULT_MAX_JSON_BYTES).
   * Enforced during the streamed read, BEFORE JSON parsing.
   */
  maxJsonBytes?: number;
  /** Per-request timeout (default 10 s). */
  fetchTimeoutMs?: number;
}

/** Human-readable stage names surfaced in the transport envelope's `reason` text. */
const STABLE_POINTER_SOURCE_KIND: SnapshotSourceKind = "stable-pointer";

/**
 * Hard cap for a single GitHub API JSON response consumed by this resolver.
 *
 * Choice rationale (documented, not arbitrary): the ONLY JSON documents the
 * resolver ever consumes are the git-ref lookup
 * (`GET /repos/{repo}/git/ref/tags/{ref}`) and the annotated tag object
 * (`GET /repos/{repo}/git/tags/{sha}`). The pointer message inside the tag
 * object is a strict ten-key JSON document (< 1 KB in practice, and
 * parseStablePointer rejects anything larger on shape alone), so legitimate
 * bodies for these two endpoints sit in the low-KB range. 1 MiB is therefore
 * ~1000× headroom over the largest legitimate response — small enough to
 * bound memory consumption against a hostile or misbehaving upstream, large
 * enough that no legitimate GitHub API answer for these endpoints is ever
 * refused. The cap is enforced DURING the streamed read (byte-counted per
 * chunk) BEFORE any JSON parsing: an oversized body is cancelled and
 * rejected with a typed OVERSIZE failure — it is NEVER silently truncated
 * and parsed as partial JSON.
 */
export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024; // 1 MiB

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/** Reject a stable-ref name that could escape the ref namespace or the URL path. */
function assertSafeRefName(ref: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.startsWith("/") || ref.endsWith("/") || ref.includes("..")) {
    throw new StablePointerError(`stable ref name ${JSON.stringify(ref)} is not a safe single ref name`);
  }
}

/** Reject a repository slug that is not a plain owner/repo pair. */
function assertSafeRepoSlug(repo: string): void {
  if (!/^[\w.-]+\/[\w.-]{1,100}$/.test(repo)) {
    throw new StablePointerError(`GitHub repository ${JSON.stringify(repo)} is not a plain "owner/repo" slug`);
  }
}

export async function resolveSnapshotViaStablePointer(
  env: StablePointerResolverEnv,
  deps: StablePointerResolverDeps,
): Promise<SnapshotTransportPayload> {
  const nowMs = deps.nowMs;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const maxJsonBytes = deps.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const checkedAtUnixMs = nowMs;

  const repo = env.GY_SNAPSHOT_GITHUB_REPO?.trim() ? env.GY_SNAPSHOT_GITHUB_REPO.trim() : null;
  const stableRef = env.GY_SNAPSHOT_STABLE_REF?.trim() ? env.GY_SNAPSHOT_STABLE_REF.trim() : STABLE_REF_DEFAULT;
  const apiBase = (env.GY_SNAPSHOT_GITHUB_API_BASE?.trim() || "https://api.github.com").replace(/\/+$/, "");
  const assetsBase = (env.GY_SNAPSHOT_GITHUB_ASSETS_BASE?.trim() || "https://github.com").replace(/\/+$/, "");
  const token = env.GY_SNAPSHOT_GITHUB_TOKEN?.trim() ? env.GY_SNAPSHOT_GITHUB_TOKEN.trim() : null;

  // Unreachable in practice (the dispatcher refuses a null repo), but the
  // resolver itself stays total: never guess a repository.
  if (!repo) {
    return {
      artifactState: "missing",
      dataState: "unavailable",
      reason: "No GitHub repository configured — set GY_SNAPSHOT_GITHUB_REPO.",
      reasonCode: "NO_SOURCE_CONFIGURED",
      source: { kind: "none", uri: null },
      checkedAtUnixMs,
      ageMs: null,
      maxAgeMs: null,
      resolverStage: "stable-ref",
      snapshot: null,
    };
  }

  const refApiUrl = `${apiBase}/repos/${repo}/git/ref/tags/${stableRef}`;
  const tagApiUrl = (sha: string) => `${apiBase}/repos/${repo}/git/tags/${sha}`;
  const source = { kind: STABLE_POINTER_SOURCE_KIND, uri: redactUrlForDisplay(refApiUrl) };

  const unavailable = (
    artifactState: "missing" | "corrupt",
    reasonCode: NonNullable<SnapshotTransportPayload["reasonCode"]>,
    stage: SnapshotResolverStage,
    reason: string,
  ): SnapshotTransportPayload => ({
    artifactState,
    dataState: transportDataState(artifactState),
    reason: `stable-pointer resolution failed at ${stage}: ${reason}`,
    reasonCode,
    source,
    checkedAtUnixMs,
    ageMs: null,
    maxAgeMs: null,
    resolverStage: stage,
    snapshot: null,
  });

  try {
    assertSafeRepoSlug(repo);
    assertSafeRefName(stableRef);
  } catch (e) {
    return unavailable("corrupt", "PARSE_FAILED", "stable-ref", errText(e));
  }

  const authHeaders: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  /**
   * Stream-read a response body under a hard byte cap. The cap is enforced
   * DURING the read (byte-counted per chunk), BEFORE any parsing: a body
   * that exceeds the cap is cancelled and a typed failure is thrown. The
   * helper NEVER returns truncated bytes and NEVER hands a partial body to
   * a parser — the only two outcomes are the complete bytes (≤ cap) or a
   * typed transport failure.
   */
  async function readBodyUnderCap(
    res: Response,
    capBytes: number,
    oversized: (readBytes: number) => SnapshotTransportPayload,
    unreadable: (e: unknown) => SnapshotTransportPayload,
  ): Promise<Uint8Array> {
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
          if (total > capBytes) {
            void reader.cancel(); // stop consuming — do not buffer the excess
            throw oversized(total);
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
      return merged;
    } catch (e) {
      if (isTransportPayload(e)) throw e; // typed OVERSIZE failure — rethrow verbatim
      throw unreadable(e);
    }
  }

  /** JSON GET against the GitHub API; typed transport failure on any non-OK status or network fault. */
  async function fetchApiJson(url: string, stage: SnapshotResolverStage): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        redirect: "follow",
        headers: authHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (isAbort(e)) {
        throw unavailable("missing", "FETCH_FAILED", "network", `GitHub API request timed out after ${timeoutMs} ms at ${stage}`);
      }
      throw unavailable("missing", "FETCH_FAILED", "network", `GitHub API request failed (${errText(e)})`);
    }
    if (!res.ok) {
      const detail = res.status === 403 || res.status === 429
        ? "GitHub API rate limit or access restriction"
        : `GitHub API answered HTTP ${res.status}`;
      throw unavailable("missing", "FETCH_HTTP_STATUS", stage, `${detail} for ${new URL(url).pathname}`);
    }
    // Bounded read: cap the body DURING the streamed read, BEFORE parsing —
    // an oversized response is a typed corrupt/OVERSIZE failure at this
    // stage; it is never truncated and never partially parsed.
    const declared = res.headers.get("content-length");
    const declaredLen = declared === null ? null : Number(declared);
    if (declaredLen !== null && Number.isFinite(declaredLen) && declaredLen > maxJsonBytes) {
      throw unavailable(
        "corrupt",
        "OVERSIZE",
        stage,
        `GitHub API response declares ${declaredLen} bytes — over the ${maxJsonBytes}-byte JSON response cap`,
      );
    }
    const bytes = await readBodyUnderCap(
      res,
      maxJsonBytes,
      (read) =>
        unavailable(
          "corrupt",
          "OVERSIZE",
          stage,
          `GitHub API JSON response exceeded the ${maxJsonBytes}-byte cap after ${read} bytes — refusing to parse a truncated body`,
        ),
      (e) => unavailable("missing", "FETCH_FAILED", stage, `GitHub API response body could not be read (${errText(e)})`),
    );
    try {
      return { status: res.status, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
    } catch (e) {
      throw unavailable("missing", "FETCH_FAILED", stage, `GitHub API response is not valid JSON (${errText(e)})`);
    }
  }

  /** Byte-stream GET under the size cap (release asset downloads follow redirects). */
  async function fetchAssetBytes(url: string, assetName: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        // GitHub serves release assets through a redirect chain to
        // release-assets.githubusercontent.com signed URLs — following is
        // required and safe here: every hop is HTTPS and the digest check
        // below pins the exact bytes regardless of the path taken.
        redirect: "follow",
        headers: { accept: "application/octet-stream" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (isAbort(e)) {
        throw unavailable("missing", "FETCH_FAILED", "network", `asset request for ${assetName} timed out after ${timeoutMs} ms`);
      }
      throw unavailable("missing", "FETCH_FAILED", "asset-fetch", `asset request for ${assetName} failed (${errText(e)})`);
    }
    if (!res.ok) {
      throw unavailable(
        "missing",
        "FETCH_HTTP_STATUS",
        "asset-fetch",
        `versioned release answered HTTP ${res.status} for ${assetName}`,
      );
    }
    const contentLength = res.headers.get("content-length");
    const declared = contentLength === null ? null : Number(contentLength);
    if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
      throw unavailable("corrupt", "OVERSIZE", "asset-fetch", `${assetName} declares ${declared} bytes — over the ${maxBytes}-byte transport cap`);
    }
    // Same bounded-read discipline as the JSON path: cap enforced during
    // the streamed read, before the bytes reach any verifier.
    return readBodyUnderCap(
      res,
      maxBytes,
      () =>
        unavailable(
          "corrupt",
          "OVERSIZE",
          "asset-fetch",
          `${assetName} stream exceeded the ${maxBytes}-byte transport cap`,
        ),
      (e) =>
        unavailable(
          "missing",
          "FETCH_FAILED",
          "asset-fetch",
          `asset body for ${assetName} could not be read (${errText(e)})`,
        ),
    );
  }

  try {
    // ── 1. Stable-ref lookup ────────────────────────────────────────────
    const refRes = await fetchApiJson(refApiUrl, "stable-ref");
    const ref = refRes.json as { object?: { sha?: unknown; type?: unknown } } | null;
    const tagObjectSha = typeof ref?.object?.sha === "string" ? ref.object.sha : null;
    if (!tagObjectSha || !/^[0-9a-f]{40}$/.test(tagObjectSha)) {
      return unavailable("corrupt", "PARSE_FAILED", "stable-ref", `the stable ref response carries no usable tag-object sha`);
    }
    if (ref?.object?.type !== "tag") {
      return unavailable(
        "corrupt",
        "PARSE_FAILED",
        "annotated-tag",
        `the stable ref points at object type ${String(ref?.object?.type)} — the publication contract requires an ANNOTATED tag object (type "tag")`,
      );
    }

    // ── 2. Annotated tag object retrieval ───────────────────────────────
    const tagRes = await fetchApiJson(tagApiUrl(tagObjectSha), "annotated-tag");
    const tag = tagRes.json as { sha?: unknown; object?: { sha?: unknown; type?: unknown }; message?: unknown } | null;
    if (typeof tag?.sha !== "string" || tag.sha !== tagObjectSha) {
      return unavailable("corrupt", "PARSE_FAILED", "annotated-tag", "the tag-object response does not identify the requested object sha");
    }
    if (typeof tag.message !== "string" || tag.message.length === 0) {
      return unavailable("corrupt", "PARSE_FAILED", "pointer-parse", "the tag object carries no message — no stable pointer to parse");
    }

    // ── 3. Pointer parse + strict schema validation ─────────────────────
    let pointer: StablePointerV1;
    try {
      pointer = parseStablePointer(tag.message, stableRef);
    } catch (e) {
      const parse = e instanceof StablePointerParseError;
      return unavailable(
        "corrupt",
        "PARSE_FAILED",
        parse ? "pointer-parse" : "pointer-validate",
        errText(e),
      );
    }

    // ── 4. Annotated-tag target identity (type + sha must satisfy the contract) ──
    if (tag.object?.type !== "commit") {
      return unavailable(
        "corrupt",
        "PARSE_FAILED",
        "annotated-tag",
        `the annotated tag object targets type ${String(tag.object?.type)} — the publication contract requires exactly "commit"`,
      );
    }
    const targetSha = typeof tag.object.sha === "string" ? tag.object.sha : null;
    if (!targetSha || !/^[0-9a-f]{40}$/.test(targetSha)) {
      return unavailable("corrupt", "PARSE_FAILED", "annotated-tag", "the annotated tag object carries no usable 40-hex target sha");
    }
    if (targetSha !== pointer.sourceCommit) {
      return unavailable(
        "corrupt",
        "PARSE_FAILED",
        "annotated-tag",
        `the annotated tag object targets commit ${targetSha} but its pointer claims sourceCommit ${pointer.sourceCommit} — refusing the identity mismatch`,
      );
    }

    // ── 5. Versioned asset retrieval (NEVER the repo-wide latest release) ──
    const assetUrls = (assetName: string) =>
      `${assetsBase}/${repo}/releases/download/${pointer.versionedTag}/${assetName}`;
    const snapshotBytes = await fetchAssetBytes(assetUrls(SNAPSHOT_ASSET_NAME), SNAPSHOT_ASSET_NAME);
    const provenanceBytes = await fetchAssetBytes(assetUrls(PROVENANCE_ASSET_NAME), PROVENANCE_ASSET_NAME);
    const checksumBytes = await fetchAssetBytes(assetUrls(CHECKSUM_ASSET_NAME), CHECKSUM_ASSET_NAME);

    // ── 6. Asset integrity verification (SHA-256 + byte length per pointer) ──
    let provenance: PublicationProvenance;
    try {
      provenance = parsePublicationProvenance(provenanceBytes);
      verifyStablePointerMatchesArtifacts({ pointer, snapshotBytes, provenanceBytes, checksumBytes, provenance });
    } catch (e) {
      return unavailable("corrupt", "PARSE_FAILED", "asset-integrity", errText(e));
    }

    // ── 7. Completeness contract (independent producer gate, mirrored) ──
    let rawSnapshot: unknown;
    try {
      rawSnapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes));
    } catch (e) {
      return unavailable("corrupt", "PARSE_FAILED", "snapshot-schema", `snapshot asset is not valid JSON (${errText(e)})`);
    }
    try {
      verifyRawArtifactCompleteness(rawSnapshot, provenance);
    } catch (e) {
      return unavailable("corrupt", "PARSE_FAILED", "completeness", errText(e));
    }

    // ── 8/9. Existing schema-v2 + freshness gate over the verified bytes ──
    const payload = bytesToPayload(snapshotBytes, { nowMs, checkedAtUnixMs, source });
    if (payload.artifactState === "corrupt") {
      return { ...payload, resolverStage: "snapshot-schema" as SnapshotResolverStage };
    }
    return { ...payload, resolverStage: null };
  } catch (e) {
    // Typed transport failures are thrown as full payloads; anything else
    // is an unexpected resolver fault — fail closed, never serve bytes.
    if (isTransportPayload(e)) return e;
    return unavailable("missing", "FETCH_FAILED", "network", errText(e));
  }
}

function isTransportPayload(e: unknown): e is SnapshotTransportPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    "artifactState" in e &&
    "resolverStage" in e &&
    ((e as SnapshotTransportPayload).artifactState === "missing" || (e as SnapshotTransportPayload).artifactState === "corrupt")
  );
}

// ─── Source dispatcher ─────────────────────────────────────────────────────

/**
 * Dispatch a snapshot resolution request across the supported source
 * topologies, extending the legacy single-GET source without breaking it:
 *
 *   - GY_SNAPSHOT_GITHUB_REPO (optionally GY_SNAPSHOT_STABLE_REF) → the
 *     stable-pointer resolver — the production topology for the dedicated
 *     `refs/tags/console-snapshot-prod` architecture;
 *   - GY_SNAPSHOT_URL / GY_SNAPSHOT_PATH → the LEGACY direct-URL / volume
 *     source, unchanged (still supported for self-hosted runs and local
 *     development; NOT the production path under the pointer architecture);
 *   - mixing the stable-pointer configuration with either legacy variable
 *     is a SOURCE_CONFLICT — the console refuses to guess, exactly like
 *     the legacy URL-vs-PATH conflict.
 */
export async function resolveSnapshotArtifact(
  env: StablePointerResolverEnv,
  deps: StablePointerResolverDeps & { readFile: (path: string) => Promise<Uint8Array>; statSize: (path: string) => Promise<number | null> },
): Promise<SnapshotTransportPayload> {
  const repo = env.GY_SNAPSHOT_GITHUB_REPO?.trim() ? env.GY_SNAPSHOT_GITHUB_REPO.trim() : null;
  const hasLegacy = Boolean(
    (env.GY_SNAPSHOT_URL?.trim() ? env.GY_SNAPSHOT_URL.trim() : null) ??
      (env.GY_SNAPSHOT_PATH?.trim() ? env.GY_SNAPSHOT_PATH.trim() : null),
  );

  if (repo && hasLegacy) {
    const checkedAtUnixMs = deps.nowMs;
    return {
      artifactState: "missing",
      dataState: "unavailable",
      reason:
        "Both GY_SNAPSHOT_GITHUB_REPO and a legacy snapshot source (GY_SNAPSHOT_URL or GY_SNAPSHOT_PATH) are configured — configure exactly one snapshot source topology.",
      reasonCode: "SOURCE_CONFLICT",
      source: { kind: "none", uri: null },
      checkedAtUnixMs,
      ageMs: null,
      maxAgeMs: null,
      resolverStage: "stable-ref",
      snapshot: null,
    };
  }
  if (repo) {
    return resolveSnapshotViaStablePointer(env, deps);
  }
  return resolveSnapshotSource(env, deps);
}
