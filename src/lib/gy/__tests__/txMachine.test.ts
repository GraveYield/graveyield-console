// P4.5 — the tx state machine battery.
//
// The machine is the console's one honesty boundary for user-initiated
// transactions: these tests pin the full transition table, every failure
// branch the audit required (wallet rejection, simulation failure, submission
// failure, confirmation timeout, blockhash-expiry re-preparation, duplicate
// suppression), and the two structural invariants:
//
//   · "confirmed" is reachable ONLY through reconciliation (the edge
//     (reconciling, reconcile-found)) — proven exhaustively over the whole
//     table, not by example paths;
//   · a tracked signature is immutable — a second broadcast is refused, and
//     only awaiting-wallet-approval can produce the first one.

import { describe, expect, test } from "bun:test";

import {
  TX_STATE_META,
  initialTxState,
  isTerminalTxState,
  isTxInFlight,
  reduceTx,
  TxTransitionError,
  type TxEvent,
  type TxMachineState,
  type TxState,
} from "../tx/machine";

const T0 = 1_700_000_000_000;

const SIG = "5Ey4FkFpttDfvsLQQQkvCLPaBKQLexUyP2yt3nineZisvbeWBjgSAGmgoDJpVhjRJWUw5DhiWWGn7VCaWW9fd";

function run(events: TxEvent[]): TxMachineState {
  let tx = initialTxState(T0);
  for (const e of events) tx = reduceTx(tx, e, T0 + tx.history.length);
  return tx;
}

/** Canonical event paths to each non-terminal state. */
const PATHS: Record<Exclude<TxState, "not-prepared" | "confirmed" | "failed">, TxEvent[]> = {
  prepared: [{ type: "prepare" }],
  simulated: [{ type: "prepare" }, { type: "simulate-ok" }],
  "awaiting-wallet-approval": [
    { type: "prepare" },
    { type: "simulate-ok" },
    { type: "request-approval" },
  ],
  submitted: [
    { type: "prepare" },
    { type: "simulate-ok" },
    { type: "request-approval" },
    { type: "submit-ok", signature: SIG },
  ],
  reconciling: [
    { type: "prepare" },
    { type: "simulate-ok" },
    { type: "request-approval" },
    { type: "submit-ok", signature: SIG },
    { type: "confirm-seen", commitment: "confirmed" },
  ],
  "confirmation-unknown": [
    { type: "prepare" },
    { type: "simulate-ok" },
    { type: "request-approval" },
    { type: "submit-ok", signature: SIG },
    { type: "confirm-timeout" },
  ],
};

describe("tx machine — happy path", () => {
  test("prepare → simulate → approve → submit → confirm-seen → reconcile-found → confirmed", () => {
    const tx = run([
      { type: "prepare" },
      { type: "simulate-ok" },
      { type: "request-approval" },
      { type: "submit-ok", signature: SIG },
      { type: "confirm-seen", commitment: "finalized" },
      { type: "reconcile-found", atUnixMs: 42 },
    ]);
    expect(tx.state).toBe("confirmed");
    expect(tx.signature).toBe(SIG);
    expect(tx.confirmedAtUnixMs).toBe(42);
    expect(tx.reason).toBeNull();
    expect(tx.signatureHistory).toEqual([SIG]);
  });

  test("submit-ok alone never reads as confirmed — submitted is not paid", () => {
    const tx = run(PATHS.submitted);
    expect(tx.state).toBe("submitted");
    expect(tx.confirmedAtUnixMs).toBeNull();
  });

  test("the history records each stage with monotonic timestamps", () => {
    const tx = run([...PATHS.reconciling, { type: "reconcile-found", atUnixMs: 42 }]);
    const stamps = tx.history.map((h) => h.atUnixMs);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
    expect(tx.history[0].state).toBe("not-prepared");
    expect(tx.history[tx.history.length - 1].state).toBe("confirmed");
  });

  test("confirm-seen records the stated commitment in the history note", () => {
    const tx = run([...PATHS.submitted, { type: "confirm-seen", commitment: "finalized" }]);
    const last = tx.history[tx.history.length - 1];
    expect(last.state).toBe("reconciling");
    expect(last.note).toBe("commitment finalized");
  });
});

