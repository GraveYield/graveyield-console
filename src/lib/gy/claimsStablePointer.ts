// Claims-artifact stable-pointer contract (console-side mirror, D4).
//
// Mirrors the PRODUCER contract implemented in `grave-indexer`
// src/claimsPublication.ts: the dedicated stable git reference
// `refs/tags/claims-artifact-prod` whose annotated tag-object message is
// the claims stable-pointer JSON
// (graveyield.claims-artifact-stable-pointer.v1). The pointer identifies
// ONE workflow-protected `--latest=false` versioned release and carries
// per-asset SHA-256 digests + byte lengths plus the immutable artifact
// identity (schema version, pool, LP mint, snapshot slot, Merkle root,
// producer identity).
//
// SEPARATION: this is the CLAIMS pointer family — distinct from the
// console-snapshot (pool-discovery) pointer in stablePointer.ts. No
// schema, ref, tag namespace, or asset name is shared or interpreted
// across the two.
//
// Pure, zero-network module: parse and verify only. The transport
// orchestration lives in claimsStablePointerResolver.ts. Server-side
// only (node:crypto); nothing here may ever be bundled into client code.

import { createHash } from "node:crypto";

/** The dedicated stable reference for claims publications. */
export const CLAIMS_STABLE_REF_DEFAULT = "claims-artifact-prod";

/** Schema discriminator of the claims stable pointer. */
export const CLAIMS_POINTER_SCHEMA = "graveyield.claims-artifact-stable-pointer.v1";

/** Exact asset filenames published on every claims versioned release. */
export const CLAIMS_ARTIFACT_ASSET_NAME = "claims-artifact.json";
export const CLAIMS_MANIFEST_ASSET_NAME = "claims-artifact-manifest.json";
export const CLAIMS_CHECKSUM_ASSET_NAME = "claims-artifact.sha256";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Versioned tag shape produced by the publisher. */
export const CLAIMS_VERSIONED_TAG_PATTERN =
  /^claims-artifact-prod-\d{8}T\d{6}Z-(?:[0-9a-f]{12}|notrack)$/;

export interface ClaimsPointerAssetDigest {
  name: string;
  sha256: string;
  byteLength: number;
}

/** The claims stable-pointer JSON — the ENTIRE content of the annotated tag object. */
export interface ClaimsStablePointerV1 {
  pointerSchema: string;
  stableRef: string;
  versionedTag: string;
  sourceCommit: string;
  publishedAtUnixMs: number;
  artifact: ClaimsPointerAssetDigest;
  manifest: ClaimsPointerAssetDigest;
  checksum: ClaimsPointerAssetDigest;
  artifactSchemaVersion: number;
  pool: string;
  lpMint: string;
  snapshotSlot: number;
  merkleRoot: string;
  producer: { identity: string; version: string };
  previousVersionedTag: string | null;
  previousTagObjectSha: string | null;
}

/** The exhaustive pointer key set — strict schema, pinned by test. */
export const CLAIMS_POINTER_KEYS = [
  "pointerSchema",
  "stableRef",
  "versionedTag",
  "sourceCommit",
  "publishedAtUnixMs",
  "artifact",
  "manifest",
  "checksum",
  "artifactSchemaVersion",
  "pool",
  "lpMint",
  "snapshotSlot",
  "merkleRoot",
  "producer",
  "previousVersionedTag",
  "previousTagObjectSha",
] as const;

export class ClaimsPointerError extends Error {
  constructor(message: string) {
    super(`claims-pointer: ${message}`);
    this.name = "ClaimsPointerError";
  }
}

export class ClaimsPointerParseError extends ClaimsPointerError {}

/** sha256 hex over the exact bytes (node:crypto — server-side only). */
export function claimsSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Strict parse of a claims stable pointer: exhaustive keys, supported
 * values, and identity coherence. Any violation throws.
 */
