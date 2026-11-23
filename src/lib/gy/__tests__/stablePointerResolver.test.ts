// Stable-pointer RESOLVER end-to-end battery — every external GitHub
// interaction is mocked (fetchImpl); no network, no credentials.
//
// Exercises the full production resolution chain of
// stablePointerResolver.resolveSnapshotViaStablePointer (and the
// resolveSnapshotArtifact source dispatcher) against the 18 failure /
// success scenarios the M1 brief requires:
//
//   1.  valid pointer → full chain succeeds, schema-v2 payload served
//   2.  missing stable reference (HTTP 404)
//   3.  stable ref pointing at a lightweight tag (object type ≠ "tag")
//   4.  annotated tag retrieval failure (HTTP 404)
//   5.  tag-object response does not identify the requested sha
//   6.  malformed pointer JSON in the tag message
//   7.  unsupported pointer schema discriminator
//   8.  pointer stableRef binding violation
//   9.  annotated tag target type ≠ "commit"
//   10. annotated tag target sha ≠ pointer.sourceCommit
//   11. versioned release asset missing (HTTP 404)
//   12. asset digest mismatch (tampered bytes, same length)
//   13. asset byte-length mismatch (pointer lies about the length)
//   14. checksum asset content violation
//   15. provenance sidecar names a different versioned tag
//   16. malformed snapshot JSON asset
//   17. snapshot rejected by the fail-closed schema-v2 parser
//   18. incomplete artifact (discovery/enrichment-completeness marker)
//   19. request timeout (AbortError) → typed network failure
//   20. rate limit / 5xx → typed transport failure at the named stage
//   21. assets are fetched from the VERSIONED release path — never
//       /releases/latest/download/... (and resolution succeeds even when
//       a different release carries the repo-wide latest designation)
//   22. stale artifact is served flagged, never as fresh
//   23. dispatcher: stable-pointer + legacy source is a SOURCE_CONFLICT
//   24. dispatcher: legacy GY_SNAPSHOT_URL passthrough unchanged
//   25. dispatcher: no source configured → NO_SOURCE_CONFIGURED
//   26. bounded GitHub API JSON responses: under-cap accepted, exactly-at-cap
//       boundary accepted, over-cap rejected with typed OVERSIZE before the
//       pointer is resolved, no silent truncation, HTTP-status precedence,
//       unchanged non-JSON typing, custom cap wiring
//   27. response cancellation on bounded-read rejection: declared-length
//       rejection cancels the body (API + asset paths), streamed-overflow
//       cancellation is awaited, hostile cancel() rejections never mask the
//       typed failure
//
// Mirrors the fixture approach of stablePointer.test.ts: the bytes are
// derived from the committed producer fixture (src/lib/gy/snapshot.json).

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import {
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  STABLE_REF_DEFAULT,
  buildStablePointer,
  sha256Hex,
  type PublicationProvenance,
} from "../stablePointer";
import {
  DEFAULT_MAX_JSON_BYTES,
  resolveSnapshotArtifact,
  resolveSnapshotViaStablePointer,
  type StablePointerResolverDeps,
  type StablePointerResolverEnv,
} from "../stablePointerResolver";
import type { SnapshotResolverStage, SnapshotTransportPayload, TransportReasonCode } from "../snapshotTransport";
import { RAW_SNAPSHOT } from "../snapshot";

const NOW = 1_800_000_000_000;
const TAG = "console-snapshot-prod-20261123T120000Z-aabbccddeeff";
const OTHER_TAG = "console-snapshot-prod-20261120T090000Z-001122334455";
const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const TAG_OBJECT_SHA = "fedcba0987654321fedcba0987654321fedcba09";
const REPO = "GraveYield/grave-indexer";
const API_BASE = "https://api.github.com.test";
const ASSETS_BASE = "https://github.com.test";

const REF_URL = `${API_BASE}/repos/${REPO}/git/ref/tags/${STABLE_REF_DEFAULT}`;
const TAG_URL = `${API_BASE}/repos/${REPO}/git/tags/${TAG_OBJECT_SHA}`;
const assetUrl = (tag: string, name: string) =>
  `${ASSETS_BASE}/${REPO}/releases/download/${tag}/${name}`;

// ─── Fixture builders (byte-consistent triple, as the producer emits it) ────

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

function provenanceBytesFor(
  snapshotBytes: Uint8Array,
  overrides: (p: Record<string, unknown>) => void = () => {},
): Uint8Array {
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
    workflowRunId: "run-42",
    workflowAttempt: "1",
    repository: REPO,
    versionedTag: TAG,
  };
  overrides(provenance as unknown as Record<string, unknown>);
  return new TextEncoder().encode(JSON.stringify(provenance));
}

