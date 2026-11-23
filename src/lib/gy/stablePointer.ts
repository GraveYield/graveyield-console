// Stable-pointer publication contract (Console-side mirror).
//
// This module mirrors, byte-for-byte in validation semantics, the PRODUCER
// contract implemented in `grave-indexer` src/snapshotPublication.ts (the
// publisher developed on PR #5, head be024ca90330a1a486e25a8bf16f7511805716d7
// at the time of this mirror). The Console consumes publications from that
// producer; it must never accept a pointer or artifact triple that the
// producer's own fail-closed parser would reject. Every rule below is
// transcribed from the producer module and pinned by tests in
// __tests__/stablePointer.test.ts.
//
// The production discovery mechanism is the dedicated stable Git reference
// `refs/tags/console-snapshot-prod` (NOT GitHub's repository-wide "latest"
// release). The ref points to an ANNOTATED tag object whose message is the
// stable-pointer JSON (graveyield.console-snapshot-stable-pointer.v1). The
// pointer IDENTIFIES one workflow-protected `--latest=false` versioned
// release — protected by the publisher workflow's `--latest=false`
// convention plus the digest verification below, NOT by GitHub's
// immutable-releases feature (a separate, owner-enabled platform setting
// whose enablement must be verified independently) — and
// carries per-asset SHA-256 digests + byte lengths. The payload bytes live
// exclusively on the versioned release assets; the stable ref never carries
// them.
//
// Pure, zero-network module: parse and verify only. The transport
// orchestration lives in stablePointerResolver.ts. Server-side only
// (node:crypto); nothing here may ever be bundled into client code.

import { createHash } from "node:crypto";

/** The dedicated stable reference (owner-selected architecture). */
export const STABLE_REF_DEFAULT = "console-snapshot-prod";

/** Schema discriminator of the stable pointer carried in the tag-object message. */
export const STABLE_POINTER_SCHEMA = "graveyield.console-snapshot-stable-pointer.v1";

/** Exact asset filenames published on every versioned release. */
export const SNAPSHOT_ASSET_NAME = "console-snapshot.json";
export const PROVENANCE_ASSET_NAME = "console-snapshot-provenance.json";
export const CHECKSUM_ASSET_NAME = "console-snapshot.sha256";

/** The three required assets, in the order the pointer carries them. */
export const REQUIRED_ASSET_NAMES = [
  SNAPSHOT_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  CHECKSUM_ASSET_NAME,
] as const;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Versioned tag shape produced by the publisher: `console-snapshot-prod-<stamp>-<commit12|notrack>`. */
export const VERSIONED_TAG_PATTERN =
  /^console-snapshot-prod-\d{8}T\d{6}Z-(?:[0-9a-f]{12}|notrack)$/;

/** Per-asset identification carried by the pointer (digest + length, NEVER the bytes). */
export interface StablePointerAssetDigest {
  name: string;
  sha256: string;
  byteLength: number;
}

/** The stable-pointer JSON — the ENTIRE content of the annotated tag object. */
export interface StablePointerV1 {
  pointerSchema: string;
  stableRef: string;
  versionedTag: string;
  sourceCommit: string;
  publishedAtUnixMs: number;
  snapshot: StablePointerAssetDigest;
  provenance: StablePointerAssetDigest;
  checksum: StablePointerAssetDigest;
  previousVersionedTag: string | null;
  previousTagObjectSha: string | null;
}

/** The exhaustive pointer key set — pinned to keep the pointer secret-free and the schema strict. */
export const STABLE_POINTER_KEYS = [
  "pointerSchema",
  "stableRef",
  "versionedTag",
  "sourceCommit",
  "publishedAtUnixMs",
  "snapshot",
  "provenance",
  "checksum",
  "previousVersionedTag",
  "previousTagObjectSha",
] as const;

const STABLE_POINTER_ASSET_KEYS = ["name", "sha256", "byteLength"] as const;

/** Error thrown by any stable-pointer contract violation (mirror of the producer's SnapshotPublicationError). */
export class StablePointerError extends Error {
  constructor(message: string) {
    super(`stable-pointer: ${message}`);
    this.name = "StablePointerError";
  }
}

/** The pointer message is not JSON at all — distinguishable from a schema violation. */
export class StablePointerParseError extends StablePointerError {}

/** sha256 hex over the exact bytes (node:crypto — server-side only). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the stable pointer for one verified versioned publication — the
 * canonical single-line serialization the producer writes into the
 * annotated tag-object message. Exported so tests can round-trip the
 * exact producer serialization; the Console never builds pointers at
 * runtime (it only consumes them).
 */
