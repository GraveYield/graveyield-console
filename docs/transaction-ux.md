# Transaction UX — the one console state machine (P4.5)

The console has exactly one transaction path: the protocol's own `claim_lp_proceeds`,
built by the **vendored canonical SDK** and signed exclusively by the connected
wallet. Every user-initiated transaction rides the shared machine in
`src/lib/gy/tx/machine.ts` — a pure, isomorphic reducer whose transition table is
the honesty boundary, pinned test-first by `src/lib/gy/__tests__/txMachine.test.ts`.

This module exists because the Phase 4.0 audit's failure matrix required it:
wallet rejection, simulation failure, blockhash expiry, confirmation timeout, and
duplicate-suppressed resubmission each had to be **explicit terminal (or
recovery) states with reasons — and no success indication without confirmed
on-chain state**.

## The states

```
not-prepared → prepared → simulated → awaiting-wallet-approval →
submitted → reconciling → confirmed
                           ↘ failed        (five failure events, each with a reason)
                           ↘ confirmation-unknown   (timeout / inconclusive read)
```

| State | Meaning (the UI's exact wording) | Notes |
| --- | --- | --- |
| `not-prepared` | not prepared | nothing exists yet |
| `prepared` | transaction prepared | the canonical-SDK instruction exists, **unsigned** — nothing moved, nothing promised |
| `simulated` | simulated — not submitted | devnet dry-ran the **exact** unsigned transaction and reported no error; the operator reviews before approving |
| `awaiting-wallet-approval` | awaiting wallet approval | the wallet is asking for a signature; the claim is not submitted |
| `submitted` | submitted — awaiting confirmation | broadcast to devnet; **submitted is not paid** |
| `reconciling` | reconciling on-chain record | the tx confirmed at the stated commitment; the console is re-reading the `ClaimRecord` PDA |
| `confirmed` | confirmed | **only** reachable through reconciliation — the record was re-read from devnet |
| `failed` | failed | no claim happened — "no lamports moved (unless an earlier confirmed claim record exists on-chain)" |
| `confirmation-unknown` | confirmation unknown | the outcome is genuinely unknown — the tx may still settle; re-check or re-prepare |

## The honesty rules (each test-pinned)

1. **"Confirmed" is gated by reconciliation.** An exhaustive sweep over the whole
   transition table proves the only edge into `confirmed` is
   `(reconciling, reconcile-found)`, and the entry chain into `reconciling`
   passes through `submit-ok` — a real broadcast. A transaction confirming is
   not evidence a claim was paid; the record is.
2. **Timeout is unknown, not failed.** A broadcast transaction may still settle.
   `confirm-timeout` and an inconclusive record read go to
   `confirmation-unknown`, which recovers via re-check (`confirm-seen`) or an
   explicit operator re-prepare. The console displays neither paid nor failed
   without evidence.
3. **Failures carry reasons; pre-broadcast failures leave no signature.**
   `simulate-failed`, `wallet-rejected`, and `submit-failed` are terminal with
   the error text, and the signature field stays null — nothing was signed,
   nothing moved.
4. **At-most-once in flight.** `submit-ok` is only valid from
   `awaiting-wallet-approval` — a state unreachable while a submission is being
   waited on — so a second broadcast during `submitted`/`reconciling` is
   structurally impossible; UI double-clicks are refused and counted
   (`duplicate-submit-refused`). The protocol's init-once `ClaimRecord`
   (7010/7011) remains the on-chain double-claim defense; the machine's
   suppression is the UX-level belt.
5. **Blockhash expiry is re-preparation, never a hopeful submit.** Before the
   wallet is asked, the staged blockhash's validity height is re-checked; an
   expired preparation is rebuilt (`re-prepare`), which is also the operator's
   recovery path after an unknown confirmation. Retried signatures append to
   `signatureHistory` (the Explorer link never loses the prior attempt).
6. **What the wallet signs is what was simulated.** The exact unsigned
   transaction shown on screen (program, blockhash, expiry slot) is the one the
   wallet receives; the instruction itself is deserialized from the
   server-prepared canonical-SDK shape and rejected outright on any malformed
   field.

## The operator flow (LP Claims → claimable card)

1. **Claim proceeds (devnet)** — deserializes the canonical instruction, fetches
   a fresh blockhash (fail-closed: an RPC error keeps the claim unprepared and
   retryable — it is not a "failed claim"), assembles the transaction, and
   dry-runs it. Simulation output (including program logs on failure) is shown
   verbatim.
2. **Review** — the staged facts are on screen before any signature is possible.
3. **Approve in wallet & submit** — the wallet signs and broadcasts via the
   wallet-adapter; rejection and broadcast failure land in distinct terminal
   states.
4. **Wait** — a bounded confirmation poll at the stated commitment (60 s, 2 s
   cadence; RPC hiccups are "not seen yet", never failure).
5. **Reconcile** — the console re-reads the `ClaimRecord` PDA (server-derived
   via the canonical SDK): found → **confirmed** + a data refresh; cleanly
   absent → failed with the honest wording; read error → unknown.
6. **Recover** — from `confirmation-unknown`: *Re-check confirmation* (30 s) or
   *Re-prepare with fresh blockhash* (a new machine stage; the old signature
   stays linked).

## Deliberately out of scope (unchanged by P4.5)

- **Certify & salvage stays disabled for submission.** A valid evaluation
  requires a fresh oracle-signed attestation inside the ~512-slot SlotHashes
  window (the 6024–6029 error family) — a browser cannot produce one. The
  documented path is the indexer's `EvidenceBundle` plus the salvor fleet's
  pipeline. The old "Simulated — nothing was submitted" toast was removed: it
  implied a simulation that never ran.
- **Evaluate (dry-run) is a real read-only re-evaluation**: the console's
  snapshot-side criteria are recomputed at click time, stamped with when they
  ran, and labeled as not the on-chain `evaluate_pool_phase_1/2`.
- The console never signs attestations, never builds salvage transactions, and
  holds no keys. `providers.tsx` was reviewed and deliberately unchanged —
  signing remains wallet-custodied via the Wallet Standard surface; the machine
  added no provider-level capability.