function checksumBytesFor(snapshotBytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`${sha256Hex(snapshotBytes)}  ${SNAPSHOT_ASSET_NAME}\n`);
}

/** Build a fully consistent pointer + the three asset byte strings. */
function validTriple(overrides?: {
  snapshot?: (snap: Record<string, unknown>) => void;
  provenance?: (p: Record<string, unknown>) => void;
}) {
  const snapshotBytes = artifactBytes(overrides?.snapshot);
  const provenanceBytes = provenanceBytesFor(snapshotBytes, overrides?.provenance);
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

// ─── Mock GitHub transport ─────────────────────────────────────────────────────

interface MockRoute {
  /** URL prefix matched exactly; first match wins. */
  url: string;
  status?: number;
  body?: Uint8Array | string | object;
  headers?: Record<string, string>;
  /** When set, fetch rejects with this error instead of answering. */
  throw?: Error;
  /** When set, fetch answers with this pre-built Response verbatim (raw streams, declared headers). */
  raw?: Response;
}

function jsonResponse(body: object | string, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

/** A mocked fetch that records every requested URL and answers from routes. */
function mockFetch(routes: MockRoute[]) {
  const requested: string[] = [];
  const impl = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    const route = routes.find((r) => url === r.url);
    if (!route) throw new Error(`mock fetch: no route for ${url}`);
    if (route.throw) throw route.throw;
    if (route.raw) return route.raw;
    if (route.status !== undefined && route.status !== 200) {
      // Non-200 answers may still carry a (potentially large) body — the
      // resolver must classify by STATUS before it ever reads the body.
      const errBody =
        route.body === undefined
          ? "mock error body"
          : typeof route.body === "string"
            ? route.body
            : JSON.stringify(route.body);
      return new Response(errBody, { status: route.status });
    }
    const body = route.body;
    if (typeof body === "string") return jsonResponse(body, route.status ?? 200);
    if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
      return jsonResponse(body, route.status ?? 200);
    }
    return bytesResponse(body as Uint8Array);
  }) as typeof fetch;
  return { impl, requested };
}

function refPayload(type: string, sha: string) {
  return { ref: `refs/tags/${STABLE_REF_DEFAULT}`, node_id: "n1", url: REF_URL, object: { sha, type } };
}

function tagPayload(message: string, targetType: string, targetSha: string) {
  return {
    node_id: "n2",
    url: TAG_URL,
    tag: STABLE_REF_DEFAULT,
    sha: TAG_OBJECT_SHA,
    object: { sha: targetSha, type: targetType },
    message,
    tagger: { name: "publisher", email: "pub@graveyield", date: "2026-11-23T12:00:00Z" },
    verification: { verified: false, reason: "unsigned" },
  };
}

