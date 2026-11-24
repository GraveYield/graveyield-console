// Rehearsal-artifact regression battery — the Console ingestion chain
// validated against the REAL publication artifacts of the authorized
// rehearsal run on GraveYield/grave-indexer-pub-rehearsal (workflow
// rehearsal-publication, scenario "happy", run 45335777653, commit
// 988aab1fc47074cb990c6bf49666e784eab8d139).
//
// Unlike the synthetic fixtures in stablePointerResolver.test.ts (derived
// from the committed console fixture), the bytes under testdata/rehearsal/
// are the EXACT artifacts the producer published on the versioned release
//   console-snapshot-prod-20261124T054752Z-988aab1fc470
// with the annotated tag object ce13ea5c05c6fe2e3038bde116c07b54af4da4a2:
//
//   ref-response.json           GET /git/ref/tags/console-snapshot-prod
//   tag-object-response.json    GET /git/tags/ce13ea5c05…  (pointer JSON)
//   console-snapshot.json       release asset (snapshot bytes)
//   console-snapshot-provenance.json  release asset (provenance sidecar)
//   console-snapshot.sha256     release asset (sha256sum line)
//
// The battery is fully OFFLINE: fetchImpl is a local routing mock over
// these captured bytes; no network, no credentials. Every mutation case
// proves fail-closed behavior over the REAL artifact set — a tampered
// snapshot, a missing release asset, a pointer naming a nonexistent
// release, a rebinding to another stable ref, and an upstream 500 (no
// silent fallback to any other artifact).
//
/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveSnapshotArtifact,
  resolveSnapshotViaStablePointer,
  type StablePointerResolverDeps,
  type StablePointerResolverEnv,
} from "../stablePointerResolver";
import {
  CHECKSUM_ASSET_NAME,
  PROVENANCE_ASSET_NAME,
  SNAPSHOT_ASSET_NAME,
  STABLE_REF_DEFAULT,
} from "../stablePointer";

const TESTDATA = fileURLToPath(new URL("./testdata/rehearsal", import.meta.url));

const REPO = "GraveYield/grave-indexer-pub-rehearsal";
const API_BASE = "https://api.github.com";
const ASSETS_BASE = "https://github.com";
const REF_URL = `${API_BASE}/repos/${REPO}/git/ref/tags/${STABLE_REF_DEFAULT}`;
const tagObjectSha = (JSON.parse(readFileSync(`${TESTDATA}/ref-response.json`, "utf8")) as { object: { sha: string } }).object.sha;
const TAG_URL = `${API_BASE}/repos/${REPO}/git/tags/${tagObjectSha}`;
const pointer = JSON.parse(readFileSync(`${TESTDATA}/tag-object-response.json`, "utf8")) as { message: string };
const VERSIONED_TAG = (JSON.parse(pointer.message) as { versionedTag: string }).versionedTag;

const REAL_SNAPSHOT_BYTES = new Uint8Array(readFileSync(`${TESTDATA}/${SNAPSHOT_ASSET_NAME}`));
const REAL_PROVENANCE_BYTES = new Uint8Array(readFileSync(`${TESTDATA}/${PROVENANCE_ASSET_NAME}`));
const REAL_CHECKSUM_BYTES = new Uint8Array(readFileSync(`${TESTDATA}/${CHECKSUM_ASSET_NAME}`));

const assetUrl = (tag: string, name: string) => `${ASSETS_BASE}/${REPO}/releases/download/${tag}/${name}`;

