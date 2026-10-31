// Claims ON-CHAIN reader (P4.4) — live, read-only devnet settlement facts.
//
// Every value here is decoded from the deployed GraveVault program's accounts
// via the CANONICAL SDK (vendored: accountDecoders.ts + pdas.ts) — the same
// decoders the salvor bots run. Nothing is estimated, nothing is cached
// across requests, and any failure degrades the affected row to an explicit
// null + error string — never a guess.
//
// Read set, per request (all PDAs under GraveVault):
//   PoolRegistry      — ["pool_registry", pool]      (the sealed distribution:
//                                                      root, supply, LP bucket
//                                                      totals, claimed totals,
//                                                      salvage slot/ts)
//   SalvageReceipt    — ["salvage_receipt", pool]    (the salvage reference:
//                                                      proceeds split, issued
//                                                      slot/ts)
//   ClaimRecord       — ["claim_record", pool, wallet] (the queried wallet's
//                                                       claim, if any: the
//                                                       canonical PAID evidence)
//   lp_holder_pool_vault — ["lp_holder_pool", pool]  (native lamports context)
//
// SERVER-ONLY (Node runtime): the SDK's merkle/web3compat use node:crypto,
// and this module's Connection usage runs in the route handler. The browser
// never imports this module.
//
// Epoch note: the "distribution epoch" the UI shows is the epoch containing
// the registry's salvagedAtSlot, computed with the LIVE slotsInEpoch from
// getEpochInfo. When the RPC cannot answer, the row renders the slot with an
// unavailable epoch — never a fabricated epoch number.

import { Connection, PublicKey } from "@solana/web3.js";

import {
  decodeClaimRecord,
  fetchPoolRegistry,
  fetchSalvageReceipt,
  type PoolRegistry,
  type SalvageReceipt,
} from "./vendor/graveyield-sdk/accountDecoders";
import {
  claimRecordPda,
  lpHolderPoolVaultPda,
  poolRegistryPda,
  salvageReceiptPda,
} from "./vendor/graveyield-sdk/pdas";
import { PROGRAM_IDS } from "./data";
import type { RegistryFacts, WalletClaimRecord } from "./claimsContract";
import type { ClaimsOnchain } from "./claimsTransport";

export const DEFAULT_CLAIMS_RPC_HOST = "api.devnet.solana.com";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function toStr(b: bigint): string {
  return b.toString(10);
}

/** Unix-seconds → unix-ms (or null when the chain carries zero). */
function tsMs(unixSec: bigint): number | null {
  if (unixSec <= 0n) return null;
  return Number(unixSec) * 1000;
}

export interface ClaimsOnchainRead {
  onchain: ClaimsOnchain;
  /** Registry facts for the wallet state machine (null unless found + decoded). */
  registryFacts: RegistryFacts | null;
  registryAbsent: boolean;
  registryError: string | null;
  /** The wallet's ClaimRecord — null when absent, and ALSO null when the read
   * itself failed (claimRecordError true): a failed lookup must never read as
   * "never claimed", so the route blocks the claimable path on the error. */
  claimRecord: WalletClaimRecord | null;
  claimRecordError: boolean;
}