/** Routes serving a complete, valid publication. */
function validRoutes(triple = validTriple(), tagMessage?: string): MockRoute[] {
  const routes: MockRoute[] = [
    { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
    { url: TAG_URL, body: tagPayload(tagMessage ?? triple.pointerJson, "commit", COMMIT) },
    { url: assetUrl(TAG, SNAPSHOT_ASSET_NAME), body: triple.snapshotBytes },
    { url: assetUrl(TAG, PROVENANCE_ASSET_NAME), body: triple.provenanceBytes },
    { url: assetUrl(TAG, CHECKSUM_ASSET_NAME), body: triple.checksumBytes },
  ];
  return routes;
}

function deps(fetchImpl: typeof fetch, extra?: Partial<StablePointerResolverDeps>): StablePointerResolverDeps {
  return { nowMs: NOW, fetchImpl, ...extra };
}

/** Dispatcher deps: the legacy topologies require fs injection (never used by the resolver path). */
function dispatchDeps(fetchImpl: typeof fetch): Parameters<typeof resolveSnapshotArtifact>[1] {
  return {
    ...deps(fetchImpl),
    readFile: async () => {
      throw new Error("readFile must not be called in these tests");
    },
    statSize: async () => {
      throw new Error("statSize must not be called in these tests");
    },
  };
}

function env(extra?: Partial<StablePointerResolverEnv>): StablePointerResolverEnv {
  return {
    GY_SNAPSHOT_GITHUB_REPO: REPO,
    GY_SNAPSHOT_GITHUB_API_BASE: API_BASE,
    GY_SNAPSHOT_GITHUB_ASSETS_BASE: ASSETS_BASE,
    ...extra,
  };
}

/** Standard failure assertions: the envelope is typed, explicit and serves no snapshot. */
function expectUnavailable(
  payload: SnapshotTransportPayload,
  expected: {
    artifactState: "missing" | "corrupt";
    reasonCode: TransportReasonCode;
    stage?: SnapshotResolverStage;
  },
) {
  expect(payload.artifactState).toBe(expected.artifactState);
  expect(payload.dataState).toBe("unavailable");
  expect(payload.reasonCode).toBe(expected.reasonCode);
  // Dispatcher/legacy envelopes may carry no resolver stage; the resolver
  // chain failures always name one.
  if (expected.stage !== undefined) {
    expect(payload.resolverStage).toBe(expected.stage);
  } else {
    expect(payload.resolverStage ?? null).toBeFalsy();
  }
  expect(payload.snapshot).toBeNull();
}

// ─── 1. Valid pointer ────────────────────────────────────────────────────────

describe("resolver success path", () => {
  test("a valid pointer resolves the full chain and serves a verified schema-v2 snapshot", async () => {
    const { impl, requested } = mockFetch(validRoutes());
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));

    expect(payload.artifactState).toBe("valid");
    expect(payload.dataState).toBe("real");
    expect(payload.reasonCode).toBeNull();
    expect(payload.resolverStage).toBeNull();
    expect(payload.snapshot).not.toBeNull();
    expect(payload.snapshot?.schemaVersion).toBe(2);
    expect(payload.source.kind).toBe("stable-pointer");
    // The exact production chain, in order: ref → tag object → assets.
    expect(requested[0]).toBe(REF_URL);
    expect(requested[1]).toBe(TAG_URL);
    expect(requested.slice(2)).toEqual([
      assetUrl(TAG, SNAPSHOT_ASSET_NAME),
      assetUrl(TAG, PROVENANCE_ASSET_NAME),
      assetUrl(TAG, CHECKSUM_ASSET_NAME),
    ]);
  });

  test("a stale (over-freshness-budget) artifact is served flagged, never as fresh", async () => {
    const triple = validTriple({
      snapshot: (snap) => {
        const maxAge = (snap.freshness as { maxAgeMs: number }).maxAgeMs;
        snap.generatedAtUnixMs = NOW - maxAge - 60_000;
      },
    });
    // Rebuild provenance so the sidecar still describes the stale bytes.
    const provenanceBytes = provenanceBytesFor(triple.snapshotBytes);
    const checksumBytes = checksumBytesFor(triple.snapshotBytes);
    const { pointerJson } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes: triple.snapshotBytes,
      provenanceBytes,
      checksumBytes,
    });
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(pointerJson, "commit", COMMIT) },
      { url: assetUrl(TAG, SNAPSHOT_ASSET_NAME), body: triple.snapshotBytes },
      { url: assetUrl(TAG, PROVENANCE_ASSET_NAME), body: provenanceBytes },
      { url: assetUrl(TAG, CHECKSUM_ASSET_NAME), body: checksumBytes },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));

    expect(payload.artifactState).toBe("stale");
    expect(payload.dataState).toBe("stale");
    expect(payload.snapshot).not.toBeNull();
    expect(payload.reasonCode).toBeNull();
    expect(payload.resolverStage).toBeNull();
    expect(payload.reason).not.toBeNull();
  });
});

// ─── 2–5. Stable reference and annotated tag failures ───────────────────────

describe("stable-reference and annotated-tag failures", () => {
  test("a missing stable reference (HTTP 404) is a typed missing/stable-ref failure", async () => {
    const { impl } = mockFetch([{ url: REF_URL, status: 404 }]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_HTTP_STATUS", stage: "stable-ref" });
    expect(payload.reason).toContain("404");
  });

  test("a stable ref pointing at a lightweight tag (type commit) is refused", async () => {
    const { impl } = mockFetch([
      { url: REF_URL, body: refPayload("commit", COMMIT) },
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "annotated-tag" });
    expect(payload.reason).toContain("ANNOTATED");
  });

  test("an annotated tag retrieval failure (HTTP 404) is a typed failure", async () => {
    const { impl } = mockFetch([
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, status: 404 },
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_HTTP_STATUS", stage: "annotated-tag" });
  });

  test("a tag-object response that does not identify the requested sha is refused", async () => {
    const triple = validTriple();
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      {
        url: TAG_URL,
        body: { ...tagPayload(triple.pointerJson, "commit", COMMIT), sha: "0000000000000000000000000000000000000000" },
      },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "annotated-tag" });
    expect(payload.reason).toContain("requested object sha");
  });
});

// ─── 6–8. Pointer parse / validation failures ───────────────────────────────