/** Local routing mock over the captured real responses; unmatched URLs answer 404. */
function makeFetch(overrides: Record<string, { status: number; body: Uint8Array | string } | undefined> = {}): typeof fetch {
  const routes: Record<string, { status: number; body: Uint8Array | string }> = {
    [REF_URL]: { status: 200, body: readFileSync(`${TESTDATA}/ref-response.json`, "utf8") },
    [TAG_URL]: { status: 200, body: readFileSync(`${TESTDATA}/tag-object-response.json`, "utf8") },
    [assetUrl(VERSIONED_TAG, SNAPSHOT_ASSET_NAME)]: { status: 200, body: REAL_SNAPSHOT_BYTES },
    [assetUrl(VERSIONED_TAG, PROVENANCE_ASSET_NAME)]: { status: 200, body: REAL_PROVENANCE_BYTES },
    [assetUrl(VERSIONED_TAG, CHECKSUM_ASSET_NAME)]: { status: 200, body: REAL_CHECKSUM_BYTES },
  };
  // An override of `undefined` DELETES the route (the mock then answers 404)
  // — how the "missing asset" case is expressed.
  for (const [url, hit] of Object.entries(overrides)) {
    if (hit === undefined) delete routes[url];
    else routes[url] = hit;
  }
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hit = routes[url];
    if (hit === undefined) {
      return new Response(JSON.stringify({ message: "Not Found (test mock: unrouteable URL)" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const body = typeof hit.body === "string" ? new TextEncoder().encode(hit.body) : hit.body;
    return new Response(body as BodyInit, { status: hit.status, headers: { "content-type": "application/octet-stream" } });
  }) as typeof fetch;
}

function envWith(overrides: Partial<StablePointerResolverEnv> = {}): StablePointerResolverEnv {
  return {
    GY_SNAPSHOT_GITHUB_REPO: REPO,
    GY_SNAPSHOT_STABLE_REF: STABLE_REF_DEFAULT,
    GY_SNAPSHOT_GITHUB_API_BASE: API_BASE,
    GY_SNAPSHOT_GITHUB_ASSETS_BASE: ASSETS_BASE,
    GY_SNAPSHOT_GITHUB_TOKEN: null,
    GY_SNAPSHOT_URL: null,
    GY_SNAPSHOT_PATH: null,
    ...overrides,
  };
}

function depsWith(fetchImpl: typeof fetch, nowMs: number): StablePointerResolverDeps & { readFile: (path: string) => Promise<Uint8Array>; statSize: (path: string) => Promise<number | null> } {
  return {
    nowMs,
    fetchImpl,
    readFile: async () => {
      throw new Error("readFile must not be called by the stable-pointer topology");
    },
    statSize: async () => null,
  };
}

// A moment shortly after the real publication (the artifact is fresh).
const REAL_GENERATED_AT = (JSON.parse(new TextDecoder().decode(REAL_SNAPSHOT_BYTES)) as { generatedAtUnixMs: number }).generatedAtUnixMs;
const NOW = REAL_GENERATED_AT + 60_000;

describe("rehearsal-artifact regression battery (REAL GraveYield/grave-indexer-pub-rehearsal publication)", () => {
  test("the REAL rehearsal publication ingests end-to-end: valid schema-v2 snapshot served, pointer identity preserved", async () => {
    const payload = await resolveSnapshotArtifact(envWith(), depsWith(makeFetch(), NOW));
    expect(payload.artifactState).toBe("valid");
    expect(payload.dataState).toBe("real");
    expect(payload.reasonCode).toBeNull();
    expect(payload.reason).toBeNull();
    expect(payload.resolverStage).toBeNull();
    expect(payload.source.kind).toBe("stable-pointer");
    expect(payload.source.uri).toBe(REF_URL);
    expect(payload.snapshot).not.toBeNull();
    const snap = payload.snapshot!;
    expect(snap.schemaVersion).toBe(2);
    expect(snap.generatedAtUnixMs).toBe(REAL_GENERATED_AT);
    expect(snap.counts.enriched).toBeGreaterThan(0);
    expect(snap.pools.length).toBe(snap.counts.enriched);
    expect(payload.ageMs).toBe(60_000);
  });

  test("a SINGLE flipped byte in the REAL snapshot asset (same length) is refused at asset-integrity — never served", async () => {
    const tampered = REAL_SNAPSHOT_BYTES.slice();
    tampered[tampered.length - 1] ^= 0x01; // same byte length, different digest
    const payload = await resolveSnapshotViaStablePointer(
      envWith(),
      depsWith(
        makeFetch({ [assetUrl(VERSIONED_TAG, SNAPSHOT_ASSET_NAME)]: { status: 200, body: tampered } }),
        NOW,
      ),
    );
    expect(payload.artifactState).toBe("corrupt");
    expect(payload.resolverStage).toBe("asset-integrity");
    expect(payload.snapshot).toBeNull();
    expect(payload.reason).toContain("digest/length mismatch");
  });

  test("a missing release asset on the REAL versioned release is a typed asset-fetch failure — no substitution from another release", async () => {
    const payload = await resolveSnapshotViaStablePointer(
      envWith(),
      depsWith(
        makeFetch({ [assetUrl(VERSIONED_TAG, PROVENANCE_ASSET_NAME)]: undefined }),
        NOW,
      ),
    );
    expect(payload.artifactState).toBe("missing");
    expect(payload.resolverStage).toBe("asset-fetch");
    expect(payload.reasonCode).toBe("FETCH_HTTP_STATUS");
    expect(payload.snapshot).toBeNull();
  });

  test("a pointer re-stamped to a NONEXISTENT versioned release fetches NOTHING — no silent fallback to the real release", async () => {
    const mutated = JSON.parse(pointer.message) as Record<string, unknown>;
    mutated.versionedTag = "console-snapshot-prod-20990101T000000Z-notrack";
    const forgedTagObject = JSON.parse(readFileSync(`${TESTDATA}/tag-object-response.json`, "utf8")) as Record<string, unknown>;
    forgedTagObject.message = JSON.stringify(mutated);
    const payload = await resolveSnapshotViaStablePointer(
      envWith(),
      depsWith(
        makeFetch({ [TAG_URL]: { status: 200, body: new TextEncoder().encode(JSON.stringify(forgedTagObject)) } }),
        NOW,
      ),
    );
    expect(payload.artifactState).toBe("missing");
    expect(payload.resolverStage).toBe("asset-fetch");
    expect(payload.reasonCode).toBe("FETCH_HTTP_STATUS");
    expect(payload.snapshot).toBeNull();
  });

  test("rebinding the REAL pointer to another stableRef name is refused before any asset fetch", async () => {
    const mutated = JSON.parse(pointer.message) as Record<string, unknown>;
    mutated.stableRef = "console-snapshot-staging";
    const forgedTagObject = JSON.parse(readFileSync(`${TESTDATA}/tag-object-response.json`, "utf8")) as Record<string, unknown>;
    forgedTagObject.message = JSON.stringify(mutated);
    const payload = await resolveSnapshotViaStablePointer(
      envWith(),
      depsWith(
        makeFetch({ [TAG_URL]: { status: 200, body: new TextEncoder().encode(JSON.stringify(forgedTagObject)) } }),
        NOW,
      ),
    );
    expect(payload.artifactState).toBe("corrupt");
    expect(payload.resolverStage).toBe("pointer-validate"); // StablePointerError (contract violation), not StablePointerParseError
    expect(payload.snapshot).toBeNull();
  });

  test("an upstream 500 on the stable-ref endpoint is a typed transport failure — no fallback, no artifact served", async () => {
    const payload = await resolveSnapshotViaStablePointer(
      envWith(),
      depsWith(
        makeFetch({ [REF_URL]: { status: 500, body: new TextEncoder().encode("{}") } }),
        NOW,
      ),
    );
    expect(payload.artifactState).toBe("missing");
    expect(payload.resolverStage).toBe("stable-ref");
    expect(payload.reasonCode).toBe("FETCH_HTTP_STATUS");
    expect(payload.snapshot).toBeNull();
    expect(payload.dataState).toBe("unavailable");
  });

  test("an oversized annotated-tag response over the REAL ref is rejected BEFORE the pointer is parsed (bounded-response behavior)", async () => {
    const bloated = "x".repeat(1024 * 1024 + 1);
    const payload = await resolveSnapshotViaStablePointer(
      envWith(),
      depsWith(
        makeFetch({ [TAG_URL]: { status: 200, body: new TextEncoder().encode(bloated) } }),
        NOW,
      ),
    );
    expect(payload.artifactState).toBe("corrupt");
    expect(payload.reasonCode).toBe("OVERSIZE");
    expect(payload.snapshot).toBeNull();
  });
});