/** Live epoch facts for the epoch-of-slot display; null when unusable. */
export async function fetchClaimsEpoch(
  rpcHost: string,
): Promise<{ epoch: number; slotsInEpoch: number } | null> {
  try {
    const res = await fetch(`https://${rpcHost}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getEpochInfo", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { value?: { epoch?: number; slotsInEpoch?: number } }; error?: unknown };
    const epoch = json.result?.value?.epoch;
    const slots = json.result?.value?.slotsInEpoch;
    if (
      typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0 ||
      typeof slots !== "number" || !Number.isInteger(slots) || slots <= 0
    ) {
      return null;
    }
    return { epoch, slotsInEpoch: slots };
  } catch {
    return null;
  }
}

/** The epoch containing a slot, when epoch telemetry is available. */
export function epochOfSlot(
  slot: string | number | null,
  epoch: { epoch: number; slotsInEpoch: number } | null,
): number | null {
  if (slot === null || epoch === null) return null;
  const s = typeof slot === "string" ? Number(slot) : slot;
  if (!Number.isFinite(s) || s < 0) return null;
  return Math.floor(s / epoch.slotsInEpoch);
}

/**
 * Read the full settlement picture for `poolAddress`. Every section fails
 * independently and honestly; only the registry gates the wallet state
 * machine (its facts drive the claimable math).
 */
export async function readClaimsOnchain(
  poolAddress: string,
  wallet: string | null,
  rpcHost: string = DEFAULT_CLAIMS_RPC_HOST,
): Promise<ClaimsOnchainRead> {
  const connection = new Connection(`https://${rpcHost}`, "confirmed");
  const pool = new PublicKey(poolAddress);
  const vaultProgramId = new PublicKey(PROGRAM_IDS.graveVault);

  const registryPda = poolRegistryPda(vaultProgramId, pool);
  const receiptPda = salvageReceiptPda(vaultProgramId, pool);

  // ── PoolRegistry ──────────────────────────────────────────────────────
  let registry: PoolRegistry | null = null;
  let registryError: string | null = null;
  let registryAbsent = false;
  try {
    registry = await fetchPoolRegistry(connection, registryPda);
    if (registry === null) registryAbsent = true;
  } catch (e) {
    registryError = String((e as Error).message ?? e).slice(0, 180);
  }

  // ── SalvageReceipt (independent) ──────────────────────────────────────
  let receipt: SalvageReceipt | null = null;
  let receiptError: string | null = null;
  try {
    receipt = await fetchSalvageReceipt(connection, receiptPda);
  } catch (e) {
    receiptError = String((e as Error).message ?? e).slice(0, 180);
  }

  // ── Vault lamports (independent) ──────────────────────────────────────
  let vaultLamports: string | null = null;
  let vaultError: string | null = null;
  try {
    const vaultInfo = await connection.getAccountInfo(lpHolderPoolVaultPda(vaultProgramId, pool));
    // An ABSENT vault PDA (no salvage has settled, or nothing was funded) is
    // "unavailable", not "0 SOL" — the UI must not read a missing account as
    // an empty one.
    vaultLamports = vaultInfo === null ? null : vaultInfo.lamports.toString(10);
  } catch (e) {
    vaultError = String((e as Error).message ?? e).slice(0, 180);
  }

  // ── Epoch telemetry (independent, best-effort) ────────────────────────
  const epoch = await fetchClaimsEpoch(rpcHost);

  // ── ClaimRecord for the queried wallet ────────────────────────────────
  // One read + one decode. Absence (account not found) is a legal
  // "never claimed"; a DECODE failure is an error and is reported as such —
  // the route must never render "claimable" off an unreadable record.
  let claimRecord: WalletClaimRecord | null = null;
  let claimRecordError = false;
  if (wallet !== null) {
    try {
      const holder = new PublicKey(wallet);
      const recordPda = claimRecordPda(vaultProgramId, pool, holder);
      const info = await connection.getAccountInfo(recordPda);
      if (info !== null) {
        try {
          const record = decodeClaimRecord(new Uint8Array(info.data));
          claimRecord = {
            pda: recordPda.toBase58(),
            amountLamports: toStr(record.amountLamports),
            lpBalanceAtSnapshot: toStr(record.lpBalanceAtSnapshot),
            claimedAtSlot: toStr(record.claimedAtSlot),
            claimedAtTs: tsMs(record.claimedAtTs),
          };
        } catch {
          claimRecordError = true;
        }
      }
    } catch {
      claimRecordError = true;
    }
  }

  const onchain: ClaimsOnchain = {
    checkedAtUnixMs: Date.now(),
    rpcHost,
    poolRegistry: {
      pda: registryPda.toBase58(),
      found: registry !== null,
      error: registryError,
      ammProgramId: registry?.ammProgramId.toBase58() ?? null,
      salvor: registry?.salvor.toBase58() ?? null,
      merkleRoot: registry === null ? null : hex(registry.lpSnapshotMerkleRoot),
      lpTotalSupplyAtSnapshot: registry === null ? null : toStr(registry.lpTotalSupplyAtSnapshot),
      lpHolderPoolTotalLamports: registry === null ? null : toStr(registry.lpHolderPoolTotalLamports),
      lpHolderPoolClaimedLamports: registry === null ? null : toStr(registry.lpHolderPoolClaimedLamports),
      salvagedAtSlot: registry === null ? null : toStr(registry.salvagedAtSlot),
      salvagedAtTs: registry === null ? null : tsMs(registry.salvagedAtTs),
    },
    salvageReceipt: {
      pda: receiptPda.toBase58(),
      found: receipt !== null,
      error: receiptError,
      lpHolderAmountLamports: receipt === null ? null : toStr(receipt.lpHolderAmountLamports),
      totalProceedsLamports: receipt === null ? null : toStr(receipt.totalProceedsLamports),
      issuedAtSlot: receipt === null ? null : toStr(receipt.issuedAtSlot),
      issuedAtTs: receipt === null ? null : tsMs(receipt.issuedAtTs),
    },
    vaultLamports,
    vaultError,
    epoch,
  };

  const registryFacts: RegistryFacts | null =
    registry === null
      ? null
      : {
          merkleRoot: hex(registry.lpSnapshotMerkleRoot),
          lpTotalSupplyAtSnapshot: registry.lpTotalSupplyAtSnapshot,
          lpHolderPoolTotalLamports: registry.lpHolderPoolTotalLamports,
        };

  return {
    onchain,
    registryFacts,
    registryAbsent,
    registryError,
    claimRecord,
    claimRecordError,
  };
}
