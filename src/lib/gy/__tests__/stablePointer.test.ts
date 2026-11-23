// Stable-pointer publication contract battery — Console-side mirror tests.
//
// Pins the exact producer contract the Console resolver enforces:
//   - strict stable-pointer parsing (graveyield.console-snapshot-stable-pointer.v1):
//     exact key set, schema discriminator, stableRef binding, versioned-tag
//     shape, 40-hex commit, 64-hex digests, positive byte lengths, paired
//     previous* fields;
//   - provenance sidecar shape validation;
//   - pointer↔artifact triple verification (digests, lengths, checksum
//     asset content, tag + commit provenance cross-check, sidecar digest);
//   - the independent completeness contract (no discovery/enrichment
//     failure markers, exact enriched-count agreement, non-empty publication).
//
// The fixtures here are the byte-level equivalents of the producer's own
// regression fixtures (grave-indexer test/ — snapshotPublication.ts
// buildStablePointer/parseStablePointer/verifyRawArtifactCompleteness).

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import {
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  STABLE_POINTER_SCHEMA,
  STABLE_REF_DEFAULT,
  buildStablePointer,
  parsePublicationProvenance,
  parseStablePointer,
  sha256Hex,
  StablePointerError,
  StablePointerParseError,
  verifyRawArtifactCompleteness,
  verifyStablePointerMatchesArtifacts,
  type PublicationProvenance,
} from "../stablePointer";
import { RAW_SNAPSHOT } from "../snapshot";

const NOW = 1_800_000_000_000;
const TAG = "console-snapshot-prod-20261123T120000Z-aabbccddeeff";
const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const TAG_OBJECT_SHA = "fedcba0987654321fedcba0987654321fedcba09";

/** Fresh, complete artifact bytes derived from the real producer fixture. */
function artifactBytes(overrides: (snap: Record<string, unknown>) => void = () => {}): Uint8Array {
  const snap = JSON.parse(JSON.stringify(RAW_SNAPSHOT)) as Record<string, unknown>;
  snap.generatedAtUnixMs = NOW;
  const pools = snap.pools as Record<string, unknown>[];
  for (const p of pools) {
    p.fetchedAtUnixMs = Math.min(p.fetchedAtUnixMs as number, NOW);
  }
  overrides(snap);
  return new TextEncoder().encode(JSON.stringify(snap));
}

/** Provenance sidecar matching the exact artifact bytes. */
function provenanceBytesFor(snapshotBytes: Uint8Array, overrides: (p: Record<string, unknown>) => void = () => {}): Uint8Array {
  const snap = JSON.parse(new TextDecoder().decode(snapshotBytes)) as Record<string, unknown>;
  const counts = snap.counts as Record<string, number>;
  const provenance: PublicationProvenance = {
    schemaVersion: 2,
    snapshotGeneratedAtUnixMs: snap.generatedAtUnixMs as number,
    indexerSourceCommitSha: COMMIT,
    cluster: snap.cluster as string,
    freshness: { maxAgeMs: (snap.freshness as { maxAgeMs: number }).maxAgeMs },
    counts: {
      rawAccounts: counts.rawAccounts,
      parsedPools: counts.parsedPools,
      supportedWsolPairs: counts.supportedWsolPairs,
      m1SourcingRejected: counts.m1SourcingRejected,
      enriched: counts.enriched,
    },
    snapshotSha256: sha256Hex(snapshotBytes),
    snapshotByteLength: snapshotBytes.byteLength,
    workflowRunId: null,
    workflowAttempt: null,
    repository: null,
    versionedTag: TAG,
  };
  overrides(provenance as unknown as Record<string, unknown>);
  return new TextEncoder().encode(JSON.stringify(provenance));
}

function checksumBytesFor(snapshotBytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`${sha256Hex(snapshotBytes)}  ${SNAPSHOT_ASSET_NAME}\n`);
}

function validTriple() {
  const snapshotBytes = artifactBytes();
  const provenanceBytes = provenanceBytesFor(snapshotBytes);
  const checksumBytes = checksumBytesFor(snapshotBytes);
  const { pointer, pointerJson } = buildStablePointer({
    versionedTag: TAG,
    sourceCommit: COMMIT,
    publishedAtUnixMs: NOW,
    snapshotBytes,
    provenanceBytes,
    checksumBytes,
  });
  return { snapshotBytes, provenanceBytes, checksumBytes, pointer, pointerJson };
}

