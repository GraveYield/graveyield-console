// TX MACHINE (P4.5) — the console's one transaction state machine.
//
// The owner's vocabulary, exactly (Phase 4.0 audit §6 Phase 4.5):
//
//   not-prepared → prepared → simulated → awaiting-wallet-approval →
//   submitted → reconciling → confirmed
//                                        ↘ failed / confirmation-unknown
//
// HONESTY RULES baked into the transition table (each is test-pinned):
//
//   1. "prepared"     means only that the canonical-SDK instruction exists
//                     and is unsigned — nothing moved, nothing was promised.
//   2. "simulated"    means the console asked the RPC to dry-run the exact
//                     transaction and the RPC answered without an error — it
//                     is still unsigned and still moves nothing.
//   3. "awaiting-wallet-approval" is the ONLY state from which a signature
//                     can be requested; the wallet, not the console, signs.
//   4. "submitted"    means the wallet broadcast a transaction — it is NOT a
//                     payment and the UI never words it as one.
//   5. "reconciling"  → "confirmed" is the ONLY path to confirmed: the
//                     console itself re-read the protocol's on-chain record
//                     (ClaimRecord PDA) and found it. A signature confirming
//                     is not evidence a claim was paid — the record is.
//   6. "confirmation-unknown" is deliberately NOT "failed": a timeout or an
//                     inconclusive read means the chain may still settle.
//                     It recovers through re-check (confirm-seen) or an
//                     explicit operator decision to re-prepare.
//   7. "failed" means no claim happened — the UI note states no lamports
//                     moved unless an earlier confirmed record exists.
//   8. At-most-once in-flight submission: `submit-ok` is only valid from
//                     awaiting-wallet-approval — a state unreachable while a
//                     submission is being waited on — so a second broadcast
//                     during submitted/reconciling is structurally
//                     impossible, and UI double-clicks are refused and
//                     counted (`duplicate-submit-refused`). A retry after an
//                     UNKNOWN outcome is the explicit operator path
//                     (re-prepare): the prior signature stays in the history
//                     and the Explorer link, and the protocol's init-once
//                     ClaimRecord (7010/7011) remains the on-chain
//                     double-claim defense — this machine's suppression is
//                     the UX-level belt.
//
// The module is PURE and ISOMORPHIC: no React, no RPC, no wallet. Callers
// (components/gy/claims.tsx) drive real I/O and feed events in; every event
// outcome is deterministic and unit-tested. Invalid transitions throw — a
// machine that quietly ignores an impossible transition would be a place
// where a lie could hide.

export type TxState =
  | "not-prepared"
  | "prepared"
  | "simulated"
  | "awaiting-wallet-approval"
  | "submitted"
  | "reconciling"
  | "confirmed"
  | "failed"
  | "confirmation-unknown";

export type TxEvent =
  | { type: "prepare" }
  | { type: "re-prepare"; reason: string }
  | { type: "simulate-ok" }
  | { type: "simulate-failed"; reason: string }
  | { type: "request-approval" }
  | { type: "submit-ok"; signature: string }
  | { type: "wallet-rejected"; reason: string }
  | { type: "submit-failed"; reason: string }
  | { type: "confirm-seen"; commitment: "confirmed" | "finalized" }
  | { type: "confirm-timeout" }
  | { type: "on-chain-failed"; reason: string }
  | { type: "reconcile-found"; atUnixMs: number }
  | { type: "reconcile-absent"; reason: string }
  | { type: "reconcile-inconclusive"; reason: string }
  | { type: "duplicate-submit-refused" };

export interface TxHistoryEntry {
  state: TxState;
  atUnixMs: number;
  note: string | null;
}

export interface TxMachineState {
  state: TxState;
  /** The tracked live submission (null until one is broadcast). */
  signature: string | null;
  /** Every signature ever broadcast by this machine run — at-most-once is
   * per-broadcast; a re-prepared retry appends rather than overwrites. */
  signatureHistory: string[];
  /** Last failure / timeout / refusal reason (null while riding a happy path). */
  reason: string | null;
  /** How many times preparation was redone (blockhash expiry re-preparation). */
  reprepareCount: number;
  /** How many duplicate submissions were suppressed. */
  duplicateSuppressedCount: number;
  /** Set ONLY by reconcile-found — the one honest "confirmed" stamp. */
  confirmedAtUnixMs: number | null;
  updatedAtUnixMs: number;
  history: TxHistoryEntry[];
}

