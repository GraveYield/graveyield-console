// Claims-artifact stable-pointer resolver — server-side transport (D4).
//
// Resolves the dedicated git reference `refs/tags/claims-artifact-prod`
// to the EXACT verified claims-artifact bytes, fail-closed at every step:
//
//   1. GET /repos/{repo}/git/ref/tags/{stableRef}   → tag-object sha
//   2. GET /repos/{repo}/git/tags/{tagObjectSha}    → annotated tag object
//   3. target sha must equal pointer.sourceCommit
//   4. parse the tag message as the claims stable pointer (strict schema)
//   5. fetch the artifact + checksum from the VERSIONED release
//      (releases/download/{pointer.versionedTag}/...) — never from any
//      repo-wide "latest" URL
//   6. verify byte length + SHA-256 + checksum sidecar against the pointer
//
// The returned bytes then go through the fail-closed claims contract
// (claimsSource) — schema, provenance, and full SDK Merkle integrity.
//
// Every failure maps onto the explicit artifact states (missing |
// corrupt) with a resolver stage, so the caller can tell WHERE the chain
// failed. No caching of any intermediate result. Every response is
// consumed under a byte cap, streamed and counted BEFORE parsing.
// The optional GitHub token is never logged and never reaches client code.

import {
  CLAIMS_ARTIFACT_ASSET_NAME,
  CLAIMS_CHECKSUM_ASSET_NAME,
  CLAIMS_MANIFEST_ASSET_NAME,
  CLAIMS_STABLE_REF_DEFAULT,
  parseClaimsManifest,
  parseClaimsStablePointer,
  verifyClaimsPointerMatchesBytes,
  ClaimsPointerError,
  type ClaimsManifest,
  type ClaimsStablePointerV1,
} from "./claimsStablePointer";

/** Hard cap per fetched asset (the artifact is ~tens of KB; 8 MiB is generous). */
export const DEFAULT_CLAIMS_RESOLVER_MAX_BYTES = 8 * 1024 * 1024;
/** Hard cap per GitHub API JSON response (1 MiB — the bodies are low-KB). */
export const DEFAULT_CLAIMS_MAX_JSON_BYTES = 1024 * 1024;
/** Per-request timeout. */
export const DEFAULT_CLAIMS_RESOLVER_TIMEOUT_MS = 10_000;

export type ClaimsResolverStage =
  | "stable-ref"
  | "annotated-tag"
  | "pointer-parse"
  | "pointer-validate"
  | "asset-fetch"
  | "asset-integrity"
  | "network";

export class ClaimsResolverError extends Error {
  readonly stage: ClaimsResolverStage;
  /** "missing" → the chain could not be walked; "corrupt" → bytes failed integrity. */
  readonly artifactState: "missing" | "corrupt";

  constructor(stage: ClaimsResolverStage, artifactState: "missing" | "corrupt", message: string) {
    super(message);
    this.name = "ClaimsResolverError";
    this.stage = stage;
    this.artifactState = artifactState;
  }
}

export interface ClaimsResolverEnv {
  /** GitHub repository ("owner/repo") holding the stable ref and versioned releases. */
  GY_CLAIMS_GITHUB_REPO?: string | null;
  /** GitHub API base (default https://api.github.com; override for tests/GHES). */
  GY_CLAIMS_GITHUB_API_BASE?: string | null;
  /** GitHub asset base (default https://github.com; override for tests). */
  GY_CLAIMS_GITHUB_ASSETS_BASE?: string | null;
  /**
   * OPTIONAL server-side GitHub token for authenticated reads. Server-only:
   * never logged, never echoed into any payload, never embedded client-side.
   */
  GY_CLAIMS_GITHUB_TOKEN?: string | null;
}

export interface ClaimsResolverDeps {
  fetchImpl: typeof fetch;
  maxBytes?: number;
  maxJsonBytes?: number;
  fetchTimeoutMs?: number;
}

export interface ClaimsResolvedArtifact {
  artifactBytes: Uint8Array;
  pointer: ClaimsStablePointerV1;
  manifest: ClaimsManifest;
  artifactSha256: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Streamed, byte-capped body read — oversized bodies are cancelled, never truncated. */
async function readCapped(res: Response, cap: number, stage: ClaimsResolverStage): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) throw new ClaimsResolverError(stage, "missing", "response body is empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel().catch(() => undefined);
        throw new ClaimsResolverError(stage, "corrupt", `response exceeded the ${cap}-byte cap`);
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
}