describe("pointer parse and validation failures", () => {
  test("malformed pointer JSON is a pointer-parse failure", async () => {
    const { impl } = mockFetch(validRoutes(validTriple(), "{not json at all"));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "pointer-parse" });
  });

  test("an unsupported pointer schema discriminator is a pointer-validate failure", async () => {
    const triple = validTriple();
    const badPointer = JSON.stringify({ ...JSON.parse(triple.pointerJson), pointerSchema: "graveyield.other.v9" });
    const { impl } = mockFetch(validRoutes(triple, badPointer));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "pointer-validate" });
    expect(payload.reason).toContain("pointerSchema");
  });

  test("a pointer bound to a different stableRef is refused", async () => {
    const triple = validTriple();
    const badPointer = JSON.stringify({ ...JSON.parse(triple.pointerJson), stableRef: "some-other-ref" });
    const { impl } = mockFetch(validRoutes(triple, badPointer));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "pointer-validate" });
    expect(payload.reason).toContain("stableRef");
  });
});

// ─── 9–10. Annotated-tag target identity ────────────────────────────────────

describe("annotated-tag target identity", () => {
  test("a tag object targeting a non-commit type is refused", async () => {
    const triple = validTriple();
    const { impl } = mockFetch([
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(triple.pointerJson, "tree", COMMIT) },
      ...validRoutes(triple).slice(2),
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "annotated-tag" });
    expect(payload.reason).toContain('"commit"');
  });

  test("a tag object targeting a DIFFERENT commit than the pointer claims is refused", async () => {
    const triple = validTriple();
    const otherCommit = "aabbccddaabbccddaabbccddaabbccddaabbccdd";
    const { impl } = mockFetch([
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(triple.pointerJson, "commit", otherCommit) },
      ...validRoutes(triple).slice(2),
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "annotated-tag" });
    expect(payload.reason).toContain("sourceCommit");
  });
});

// ─── 11–15. Versioned asset retrieval and integrity ─────────────────────────

describe("versioned asset retrieval and integrity", () => {
  test("a missing versioned-release asset (HTTP 404) is a typed asset-fetch failure", async () => {
    const triple = validTriple();
    const routes = validRoutes(triple).filter((r) => r.url !== assetUrl(TAG, SNAPSHOT_ASSET_NAME));
    routes.push({ url: assetUrl(TAG, SNAPSHOT_ASSET_NAME), status: 404 });
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_HTTP_STATUS", stage: "asset-fetch" });
    expect(payload.reason).toContain(SNAPSHOT_ASSET_NAME);
  });

  test("a snapshot digest mismatch (tampered bytes, same length) is an asset-integrity failure", async () => {
    const triple = validTriple();
    const tampered = new Uint8Array(triple.snapshotBytes);
    tampered[0] = tampered[0] ^ 0x01; // same length, different bytes
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(triple.pointerJson, "commit", COMMIT) },
      { url: assetUrl(TAG, SNAPSHOT_ASSET_NAME), body: tampered },
      { url: assetUrl(TAG, PROVENANCE_ASSET_NAME), body: triple.provenanceBytes },
      { url: assetUrl(TAG, CHECKSUM_ASSET_NAME), body: triple.checksumBytes },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "asset-integrity" });
    expect(payload.reason).toContain("mismatch");
  });

  test("a byte-length mismatch (pointer lies about the length) is refused", async () => {
    const triple = validTriple();
    const badPointer = JSON.stringify({
      ...JSON.parse(triple.pointerJson),
      snapshot: { ...JSON.parse(triple.pointerJson).snapshot, byteLength: triple.snapshotBytes.byteLength + 1 },
    });
    const { impl } = mockFetch(validRoutes(triple, badPointer));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "asset-integrity" });
  });

  test("a checksum asset that does not describe the snapshot bytes is refused", async () => {
    const triple = validTriple();
    const bogusChecksum = new TextEncoder().encode(`${"0".repeat(64)}  ${SNAPSHOT_ASSET_NAME}\n`);
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(triple.pointerJson, "commit", COMMIT) },
      { url: assetUrl(TAG, SNAPSHOT_ASSET_NAME), body: triple.snapshotBytes },
      { url: assetUrl(TAG, PROVENANCE_ASSET_NAME), body: triple.provenanceBytes },
      { url: assetUrl(TAG, CHECKSUM_ASSET_NAME), body: bogusChecksum },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "asset-integrity" });
    expect(payload.reason).toContain("checksum");
  });

  test("a provenance sidecar naming a DIFFERENT versioned tag is refused", async () => {
    const triple = validTriple({
      provenance: (p) => {
        p.versionedTag = OTHER_TAG;
      },
    });
    const { impl } = mockFetch(validRoutes(triple));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "asset-integrity" });
    expect(payload.reason).toContain("cross-release");
  });
});

