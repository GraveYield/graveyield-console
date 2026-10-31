// /api/gy/claims — server-side LP-claims transport (P4.4 claims integration).
//
// Pull-only, fail-closed, manual-refresh: every request re-resolves the
// configured distribution source (GY_CLAIMS_URL or GY_CLAIMS_PATH) through
// src/lib/gy/claimsSource.ts — schema gate + canonical-SDK integrity gate —
// and reads the live devnet settlement accounts for the artifact's pool
// through the canonical SDK (claimsOnchain.ts). The route answers with an
// explicit four-state envelope (valid | stale | missing | corrupt) for the
// distribution half, the on-chain settlement facts as an independent data
// plane, and — when ?wallet= is provided — that wallet's claim view computed
// by the fail-closed state machine (claimsContract.walletClaimView).
//
// PRIVACY: the route NEVER serves the distribution's per-holder entry set.
// The client receives the privacy-stripped projection (no rows) plus, for the
// queried wallet only, that wallet's own row. Any wallet address may be
// queried — the data is public on-chain — but the console surfaces only the
// queried wallet's own claim detail, never a directory of other holders.
//
// The route NEVER caches (force-dynamic + no-store), NEVER polls upstream on
// its own, NEVER writes artifacts, and NEVER serves an artifact that failed
// the fail-closed contract. The state machine lives in the JSON payload, not
// the HTTP status: every outcome answers 200 so the envelope stays the single
// diagnostic surface.

import { readFile, stat } from "node:fs/promises";

import { resolveClaimsSource } from "@/lib/gy/claimsSource";
import {
  canonicalQueryWallet,
  walletClaimView,
  type RegistryFacts,
  type WalletClaimInput,
  type WalletClaimRecord,
  type WalletClaimView,
} from "@/lib/gy/claimsContract";
import { readClaimsOnchain, DEFAULT_CLAIMS_RPC_HOST } from "@/lib/gy/claimsOnchain";
import { PROGRAM_IDS } from "@/lib/gy/data";

// Dynamic + no-store: a cached stale response must never masquerade as a
// fresh check. Each request is a real evaluation of the configured source.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const walletParam = url.searchParams.get("wallet");
  // An invalid wallet parameter is refused with the same envelope (wallet:
  // null) — never guessed, never echoed as data. SECURITY (review
  // 2026-10-31, F1): "invalid" means the REAL PublicKey gate, not just the
  // base58 regex — canonicalQueryWallet rejects regex-passing strings that
  // do not decode to exactly 32 bytes, which previously crashed the route
  // with an unhandled 500 once a distribution artifact was configured.
  const wallet = canonicalQueryWallet(walletParam);

  // 1. Distribution artifact (four-state envelope + server-side artifact).
  const resolution = await resolveClaimsSource(
    {
      GY_CLAIMS_PATH: process.env.GY_CLAIMS_PATH ?? null,
      GY_CLAIMS_URL: process.env.GY_CLAIMS_URL ?? null,
      GY_CLAIMS_MAX_AGE_MS: process.env.GY_CLAIMS_MAX_AGE_MS ?? null,
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

  // 2. On-chain settlement facts — only meaningful when the artifact named a
  //    pool; otherwise the payload carries the envelope's honest reason and
  //    no on-chain half (we do not know WHICH settlement to read).
  //    SECURITY (review 2026-10-31, F2b): the on-chain read and the wallet
  //    state machine are wrapped — ANY failure they throw degrades to the
  //    honest envelope (no onchain half; wallet → snapshot-unavailable),
  //    never to an HTTP 500. The four-state contract survives every single
  //    component failure.
  let onchain: Awaited<ReturnType<typeof readClaimsOnchain>>["onchain"] | null = null;
  let walletView: WalletClaimView | null = null;
  const artifact = resolution.artifact;

  if (artifact !== null) {
    // Registry facts for the state machine, defaulting to "the read failed"
    // (registryError set → the machine answers snapshot-unavailable).
    let registryFacts: RegistryFacts | null = null;
    let registryAbsent = false;
    let registryError: string | null = null;
    let claimRecord: WalletClaimRecord | null = null;
    let claimRecordError = false;
    try {
      const read = await readClaimsOnchain(
        artifact.poolAddress,
        wallet,
        process.env.GY_CLAIMS_RPC_HOST?.trim() || DEFAULT_CLAIMS_RPC_HOST,
      );
      onchain = read.onchain;
      registryFacts = read.registryFacts;
      registryAbsent = read.registryAbsent;
      registryError = read.registryError;
      claimRecord = read.claimRecord;
      claimRecordError = read.claimRecordError;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`[gy/claims] on-chain settlement read failed (fail-closed): ${msg.slice(0, 180)}`);
      registryError = msg.slice(0, 180);
    }

    if (wallet !== null) {
      // 3. Wallet claim view — the fail-closed state machine. A failed
      //    claim-record read blocks the claimable path (fail-closed).
      const input: WalletClaimInput = {
        wallet,
        artifact,
        registry: registryFacts,
        registryAbsent,
        registryError,
        claimRecord,
        claimRecordError,
        vaultProgramId: PROGRAM_IDS.graveVault,
      };
      try {
        walletView = walletClaimView(input);
      } catch (e) {
        // Unreachable after the F1/F2 gates — kept as defense-in-depth: an
        // exception here degrades to snapshot-unavailable, never a 500.
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        console.error(`[gy/claims] wallet claim view failed (fail-closed): ${msg.slice(0, 180)}`);
        walletView = walletClaimView({
          wallet,
          artifact: null,
          registry: null,
          registryAbsent: false,
          registryError: null,
          claimRecord: null,
          claimRecordError: false,
          vaultProgramId: PROGRAM_IDS.graveVault,
        });
      }
    }
  } else if (wallet !== null) {
    // No usable artifact → eligibility unknown; the state machine says so
    // honestly (snapshot-unavailable), with no registry to read.
    walletView = walletClaimView({
      wallet,
      artifact: null,
      registry: null,
      registryAbsent: false,
      registryError: null,
      claimRecord: null,
      claimRecordError: false,
      vaultProgramId: PROGRAM_IDS.graveVault,
    });
  }

  // A corrupt artifact means real bytes failed the contract — loud in server
  // logs, not just in the UI banner.
  if (resolution.payload.artifactState === "corrupt") {
    console.error(`[gy/claims] corrupt artifact (${resolution.payload.reasonCode}): ${resolution.payload.reason}`);
  }

  const payload = { ...resolution.payload, onchain, wallet: walletView };
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}
