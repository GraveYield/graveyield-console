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

/** The claims-artifact manifest published alongside every versioned release. */
export interface ClaimsManifest {
  manifestSchema: string;
  artifact: {
    asset: string;
    sha256: string;
    byteLength: number;
    formatVersion: number;
    pool: string;
    lpMint: string;
    snapshotSlot: number;
    merkleRoot: string;
    producer: { identity: string; version: string };
  };
  sourceCommit: string;
  publishedAtUnixMs: number;
}

export const CLAIMS_MANIFEST_SCHEMA = "graveyield.claims-artifact-manifest.v1";

const MANIFEST_KEYS = [
  "manifestSchema",
  "artifact",
  "sourceCommit",
  "publishedAtUnixMs",
] as const;

/**
 * D4 (review): strict parse + CONSISTENCY verification of the published
 * manifest. The manifest must (a) match the strict schema, and (b) agree
 * with the pointer on every immutable-identity field and with the
 * artifact's exact digest. Any mismatch refuses the whole chain before
 * anything can become actionable.
 */
export function parseClaimsManifest(
  text: string,
  pointer: ClaimsStablePointerV1,
): ClaimsManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ClaimsPointerError("manifest is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClaimsPointerError("manifest must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = [...MANIFEST_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new ClaimsPointerError("manifest keys do not match the strict schema");
  }
  if (obj.manifestSchema !== CLAIMS_MANIFEST_SCHEMA) {
    throw new ClaimsPointerError(`unsupported manifestSchema ${JSON.stringify(obj.manifestSchema)}`);
  }
  const a = obj.artifact as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null || Array.isArray(a)) {
    throw new ClaimsPointerError("manifest.artifact must be an object");
  }
  const identity = {
    asset: a.asset,
    sha256: a.sha256,
    byteLength: a.byteLength,
    formatVersion: a.formatVersion,
    pool: a.pool,
    lpMint: a.lpMint,
    snapshotSlot: a.snapshotSlot,
    merkleRoot: a.merkleRoot,
    producer: a.producer,
  };
  const checks: Array<[unknown, unknown, string]> = [
    [identity.asset, CLAIMS_ARTIFACT_ASSET_NAME, "manifest.artifact.asset"],
    [identity.sha256, pointer.artifact.sha256, "manifest.artifact.sha256 vs pointer"],
    [identity.byteLength, pointer.artifact.byteLength, "manifest.artifact.byteLength vs pointer"],
    [identity.formatVersion, 2, "manifest.artifact.formatVersion"],
    [identity.pool, pointer.pool, "manifest.artifact.pool vs pointer"],
    [identity.lpMint, pointer.lpMint, "manifest.artifact.lpMint vs pointer"],
    [identity.snapshotSlot, pointer.snapshotSlot, "manifest.artifact.snapshotSlot vs pointer"],
    [identity.merkleRoot, pointer.merkleRoot, "manifest.artifact.merkleRoot vs pointer"],
    [obj.sourceCommit, pointer.sourceCommit, "manifest.sourceCommit vs pointer"],
    [obj.publishedAtUnixMs, pointer.publishedAtUnixMs, "manifest.publishedAtUnixMs vs pointer"],
  ];
  for (const [got, want, what] of checks) {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new ClaimsPointerError(`${what} mismatch (manifest ${JSON.stringify(got)} vs expected ${JSON.stringify(want)})`);
    }
  }
  if (
    typeof identity.producer !== "object" || identity.producer === null ||
    (identity.producer as ClaimsStablePointerV1["producer"]).identity !== pointer.producer.identity ||
    (identity.producer as ClaimsStablePointerV1["producer"]).version !== pointer.producer.version
  ) {
    throw new ClaimsPointerError("manifest.artifact.producer mismatch vs pointer");
  }
  return {
    manifestSchema: CLAIMS_MANIFEST_SCHEMA,
    artifact: {
      asset: identity.asset as string,
      sha256: identity.sha256 as string,
      byteLength: identity.byteLength as number,
      formatVersion: 2,
      pool: identity.pool as string,
      lpMint: identity.lpMint as string,
      snapshotSlot: identity.snapshotSlot as number,
      merkleRoot: identity.merkleRoot as string,
      producer: identity.producer as ClaimsStablePointerV1["producer"],
    },
    sourceCommit: obj.sourceCommit as string,
    publishedAtUnixMs: obj.publishedAtUnixMs as number,
  };
}

/**
 * Verify the fetched bytes against the pointer: byte length + SHA-256 for
 * every asset (artifact + manifest + checksum), and the checksum sidecar
 * against the artifact digest. Throws `ClaimsPointerError` on ANY
 * mismatch — a consumer can never accept bytes that do not match the
 * immutable identity.
 */
export function verifyClaimsPointerMatchesBytes(args: {
  pointer: ClaimsStablePointerV1;
  artifactBytes: Uint8Array;
  manifestBytes: Uint8Array;
  checksumBytes: Uint8Array;
}): { artifactSha256: string } {
  const { pointer, artifactBytes, manifestBytes, checksumBytes } = args;
  const assets: Array<[ClaimsPointerAssetDigest, Uint8Array, string]> = [
    [pointer.artifact, artifactBytes, "artifact"],
    [pointer.manifest, manifestBytes, "manifest"],
    [pointer.checksum, checksumBytes, "checksum"],
  ];
  for (const [digest, bytes, what] of assets) {
    if (bytes.byteLength !== digest.byteLength) {
      throw new ClaimsPointerError(`${what} byte length ${bytes.byteLength} != pointer ${digest.byteLength}`);
    }
    const hex = claimsSha256Hex(bytes);
    if (hex !== digest.sha256) {
      throw new ClaimsPointerError(`${what} sha256 ${hex} != pointer ${digest.sha256}`);
    }
  }
  const sidecar = Buffer.from(checksumBytes).toString("utf8").trim();
  const expected = `${pointer.artifact.sha256}  ${CLAIMS_ARTIFACT_ASSET_NAME}`;
  if (sidecar !== expected) {
    throw new ClaimsPointerError("checksum sidecar does not match the artifact digest");
  }
  return { artifactSha256: pointer.artifact.sha256 };
}