// ─── 16–18. Snapshot payload validation ─────────────────────────────────────

describe("snapshot payload validation", () => {
  test("a malformed snapshot JSON asset is a snapshot-schema failure", async () => {
    // The pointer digests are built over the MALFORMED bytes so the failure
    // lands past integrity (a consistently published corrupt release), and
    // the provenance sidecar remains shape-valid — its digest fields are
    // overridden to describe the malformed bytes exactly.
    const malformed = new TextEncoder().encode("{ truncated json");
    const provenanceBytes = provenanceBytesFor(artifactBytes(), (p) => {
      p.snapshotSha256 = sha256Hex(malformed);
      p.snapshotByteLength = malformed.byteLength;
    });
    const checksumBytes = checksumBytesFor(malformed);
    const { pointerJson } = buildStablePointer({
      versionedTag: TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes: malformed,
      provenanceBytes,
      checksumBytes,
    });
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(pointerJson, "commit", COMMIT) },
      { url: assetUrl(TAG, SNAPSHOT_ASSET_NAME), body: malformed },
      { url: assetUrl(TAG, PROVENANCE_ASSET_NAME), body: provenanceBytes },
      { url: assetUrl(TAG, CHECKSUM_ASSET_NAME), body: checksumBytes },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "snapshot-schema" });
  });

  test("a complete artifact rejected by the fail-closed schema-v2 parser is a snapshot-schema failure", async () => {
    const triple = validTriple({
      snapshot: (snap) => {
        (snap as Record<string, unknown>).schemaVersion = 3; // unsupported schema version
      },
    });
    const { impl } = mockFetch(validRoutes(triple));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "snapshot-schema" });
    expect(payload.reason).toContain("schemaVersion");
  });

  test("an artifact carrying a discovery-completeness failure marker is refused", async () => {
    const triple = validTriple({
      snapshot: (snap) => {
        (snap.failures as unknown[]).push({ stage: "discovery-completeness", reason: "injected in test" });
      },
    });
    const { impl } = mockFetch(validRoutes(triple));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "completeness" });
    expect(payload.reason).toContain("discovery-completeness");
  });

  test("an artifact whose enriched count contradicts its sidecar is refused", async () => {
    const triple = validTriple({
      provenance: (p) => {
        (p.counts as Record<string, number>).enriched = 99;
      },
    });
    const { impl } = mockFetch(validRoutes(triple));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "completeness" });
    expect(payload.reason).toContain("claims 99");
  });

  test("an empty publication (zero enriched pools) is never served", async () => {
    const triple = validTriple({
      snapshot: (snap) => {
        (snap as Record<string, unknown>).pools = [];
        ((snap as Record<string, unknown>).counts as Record<string, number>).enriched = 0;
      },
      provenance: (p) => {
        (p.counts as Record<string, number>).enriched = 0;
      },
    });
    const { impl } = mockFetch(validRoutes(triple));
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "completeness" });
  });
});

// ─── 19–20. Network, timeout, rate limit ────────────────────────────────────

describe("network, timeout and upstream failures", () => {
  test("a timed-out stable-ref request is a typed missing/network failure", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "AbortError";
    const { impl } = mockFetch([{ url: REF_URL, throw: abort }]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_FAILED", stage: "network" });
    expect(payload.reason).toContain("timed out");
  });

  test("a network-level failure on an asset fetch is typed at asset-fetch", async () => {
    const triple = validTriple();
    const routes = validRoutes(triple).map((r) =>
      r.url === assetUrl(TAG, SNAPSHOT_ASSET_NAME) ? { ...r, throw: new Error("ECONNRESET") } : r,
    );
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_FAILED", stage: "asset-fetch" });
  });

  test("a rate-limited API answer (HTTP 403) is a typed transport failure naming the stage", async () => {
    const { impl } = mockFetch([{ url: REF_URL, status: 403 }]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_HTTP_STATUS", stage: "stable-ref" });
    expect(payload.reason).toContain("rate limit");
  });

  test("an upstream outage (HTTP 500) is a typed transport failure, never a fallback", async () => {
    const { impl } = mockFetch([{ url: REF_URL, status: 500 }]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_HTTP_STATUS", stage: "stable-ref" });
    expect(payload.reason).toContain("500");
  });
});

// ─── 21. Versioned-release discipline ───────────────────────────────────────

describe("versioned-release discipline", () => {
  test("assets are fetched from the pointer's versioned tag path — never releases/latest", async () => {
    const { impl, requested } = mockFetch(validRoutes());
    await resolveSnapshotViaStablePointer(env(), deps(impl));
    for (const url of requested) {
      expect(url).not.toContain("/releases/latest");
    }
    expect(requested.filter((u) => u.includes("/releases/download/")).length).toBe(3);
  });

  test("a pointer to an OLDER versioned release resolves from THAT release's assets", async () => {
    // Simulate a rollback pointer: the versioned tag is the previous one,
    // and (unrelatedly) some other release carries the repo-wide latest
    // designation — which must be irrelevant to resolution.
    const snapshotBytes = artifactBytes();
    const provenanceBytes = provenanceBytesFor(snapshotBytes, (p) => {
      p.versionedTag = OTHER_TAG;
    });
    const checksumBytes = checksumBytesFor(snapshotBytes);
    const { pointerJson } = buildStablePointer({
      versionedTag: OTHER_TAG,
      sourceCommit: COMMIT,
      publishedAtUnixMs: NOW,
      snapshotBytes,
      provenanceBytes,
      checksumBytes,
    });
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(pointerJson, "commit", COMMIT) },
      { url: assetUrl(OTHER_TAG, SNAPSHOT_ASSET_NAME), body: snapshotBytes },
      { url: assetUrl(OTHER_TAG, PROVENANCE_ASSET_NAME), body: provenanceBytes },
      { url: assetUrl(OTHER_TAG, CHECKSUM_ASSET_NAME), body: checksumBytes },
    ];
    const { impl, requested } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));

    expect(payload.artifactState).toBe("valid");
    expect(requested.filter((u) => u.includes(`/releases/download/${OTHER_TAG}/`)).length).toBe(3);
    expect(requested.some((u) => u.includes(TAG))).toBe(false);
  });
});

