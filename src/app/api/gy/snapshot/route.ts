// /api/gy/snapshot — server-side ConsoleSnapshotV1 artifact transport
// (P4.1 Step 1).
//
// Pull-only, fail-closed, manual-refresh: every request re-resolves the
// configured artifact source and answers with an explicit four-state
// envelope (valid | stale | missing | corrupt). The route NEVER caches
// (force-dynamic + no-store), NEVER polls upstream on its own, NEVER writes
// artifacts, and NEVER serves an artifact that failed the fail-closed
// contract. Stale artifacts are served but flagged — they can never be
// presented as fresh; missing/corrupt serve no payload at all.
//
// Source topologies (resolved by resolveSnapshotArtifact — see
// docs/snapshot-stable-pointer.md):
//   - GY_SNAPSHOT_GITHUB_REPO: the production stable-pointer resolver —
//     dedicated ref refs/tags/console-snapshot-prod → annotated tag object
//     (stable-pointer JSON) → workflow-protected --latest=false versioned
//     release (publisher-convention immutability, NOT GitHub-enforced)
//     assets, every byte verified against the pointer digests (P4.1 Step 2)
//   - GY_SNAPSHOT_URL (LEGACY direct-URL store): still supported for local
//     development and self-hosted runs; NOT the production path under the
//     dedicated-reference architecture
//   - GY_SNAPSHOT_PATH (LEGACY volume mount): self-hosted / Docker
//
// The state machine lives in the JSON payload, not the HTTP status: every
// outcome answers 200 so the envelope stays the single diagnostic surface.

import { readFile, stat } from "node:fs/promises";

import { resolveSnapshotArtifact, type StablePointerResolverEnv } from "@/lib/gy/stablePointerResolver";

// Dynamic + no-store: a cached stale response must never masquerade as a
// fresh check. Each request is a real evaluation of the configured source.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const env: StablePointerResolverEnv = {
    GY_SNAPSHOT_PATH: process.env.GY_SNAPSHOT_PATH ?? null,
    GY_SNAPSHOT_URL: process.env.GY_SNAPSHOT_URL ?? null,
    GY_SNAPSHOT_GITHUB_REPO: process.env.GY_SNAPSHOT_GITHUB_REPO ?? null,
    GY_SNAPSHOT_STABLE_REF: process.env.GY_SNAPSHOT_STABLE_REF ?? null,
    GY_SNAPSHOT_GITHUB_API_BASE: process.env.GY_SNAPSHOT_GITHUB_API_BASE ?? null,
    GY_SNAPSHOT_GITHUB_ASSETS_BASE: process.env.GY_SNAPSHOT_GITHUB_ASSETS_BASE ?? null,
    // Optional server-side token for authenticated GitHub reads (rate-limit
    // headroom). Consumed only inside the server-side resolver; never
    // logged, never echoed into any payload.
    GY_SNAPSHOT_GITHUB_TOKEN: process.env.GY_SNAPSHOT_GITHUB_TOKEN ?? null,
  };

  const payload = await resolveSnapshotArtifact(env, {
    nowMs: Date.now(),
    readFile: async (p) => new Uint8Array(await readFile(p)),
    statSize: async (p) => {
      const s = await stat(p);
      return s.size;
    },
    fetchImpl: fetch,
  });

  // A corrupt artifact means real bytes failed the contract — that must be
  // loud in server logs, not just in the UI banner. The resolver stage (when
  // present) names WHERE the fail-closed chain stopped. No credential value
  // can ever appear here: reasons carry only stage names and URL paths.
  if (payload.artifactState === "corrupt") {
    console.error(
      `[gy/snapshot] corrupt artifact (stage=${payload.resolverStage ?? "legacy"} ${payload.reasonCode}): ${payload.reason}`,
    );
  }

  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}
