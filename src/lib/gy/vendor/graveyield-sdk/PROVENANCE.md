# Vendored canonical SDK — `@graveyield/sdk`

This directory carries the **canonical GraveYield SDK surfaces** the LP
Claims integration (Phase 4.4) requires. The SDK lives upstream at
[`graveyield-protocol/sdk`](https://github.com/GraveYield/graveyield-protocol/tree/main/sdk)
(it is not published to npm), so the console vendors the files it needs —
the same vendor-with-drift-protection decision the Phase 4.0 audit recorded
for SDK bridging (Q1, Option A).

## Canonical source

- Repository: `GraveYield/graveyield-protocol`
- Files vendored from `sdk/src/` at canonical commit
  `2b0bc240e7db2c551bc9b2034bc133110a353ce2` (the `sdk/` tree is untouched
  by later commits through `78b5d87`, verified before vendoring).
- Upstream license: Apache-2.0 (headers preserved verbatim).

## Byte-identical files (SHA-256 pinned by `src/lib/gy/__tests__/sdkVendored.test.ts`)

| File | Role in the claim flow |
| --- | --- |
| `borsh.ts` | Hand-rolled borsh reader/writer — instruction + account decoding |
| `discriminators.ts` | Anchor discriminators (`global:claim_lp_proceeds`, `account:PoolRegistry`, …) |
| `web3compat.ts` | Byte-exact synchronous PDA derivation (`find_program_address` mirror) |
| `pdas.ts` | PDA seeds/derivations: `poolRegistryPda`, `claimRecordPda`, `salvageReceiptPda`, `lpHolderPoolVaultPda` |
| `merkle.ts` | THE Merkle implementation: `SnapshotMerkleTree`, `computeLeaf`, `verifyMerkleProof` — byte-locked to `grave_vault::merkle` |
| `accountDecoders.ts` | Decoders for `PoolRegistry`, `SalvageReceipt`, `ClaimRecord`, config accounts |
| `errors.ts` | Program error decoding (Scanner 6000–6034, Vault 7000–7021) for failed-claim reporting |

These files MUST remain byte-identical to upstream. The drift test fails on
any local edit; to take an upstream update, copy the file, update the pin,
and note it in the console CHANGELOG (that is the deliberate friction).

## Transcribed file (golden-vector pinned, not byte-identical)

| File | Why |
| --- | --- |
| `claimsInstructions.ts` | `buildClaimLpProceedsIx` transcribed verbatim from `sdk/src/instructions.ts`. The canonical file imports `@solana/spl-token` at top level (salvage-side builders); the console tree intentionally carries no spl-token dependency (audit: `bigint-buffer` stays out). Drift protection: the encoded instruction DATA is asserted against an independently computed golden vector (Python `hashlib`/`struct` implementation of the on-chain Anchor convention). |

## Import-shim files (`borsh.js`, `discriminators.js`, `pdas.js`, `web3compat.js`)

The canonical SDK is ESM with NodeNext-style relative imports (`./borsh.js`),
which TypeScript maps to the `.ts` sources. Bun and `tsc` apply that mapping;
Turbopack (Next 16's build bundler) resolves the literal `.js` specifier.
Four one-line shim files exist so every resolver agrees: each simply
`export * from "./<name>.ts";`. They carry no logic, are not pinned (they are
console-side plumbing, not canonical content), and must never be edited to
contain anything else.

## Runtime boundary

Every file here is **server-only** (Node runtime): `merkle.ts` and
`web3compat.ts` use `node:crypto`, and the claims route handlers are the
only importers. The browser bundle never imports this directory — the UI
consumes the JSON envelope from `/api/gy/claims`, and the client-side claim
transaction flow re-checks the only thing that matters on-chain (the
`ClaimRecord` PDA) with the console's own web3.js after confirmation.

## Compatibility note

Upstream SDK builds against `@solana/web3.js` 3.x; this tree pins web3.js
1.99.0. The vendored files use only the surface that is byte-compatible
across both (`PublicKey.toBytes/isOnCurve`, `TransactionInstruction`,
`AccountMeta`, `SystemProgram`, `MAX_SEED_LENGTH`), and the vendored-file
tests (PDA vectors against the live devnet config PDAs, instruction golden
vector, Merkle fork vector) run against the console's web3.js on every CI
run — which is exactly the drift net this vendoring needs.