describe("tx machine — every failure branch", () => {
  test("wallet rejection: failed, nothing signed, reason carried", () => {
    const tx = run([...PATHS["awaiting-wallet-approval"], { type: "wallet-rejected", reason: "user rejected" }]);
    expect(tx.state).toBe("failed");
    expect(tx.signature).toBeNull();
    expect(tx.signatureHistory).toEqual([]);
    expect(tx.reason).toBe("user rejected");
  });

  test("submission failure (broadcast error): failed with reason", () => {
    const tx = run([...PATHS["awaiting-wallet-approval"], { type: "submit-failed", reason: "rpc down" }]);
    expect(tx.state).toBe("failed");
    expect(tx.signature).toBeNull();
  });

  test("simulation failure: failed before anything reached a wallet", () => {
    const tx = run([{ type: "prepare" }, { type: "simulate-failed", reason: "7010 InvalidClaimProof" }]);
    expect(tx.state).toBe("failed");
    expect(tx.reason).toBe("7010 InvalidClaimProof");
    expect(tx.signature).toBeNull();
  });

  test("on-chain failure after broadcast: failed with the program's verdict", () => {
    const tx = run([...PATHS.submitted, { type: "on-chain-failed", reason: "0x1b6d" }]);
    expect(tx.state).toBe("failed");
    expect(tx.reason).toBe("0x1b6d");
  });

  test("confirmation timeout is UNKNOWN, not failed — the tx may still settle", () => {
    const tx = run([...PATHS.submitted, { type: "confirm-timeout" }]);
    expect(tx.state).toBe("confirmation-unknown");
    expect(tx.state).not.toBe("failed");
    expect(tx.reason).toContain("unknown, not failed");
  });

  test("inconclusive record read is UNKNOWN, never collapsed to absent/failed", () => {
    const tx = run([...PATHS.reconciling, { type: "reconcile-inconclusive", reason: "read failed" }]);
    expect(tx.state).toBe("confirmation-unknown");
    expect(tx.reason).toBe("read failed");
  });

  test("record absent after a confirmed tx is the honest failed", () => {
    const tx = run([...PATHS.reconciling, { type: "reconcile-absent", reason: "PDA absent" }]);
    expect(tx.state).toBe("failed");
    expect(tx.reason).toBe("PDA absent");
  });

  test("terminal states are terminal — every event throws", () => {
    const failed = run([{ type: "prepare" }, { type: "simulate-failed", reason: "x" }]);
    const confirmed = run([...PATHS.reconciling, { type: "reconcile-found", atUnixMs: 1 }]);
    for (const tx of [failed, confirmed]) {
      for (const e of ALL_EVENTS) {
        expect(() => reduceTx(tx, e, T0 + 1)).toThrow(TxTransitionError);
      }
    }
  });
});

describe("tx machine — recovery paths", () => {
  test("confirmation-unknown recovers: re-check sees the tx → reconciling → confirmed", () => {
    const tx = run([
      ...PATHS["confirmation-unknown"],
      { type: "confirm-seen", commitment: "confirmed" },
      { type: "reconcile-found", atUnixMs: 7 },
    ]);
    expect(tx.state).toBe("confirmed");
    expect(tx.confirmedAtUnixMs).toBe(7);
  });

  test("blockhash-expiry re-preparation: valid from pre-broadcast states AND confirmation-unknown", () => {
    for (const [state, events] of Object.entries(PATHS) as [TxState, TxEvent[]][]) {
      if (state === "reconciling" || state === "submitted") continue; // mid-flight, not repreparable
      const tx = reduceTx(run(events), { type: "re-prepare", reason: "blockhash expired" }, T0 + 99);
      expect(tx.state).toBe("prepared");
      expect(tx.reprepareCount).toBe(1);
      expect(tx.reason).toBe("re-prepared: blockhash expired");
    }
  });

  test("re-prepare is refused mid-flight and from not-prepared", () => {
    expect(() => reduceTx(initialTxState(T0), { type: "re-prepare", reason: "x" }, T0)).toThrow(TxTransitionError);
    expect(() => reduceTx(run(PATHS.submitted), { type: "re-prepare", reason: "x" }, T0)).toThrow(TxTransitionError);
    expect(() => reduceTx(run(PATHS.reconciling), { type: "re-prepare", reason: "x" }, T0)).toThrow(TxTransitionError);
  });

  test("a re-prepared run keeps the prior signatures in its history", () => {
    const tx = run([
      ...PATHS["confirmation-unknown"],
      { type: "re-prepare", reason: "operator: fresh blockhash" },
      { type: "simulate-ok" },
      { type: "request-approval" },
      { type: "submit-ok", signature: "SIG2" },
    ]);
    expect(tx.signature).toBe("SIG2");
    expect(tx.signatureHistory).toEqual([SIG, "SIG2"]);
    expect(tx.state).toBe("submitted");
  });
});