// ─── 22–25. Source dispatcher (resolveSnapshotArtifact) ─────────────────────

describe("source dispatcher", () => {
  test("configuring the stable-pointer source AND a legacy source is a SOURCE_CONFLICT", async () => {
    const { impl, requested } = mockFetch([]);
    const payload = await resolveSnapshotArtifact(
      env({ GY_SNAPSHOT_URL: "https://artifacts.example/gy/console-snapshot.json" }),
      dispatchDeps(impl),
    );
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "SOURCE_CONFLICT", stage: "stable-ref" });
    expect(requested.length).toBe(0); // refuses to guess — no fetch at all
  });

  test("a legacy GY_SNAPSHOT_URL configuration still resolves through the unchanged legacy source", async () => {
    const triple = validTriple();
    const { impl, requested } = mockFetch([
      { url: "https://artifacts.example/gy/console-snapshot.json", body: triple.snapshotBytes },
    ]);
    const payload = await resolveSnapshotArtifact(
      env({ GY_SNAPSHOT_GITHUB_REPO: null, GY_SNAPSHOT_URL: "https://artifacts.example/gy/console-snapshot.json" }),
      dispatchDeps(impl),
    );
    expect(payload.artifactState).toBe("valid");
    expect(payload.source.kind).toBe("url");
    expect(requested.length).toBe(1); // single GET — no GitHub API interaction
  });

  test("no source configuration answers NO_SOURCE_CONFIGURED", async () => {
    const { impl } = mockFetch([]);
    const payload = await resolveSnapshotArtifact(env({ GY_SNAPSHOT_GITHUB_REPO: null }), dispatchDeps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "NO_SOURCE_CONFIGURED" });
    expect(payload.source.kind).toBe("none");
  });

  test("a repository slug that is not owner/repo is refused before any fetch", async () => {
    const { impl, requested } = mockFetch([]);
    const payload = await resolveSnapshotViaStablePointer(
      env({ GY_SNAPSHOT_GITHUB_REPO: "not-a-repo-slug" }),
      deps(impl),
    );
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "PARSE_FAILED", stage: "stable-ref" });
    expect(requested.length).toBe(0);
  });
});

// ─── 26. Bounded GitHub API JSON responses ──────────────────────────
//
// Every test here drives the REAL helper path (streamed byte-counted read →
// JSON parse → resolver chain) over the mocked transport — none of them
// merely asserts a constant. The documented cap is DEFAULT_MAX_JSON_BYTES
// (1 MiB, inclusive: bodies AT the cap are accepted, bodies OVER it are
// cancelled and rejected before any parsing).

/** An annotated-tag payload whose serialized JSON body is EXACTLY `targetBytes` bytes. */
function tagPayloadPaddedToExactBytes(message: string, targetBytes: number): object {
  const enc = new TextEncoder();
  const base = { ...tagPayload(message, "commit", COMMIT), response_pad: "" };
  const baseLen = enc.encode(JSON.stringify(base)).byteLength;
  const padLen = targetBytes - baseLen;
  if (padLen < 0) throw new Error(`cannot pad a ${baseLen}-byte payload down to ${targetBytes} bytes`);
  // The pad value is ASCII and JSON-serializes 1:1, so the body is exactly targetBytes.
  return { ...tagPayload(message, "commit", COMMIT), response_pad: "x".repeat(padLen) };
}

