# LP Claims integration (P4.4) — runbook and contract

The LP Claims view is wired to **actual snapshot, Merkle distribution, and
on-chain claim data**. This document is the operator/developer contract: where
the data comes from, what each state means, and what the console refuses to do.

## Data planes

```
grave-snapshotter (graveyield-protocol)          devnet GraveVault program
└── sealed SnapshotArtifact JSON                 ├── PoolRegistry      ["pool_registry", pool]
    (root, per-holder leaves + proofs,           ├── SalvageReceipt    ["salvage_receipt", pool]
     reconciliation identity)                    ├── ClaimRecord       ["claim_record", pool, wallet]
        │                                        └── lp_holder_pool_vault ["lp_holder_pool", pool]
        ▼                                                ▲
GY_CLAIMS_PATH (mounted volume)                          │
GY_CLAIMS_URL  (HTTPS artifact store)                    │
        │                                                │
        ▼                                                │
/api/gy/claims ── schema gate + SDK integrity gate ──────┘
        │            (canonical SDK: SnapshotMerkleTree + decoders + PDAs)
        ▼
privacy-stripped projection + queried wallet's own row
```

Three planes, independently gated, all fail-closed:

1. **Distribution artifact** — the sealed `SnapshotArtifact` (format_version 1)
   produced by `grave-snapshotter-cli` after an LP-holder snapshot. Transported
   exactly like the indexer snapshot (P4.1): `GY_CLAIMS_PATH` for mounted
   volumes (self-hosted/Docker), `GY_CLAIMS_URL` for HTTPS artifact stores
   (serverless). Every artifact is schema-validated **and** integrity-verified:
   the whole tree re-derives through the canonical SDK's `SnapshotMerkleTree`
   (root, every leaf, every proof, the reconciliation identity) — the
   console-side equivalent of `artifact.rs::verify_integrity`. A tampered or
   precision-damaged artifact is rejected as `corrupt`, never rendered.
2. **On-chain settlement** — live devnet reads through the canonical SDK's
   account decoders and PDA derivations. `PoolRegistry` is the authority for
   the sealed root and the LP-holder bucket; `SalvageReceipt` carries the
   salvage reference; `ClaimRecord` is the canonical evidence a claim was PAID.
3. **Claim transaction** — client-side lifecycle (see below), driven by the
   canonical SDK-built `claim_lp_proceeds` instruction.

## Canonical SDK vendoring

The SDK (`@graveyield/sdk`, in `graveyield-protocol/sdk`) is **vendored** at
`src/lib/gy/vendor/graveyield-sdk/` — the Phase 4.0 audit's Q1 Option A. See
that directory's `PROVENANCE.md`. Rules:

- Seven files are byte-identical to upstream (sha256-pinned by
  `__tests__/sdkVendored.test.ts`). Editing them locally fails CI; taking an
  upstream update is a deliberate re-pin + CHANGELOG entry.
- `claimsInstructions.ts` is a verbatim transcription of the canonical
  `buildClaimLpProceedsIx` (the canonical file top-level-imports
  `@solana/spl-token`, which this tree intentionally lacks). Its instruction
  encoding is asserted against an **independently computed golden vector**
  (Python implementation of the on-chain Anchor layout) on every CI run.
- The console does NOT implement a competing Merkle verification or claim
  calculation: every hash, proof fold, and PDA derivation calls the vendored
  canonical SDK. The only local arithmetic is the display of the normative
  claimable formula from `claim_lp_proceeds.rs` (`u128` intermediate,
  integer-division floor), labeled in the UI as *expected — final amount is
  determined on-chain at claim time*.
- The vendored code is **server-only** (Node runtime; `node:crypto`). The
  browser bundle imports none of it.

## Env configuration