export function buildStablePointer(args: {
  versionedTag: string;
  sourceCommit: string;
  publishedAtUnixMs: number;
  snapshotBytes: Uint8Array;
  provenanceBytes: Uint8Array;
  checksumBytes: Uint8Array;
  previous?: { versionedTag: string; tagObjectSha: string } | null;
  stableRef?: string;
}): { pointer: StablePointerV1; pointerJson: string } {
  if (!VERSIONED_TAG_PATTERN.test(args.versionedTag)) {
    throw new StablePointerError(`versioned tag ${JSON.stringify(args.versionedTag)} does not match the expected shape`);
  }
  if (!HEX40.test(args.sourceCommit)) {
    throw new StablePointerError("sourceCommit must be 40-hex");
  }
  if (!Number.isInteger(args.publishedAtUnixMs) || args.publishedAtUnixMs <= 0) {
    throw new StablePointerError("publishedAtUnixMs must be a positive integer");
  }
  const stableRef = args.stableRef ?? STABLE_REF_DEFAULT;
  const pointer: StablePointerV1 = {
    pointerSchema: STABLE_POINTER_SCHEMA,
    stableRef,
    versionedTag: args.versionedTag,
    sourceCommit: args.sourceCommit,
    publishedAtUnixMs: args.publishedAtUnixMs,
    snapshot: { name: SNAPSHOT_ASSET_NAME, sha256: sha256Hex(args.snapshotBytes), byteLength: args.snapshotBytes.byteLength },
    provenance: { name: PROVENANCE_ASSET_NAME, sha256: sha256Hex(args.provenanceBytes), byteLength: args.provenanceBytes.byteLength },
    checksum: { name: CHECKSUM_ASSET_NAME, sha256: sha256Hex(args.checksumBytes), byteLength: args.checksumBytes.byteLength },
    previousVersionedTag: args.previous?.versionedTag ?? null,
    previousTagObjectSha: args.previous?.tagObjectSha ?? null,
  };
  return { pointer, pointerJson: JSON.stringify(pointer) };
}