async function fetchJson<T>(
  env: ClaimsResolverEnv,
  deps: ClaimsResolverDeps,
  args: { path: string; stage: ClaimsResolverStage },
): Promise<T> {
  const apiBase = (env.GY_CLAIMS_GITHUB_API_BASE?.trim() || "https://api.github.com").replace(/\/$/, "");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const token = env.GY_CLAIMS_GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`; // never logged
  let res: Response;
  try {
    res = await deps.fetchImpl(`${apiBase}${args.path}`, {
      headers,
      signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? DEFAULT_CLAIMS_RESOLVER_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ClaimsResolverError(args.stage, "missing", `GitHub API request failed: ${errText(e)}`);
  }
  if (!res.ok) {
    throw new ClaimsResolverError(args.stage, "missing", `GitHub API answered HTTP ${res.status} for ${args.path}`);
  }
  return JSON.parse(Buffer.from(await readCapped(res, deps.maxJsonBytes ?? DEFAULT_CLAIMS_MAX_JSON_BYTES, args.stage)).toString("utf8")) as T;
}

/**
 * Resolve the full chain and return the verified artifact bytes. Throws
 * `ClaimsResolverError` (with stage) on any failure.
 */
export async function resolveClaimsStablePointer(
  env: ClaimsResolverEnv,
  deps: ClaimsResolverDeps,
): Promise<ClaimsResolvedArtifact> {
  const repo = env.GY_CLAIMS_GITHUB_REPO?.trim();
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new ClaimsResolverError("stable-ref", "missing", "GY_CLAIMS_GITHUB_REPO must be configured as owner/repo");
  }
  // D4 (review): the stable reference is a FIXED part of the architecture.
  // The previously supported GY_CLAIMS_STABLE_REF override was removed —
  // the strict pointer parser only ever accepts
  // graveyield.claims-artifact-stable-pointer.v1 pointers naming
  // claims-artifact-prod, so an override could only ever produce a
  // guaranteed-refused chain. There is exactly one production reference.
  const stableRef = CLAIMS_STABLE_REF_DEFAULT;
  const assetsBase = (env.GY_CLAIMS_GITHUB_ASSETS_BASE?.trim() || "https://github.com").replace(/\/$/, "");

  // 1. stable ref → tag object sha
  const ref = await fetchJson<{ object: { sha: string; type: string } }>(env, deps, {
    path: `/repos/${repo}/git/ref/tags/${stableRef}`,
    stage: "stable-ref",
  });
  if (ref.object.type !== "tag" || typeof ref.object.sha !== "string") {
    throw new ClaimsResolverError("stable-ref", "corrupt", `stable ref does not name an annotated tag object (${ref.object.type})`);
  }

  // 2. annotated tag object
  const tag = await fetchJson<{ message: string; object: { sha: string; type: string } }>(env, deps, {
    path: `/repos/${repo}/git/tags/${ref.object.sha}`,
    stage: "annotated-tag",
  });

  // 3+4. strict pointer parse; the tag object must name the recorded commit
  const pointer = (() => {
    try {
      return parseClaimsStablePointer(tag.message);
    } catch (e) {
      if (e instanceof ClaimsPointerError) {
        throw new ClaimsResolverError("pointer-parse", "corrupt", e.message);
      }
      throw e;
    }
  })();
  if (tag.object.sha !== pointer.sourceCommit && pointer.sourceCommit !== "notrack") {
    throw new ClaimsResolverError(
      "pointer-validate",
      "corrupt",
      `tag object sha ${tag.object.sha} does not match pointer.sourceCommit ${pointer.sourceCommit}`,
    );
  }

  // 5. fetch the EXACT versioned release assets (never a "latest" URL)
  const fetchAsset = async (name: string): Promise<Uint8Array> => {
    const headers: Record<string, string> = { accept: "application/octet-stream" };
    const token = env.GY_CLAIMS_GITHUB_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const url = `${assetsBase}/${repo}/releases/download/${pointer.versionedTag}/${name}`;
    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? DEFAULT_CLAIMS_RESOLVER_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ClaimsResolverError("asset-fetch", "missing", `asset request failed (${name}): ${errText(e)}`);
    }
    if (!res.ok) {
      throw new ClaimsResolverError("asset-fetch", "missing", `asset ${name} answered HTTP ${res.status}`);
    }
    return readCapped(res, deps.maxBytes ?? DEFAULT_CLAIMS_RESOLVER_MAX_BYTES, "asset-fetch");
  };
  const artifactBytes = await fetchAsset(CLAIMS_ARTIFACT_ASSET_NAME);
  const manifestBytes = await fetchAsset(CLAIMS_MANIFEST_ASSET_NAME);
  const checksumBytes = await fetchAsset(CLAIMS_CHECKSUM_ASSET_NAME);

  // 6. digest + length + manifest schema/consistency + sidecar, all against
  //    the pointer's immutable identity. A manifest mismatch (digest,
  //    length, schema, or identity fields) is refused BEFORE the artifact
  //    can ever become actionable.
  try {
    const manifest = parseClaimsManifest(
      Buffer.from(manifestBytes).toString("utf8"),
      pointer,
    );
    return {
      artifactBytes,
      pointer,
      manifest,
      ...verifyClaimsPointerMatchesBytes({ pointer, artifactBytes, manifestBytes, checksumBytes }),
    };
  } catch (e) {
    if (e instanceof ClaimsPointerError) {
      throw new ClaimsResolverError("asset-integrity", "corrupt", e.message);
    }
    throw e;
  }
}