// ─── Pointer parsing ───────────────────────────────────────────────────────────

describe("stable pointer parsing", () => {
  test("valid pointer round-trips through the producer serialization", () => {
    const { pointerJson } = validTriple();
    const parsed = parseStablePointer(pointerJson);
    expect(parsed.pointerSchema).toBe(STABLE_POINTER_SCHEMA);
    expect(parsed.stableRef).toBe(STABLE_REF_DEFAULT);
    expect(parsed.versionedTag).toBe(TAG);
    expect(parsed.sourceCommit).toBe(COMMIT);
    expect(parsed.snapshot.name).toBe(SNAPSHOT_ASSET_NAME);
    expect(parsed.provenance.name).toBe(PROVENANCE_ASSET_NAME);
    expect(parsed.checksum.name).toBe(CHECKSUM_ASSET_NAME);
    expect(parsed.previousVersionedTag).toBeNull();
    expect(parsed.previousTagObjectSha).toBeNull();
  });

  test("malformed JSON is a parse failure (StablePointerParseError)", () => {
    expect(() => parseStablePointer("{not json")).toThrow(StablePointerParseError);
  });

  test("a non-object pointer is rejected", () => {
    expect(() => parseStablePointer("[1,2,3]")).toThrow(StablePointerError);
  });

  test("an unexpected key set is rejected (no extra keys, no missing keys)", () => {
    const { pointerJson } = validTriple();
    const obj = JSON.parse(pointerJson) as Record<string, unknown>;
    const extra = JSON.stringify({ ...obj, sneaky: "field" });
    expect(() => parseStablePointer(extra)).toThrow(/unexpected key set/);
    const missing = JSON.stringify({ ...obj, checksum: undefined });
    expect(() => parseStablePointer(missing)).toThrow(/unexpected key set/);
  });

  test("a wrong schema discriminator is rejected", () => {
    const { pointerJson } = validTriple();
    const obj = JSON.parse(pointerJson) as Record<string, unknown>;
    obj.pointerSchema = "graveyield.console-snapshot-stable-pointer.v2";
    expect(() => parseStablePointer(JSON.stringify(obj))).toThrow(/pointerSchema must be/);
  });

  test("stableRef must equal the configured stable ref", () => {
    const { pointerJson } = validTriple();
    const obj = JSON.parse(pointerJson) as Record<string, unknown>;
    obj.stableRef = "console-snapshot-prod-2020";
    expect(() => parseStablePointer(JSON.stringify(obj))).toThrow(/stableRef must be/);
    // A pointer minted for a different ref name is valid under that ref name.
    const { pointer, pointerJson: otherJson } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes: artifactBytes(),
      provenanceBytes: provenanceBytesFor(artifactBytes()),
      checksumBytes: checksumBytesFor(artifactBytes()),
      stableRef: "other-ref",
    });
    expect(pointer.stableRef).toBe("other-ref");
    expect(parseStablePointer(otherJson, "other-ref").stableRef).toBe("other-ref");
    expect(() => parseStablePointer(otherJson)).toThrow(/stableRef must be/);
  });

  test("a malformed versioned tag shape is rejected", () => {
    const { pointerJson } = validTriple();
    for (const bad of [
      "console-snapshot-prod",
      "console-snapshot-prod-20261123T120000Z",
      "console-snapshot-prod-20261123T120000Z-ZZZZ",
      "console-snapshot-prod-261123T120000Z-aabbccddeeff",
      "../etc/passwd",
    ]) {
      const obj = JSON.parse(pointerJson) as Record<string, unknown>;
      obj.versionedTag = bad;
      expect(() => parseStablePointer(JSON.stringify(obj))).toThrow(StablePointerError);
    }
  });

  test("a non-40-hex sourceCommit is rejected", () => {
    const { pointerJson } = validTriple();
    const obj = JSON.parse(pointerJson) as Record<string, unknown>;
    obj.sourceCommit = "123456";
    expect(() => parseStablePointer(JSON.stringify(obj))).toThrow(/sourceCommit must be 40-hex/);
  });

  test("malformed asset digests are rejected", () => {
    const { pointerJson } = validTriple();
    for (const field of ["snapshot", "provenance", "checksum"]) {
      const obj = JSON.parse(pointerJson) as Record<string, unknown>;
      const asset = obj[field] as Record<string, unknown>;
      asset.sha256 = "not-hex";
      expect(() => parseStablePointer(JSON.stringify(obj))).toThrow(/sha256' must be 64-hex/);
      const obj2 = JSON.parse(pointerJson) as Record<string, unknown>;
      (obj2[field] as Record<string, unknown>).byteLength = 0;
      expect(() => parseStablePointer(JSON.stringify(obj2))).toThrow(/byteLength' must be a positive integer/);
      const obj3 = JSON.parse(pointerJson) as Record<string, unknown>;
      obj3[field] = { name: asset.name, sha256: asset.sha256, byteLength: asset.byteLength, extra: 1 };
      expect(() => parseStablePointer(JSON.stringify(obj3))).toThrow(/unexpected key set/);
      const obj4 = JSON.parse(pointerJson) as Record<string, unknown>;
      (obj4[field] as Record<string, unknown>).name = "other.json";
      expect(() => parseStablePointer(JSON.stringify(obj4))).toThrow(new RegExp(`${field}\\.name' must be`));
    }
  });

  test("previous* fields must be both null or both set, and well-formed", () => {
    const { pointerJson } = validTriple();
    const obj = JSON.parse(pointerJson) as Record<string, unknown>;
    obj.previousVersionedTag = TAG;
    expect(() => parseStablePointer(JSON.stringify(obj))).toThrow(/both null or both set/);
    const obj2 = JSON.parse(pointerJson) as Record<string, unknown>;
    obj2.previousTagObjectSha = TAG_OBJECT_SHA;
    expect(() => parseStablePointer(JSON.stringify(obj2))).toThrow(/both null or both set/);
    const obj3 = JSON.parse(pointerJson) as Record<string, unknown>;
    obj3.previousVersionedTag = "garbage-tag";
    obj3.previousTagObjectSha = TAG_OBJECT_SHA;
    expect(() => parseStablePointer(JSON.stringify(obj3))).toThrow(StablePointerError);
    const obj4 = JSON.parse(pointerJson) as Record<string, unknown>;
    obj4.previousVersionedTag = TAG;
    obj4.previousTagObjectSha = "xyz";
    expect(() => parseStablePointer(JSON.stringify(obj4))).toThrow(/previousTagObjectSha must be 40-hex or null/);
    const obj5 = JSON.parse(pointerJson) as Record<string, unknown>;
    obj5.previousVersionedTag = TAG;
    obj5.previousTagObjectSha = TAG_OBJECT_SHA;
    expect(parseStablePointer(JSON.stringify(obj5)).previousVersionedTag).toBe(TAG);
  });
});