function parseAssetDigest(value: unknown, expectedName: string, field: string): StablePointerAssetDigest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StablePointerError(`field '${field}' must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...STABLE_POINTER_ASSET_KEYS].sort())) {
    throw new StablePointerError(`field '${field}' carries an unexpected key set: ${keys.join(",")}`);
  }
  if (record["name"] !== expectedName) {
    throw new StablePointerError(`field '${field}.name' must be ${expectedName}`);
  }
  if (typeof record["sha256"] !== "string" || !HEX64.test(record["sha256"])) {
    throw new StablePointerError(`field '${field}.sha256' must be 64-hex`);
  }
  if (typeof record["byteLength"] !== "number" || !Number.isInteger(record["byteLength"]) || record["byteLength"] <= 0) {
    throw new StablePointerError(`field '${field}.byteLength' must be a positive integer`);
  }
  return { name: record["name"] as string, sha256: record["sha256"] as string, byteLength: record["byteLength"] as number };
}

/**
 * Strict, fail-closed parse of a stable-pointer JSON (the annotated tag
 * object message). Mirrors the producer's parseStablePointer exactly:
 * every field is validated; an unexpected key set, a wrong schema
 * discriminator, a malformed tag/commit/digest or a non-positive length
 * throws. Never returns an unvalidated shape.
 */
export function parseStablePointer(text: string, stableRef: string = STABLE_REF_DEFAULT): StablePointerV1 {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new StablePointerParseError(`pointer is not JSON: ${String((err as Error).message ?? err)}`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new StablePointerError("pointer is not a JSON object");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...STABLE_POINTER_KEYS].sort())) {
    throw new StablePointerError(`pointer carries an unexpected key set: ${keys.join(",")}`);
  }
  if (record["pointerSchema"] !== STABLE_POINTER_SCHEMA) {
    throw new StablePointerError(`pointerSchema must be ${STABLE_POINTER_SCHEMA}`);
  }
  if (record["stableRef"] !== stableRef) {
    throw new StablePointerError(`stableRef must be ${stableRef}`);
  }
  if (typeof record["versionedTag"] !== "string") {
    throw new StablePointerError("versionedTag must be a string");
  }
  if (!VERSIONED_TAG_PATTERN.test(record["versionedTag"] as string)) {
    throw new StablePointerError(
      `versionedTag ${JSON.stringify(record["versionedTag"])} does not match the expected shape console-snapshot-prod-<YYYYMMDDTHHMMSSZ>-<commit12|notrack>`,
    );
  }
  if (typeof record["sourceCommit"] !== "string" || !HEX40.test(record["sourceCommit"])) {
    throw new StablePointerError("sourceCommit must be 40-hex");
  }
  if (
    typeof record["publishedAtUnixMs"] !== "number" ||
    !Number.isInteger(record["publishedAtUnixMs"]) ||
    record["publishedAtUnixMs"] <= 0
  ) {
    throw new StablePointerError("publishedAtUnixMs must be a positive integer");
  }
  const pointer = record as unknown as StablePointerV1;
  pointer.snapshot = parseAssetDigest(record["snapshot"], SNAPSHOT_ASSET_NAME, "snapshot");
  pointer.provenance = parseAssetDigest(record["provenance"], PROVENANCE_ASSET_NAME, "provenance");
  pointer.checksum = parseAssetDigest(record["checksum"], CHECKSUM_ASSET_NAME, "checksum");
  if (record["previousVersionedTag"] !== null && typeof record["previousVersionedTag"] !== "string") {
    throw new StablePointerError("previousVersionedTag must be a string or null");
  }
  if (typeof record["previousVersionedTag"] === "string") {
    if (!VERSIONED_TAG_PATTERN.test(record["previousVersionedTag"] as string)) {
      throw new StablePointerError("previousVersionedTag does not match the expected versioned tag shape");
    }
  }
  if (
    record["previousTagObjectSha"] !== null &&
    (typeof record["previousTagObjectSha"] !== "string" || !HEX40.test(record["previousTagObjectSha"]))
  ) {
    throw new StablePointerError("previousTagObjectSha must be 40-hex or null");
  }
  if ((record["previousVersionedTag"] === null) !== (record["previousTagObjectSha"] === null)) {
    throw new StablePointerError("previous fields must be both null or both set");
  }
  return pointer;
}

// ─── Provenance sidecar ────────────────────────────────────────────────────

/**
 * The provenance sidecar shape (PublicationProvenance on the producer).
 * The exhaustive key set is pinned exactly like the producer's — a sidecar
 * carrying extra or missing keys does not describe these bytes.
 */
export interface PublicationProvenance {
  schemaVersion: number;
  snapshotGeneratedAtUnixMs: number;
  indexerSourceCommitSha: string | null;
  cluster: string;
  freshness: { maxAgeMs: number };
  counts: {
    rawAccounts: number;
    parsedPools: number;
    supportedWsolPairs: number;
    m1SourcingRejected: number;
    enriched: number;
  };
  snapshotSha256: string;
  snapshotByteLength: number;
  workflowRunId: string | null;
  workflowAttempt: string | null;
  repository: string | null;
  versionedTag: string | null;
}

export const PUBLICATION_PROVENANCE_KEYS = [
  "schemaVersion",
  "snapshotGeneratedAtUnixMs",
  "indexerSourceCommitSha",
  "cluster",
  "freshness",
  "counts",
  "snapshotSha256",
  "snapshotByteLength",
  "workflowRunId",
  "workflowAttempt",
  "repository",
  "versionedTag",
] as const;

/**
 * Strict parse of the provenance sidecar bytes. The sidecar is metadata,
 * not payload: its integrity is enforced by the pointer's digest over its
 * exact bytes; this parse validates only its shape so the cross-checks
 * below can rely on typed fields. Fail closed on any shape violation.
 */
export function parsePublicationProvenance(bytes: Uint8Array): PublicationProvenance {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    throw new StablePointerError(`provenance sidecar is not UTF-8 JSON: ${String((err as Error).message ?? err)}`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new StablePointerError("provenance sidecar is not a JSON object");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...PUBLICATION_PROVENANCE_KEYS].sort())) {
    throw new StablePointerError(`provenance sidecar carries an unexpected key set: ${keys.join(",")}`);
  }
  if (typeof record["schemaVersion"] !== "number" || !Number.isInteger(record["schemaVersion"])) {
    throw new StablePointerError("provenance schemaVersion must be an integer");
  }
  const freshness = record["freshness"];
  if (
    typeof freshness !== "object" ||
    freshness === null ||
    Array.isArray(freshness) ||
    Object.keys(freshness as object).sort().join(",") !== "maxAgeMs" ||
    typeof (freshness as Record<string, unknown>)["maxAgeMs"] !== "number" ||
    !Number.isInteger((freshness as Record<string, unknown>)["maxAgeMs"] as number) ||
    ((freshness as Record<string, unknown>)["maxAgeMs"] as number) <= 0
  ) {
    throw new StablePointerError("provenance freshness.maxAgeMs must be a positive integer");
  }
  const counts = record["counts"];
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    throw new StablePointerError("provenance carries no counts object");
  }
  for (const k of ["rawAccounts", "parsedPools", "supportedWsolPairs", "m1SourcingRejected", "enriched"]) {
    const v = (counts as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new StablePointerError(`provenance counts.${k} must be a non-negative integer`);
    }
  }
  if (typeof record["snapshotSha256"] !== "string" || !HEX64.test(record["snapshotSha256"])) {
    throw new StablePointerError("provenance snapshotSha256 must be 64-hex");
  }
  if (typeof record["snapshotByteLength"] !== "number" || !Number.isInteger(record["snapshotByteLength"]) || record["snapshotByteLength"] <= 0) {
    throw new StablePointerError("provenance snapshotByteLength must be a positive integer");
  }
  for (const k of ["indexerSourceCommitSha", "workflowRunId", "workflowAttempt", "repository", "versionedTag"]) {
    const v = record[k];
    if (v !== null && typeof v !== "string") {
      throw new StablePointerError(`provenance ${k} must be a string or null`);
    }
  }
  return record as unknown as PublicationProvenance;
}

/**
 * Cross-check the pointer against the EXACT artifact triple fetched from
 * the versioned release it names, and against that release's own
 * provenance sidecar. Any digest, length, tag or commit divergence is a
 * hard failure — the pointer must never bless bytes it does not name.
 * (Mirror of the producer's verifyStablePointerMatchesArtifacts.)
 */
export function verifyStablePointerMatchesArtifacts(args: {
  pointer: StablePointerV1;
  snapshotBytes: Uint8Array;
  provenanceBytes: Uint8Array;
  checksumBytes: Uint8Array;
  provenance: PublicationProvenance;
}): void {
  const pairs: Array<[StablePointerAssetDigest, Uint8Array, string]> = [
    [args.pointer.snapshot, args.snapshotBytes, "snapshot"],
    [args.pointer.provenance, args.provenanceBytes, "provenance"],
    [args.pointer.checksum, args.checksumBytes, "checksum"],
  ];
  for (const [digest, bytes, field] of pairs) {
    const actual = sha256Hex(bytes);
    if (actual !== digest.sha256 || bytes.byteLength !== digest.byteLength) {
      throw new StablePointerError(
        `${field} digest/length mismatch: pointer says ${digest.sha256}/${digest.byteLength}, fetched bytes hash to ${actual}/${bytes.byteLength}`,
      );
    }
  }
  // The checksum asset must be a sha256sum-compatible line naming the
  // snapshot asset and carrying the snapshot's digest (the producer runs
  // `sha256sum -c` over the same content).
  const text = new TextDecoder("utf-8", { fatal: false }).decode(args.checksumBytes);
  const match = /^([0-9a-f]{64})  ([^\n]+)\n?$/.exec(text);
  if (!match) {
    throw new StablePointerError(`checksum asset is not sha256sum-compatible: ${JSON.stringify(text.slice(0, 120))}`);
  }
  if (match[2] !== SNAPSHOT_ASSET_NAME) {
    throw new StablePointerError(`checksum asset names ${match[2]}, expected ${SNAPSHOT_ASSET_NAME}`);
  }
  if (match[1] !== args.pointer.snapshot.sha256) {
    throw new StablePointerError(
      `checksum asset MISMATCH: file says ${match[1]}, pointer says ${args.pointer.snapshot.sha256}`,
    );
  }
  // Provenance cross-check: the sidecar must name the SAME versioned tag
  // and (when present) the SAME source commit — a cross-release mixture is
  // detectable because only the release's own sidecar carries its tag.
  if (args.provenance.versionedTag !== args.pointer.versionedTag) {
    throw new StablePointerError(
      `pointer names ${args.pointer.versionedTag} but the release's provenance names ${args.provenance.versionedTag ?? "<none>"} — refusing a cross-release identification`,
    );
  }
  if (args.provenance.indexerSourceCommitSha !== null && args.provenance.indexerSourceCommitSha !== args.pointer.sourceCommit) {
    throw new StablePointerError(
      `pointer sourceCommit ${args.pointer.sourceCommit} does not match the release provenance commit ${args.provenance.indexerSourceCommitSha}`,
    );
  }
  // Sidecar integrity over the exact snapshot bytes (redundant with the
  // pointer digest but enforced independently — the sidecar must describe
  // THESE bytes, not just agree with the pointer).
  const actualSha = sha256Hex(args.snapshotBytes);
  if (actualSha !== args.provenance.snapshotSha256) {
    throw new StablePointerError(
      `snapshot SHA-256 mismatch: sidecar declares ${args.provenance.snapshotSha256}, actual bytes hash to ${actualSha}`,
    );
  }
  if (args.snapshotBytes.byteLength !== args.provenance.snapshotByteLength) {
    throw new StablePointerError(
      `snapshot byte length mismatch: sidecar declares ${args.provenance.snapshotByteLength}, actual ${args.snapshotBytes.byteLength}`,
    );
  }
}