```bash
# Exactly one distribution source (like the snapshot transport):
GY_CLAIMS_URL="https://artifacts.example/gy/distribution.json"   # serverless
GY_CLAIMS_PATH="/var/lib/grave-snapshotter/distribution.json"    # self-hosted

# Optional freshness budget (ms; default 604800000 = 7 days — a sealed
# distribution is a historical record; its root is bound to the on-chain
# PoolRegistry, the budget only stops an abandoned artifact reading current).
GY_CLAIMS_MAX_AGE_MS="604800000"

# Optional RPC host for the on-chain reads (default api.devnet.solana.com).
GY_CLAIMS_RPC_HOST="api.devnet.solana.com"
```

With neither source configured the view honestly renders *snapshot
unavailable* — it never falls back to fixtures.

## State vocabulary (normative)

Server-side wallet lookup (`claimsContract.walletClaimView`), in evaluation
order — each state maps 1:1 to the owner's acceptance vocabulary:

| State | Meaning |
| --- | --- |
| `claimed` | A `ClaimRecord` exists on-chain for (pool, wallet) — the canonical PAID evidence; amounts, slot and timestamp come from the record. Checked first: a chain fact independent of artifact transport. |
| `no-claim-record` | Nothing found: no `PoolRegistry` exists on-chain for the pool (no salvage has settled) and no claim record exists. |
| `snapshot-unavailable` | Eligibility is UNKNOWN — the artifact is missing/corrupt, the registry read failed, or the artifact's root does not match the on-chain registry root. Fail-closed: never conflated with "not eligible". |
| `wallet-not-eligible` | A healthy, root-bound distribution exists and the wallet holds no leaf in it — definitively not a claimant of this distribution. |
| `proof-unavailable` | The wallet holds a leaf but its proof does not fold to the on-chain registry root (defense-in-depth beyond the whole-artifact integrity gate). |
| `claimable` | Leaf present, proof verified against the on-chain root via the canonical SDK, no `ClaimRecord` — expected amount computed from the normative formula, instruction prepared. |

Client-side transaction lifecycle (overlay on `claimable`/`claimed`):

| Status | Meaning — and what it is NOT |
| --- | --- |
| `transaction prepared` | The canonical-SDK instruction exists, unsigned. Nothing has moved; nothing is promised. |
| `submitted` | The wallet broadcast to devnet. Submitted is NOT paid — confirmation is pending. |
| `confirmed` | Displayed ONLY after the console itself re-reads the `ClaimRecord` PDA from devnet. A confirmed transaction alone never reads as paid. |
| `failed` | No claim happened; no lamports moved (unless an earlier confirmed record exists). |

**Non-expiring semantics**: nothing in the pipeline models a deadline. The
on-chain `claim_lp_proceeds` has no expiry (it stays live even under emergency
pause), and the UI says so: distributions remain claimable indefinitely.

## Privacy

- The full per-holder entry set (other wallets' balances and proofs) NEVER
  leaves the server. The transport serves the privacy-stripped projection
  (`DistributionPublic` — counts and root only) plus, for the queried wallet,
  that wallet's own row. The client-side hydrator structurally rejects any
  payload whose "projection" carries per-holder rows.
- Any address may be queried (the data is public on-chain), but the console
  surfaces only the queried wallet's detail — never a holder directory.
- The demo fixture wallets from the simulated era are gone.

## Claims flow (operator)

1. After a salvage settles, run `grave-snapshotter` (pre-salvage, per the
   protocol's Phase 5 order: snapshot → root → salvage seals it into
   `PoolRegistry`), publish the sealed artifact to the artifact store.
2. Point the console at it (`GY_CLAIMS_URL`/`GY_CLAIMS_PATH`), refresh.
3. The view shows the sealed distribution facts + on-chain settlement, and
   binds them (root cross-check). Holders connect a wallet and look up their
   own claim; `claimable` rows can sign the SDK-prepared instruction with the
   connected wallet on devnet.

## What the console still refuses to do

- It never signs with anything but the user's own wallet, never submits
  anything but `claim_lp_proceeds` for the connected wallet, and never on
  mainnet.
- It never displays "claimed"/"paid" without an on-chain `ClaimRecord`
  (server read for the resting state; client re-read after confirmation).
- It never estimates eligibility from partial data: unknown is
  `snapshot-unavailable`, never "ineligible"; absent is `no-claim-record`,
  never "claimable".