// ─── Provenance sidecar parsing ────────────────────────────────────────────────

describe("provenance sidecar parsing", () => {
  test("a well-formed sidecar parses", () => {
    const { provenanceBytes } = validTriple();
    const p = parsePublicationProvenance(provenanceBytes);
    expect(p.versionedTag).toBe(TAG);
    expect(p.indexerSourceCommitSha).toBe(COMMIT);
    expect(p.counts.enriched).toBe(2);
  });

  test("an unexpected key set is rejected", () => {
    const { provenanceBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    obj.extra = true;
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    expect(() => parsePublicationProvenance(bytes)).toThrow(/unexpected key set/);
  });

  test("missing or malformed counts are rejected", () => {
    const { provenanceBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    delete (obj.counts as Record<string, unknown>).enriched;
    expect(() => parsePublicationProvenance(new TextEncoder().encode(JSON.stringify(obj)))).toThrow(/counts\.enriched/);
    const obj2 = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    (obj2.counts as Record<string, unknown>).enriched = 1.5;
    expect(() => parsePublicationProvenance(new TextEncoder().encode(JSON.stringify(obj2)))).toThrow(/counts\.enriched/);
  });

  test("non-JSON sidecar bytes are rejected", () => {
    expect(() => parsePublicationProvenance(new TextEncoder().encode("nope"))).toThrow(StablePointerError);
  });
});

// ─── Pointer ↔ artifact verification ──────────────────────────────────────────

describe("pointer ↔ artifact verification", () => {
  test("a valid triple verifies", () => {
    const { pointer, snapshotBytes, provenanceBytes, checksumBytes } = validTriple();
    verifyStablePointerMatchesArtifacts({
      pointer,
      snapshotBytes,
      provenanceBytes,
      checksumBytes,
      provenance: parsePublicationProvenance(provenanceBytes),
    });
  });

  test("a snapshot digest mismatch is a hard failure", () => {
    const { pointer, provenanceBytes, checksumBytes } = validTriple();
    // Same byte length, different bytes: in-place same-length value edit.
    const tampered = artifactBytes((snap) => {
      snap.cluster = "mainnet-betX"; // same length as "mainnet-beta"
    });
    expect(tampered.byteLength).toBe(pointer.snapshot.byteLength);
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes: tampered,
        provenanceBytes,
        checksumBytes,
        provenance: parsePublicationProvenance(provenanceBytes),
      }),
    ).toThrow(/snapshot digest\/length mismatch/);
  });

  test("a byte-length mismatch is a hard failure", () => {
    const { pointer, snapshotBytes, provenanceBytes, checksumBytes } = validTriple();
    const truncated = snapshotBytes.slice(0, snapshotBytes.byteLength - 1);
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes: truncated,
        provenanceBytes,
        checksumBytes,
        provenance: parsePublicationProvenance(provenanceBytes),
      }),
    ).toThrow(/snapshot digest\/length mismatch/);
  });

  test("a tampered provenance sidecar fails its pointer digest", () => {
    const { pointer, snapshotBytes, provenanceBytes, checksumBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    obj.repository = "GraveYield/other";
    const tamperedProvenance = new TextEncoder().encode(JSON.stringify(obj));
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes,
        provenanceBytes: tamperedProvenance,
        checksumBytes,
        provenance: parsePublicationProvenance(tamperedProvenance),
      }),
    ).toThrow(/provenance digest\/length mismatch/);
  });

  test("a checksum asset with wrong content fails", () => {
    const { pointer, snapshotBytes, provenanceBytes } = validTriple();
    // A checksum asset whose DIGEST no longer matches the pointer.
    const badDigest = new TextEncoder().encode(`${"0".repeat(64)}  ${SNAPSHOT_ASSET_NAME}\n`);
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes,
        provenanceBytes,
        checksumBytes: badDigest,
        provenance: parsePublicationProvenance(provenanceBytes),
      }),
    ).toThrow(/checksum digest\/length mismatch/);
    // A checksum asset whose CONTENT names another file (pointer consistent
    // with the renamed asset, so the content check is what fires).
    const badName = new TextEncoder().encode(`${sha256Hex(snapshotBytes)}  other-file.json\n`);
    const { pointer: pointerBadName } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes,
      provenanceBytes,
      checksumBytes: badName,
    });
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer: pointerBadName,
        snapshotBytes,
        provenanceBytes,
        checksumBytes: badName,
        provenance: parsePublicationProvenance(provenanceBytes),
      }),
    ).toThrow(/checksum asset names other-file\.json/);
    // A checksum asset that is not sha256sum-compatible at all.
    const garbage = new TextEncoder().encode("definitely not a checksum line");
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes,
        provenanceBytes,
        checksumBytes: garbage,
        provenance: parsePublicationProvenance(provenanceBytes),
      }),
    ).toThrow(/checksum digest\/length mismatch/);
  });

  test("a provenance naming a DIFFERENT versioned tag is refused", () => {
    const { snapshotBytes, provenanceBytes, checksumBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    obj.versionedTag = "console-snapshot-prod-20260101T000000Z-000000000000";
    const tampered = new TextEncoder().encode(JSON.stringify(obj));
    // The pointer must be consistent with the tampered sidecar bytes, so the
    // SEMANTIC cross-check (not the digest loop) is what fires.
    const { pointer } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes,
      provenanceBytes: tampered,
      checksumBytes,
    });
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes,
        provenanceBytes: tampered,
        checksumBytes,
        provenance: parsePublicationProvenance(tampered),
      }),
    ).toThrow(/cross-release identification/);
  });

  test("a provenance commit mismatch is refused", () => {
    const { snapshotBytes, provenanceBytes, checksumBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    obj.indexerSourceCommitSha = "9999997890abcdef1234567890abcdef12345678";
    const tampered = new TextEncoder().encode(JSON.stringify(obj));
    const { pointer } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes,
      provenanceBytes: tampered,
      checksumBytes,
    });
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes,
        provenanceBytes: tampered,
        checksumBytes,
        provenance: parsePublicationProvenance(tampered),
      }),
    ).toThrow(/does not match the release provenance commit/);
  });

  test("a sidecar whose digest does not describe the snapshot bytes is refused", () => {
    const { snapshotBytes, provenanceBytes, checksumBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    obj.snapshotSha256 = "f".repeat(64);
    const tampered = new TextEncoder().encode(JSON.stringify(obj));
    const { pointer } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes,
      provenanceBytes: tampered,
      checksumBytes,
    });
    expect(() =>
      verifyStablePointerMatchesArtifacts({
        pointer,
        snapshotBytes,
        provenanceBytes: tampered,
        checksumBytes,
        provenance: parsePublicationProvenance(tampered),
      }),
    ).toThrow(/SHA-256 mismatch: sidecar declares/);
  });
});

