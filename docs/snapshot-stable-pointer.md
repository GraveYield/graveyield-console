# Snapshot stable-pointer resolution — Console-side production contract

Companion to `snapshot-contract.md` (the schema-v2 artifact contract) and
`snapshot-transport.md` (the four-state transport envelope). This document
specifies HOW the Console obtains the artifact bytes from the
grave-indexer publisher under the owner-selected **dedicated stable
reference architecture** (`grave-indexer docs/SNAPSHOT_PUBLICATION.md`
§9, §13.1 — grave-indexer PR #5).

## 1. Why a two-step resolver

The production stable pointer is NOT a URL. It is the dedicated git
reference `refs/tags/console-snapshot-prod` in `GraveYield/grave-indexer`,
whose annotated tag object's MESSAGE carries a stable-pointer JSON
(`graveyield.console-snapshot-stable-pointer.v1`) naming ONE
workflow-protected `--latest=false` versioned release together with
per-asset SHA-256 digests and byte lengths. There is deliberately no single-GET URL behind
this architecture: the retired repo-wide `releases/latest/download/...`
URL family is LEGACY, non-production, and cannot enforce pointer digests.
The Console therefore resolves the chain server-side on every request.

## 2. The resolution chain (fail-closed at every step)

Implemented by `src/lib/gy/stablePointerResolver.ts`
(`resolveSnapshotViaStablePointer`); the pure validation contract lives in
`src/lib/gy/stablePointer.ts` (a byte-for-byte mirror of the producer's
`grave-indexer src/snapshotPublication.ts`).

1. `GET {api}/repos/{repo}/git/ref/tags/{stableRef}` → tag-object sha
   (must be 40-hex; the ref must point at object type `"tag"`).
2. `GET {api}/repos/{repo}/git/tags/{sha}` → annotated tag object
   (response must identify the requested sha; a non-empty message is
   required).
3. Parse the tag message strictly as the stable pointer (exact key set,
   schema discriminator, stableRef binding, versioned-tag shape, 40-hex
   commit, 64-hex digests, positive lengths, paired `previous*` fields).
4. Verify the annotated tag object's TARGET: type exactly `"commit"`,
   target sha 40-hex and EQUAL to `pointer.sourceCommit`.
5. Fetch the three assets from the VERSIONED release the pointer names —
   `releases/download/{pointer.versionedTag}/{console-snapshot.json |
   console-snapshot-provenance.json | console-snapshot.sha256}` — never
   from `/releases/latest/download/...`.
6. Verify every asset's SHA-256 + byte length against the pointer; the
   checksum asset must be a sha256sum-compatible line naming the snapshot
   asset with the pointer's snapshot digest; the provenance sidecar must
   name the SAME versioned tag and (when present) the SAME source commit,
   and must describe the exact snapshot bytes.
7. Enforce the independent completeness contract (no
   discovery/enrichment-completeness failure markers; artifact and
   sidecar enriched counts well-formed, exactly equal, and positive).
8. Run the existing schema-v2 fail-closed parser
   (`snapshotSource.bytesToPayload`) and the freshness gate over the
   verified bytes.

## 3. Failure taxonomy (the envelope names WHERE it failed)

Every failure maps onto the existing four-state transport envelope
(`valid | stale | missing | corrupt`) with an explicit
`resolverStage` diagnostic — the chain NEVER falls back to a cached or
legacy source on failure:

| Stage | Artifact state | Typical cause |
| --- | --- | --- |
| `stable-ref` | missing (HTTP 404 / 403 / 5xx) or corrupt (unsafe name) | no publication yet, rate limit, outage, bad config |
| `annotated-tag` | missing (fetch) or corrupt (identity) | ref dangling, lightweight tag, sha/target mismatch |
| `pointer-parse` | corrupt | tag message is not JSON |
| `pointer-validate` | corrupt | schema/key/shape violations |
| `asset-fetch` | missing (HTTP/network) or corrupt (oversize) | release or asset absent, stream cap |
| `asset-integrity` | corrupt | digest/length/checksum/provenance mismatch |
| `completeness` | corrupt | failure markers, count contradiction, empty publication |
| `snapshot-schema` | corrupt | schema-v2 parse rejection |
| `network` | missing | timeout, connection failure |

A first publication (the stable ref does not exist yet) is honest
bootstrap, not data loss: the route answers `missing`/`stable-ref`.

## 4. Configuration (server-side only)

Exactly one topology may be configured — mixing them is a fail-closed
`SOURCE_CONFLICT`:

- **Production:** `GY_SNAPSHOT_GITHUB_REPO` (`owner/repo`) +
  optional `GY_SNAPSHOT_STABLE_REF` (default `console-snapshot-prod`) +
  optional `GY_SNAPSHOT_GITHUB_API_BASE` / `GY_SNAPSHOT_GITHUB_ASSETS_BASE`
  (test/GHES overrides) + optional `GY_SNAPSHOT_GITHUB_TOKEN`
  (server-side authenticated reads for rate-limit headroom; never logged,
  never echoed, never sent to the client).
- **Legacy (still supported, NOT the production path):**
  `GY_SNAPSHOT_URL` (HTTPS artifact store) / `GY_SNAPSHOT_PATH` (mounted
  volume), unchanged from P4.1 Step 1.

## 5. Honesty and security properties

- Pull-only, no caching of any intermediate result: every request
  resolves the full chain, so a partially verified artifact can never be
  served from a cache.
- Stale artifacts are served but flagged exactly like the legacy source —
  never presented as fresh.
- No credential ever reaches client code: the pointer indirection is
  browser-safe because it is resolved server-side; the optional token is
  read from the server environment only.
- The route NEVER changes its HTTP status by outcome — the JSON envelope
  is the single diagnostic surface — and `no-store`/`force-dynamic`
  prevent a cached stale response from masquerading as a fresh check.
- Corrupt artifacts are loud in server logs (`stage=` + `reasonCode`),
  and reason strings carry only stage names and URL paths — never
  credential values.
- Bounded consumption of every upstream response: the GitHub API JSON
  responses the resolver reads are capped at a documented maximum
  (`DEFAULT_MAX_JSON_BYTES`) enforced during the streamed read, BEFORE
  any JSON parsing — an oversized response is cancelled and rejected
  with a typed `OVERSIZE` failure, never silently truncated and parsed.

## 6. Terminology — two distinct protections, never conflated

This document deliberately says "workflow-protected versioned release",
not "immutable release". Those are two different, non-interchangeable
protections:

- **Workflow-protected versioned release** — what this architecture
  actually relies on: the publisher workflow's `--latest=false`
  convention (every publication lands on a fresh versioned release and
  the pointer names exactly one) PLUS the SHA-256 + byte-length
  verification the Console performs on every resolution. This guarantees
  the console never consumes bytes the pointer does not name, but it
  does NOT prevent a privileged writer from replacing release assets or
  metadata — in that case digest verification fails loudly and the
  console serves nothing (fail closed).
- **GitHub-enforced immutable release** — GitHub's immutable-releases
  platform feature: once a release is published while the feature is
  enabled, GitHub locks its assets and its tag. This is an
  owner-enabled repository setting and is NOT assumed, claimed, or
  implied anywhere in this architecture.

Whether GitHub-enforced immutable releases are actually enabled on the
publisher repository is an owner setting that can only be confirmed by
an authorized read of the documented read-only REST endpoint
`GET /repos/{owner}/{repo}/immutable-releases` (requires the
"Administration" repository permission, read; HTTP 200 returns
`enabled` and `enforced_by_owner`; HTTP 404 means, per the documented
behavior, that the feature is not enabled for the repository). Until an
authorized read succeeds, the setting must be treated as UNKNOWN — and
a permission failure (403) must never be interpreted as "disabled".

## 7. Testing

- `src/lib/gy/__tests__/stablePointer.test.ts` — the 28-case contract
  mirror battery (strict pointer parsing, provenance shape, pointer↔artifact
  verification, completeness contract).
- `src/lib/gy/__tests__/stablePointerResolver.test.ts` — the end-to-end
  resolver battery over a mocked GitHub transport: valid pointer, missing
  stable ref, lightweight-tag refusal, annotated-tag failures, pointer
  parse/validate failures, target-identity enforcement, missing asset,
  digest/length/checksum/provenance mismatches, malformed JSON,
  schema-v2 rejection, completeness rejections, timeout/network/rate-limit
  typing, versioned-release discipline (never `releases/latest`),
  stale-flagged serving, the source dispatcher (conflict, legacy
  passthrough, unconfigured, unsafe slug), and the bounded-response
  battery (under-cap accepted, exactly-at-cap boundary, over-cap
  rejected before pointer parsing, no silent truncation, HTTP-status
  precedence over body size, custom cap wiring, non-JSON handling).
