// /api/gy/snapshot — server-side ConsoleSnapshotV1 artifact transport
// (P4.1 Step 1).
//
// Pull-only, fail-closed, manual-refresh: every request re-resolves the
// configured artifact source (GY_SNAPSHOT_URL or GY_SNAPSHOT_PATH) through
// src/lib/gy/snapshotSource.ts and answers with an explicit four-state
// envelope (valid | stale | missing | corrupt). The route NEVER caches
// (force-dynamic + no-store), NEVER polls upstream on its own, NEVER writes
// artifacts, and NEVER serves an artifact that failed the fail-closed
// contract. Stale artifacts are served but flagged — they can never be
// presented as fresh; missing/corrupt serve no payload at all.
//
// Deployment topologies (see docs/snapshot-transport.md):
//   - self-hosted / Docker: mount the indexer output volume, set GY_SNAPSHOT_PATH
//   - serverless (e.g. Vercel): publish the artifact to an HTTPS artifact
//     store (GitHub Release asset, R2/S3, any GET endpoint), set GY_SNAPSHOT_URL
//
// The state machine lives in the JSON payload, not the HTTP status: every
// outcome answers 200 so the envelope stays the single diagnostic surface.

import { readFile, stat } from "node:fs/promises";

import { resolveSnapshotSource } from "@/lib/gy/snapshotSource";

// Dynamic + no-store: a cached stale response must never masquerade as a
// fresh check. Each request is a real evaluation of the configured source.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const payload = await resolveSnapshotSource(
    {
      GY_SNAPSHOT_PATH: process.env.GY_SNAPSHOT_PATH ?? null,
      GY_SNAPSHOT_URL: process.env.GY_SNAPSHOT_URL ?? null,
    },
    {
      nowMs: Date.now(),
      readFile: async (p) => new Uint8Array(await readFile(p)),
      statSize: async (p) => {
        const s = await stat(p);
        return s.size;
      },
      fetchImpl: fetch,
    },
  );

  // A corrupt artifact means real bytes failed the contract — that must be
  // loud in server logs, not just in the UI banner.
  if (payload.artifactState === "corrupt") {
    console.error(`[gy/snapshot] corrupt artifact (${payload.reasonCode}): ${payload.reason}`);
  }

  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}