describe("bounded GitHub API JSON responses", () => {
  test("a normal JSON response under the cap is accepted (helper path exercised end-to-end)", async () => {
    const { impl, requested } = mockFetch(validRoutes());
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expect(payload.artifactState).toBe("valid");
    expect(payload.snapshot).not.toBeNull();
    expect(requested.length).toBe(5); // ref + tag + three assets — the JSON reads succeeded
  });

  test("a response of EXACTLY the documented cap is accepted (the boundary is inclusive)", async () => {
    const triple = validTriple();
    const padded = tagPayloadPaddedToExactBytes(triple.pointerJson, DEFAULT_MAX_JSON_BYTES);
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: padded },
      ...validRoutes(triple).slice(2),
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expect(payload.artifactState).toBe("valid");
    expect(payload.snapshot).not.toBeNull();
    expect(payload.reasonCode).toBeNull();
  });

  test("a response one byte over the cap is rejected with a typed OVERSIZE failure", async () => {
    const triple = validTriple();
    const over = tagPayloadPaddedToExactBytes(triple.pointerJson, DEFAULT_MAX_JSON_BYTES + 1);
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: over },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "annotated-tag" });
    expect(payload.reason).toContain("cap");
  });

  test("an oversized annotated-tag response carrying a VALID pointer is refused BEFORE pointer resolution", async () => {
    const triple = validTriple();
    // The message itself is a perfectly valid pointer — only the response
    // size disqualifies it, so any acceptance would prove the cap is a no-op.
    const over = tagPayloadPaddedToExactBytes(triple.pointerJson, DEFAULT_MAX_JSON_BYTES + 1024);
    const { impl, requested } = mockFetch([
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: over },
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "annotated-tag" });
    // The chain stopped before pointer resolution: no versioned asset fetch.
    expect(requested.filter((u) => u.includes("/releases/download/")).length).toBe(0);
    expect(payload.snapshot).toBeNull();
  });

  test("an over-cap response is rejected BEFORE parsing even when the body is not JSON at all", async () => {
    // If the implementation truncated and parsed, this body's prefix could
    // still be handed to a parser; instead the cap must fire first and the
    // error must name the refusal explicitly — no silent truncation.
    const { impl } = mockFetch([
      { url: REF_URL, body: "x".repeat(DEFAULT_MAX_JSON_BYTES + 10) },
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "stable-ref" });
    expect(payload.reason).toContain("refusing to parse a truncated body");
    expect(payload.snapshot).toBeNull();
  });

  test("HTTP error responses keep their typed status handling even with an oversized body", async () => {
    // Status classification happens BEFORE the body is read: a 404 with a
    // huge body is FETCH_HTTP_STATUS, never OVERSIZE.
    const { impl } = mockFetch([
      { url: REF_URL, status: 404, body: "x".repeat(DEFAULT_MAX_JSON_BYTES + 10) },
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_HTTP_STATUS", stage: "stable-ref" });
    expect(payload.reason).toContain("404");
  });

  test("a non-JSON response under the cap still fails with the UNCHANGED not-valid-JSON typing", async () => {
    // The raw body itself is not JSON (under the cap) — the streaming read
    // succeeds, the strict JSON.parse fails, and the failure mapping is
    // unchanged from the pre-cap implementation.
    const { impl } = mockFetch([
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: "{not json at all" },
    ]);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));
    expectUnavailable(payload, { artifactState: "missing", reasonCode: "FETCH_FAILED", stage: "annotated-tag" });
    expect(payload.reason).toContain("not valid JSON");
  });

  test("a custom maxJsonBytes is honored — the cap is configurable and still enforced before parsing", async () => {
    const triple = validTriple();
    const padded = tagPayloadPaddedToExactBytes(triple.pointerJson, 2048); // valid JSON, 2 KB body
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: padded },
      ...validRoutes(triple).slice(2),
    ];
    const { impl, requested } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl, { maxJsonBytes: 1024 }));
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "annotated-tag" });
    expect(requested.filter((u) => u.includes("/releases/download/")).length).toBe(0);
  });
});

// ─── 27. Response cancellation on bounded-read rejection ────────────────────
//
// The bounded-read contract promises that oversized responses are CANCELLED,
// not merely rejected. These tests verify that promise at both rejection
// sites and through both cancellation mechanisms:
//
//   - declared Content-Length over the cap → the (unconsumed) body's
//     stream.cancel() is awaited before the typed OVERSIZE failure
//     propagates (API JSON path and release-asset path);
//   - streamed overflow → reader.cancel() is awaited before the typed
//     OVERSIZE failure propagates;
//   - a hostile stream whose cancel() itself rejects must never mask the
//     typed failure.