describe("tx machine — at-most-once (duplicate suppression)", () => {
  test("duplicate-submit-refused is a counted no-op while a signature is tracked", () => {
    const submitted = run(PATHS.submitted);
    const tx = reduceTx(submitted, { type: "duplicate-submit-refused" }, T0 + 50);
    expect(tx.state).toBe("submitted");
    expect(tx.signature).toBe(SIG);
    expect(tx.duplicateSuppressedCount).toBe(1);
    expect(tx.history.length).toBe(submitted.history.length);
  });

  test("a second submit-ok without re-approval is an impossible transition", () => {
    expect(() => reduceTx(run(PATHS.submitted), { type: "submit-ok", signature: "SIG2" }, T0)).toThrow(TxTransitionError);
  });

  test("duplicate suppression requires a tracked signature", () => {
    expect(() => reduceTx(run(PATHS["awaiting-wallet-approval"]), { type: "duplicate-submit-refused" }, T0)).toThrow(TxTransitionError);
    expect(() => reduceTx(initialTxState(T0), { type: "duplicate-submit-refused" }, T0)).toThrow(TxTransitionError);
  });
});

/* ── The structural invariants — exhaustive over the transition table ── */

const ALL_EVENTS: TxEvent[] = [
  { type: "prepare" },
  { type: "re-prepare", reason: "sweep" },
  { type: "simulate-ok" },
  { type: "simulate-failed", reason: "sweep" },
  { type: "request-approval" },
  { type: "submit-ok", signature: "SIG_SWEEP" },
  { type: "wallet-rejected", reason: "sweep" },
  { type: "submit-failed", reason: "sweep" },
  { type: "confirm-seen", commitment: "confirmed" },
  { type: "confirm-timeout" },
  { type: "on-chain-failed", reason: "sweep" },
  { type: "reconcile-found", atUnixMs: 1 },
  { type: "reconcile-absent", reason: "sweep" },
  { type: "reconcile-inconclusive", reason: "sweep" },
  { type: "duplicate-submit-refused" },
];

