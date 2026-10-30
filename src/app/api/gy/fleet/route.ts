// /api/gy/fleet — server-side fleet trail transport (P4.3 fleet ingestion).
//
// Pull-only, fail-closed, manual-refresh: every request re-resolves the
// configured fleet state source (GY_FLEET_STATE_PATH — the salvor fleet's
// FLEET_STATE_DIR) through src/lib/gy/fleetSource.ts and answers with an
// explicit four-state envelope (valid | stale | missing | corrupt). The
// route NEVER caches (force-dynamic + no-store), NEVER polls the fleet on
// its own, NEVER writes trails, and NEVER serves a trail that failed the
// fail-closed contract. Stale trails are served but flagged — they can
// never be presented as fresh; missing/corrupt serve no payload at all.
//
// The state machine lives in the JSON payload, not the HTTP status: every
// outcome answers 200 so the envelope stays the single diagnostic surface.

import { readFile, stat } from "node:fs/promises";

import { resolveFleetSource } from "@/lib/gy/fleetSource";

// Dynamic + no-store: a cached stale response must never masquerade as a
// fresh check. Each request is a real evaluation of the configured source.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const payload = await resolveFleetSource(
    {
      GY_FLEET_STATE_PATH: process.env.GY_FLEET_STATE_PATH ?? null,
      GY_FLEET_MAX_AGE_MS: process.env.GY_FLEET_MAX_AGE_MS ?? null,
    },
    {
      nowMs: Date.now(),
      readFile: async (p) => new Uint8Array(await readFile(p)),
      statSize: async (p) => {
        const s = await stat(p);
        return s.size;
      },
    },
  );

  // A corrupt trail means real bytes failed the contract — that must be
  // loud in server logs, not just in the UI banner.
  if (payload.artifactState === "corrupt") {
    console.error(`[gy/fleet] corrupt trail (${payload.reasonCode}): ${payload.reason}`);
  }

  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}