/** Build a 200 Response whose body is a stream that records its cancellation. */
function cancellableStreamResponse(opts: {
  chunkCount: number;
  chunkBytes?: number;
  headers?: Record<string, string>;
  onCancel: () => void;
}): Response {
  const chunkBytes = opts.chunkBytes ?? 8;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < opts.chunkCount; i++) {
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x61 + (i % 26)));
      }
      controller.close();
    },
    cancel() {
      opts.onCancel();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json", ...opts.headers } });
}

describe("response cancellation on bounded-read rejection", () => {
  test("a response whose DECLARED Content-Length exceeds the JSON cap has its body cancelled before the typed OVERSIZE failure", async () => {
    let bodyCancelled = false;
    const routes: MockRoute[] = [
      {
        url: REF_URL,
        raw: cancellableStreamResponse({
          chunkCount: 2,
          headers: { "content-length": String(DEFAULT_MAX_JSON_BYTES + 1) },
          onCancel: () => {
            bodyCancelled = true;
          },
        }),
      },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl));

    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "stable-ref" });
    expect(payload.reason).toContain("declares");
    // Cancellation is awaited before the failure propagates: by the time the
    // payload is back, the refused body is already cancelled.
    expect(bodyCancelled).toBe(true);
    expect(payload.snapshot).toBeNull();
  });

  test("a release asset whose DECLARED Content-Length exceeds the transport cap has its body cancelled (asset-fetch stage)", async () => {
    let bodyCancelled = false;
    const triple = validTriple();
    const routes: MockRoute[] = [
      { url: REF_URL, body: refPayload("tag", TAG_OBJECT_SHA) },
      { url: TAG_URL, body: tagPayload(triple.pointerJson, "commit", COMMIT) },
      {
        url: assetUrl(TAG, SNAPSHOT_ASSET_NAME),
        raw: cancellableStreamResponse({
          chunkCount: 2,
          headers: { "content-length": "65" }, // cap is 64 in this test
          onCancel: () => {
            bodyCancelled = true;
          },
        }),
      },
      { url: assetUrl(TAG, PROVENANCE_ASSET_NAME), body: triple.provenanceBytes },
      { url: assetUrl(TAG, CHECKSUM_ASSET_NAME), body: triple.checksumBytes },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl, { maxBytes: 64 }));

    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "asset-fetch" });
    expect(payload.reason).toContain("declares");
    expect(payload.reason).toContain(SNAPSHOT_ASSET_NAME);
    expect(bodyCancelled).toBe(true);
    expect(payload.snapshot).toBeNull();
  });

  test("a STREAMED response overflowing the JSON cap mid-read has its reader cancelled (AND AWAITED) before the typed OVERSIZE failure", async () => {
    // No Content-Length declared — the cap fires during the streamed read
    // (4 chunks × 8 bytes = 32 > 16). The cancel hook resolves
    // ASYNCHRONOUSLY: fire-and-forget cancellation (not awaiting
    // reader.cancel()) would leave the flag unset when the payload returns,
    // so this test fails unless the implementation awaits the cancellation.
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(8).fill(0x61 + i));
        controller.close();
      },
      cancel() {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            streamCancelled = true;
            resolve();
          }, 20);
        });
      },
    });
    const routes: MockRoute[] = [
      {
        url: REF_URL,
        raw: new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl, { maxJsonBytes: 16 }));

    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "stable-ref" });
    expect(payload.reason).toContain("refusing to parse a truncated body");
    expect(streamCancelled).toBe(true);
    expect(payload.snapshot).toBeNull();
  });

  test("a hostile stream whose cancel() REJECTS never masks the typed OVERSIZE failure", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(8).fill(0x62));
        controller.close();
      },
      cancel() {
        return Promise.reject(new Error("cancel refused by hostile stream"));
      },
    });
    const routes: MockRoute[] = [
      {
        url: REF_URL,
        raw: new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      },
    ];
    const { impl } = mockFetch(routes);
    const payload = await resolveSnapshotViaStablePointer(env(), deps(impl, { maxJsonBytes: 16 }));

    // The typed failure still surfaces — cancellation cleanup is best-effort.
    expectUnavailable(payload, { artifactState: "corrupt", reasonCode: "OVERSIZE", stage: "stable-ref" });
    expect(payload.reason).toContain("refusing to parse a truncated body");
    expect(payload.snapshot).toBeNull();
  });
});