export function initialTxState(nowUnixMs: number): TxMachineState {
  return {
    state: "not-prepared",
    signature: null,
    signatureHistory: [],
    reason: null,
    reprepareCount: 0,
    duplicateSuppressedCount: 0,
    confirmedAtUnixMs: null,
    updatedAtUnixMs: nowUnixMs,
    history: [{ state: "not-prepared", atUnixMs: nowUnixMs, note: null }],
  };
}

export class TxTransitionError extends Error {
  constructor(event: TxEvent["type"], state: TxState) {
    super(`tx machine: event "${event}" is not valid in state "${state}"`);
    this.name = "TxTransitionError";
  }
}

/** Terminal states — no event is valid in them. */
export function isTerminalTxState(state: TxState): boolean {
  return state === "confirmed" || state === "failed";
}

/** States in which something is visibly in flight (busy indicators). */
export function isTxInFlight(state: TxState): boolean {
  return (
    state === "prepared" ||
    state === "simulated" ||
    state === "awaiting-wallet-approval" ||
    state === "submitted" ||
    state === "reconciling"
  );
}

/** The pre-broadcast states a fresh preparation may replace. */
const REPREPARABLE: ReadonlySet<TxState> = new Set<TxState>([
  "prepared",
  "simulated",
  "awaiting-wallet-approval",
  "confirmation-unknown",
]);

/**
 * The reducer. Throws TxTransitionError on any transition the table does
 * not define — see the module header for why failing loudly is the point.
 */
export function reduceTx(tx: TxMachineState, event: TxEvent, nowUnixMs: number): TxMachineState {
  if (isTerminalTxState(tx.state)) {
    throw new TxTransitionError(event.type, tx.state);
  }

  // Duplicate suppression (audit: "duplicate-suppressed resubmission"): a
  // submit while a broadcast is tracked is an expected UI double-click, not
  // an impossible transition — it is refused and counted, never re-broadcast.
  if (event.type === "duplicate-submit-refused") {
    if (tx.signature === null) {
      throw new TxTransitionError(event.type, tx.state);
    }
    return {
      ...tx,
      duplicateSuppressedCount: tx.duplicateSuppressedCount + 1,
      updatedAtUnixMs: nowUnixMs,
    };
  }

  // At-most-once in flight: submit-ok is only valid from
  // awaiting-wallet-approval — a state that cannot be reached while a
  // submission is being waited on (its only entries are request-approval
  // from simulated and re-prepare → prepare → simulate → request-approval).
  // The tracked `signature` is the LATEST broadcast; retries append to
  // signatureHistory rather than overwrite it.
  if (event.type === "submit-ok") {
    if (tx.state !== "awaiting-wallet-approval") {
      throw new TxTransitionError(event.type, tx.state);
    }
    return commit(tx, "submitted", nowUnixMs, (next) => ({
      ...next,
      signature: event.signature,
      signatureHistory: [...tx.signatureHistory, event.signature],
      reason: null,
    }));
  }

  if (event.type === "prepare") {
    if (tx.state !== "not-prepared") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "prepared", nowUnixMs, (next) => ({ ...next, reason: null }));
  }

  if (event.type === "re-prepare") {
    if (!REPREPARABLE.has(tx.state)) throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "prepared", nowUnixMs, (next) => ({
      ...next,
      reprepareCount: tx.reprepareCount + 1,
      reason: `re-prepared: ${event.reason}`,
    }));
  }

  if (event.type === "simulate-ok") {
    if (tx.state !== "prepared") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "simulated", nowUnixMs, (next) => ({ ...next, reason: null }));
  }

  if (event.type === "simulate-failed") {
    if (tx.state !== "prepared") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "failed", nowUnixMs, (next) => ({
      ...next,
      reason: event.reason,
    }));
  }

  if (event.type === "request-approval") {
    if (tx.state !== "simulated") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "awaiting-wallet-approval", nowUnixMs, (next) => next);
  }

  if (event.type === "wallet-rejected") {
    if (tx.state !== "awaiting-wallet-approval") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "failed", nowUnixMs, (next) => ({
      ...next,
      reason: event.reason,
    }));
  }

  if (event.type === "submit-failed") {
    if (tx.state !== "awaiting-wallet-approval") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "failed", nowUnixMs, (next) => ({
      ...next,
      reason: event.reason,
    }));
  }

  if (event.type === "confirm-seen") {
    if (tx.state !== "submitted" && tx.state !== "confirmation-unknown") {
      throw new TxTransitionError(event.type, tx.state);
    }
    return commit(tx, "reconciling", nowUnixMs, (next) => next, `commitment ${event.commitment}`);
  }

  if (event.type === "confirm-timeout") {
    if (tx.state !== "submitted") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "confirmation-unknown", nowUnixMs, (next) => ({
      ...next,
      reason:
        "Confirmation window elapsed — the transaction may still settle on devnet. This is unknown, not failed; the console will not display paid either way without the on-chain record.",
    }));
  }

  if (event.type === "on-chain-failed") {
    if (tx.state !== "submitted") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "failed", nowUnixMs, (next) => ({
      ...next,
      reason: event.reason,
    }));
  }

  if (event.type === "reconcile-found") {
    if (tx.state !== "reconciling") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "confirmed", nowUnixMs, (next) => ({
      ...next,
      confirmedAtUnixMs: event.atUnixMs,
      reason: null,
    }));
  }

  if (event.type === "reconcile-absent") {
    if (tx.state !== "reconciling") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "failed", nowUnixMs, (next) => ({
      ...next,
      reason: event.reason,
    }));
  }

  if (event.type === "reconcile-inconclusive") {
    if (tx.state !== "reconciling") throw new TxTransitionError(event.type, tx.state);
    return commit(tx, "confirmation-unknown", nowUnixMs, (next) => ({
      ...next,
      reason: event.reason,
    }));
  }

  throw new TxTransitionError((event as { type: string }).type as TxEvent["type"], tx.state);
}