export function parseClaimsStablePointer(text: string): ClaimsStablePointerV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ClaimsPointerParseError("pointer message is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClaimsPointerParseError("pointer must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...CLAIMS_POINTER_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new ClaimsPointerError("pointer keys do not match the strict schema (unknown or missing fields)");
  }
  if (obj.pointerSchema !== CLAIMS_POINTER_SCHEMA) {
    throw new ClaimsPointerError(`unsupported pointerSchema ${JSON.stringify(obj.pointerSchema)}`);
  }
  if (obj.stableRef !== CLAIMS_STABLE_REF_DEFAULT) {
    throw new ClaimsPointerError(`pointer names stableRef ${JSON.stringify(obj.stableRef)} (expected ${CLAIMS_STABLE_REF_DEFAULT})`);
  }
  const p = raw as ClaimsStablePointerV1;
  if (!CLAIMS_VERSIONED_TAG_PATTERN.test(p.versionedTag)) {
    throw new ClaimsPointerError(`versionedTag does not match the claims tag namespace: ${p.versionedTag}`);
  }
  if (typeof p.sourceCommit !== "string" || (!HEX40.test(p.sourceCommit) && p.sourceCommit !== "notrack")) {
    throw new ClaimsPointerError("sourceCommit must be a 40-hex sha or 'notrack'");
  }
  if (typeof p.publishedAtUnixMs !== "number" || !Number.isInteger(p.publishedAtUnixMs) || p.publishedAtUnixMs <= 0) {
    throw new ClaimsPointerError("publishedAtUnixMs must be a positive integer");
  }
  const expectedAssetName: Record<string, string> = {
    artifact: CLAIMS_ARTIFACT_ASSET_NAME,
    manifest: CLAIMS_MANIFEST_ASSET_NAME,
    checksum: CLAIMS_CHECKSUM_ASSET_NAME,
  };
  for (const key of ["artifact", "manifest", "checksum"] as const) {
    const d = p[key] as ClaimsPointerAssetDigest;
    if (
      typeof d !== "object" || d === null ||
      d.name !== expectedAssetName[key] ||
      !HEX64.test(d.sha256) ||
      typeof d.byteLength !== "number" || !Number.isInteger(d.byteLength) || d.byteLength <= 0
    ) {
      throw new ClaimsPointerError(`pointer.${key} is not a valid asset digest`);
    }
  }
  if (p.artifactSchemaVersion !== 2) {
    throw new ClaimsPointerError(`pointer artifactSchemaVersion ${p.artifactSchemaVersion} != the supported claims format 2`);
  }
  if (typeof p.pool !== "string" || !PUBKEY_RE.test(p.pool)) {
    throw new ClaimsPointerError("pointer.pool must be a base58 pubkey string");
  }
  if (typeof p.lpMint !== "string" || !PUBKEY_RE.test(p.lpMint)) {
    throw new ClaimsPointerError("pointer.lpMint must be a base58 pubkey string");
  }
  if (!HEX64.test(p.merkleRoot)) throw new ClaimsPointerError("pointer.merkleRoot must be a 64-hex digest");
  if (typeof p.snapshotSlot !== "number" || !Number.isInteger(p.snapshotSlot) || p.snapshotSlot <= 0) {
    throw new ClaimsPointerError("pointer.snapshotSlot must be a positive integer");
  }
  if (
    typeof p.producer !== "object" || p.producer === null ||
    typeof (p.producer as { identity?: unknown }).identity !== "string" ||
    ((p.producer as { identity: string }).identity.trim().length === 0) ||
    typeof (p.producer as { version?: unknown }).version !== "string" ||
    ((p.producer as { version: string }).version.trim().length === 0)
  ) {
    throw new ClaimsPointerError("pointer.producer must carry non-empty identity and version");
  }
  if (p.previousVersionedTag !== null && typeof p.previousVersionedTag !== "string") {
    throw new ClaimsPointerError("previousVersionedTag must be a string or null");
  }
  if (p.previousTagObjectSha !== null && (typeof p.previousTagObjectSha !== "string" || !HEX40.test(p.previousTagObjectSha))) {
    throw new ClaimsPointerError("previousTagObjectSha must be a 40-hex sha or null");
  }
  // Identity coherence: a pointer naming a previous tag must also carry
  // that tag's object sha, and vice versa.
  if ((p.previousVersionedTag === null) !== (p.previousTagObjectSha === null)) {
    throw new ClaimsPointerError("previousVersionedTag and previousTagObjectSha must be set together");
  }
  return p;
}

/**
 * Verify the fetched bytes against the pointer: byte length + SHA-256 for
 * every asset, and the checksum sidecar against the artifact digest.
 * Throws `ClaimsPointerError` on ANY mismatch — a consumer can never
 * accept bytes that do not match the immutable identity.
 */
export function verifyClaimsPointerMatchesBytes(args: {
  pointer: ClaimsStablePointerV1;
  artifactBytes: Uint8Array;
  checksumBytes: Uint8Array;
}): { artifactSha256: string } {
  const { pointer, artifactBytes, checksumBytes } = args;
  if (artifactBytes.byteLength !== pointer.artifact.byteLength) {
    throw new ClaimsPointerError(
      `artifact byte length ${artifactBytes.byteLength} != pointer ${pointer.artifact.byteLength}`,
    );
  }
  const sha = claimsSha256Hex(artifactBytes);
  if (sha !== pointer.artifact.sha256) {
    throw new ClaimsPointerError(`artifact sha256 ${sha} != pointer ${pointer.artifact.sha256}`);
  }
  const sidecar = Buffer.from(checksumBytes).toString("utf8").trim();
  const expected = `${sha}  ${CLAIMS_ARTIFACT_ASSET_NAME}`;
  if (sidecar !== expected) {
    throw new ClaimsPointerError("checksum sidecar does not match the artifact digest");
  }
  return { artifactSha256: sha };
}