describe("tx machine — structural invariants (exhaustive sweep)", () => {
  const NON_TERMINAL: TxState[] = [
    "not-prepared",
    "prepared",
    "simulated",
    "awaiting-wallet-approval",
    "submitted",
    "reconciling",
    "confirmation-unknown",
  ];

  interface Edge {
    from: TxState;
    event: TxEvent["type"];
    to: TxState;
    signatureBefore: string | null;
    signatureAfter: string | null;
  }

  /** Every defined edge of the table, probed with a representative machine. */
  const edges: Edge[] = [];
  for (const state of NON_TERMINAL) {
    const tx = state === "not-prepared" ? initialTxState(T0) : run(PATHS[state as keyof typeof PATHS]);
    for (const e of ALL_EVENTS) {
      try {
        const next = reduceTx(tx, e, T0 + 1);
        edges.push({
          from: state,
          event: e.type,
          to: next.state,
          signatureBefore: tx.signature,
          signatureAfter: next.signature,
        });
      } catch {
        // transition not defined — exactly what the table should do
      }
    }
  }

  test("the only edge into confirmed is (reconciling, reconcile-found)", () => {
    const into = edges.filter((e) => e.to === "confirmed");
    expect(into.length).toBe(1);
    expect(into[0].from).toBe("reconciling");
    expect(into[0].event).toBe("reconcile-found");
  });

  test("every edge into failed is a failure event", () => {
    const failures = new Set(["simulate-failed", "wallet-rejected", "submit-failed", "on-chain-failed", "reconcile-absent"]);
    for (const e of edges.filter((e) => e.to === "failed")) {
      expect(failures.has(e.event)).toBe(true);
    }
  });

  test("a signature changes only on submit-ok edges — and only from awaiting-wallet-approval", () => {
    for (const e of edges) {
      if (e.event === "submit-ok") {
        expect(e.from).toBe("awaiting-wallet-approval");
        expect(e.signatureAfter).not.toBeNull();
      } else {
        expect(e.signatureAfter).toBe(e.signatureBefore);
      }
    }
  });

  test("failures before a broadcast leave no signature — nothing was signed, nothing moved", () => {
    for (const e of edges) {
      if (e.to === "failed" && (e.event === "simulate-failed" || e.event === "wallet-rejected" || e.event === "submit-failed")) {
        expect(e.signatureAfter).toBeNull();
      }
    }
  });

  test("the chain of entries proves confirmed requires a broadcast on its own path", () => {
    // BFS with a global broadcast flag is path-insensitive; the airtight form
    // is the entry-chain: reconciling only from submitted/unknown, submitted
    // only via submit-ok from awaiting, awaiting only via request-approval
    // from simulated, simulated only via simulate-ok from prepared. Every
    // path to confirmed therefore passes submit-ok.
    const from = (s: TxState) => edges.filter((e) => e.from === s);
    // Entries into reconciling: only confirm-seen from submitted/unknown,
    // plus the counted duplicate-suppression self-edge.
    const reconcilingEntries = edges.filter((e) => e.to === "reconciling");
    expect(reconcilingEntries.length).toBeGreaterThan(0);
    for (const e of reconcilingEntries) {
      if (e.event === "duplicate-submit-refused") {
        expect(e.from).toBe("reconciling");
      } else {
        expect(e.event).toBe("confirm-seen");
        expect(["submitted", "confirmation-unknown"]).toContain(e.from);
      }
    }
    // Departures from reconciling: only the three reconciliation outcomes
    // and the counted duplicate no-op.
    for (const e of from("reconciling")) {
      expect(["reconcile-found", "reconcile-absent", "reconcile-inconclusive", "duplicate-submit-refused"]).toContain(e.event);
    }
    const submittedEntries = edges.filter((e) => e.to === "submitted");
    expect(submittedEntries.length).toBeGreaterThan(0);
    for (const e of submittedEntries) {
      // Real entries come only from an approval; the duplicate-suppression
      // self-edge is the counted no-op.
      if (e.event === "duplicate-submit-refused") {
        expect(e.from).toBe("submitted");
      } else {
        expect(e.from).toBe("awaiting-wallet-approval");
        expect(e.event).toBe("submit-ok");
      }
    }
    const awaitingEntries = edges.filter((e) => e.to === "awaiting-wallet-approval");
    for (const e of awaitingEntries) {
      expect(e.from).toBe("simulated");
      expect(e.event).toBe("request-approval");
    }
    const simulatedEntries = edges.filter((e) => e.to === "simulated");
    for (const e of simulatedEntries) {
      expect(e.from).toBe("prepared");
      expect(e.event).toBe("simulate-ok");
    }
    // And confirmed is reached only from reconciling (asserted above), so
    // every confirmed path traverses submit-ok — a broadcast — first.
  });

  test("every state renders UI metadata with honest wording", () => {
    const states: TxState[] = [...NON_TERMINAL, "confirmed", "failed"];
    for (const s of states) {
      const meta = TX_STATE_META[s];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.note).toBe("string");
    }
    expect(TX_STATE_META.submitted.note).toContain("not paid");
    expect(TX_STATE_META.failed.note).toContain("no lamports moved");
    expect(TX_STATE_META["confirmation-unknown"].note).toContain("may still settle");
    expect(TX_STATE_META.confirmed.note).toContain("ClaimRecord");
  });
});

describe("tx machine — helpers", () => {
  test("isTerminalTxState / isTxInFlight truth tables", () => {
    expect(isTerminalTxState("confirmed")).toBe(true);
    expect(isTerminalTxState("failed")).toBe(true);
    for (const s of ["not-prepared", "prepared", "simulated", "awaiting-wallet-approval", "submitted", "reconciling", "confirmation-unknown"] as TxState[]) {
      expect(isTerminalTxState(s)).toBe(false);
    }
    expect(isTxInFlight("not-prepared")).toBe(false);
    expect(isTxInFlight("confirmed")).toBe(false);
    expect(isTxInFlight("failed")).toBe(false);
    expect(isTxInFlight("confirmation-unknown")).toBe(false);
    for (const s of ["prepared", "simulated", "awaiting-wallet-approval", "submitted", "reconciling"] as TxState[]) {
      expect(isTxInFlight(s)).toBe(true);
    }
  });

  test("invalid event/state pairs throw with a precise message", () => {
    try {
      reduceTx(initialTxState(T0), { type: "simulate-ok" }, T0);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TxTransitionError);
      expect((err as Error).message).toBe('tx machine: event "simulate-ok" is not valid in state "not-prepared"');
    }
  });
});