// ─── Completeness contract (mirror of the producer's eighth-round gate) ────

/** The failure stages that mark an artifact as INCOMPLETE (never publication-ready). */
export const COMPLETENESS_STAGES = ["discovery-completeness", "enrichment-completeness"] as const;

/**
 * The INDEPENDENT completeness gate the release-ops verifier enforces over
 * fetched bytes (producer src/snapshotPublication.ts verifyRawArtifactCompleteness):
 *
 *   1. the artifact's `failures` array must EXIST and be well-formed;
 *   2. no failure entry may carry a discovery/enrichment-completeness marker;
 *   3. the artifact's own counts.enriched must be a non-negative integer;
 *   4. the provenance sidecar's counts.enriched must be well-formed;
 *   5. the two counts must EXACTLY agree;
 *   6. the agreed count must be positive — an empty publication can never
 *      be a production snapshot.
 */
export function verifyRawArtifactCompleteness(raw: unknown, provenance: PublicationProvenance): void {
  const notComplete = (detail: string): StablePointerError => new StablePointerError(`completeness evidence: ${detail}`);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw notComplete("the snapshot payload is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const failures = obj["failures"];
  if (!Array.isArray(failures)) {
    throw notComplete("the snapshot carries no failures array — completeness evidence is missing");
  }
  for (const [i, f] of failures.entries()) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      throw notComplete(`failures[${i}] is not an object — completeness evidence is malformed`);
    }
    const stage = (f as { stage?: unknown }).stage;
    if (typeof stage !== "string" || stage.length === 0) {
      throw notComplete(`failures[${i}].stage is not a non-empty string — completeness evidence is malformed`);
    }
    if ((COMPLETENESS_STAGES as readonly string[]).includes(stage)) {
      const reason = (f as { reason?: unknown }).reason;
      const detail = typeof reason === "string" ? reason : "(no reason recorded)";
      throw notComplete(`the artifact carries a "${stage}" failure marker — ${detail}`);
    }
  }

  const counts = obj["counts"];
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    throw notComplete("the snapshot carries no counts object — the enriched-pool count is missing");
  }
  const enrichedActual = (counts as { enriched?: unknown })["enriched"];
  if (typeof enrichedActual !== "number" || !Number.isInteger(enrichedActual) || enrichedActual < 0) {
    throw notComplete(
      `the snapshot's counts.enriched is malformed (${JSON.stringify(enrichedActual ?? null)}) — expected a non-negative integer`,
    );
  }

  const provenanceCounts = provenance.counts as { enriched?: unknown } | undefined;
  if (typeof provenanceCounts !== "object" || provenanceCounts === null || Array.isArray(provenanceCounts)) {
    throw notComplete("the provenance sidecar carries no counts object — the enriched-pool count is missing");
  }
  const enrichedClaim = provenanceCounts.enriched;
  if (typeof enrichedClaim !== "number" || !Number.isInteger(enrichedClaim) || enrichedClaim < 0) {
    throw notComplete(
      `the provenance sidecar's counts.enriched is malformed (${JSON.stringify(enrichedClaim ?? null)}) — expected a non-negative integer`,
    );
  }

  if (enrichedActual !== enrichedClaim) {
    throw notComplete(
      `the artifact reports ${enrichedActual} enriched pool(s) but the provenance sidecar claims ${enrichedClaim} — the sidecar does not describe these bytes`,
    );
  }

  if (!(enrichedActual > 0)) {
    throw notComplete("the artifact reports zero enriched pools — refusing to endorse an empty snapshot");
  }
}