// ─── Completeness contract ─────────────────────────────────────────────────────

describe("independent completeness contract", () => {
  test("a valid complete artifact passes", () => {
    const { snapshotBytes, provenanceBytes } = validTriple();
    verifyRawArtifactCompleteness(JSON.parse(new TextDecoder().decode(snapshotBytes)), parsePublicationProvenance(provenanceBytes));
  });

  test("a discovery-completeness failure marker is rejected", () => {
    const { snapshotBytes, provenanceBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(snapshotBytes)) as Record<string, unknown>;
    (obj.failures as unknown[]).push({ stage: "discovery-completeness", reason: "probe aborted" });
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    expect(() =>
      verifyRawArtifactCompleteness(JSON.parse(new TextDecoder().decode(bytes)), parsePublicationProvenance(provenanceBytes)),
    ).toThrow(/discovery-completeness/);
  });

  test("an enrichment-completeness failure marker is rejected", () => {
    const { snapshotBytes, provenanceBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(snapshotBytes)) as Record<string, unknown>;
    (obj.failures as unknown[]).push({ stage: "enrichment-completeness", reason: "enrichment aborted" });
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    expect(() =>
      verifyRawArtifactCompleteness(JSON.parse(new TextDecoder().decode(bytes)), parsePublicationProvenance(provenanceBytes)),
    ).toThrow(/enrichment-completeness/);
  });

  test("a missing failures array fails closed", () => {
    const { snapshotBytes, provenanceBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(snapshotBytes)) as Record<string, unknown>;
    delete obj.failures;
    expect(() =>
      verifyRawArtifactCompleteness(obj, parsePublicationProvenance(provenanceBytes)),
    ).toThrow(/no failures array/);
  });

  test("an enriched-count contradiction between artifact and sidecar fails", () => {
    const { snapshotBytes, provenanceBytes } = validTriple();
    const obj = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
    (obj.counts as Record<string, unknown>).enriched = 3;
    expect(() =>
      verifyRawArtifactCompleteness(JSON.parse(new TextDecoder().decode(snapshotBytes)), parsePublicationProvenance(new TextEncoder().encode(JSON.stringify(obj)))),
    ).toThrow(/does not describe these bytes/);
  });

  test("an empty publication (zero enriched pools) is never endorsed", () => {
    const snapshotBytes = artifactBytes((snap) => {
      (snap.counts as Record<string, unknown>).enriched = 0;
    });
    const provenanceBytes = provenanceBytesFor(snapshotBytes);
    expect(() =>
      verifyRawArtifactCompleteness(JSON.parse(new TextDecoder().decode(snapshotBytes)), parsePublicationProvenance(provenanceBytes)),
    ).toThrow(/zero enriched pools/);
  });
});
