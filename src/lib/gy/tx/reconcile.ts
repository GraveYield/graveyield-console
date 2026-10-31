// TX RECONCILE (P4.5) — the on-chain steps after a broadcast.
//
// Two reads, both read-only and both fail-closed:
//
//   1. Signature confirmation at the stated commitment. Polling is bounded
//      (deadline + poll interval, both caller-set); the RPC failing is NOT
//      confirmation failure — it is "not seen yet", and polling continues
//      until the deadline. A timeout returns `timeout` — deliberately NOT
//      "failed" — because a broadcast transaction may still settle; the
//      machine maps it to "confirmation-unknown".
//
//   2. ClaimRecord reconciliation — the honesty gate. "Confirmed" is only
//      ever displayed after the console itself re-reads the protocol's
//      ClaimRecord PDA and finds it. Three outcomes, none collapsible into
//      another: found (the record exists — the one path to "confirmed"),
//      absent (a clean read showing no record — the honest "not paid"),
//      inconclusive (the read itself failed — unknown; the machine goes to
//      "confirmation-unknown", never to "failed": a read error is not
//      evidence that nothing moved).
//
// Browser-safe: web3.js only. The PDA arrives server-derived by the
// canonical SDK (the browser never derives PDAs — P4.4 contract); this
// module only reads the account at that address.

export type SignatureConfirmation =
  | { kind: "seen"; commitment: "confirmed" | "finalized" }
  | { kind: "on-chain-failed"; err: string }
  | { kind: "timeout" };

export interface SignatureStatusLike {
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export interface StatusConnection {
  getSignatureStatuses(signatures: string[]): Promise<{ value: (SignatureStatusLike | null)[] }>;
  getAccountInfo(address: string): Promise<{ data: Uint8Array | unknown[] } | null>;
}

export interface AwaitConfirmationOptions {
  timeoutMs: number;
  pollMs: number;
  /** Cooperatively stop polling (component unmount). An aborted loop
   * resolves as `timeout` — the outcome is genuinely unknown. */
  isAborted?: () => boolean;
  onPoll?: (elapsedMs: number) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bounded confirmation wait at the stated commitment (confirmed ⊇ finalized). */
export async function awaitSignatureConfirmation(
  connectionLike: StatusConnection,
  signature: string,
  opts: AwaitConfirmationOptions,
): Promise<SignatureConfirmation> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("awaitSignatureConfirmation: timeoutMs must be a positive number");
  }
  if (!Number.isFinite(opts.pollMs) || opts.pollMs <= 0) {
    throw new Error("awaitSignatureConfirmation: pollMs must be a positive number");
  }
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      const statuses = await connectionLike.getSignatureStatuses([signature]);
      const st = statuses.value[0] ?? null;
      if (st !== null) {
        if (st.err !== null && st.err !== undefined) {
          return {
            kind: "on-chain-failed",
            err: typeof st.err === "string" ? st.err : JSON.stringify(st.err),
          };
        }
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
          return { kind: "seen", commitment: st.confirmationStatus };
        }
      }
    } catch {
      // RPC hiccup — "not seen yet", never "failed". Loop until deadline.
    }
    if (opts.onPoll) opts.onPoll(opts.timeoutMs - (deadline - Date.now()));
    if (Date.now() >= deadline || (opts.isAborted?.() ?? false)) {
      return { kind: "timeout" };
    }
    await sleep(Math.min(opts.pollMs, Math.max(0, deadline - Date.now())));
  }
}

export type ClaimRecordReconciliation =
  | { kind: "found"; atUnixMs: number }
  | { kind: "absent"; atUnixMs: number }
  | { kind: "inconclusive"; error: string; atUnixMs: number };

/**
 * The honesty gate: re-read the ClaimRecord PDA the server derived (via the
 * canonical SDK) from devnet. Existence of the init-once record is the
 * on-chain evidence the claim was processed; a failed READ is inconclusive
 * — it must never collapse to "absent" (absence would read as "not paid").
 */
export async function reconcileClaimRecord(
  connectionLike: StatusConnection,
  claimRecordPda: string,
): Promise<ClaimRecordReconciliation> {
  const atUnixMs = Date.now();
  let info: { data: Uint8Array | unknown[] } | null;
  try {
    info = await connectionLike.getAccountInfo(claimRecordPda);
  } catch (err) {
    return {
      kind: "inconclusive",
      error: String((err as Error).message ?? err).slice(0, 200),
      atUnixMs,
    };
  }
  if (info === null) return { kind: "absent", atUnixMs };
  // A found record carries data; anything else is malformed and inconclusive.
  if (info.data === undefined || info.data === null) {
    return { kind: "inconclusive", error: "record account returned no data", atUnixMs };
  }
  return { kind: "found", atUnixMs };
}
