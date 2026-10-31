// TX PREPARE (P4.5) — building the exact unsigned transaction the wallet will
// be shown, from the canonical-SDK instruction the server prepared.
//
// The console's contract with the canonical SDK (P4.4, audit Q1): derivation,
// proof folding, and instruction construction live in the vendored SDK — the
// console never re-implements them. This module therefore only SERIALIZES the
// already-built instruction into a web3.js transaction and wraps the two
// RPC reads the state machine needs before approval:
//
//   · a fresh blockhash (fail-closed: an RPC failure throws — the caller
//     stays in "not-prepared" and the UI says why; no stale-blockhash hope),
//   · a simulation of the EXACT transaction (the audit's "simulate → show
//     result → explicit wallet approval" step). An RPC error on simulate is
//     NEVER reported as a passing simulation — it is a failure with the
//     error text, so the machine can only advance to "simulated" on a real
//     RPC answer.
//
// Browser-safe: web3.js + the same atob-based base64 decode the P4.4 claim
// card proved out. No Node APIs, no SDK import, no signing of any kind —
// the returned Transaction is UNSIGNED until the wallet signs it.

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

import type { PreparedClaimInstruction } from "../claimsContract";

export class GyTxPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GyTxPrepareError";
  }
}

/** Deserialize the transport's prepared instruction into a web3.js instruction.
 * Throws GyTxPrepareError on any malformed field — a bad instruction must
 * never reach the wallet approval screen. */
export function deserializeClaimInstruction(prepared: PreparedClaimInstruction): TransactionInstruction {
  let data: Uint8Array;
  try {
    const bin = atob(prepared.data);
    data = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new GyTxPrepareError("prepared claim instruction data is not valid base64");
  }
  if (data.length === 0) {
    throw new GyTxPrepareError("prepared claim instruction data is empty");
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(prepared.programId);
  } catch {
    throw new GyTxPrepareError("prepared claim instruction programId is not a valid public key");
  }
  if (!Array.isArray(prepared.keys) || prepared.keys.length === 0) {
    throw new GyTxPrepareError("prepared claim instruction carries no account keys");
  }
  const keys = prepared.keys.map((k, i) => {
    try {
      return {
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner === true,
        isWritable: k.isWritable === true,
      };
    } catch {
      throw new GyTxPrepareError(`prepared claim instruction key[${i}] is not a valid public key`);
    }
  });
  if (!keys.some((k) => k.isSigner)) {
    throw new GyTxPrepareError("prepared claim instruction has no signer account — refusing");
  }
  // web3.js 1.x types the wire data as Buffer; the canonical SDK's
  // instruction data arrives as bytes. (Buffer here matches the app's proven
  // P4.4 pattern — web3.js itself polyfills it in the browser bundle.)
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

export interface FreshBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAtUnixMs: number;
}

/** A fresh blockhash at the stated commitment — fail-closed on RPC failure. */
export async function fetchFreshBlockhash(
  connection: Connection,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed",
): Promise<FreshBlockhash> {
  const bh: BlockhashWithExpiryBlockHeight = await connection.getLatestBlockhash(commitment);
  if (!bh || typeof bh.blockhash !== "string" || bh.blockhash.length === 0) {
    throw new GyTxPrepareError("RPC returned an unusable blockhash");
  }
  if (!Number.isFinite(bh.lastValidBlockHeight) || bh.lastValidBlockHeight <= 0) {
    throw new GyTxPrepareError("RPC returned an unusable blockhash expiry height");
  }
  return {
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    fetchedAtUnixMs: Date.now(),
  };
}

/** True when the chain has passed the blockhash's validity height. */
export function blockhashExpired(lastValidBlockHeight: number, currentBlockHeight: number): boolean {
  return currentBlockHeight >= lastValidBlockHeight;
}

export function buildClaimTransaction(opts: {
  instruction: TransactionInstruction;
  feePayer: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
}): Transaction {
  const tx = new Transaction({
    feePayer: opts.feePayer,
    blockhash: opts.blockhash,
    lastValidBlockHeight: opts.lastValidBlockHeight,
  });
  tx.add(opts.instruction);
  return tx;
}

export interface SimulationOutcome {
  ok: boolean;
  /** Present when the simulation failed or the RPC could not be asked. */
  error: string | null;
  /** Program logs from the failed simulation (when the RPC provided them). */
  logs: string[] | null;
}

export interface SimulatableConnection {
  simulateTransaction(transaction: Transaction): Promise<{
    value: { err: unknown; logs: string[] | null } | null;
  }>;
}

/**
 * Dry-run the exact unsigned transaction. Fail-closed in both directions:
 * the transaction erroring → ok:false with logs; the RPC failing → ok:false
 * with the error (an unreachable RPC must never read as "simulation passed").
 */
export async function simulateClaimTransaction(
  connectionLike: SimulatableConnection,
  transaction: Transaction,
): Promise<SimulationOutcome> {
  try {
    const result = await connectionLike.simulateTransaction(transaction);
    const value = result?.value ?? null;
    if (value === null) {
      return { ok: false, error: "simulation returned no value", logs: null };
    }
    if (value.err !== null && value.err !== undefined) {
      const detail = typeof value.err === "string" ? value.err : JSON.stringify(value.err);
      return { ok: false, error: `simulation failed: ${detail}`, logs: value.logs ?? null };
    }
    return { ok: true, error: null, logs: null };
  } catch (err) {
    return {
      ok: false,
      error: `simulation could not run: ${String((err as Error).message ?? err).slice(0, 200)}`,
      logs: null,
    };
  }
}