function commit(
  tx: TxMachineState,
  next: TxState,
  nowUnixMs: number,
  mutate: (base: TxMachineState) => TxMachineState,
  note: string | null = null,
): TxMachineState {
  const mutated = mutate({ ...tx, state: next });
  const stamped: TxMachineState = { ...mutated, updatedAtUnixMs: nowUnixMs };
  return {
    ...stamped,
    history: [...tx.history, { state: next, atUnixMs: nowUnixMs, note: note ?? failureNote(stamped) }],
  };
}

/** A failure-path transition records its reason in the history note. */
function failureNote(stamped: TxMachineState): string | null {
  return stamped.state === "failed" || stamped.state === "confirmation-unknown" ? stamped.reason : null;
}

/* ── UI vocabulary ────────────────────────────────────────────────────
 * Honest labels + standing notes, one wording for every surface. */

export interface TxStateMeta {
  label: string;
  tone: "ok" | "info" | "warn" | "bad" | "muted" | "brand";
  note: string;
}

export const TX_STATE_META: Record<TxState, TxStateMeta> = {
  "not-prepared": {
    label: "not prepared",
    tone: "muted",
    note: "",
  },
  prepared: {
    label: "transaction prepared",
    tone: "info",
    note: "The claim instruction is built from the sealed distribution via the canonical SDK. It is unsigned — nothing has moved.",
  },
  simulated: {
    label: "simulated — not submitted",
    tone: "info",
    note: "Devnet dry-ran the exact unsigned transaction and reported no error. Review the result, then approve in the wallet — or walk away.",
  },
  "awaiting-wallet-approval": {
    label: "awaiting wallet approval",
    tone: "info",
    note: "The wallet is asking for a signature — the claim is not submitted yet.",
  },
  submitted: {
    label: "submitted — awaiting confirmation",
    tone: "warn",
    note: "The transaction was broadcast to devnet. Submitted is not paid — confirmation and the on-chain claim record are still pending.",
  },
  reconciling: {
    label: "reconciling on-chain record",
    tone: "warn",
    note: "The transaction confirmed at the stated commitment — the console is now re-reading the ClaimRecord PDA from devnet. Only the record makes this confirmed.",
  },
  confirmed: {
    label: "confirmed",
    tone: "ok",
    note: "The ClaimRecord PDA was re-read from devnet — the claim is on-chain record-backed.",
  },
  failed: {
    label: "failed",
    tone: "bad",
    note: "The claim did not go through — no lamports moved (unless an earlier confirmed claim record exists on-chain).",
  },
  "confirmation-unknown": {
    label: "confirmation unknown",
    tone: "warn",
    note: "The outcome is unknown — the transaction may still settle. Re-check the status or re-prepare with a fresh blockhash; the console displays neither paid nor failed without evidence.",
  },
};
