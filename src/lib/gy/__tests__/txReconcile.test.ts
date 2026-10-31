// P4.5 — reconcile battery: the bounded confirmation wait and the
// ClaimRecord reconciliation gate. The load-bearing fail-closed rule under
// test: a FAILED READ is inconclusive — it must never collapse to "absent"
// (absence reads as "not paid", and a read error is not evidence), and a
// TIMEOUT is unknown — never failed (a broadcast tx may still settle).

import { describe, expect, test } from "bun:test";

import {
  awaitSignatureConfirmation,
  reconcileClaimRecord,
  type StatusConnection,
} from "../tx/reconcile";
import { initialTxState, reduceTx } from "../tx/machine";

function conn(impl: {
  getSignatureStatuses?: StatusConnection["getSignatureStatuses"];
  getAccountInfo?: StatusConnection["getAccountInfo"];
}): StatusConnection {
  return impl as StatusConnection;
}

const STATUS = (confirmationStatus: "processed" | "confirmed" | "finalized" | null, err: unknown = null) => ({
  value: [{ err, confirmationStatus }],
});

describe("awaitSignatureConfirmation — the bounded wait at the stated commitment", () => {
  test("confirmed at the stated commitment", async () => {
    const c = conn({ getSignatureStatuses: async () => STATUS("confirmed") });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 500, pollMs: 10 });
    expect(out).toEqual({ kind: "seen", commitment: "confirmed" });
  });

  test("finalized counts as seen — with its own commitment", async () => {
    const c = conn({ getSignatureStatuses: async () => STATUS("finalized") });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 500, pollMs: 10 });
    expect(out).toEqual({ kind: "seen", commitment: "finalized" });
  });

  test("processed is NOT seen — the wait continues", async () => {
    let calls = 0;
    const c = conn({
      getSignatureStatuses: async () => {
        calls++;
        return STATUS("processed");
      },
    });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 60, pollMs: 10 });
    expect(out).toEqual({ kind: "timeout" });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("an on-chain error terminates as on-chain-failed with the program's verdict", async () => {
    const c = conn({ getSignatureStatuses: async () => STATUS(null, "0x1b6d") });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 500, pollMs: 10 });
    expect(out).toEqual({ kind: "on-chain-failed", err: "0x1b6d" });

    const obj = conn({
      getSignatureStatuses: async () => STATUS(null, { InstructionError: [0, { Custom: 7011 }] }),
    });
    const out2 = await awaitSignatureConfirmation(obj, "SIG", { timeoutMs: 500, pollMs: 10 });
    expect(out2.kind).toBe("on-chain-failed");
    if (out2.kind === "on-chain-failed") expect(out2.err).toContain("7011");
  });

  test("statuses missing keeps polling until the deadline — then timeout, NOT failed", async () => {
    const c = conn({ getSignatureStatuses: async () => ({ value: [null] }) });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 80, pollMs: 10 });
    expect(out).toEqual({ kind: "timeout" });
  });

  test("an RPC failure is 'not seen yet', never failure — resilience until deadline", async () => {
    let calls = 0;
    const c = conn({
      getSignatureStatuses: async () => {
        calls++;
        if (calls < 3) throw new Error("rpc hiccup");
        return STATUS("confirmed");
      },
    });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 2_000, pollMs: 10 });
    expect(out).toEqual({ kind: "seen", commitment: "confirmed" });
  });

  test("an RPC that never answers ends in timeout — the machine shows unknown", async () => {
    const c = conn({
      getSignatureStatuses: async () => {
        throw new Error("rpc down");
      },
    });
    const out = await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 60, pollMs: 10 });
    expect(out).toEqual({ kind: "timeout" });
  });

  test("abort stops the loop as timeout (outcome genuinely unknown)", async () => {
    let aborted = false;
    const c = conn({ getSignatureStatuses: async () => ({ value: [null] }) });
    const out = await awaitSignatureConfirmation(c, "SIG", {
      timeoutMs: 10_000,
      pollMs: 5,
      isAborted: () => aborted,
      onPoll: () => {
        aborted = true; // unmount after the first poll — the loop must end
      },
    });
    expect(out).toEqual({ kind: "timeout" });
  });

  test("invalid options throw — no silent zero-timeout waits", async () => {
    const c = conn({ getSignatureStatuses: async () => STATUS("confirmed") });
    expect(await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 0, pollMs: 10 }).catch((e: Error) => e.message)).toContain("timeoutMs");
    expect(await awaitSignatureConfirmation(c, "SIG", { timeoutMs: 10, pollMs: 0 }).catch((e: Error) => e.message)).toContain("pollMs");
  });
});

describe("reconcileClaimRecord — the honesty gate", () => {
  test("a found record is the one path to 'found'", async () => {
    const c = conn({ getAccountInfo: async () => ({ data: Uint8Array.from([1, 2, 3]) }) });
    const out = await reconcileClaimRecord(c, "PDA");
    expect(out.kind).toBe("found");
  });

  test("a clean read showing no account is 'absent' — the honest not-paid", async () => {
    const c = conn({ getAccountInfo: async () => null });
    const out = await reconcileClaimRecord(c, "PDA");
    expect(out.kind).toBe("absent");
  });

  test("a read error is INCONCLUSIVE — never 'absent' (absence would read as not paid)", async () => {
    const c = conn({
      getAccountInfo: async () => {
        throw new Error("rpc 429");
      },
    });
    const out = await reconcileClaimRecord(c, "PDA");
    expect(out.kind).toBe("inconclusive");
    if (out.kind === "inconclusive") expect(out.error).toContain("429");
    expect(out.kind).not.toBe("absent");
  });

  test("a malformed record (no data) is inconclusive, not found", async () => {
    const c = conn({ getAccountInfo: async () => ({ data: undefined }) as never });
    const out = await reconcileClaimRecord(c, "PDA");
    expect(out.kind).toBe("inconclusive");
  });
});

describe("machine mapping of reconciliation outcomes (cross-module honesty wiring)", () => {
  const RECONCILING = [
    { type: "prepare" },
    { type: "simulate-ok" },
    { type: "request-approval" },
    { type: "submit-ok", signature: "SIG" },
    { type: "confirm-seen", commitment: "confirmed" },
  ] as const;

  test("found → confirmed; absent → failed; inconclusive → confirmation-unknown", () => {
    let tx = initialTxState(0);
    for (const e of RECONCILING) tx = reduceTx(tx, e, 1);
    const found = reduceTx(tx, { type: "reconcile-found", atUnixMs: 2 }, 2);
    expect(found.state).toBe("confirmed");

    const absent = reduceTx(tx, { type: "reconcile-absent", reason: "absent" }, 2);
    expect(absent.state).toBe("failed");

    const inconclusive = reduceTx(tx, { type: "reconcile-inconclusive", reason: "read failed" }, 2);
    expect(inconclusive.state).toBe("confirmation-unknown");
    expect(inconclusive.state).not.toBe("failed");
  });
});
