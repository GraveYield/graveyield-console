// LP Claims CONTRACT (P4.4) — artifact parsing, SDK integrity gate, and the
// wallet claim state machine.
//
// SERVER-ONLY by design: unlike the snapshot/fleet contracts, the raw
// distribution artifact NEVER reaches the client — it is the full per-holder
// leaf set (every claimant's balance and proof), and "never expose another
// wallet's claim detail" is enforced by construction: the transport serves a
// privacy-stripped projection (publicDistribution, no entries) plus, for the
// queried wallet only, that wallet's own row. The client-side envelope gate
// lives in claimsTransport.ts; it validates the derived facts, which is all
// it is given.
//
// THE WRITER, byte for byte: the artifact format below is a transcription of
// graveyield-protocol snapshotter/src/artifact.rs (SnapshotArtifact,
// ARTIFACT_FORMAT_VERSION 1):
//
//   {
//     "format_version": 1,
//     "pool_address": "<base58>", "amm_program_id": "<base58>",
//     "lp_mint": "<base58>",
//     "snapshot_slot": <u64>, "lp_total_supply_at_snapshot": <u64>,
//     "merkle_root": "<32-byte lowercase hex>",
//     "leaf_count": <usize>, "tree_depth": <usize>,
//     "entries": [ { "owner": "<base58>", "lp_balance": <u64>,
//                    "leaf": "<hex32>", "proof": ["<hex32>", ...] }, ... ],
//     "reconciliation": { "enumerated_total": <u64>, "entries_total": <u64>,
//                         "sink_exclusions_total": <u64> }
//   }
//
// serde_json writes u64s as JSON numbers. A number past 2^53 loses float64
// precision on JSON.parse — but PRECISION LOSS CANNOT SURVIVE THIS CONTRACT:
// verifyDistributionIntegrity() re-derives every leaf from the parsed balance
// through the canonical SDK Merkle tree, and a balance that round-tripped
// imprecisely produces a different leaf hash. The artifact is rejected as
// corrupt — never rendered as data.
//
// Contract rules:
//   - FAIL-CLOSED: any missing/invalid field, duplicate owner, zero balance,
//     or broken reconciliation identity throws ClaimsError. A broken
//     distribution can never silently render as data.
//   - MERKLE/PROOF LOGIC IS THE CANONICAL SDK, NOT A COMPETING SYSTEM: every
//     hash re-derivation and proof fold calls vendor/graveyield-sdk/merkle.ts
//     — the SnapshotMerkleTree byte-locked to `grave_vault::merkle`. No
//     hashing lives in this repo.
//   - NON-EXPIRING: nothing here models a deadline. The LP claim window has
//     no expiry on-chain (claim_lp_proceeds is live even under emergency
//     pause) and none here — distributions stay claimable indefinitely.
//   - The claimable-amount math mirrors the normative formula in
//     programs/grave-vault/src/instructions/claim_lp_proceeds.rs exactly
//     (u128 intermediate, integer-division floor). It is a DISPLAY of the
//     settled formula — the final amount is determined on-chain at claim
//     time, and the UI copy says so.

import { PublicKey } from "@solana/web3.js";

import { SnapshotMerkleTree, computeLeaf, verifyMerkleProof, type HolderEntry } from "./vendor/graveyield-sdk/merkle";
import { buildClaimLpProceedsIx } from "./vendor/graveyield-sdk/claimsInstructions";
import { claimRecordPda } from "./vendor/graveyield-sdk/pdas";

export const DISTRIBUTION_FORMAT_VERSION = 1;

/** One claimant row in the sealed artifact (server-side only — never transported). */
export interface DistributionEntry {
  owner: string;
  /** Raw LP balance at snapshot (exact — the JSON number is integer-validated). */
  lpBalance: bigint;
  leaf: string;
  proof: string[];
}

/** The full parsed artifact (server-side only). */
export interface DistributionArtifact {
  formatVersion: number;
  poolAddress: string;
  ammProgramId: string;
  lpMint: string;
  snapshotSlot: number;
  lpTotalSupplyAtSnapshot: bigint;
  merkleRoot: string;
  leafCount: number;
  treeDepth: number;
  /** Canonical ascending-owner order, as sealed. */
  entries: DistributionEntry[];
  reconciliation: {
    enumeratedTotal: bigint;
    entriesTotal: bigint;
    sinkExclusionsTotal: bigint;
  };
}

/**
 * Privacy-stripped projection of a verified artifact — the ONLY shape the
 * transport may serve to a client. No per-holder rows, no leaves, no proofs.
 */
export interface DistributionPublic {
  formatVersion: number;
  poolAddress: string;
  ammProgramId: string;
  lpMint: string;
  snapshotSlot: number;
  lpTotalSupplyAtSnapshot: string;
  merkleRoot: string;
  leafCount: number;
  treeDepth: number;
  reconciliation: {
    enumeratedTotal: string;
    entriesTotal: string;
    sinkExclusionsTotal: string;
  };
  /** "verified" — integrity re-derived via the canonical SDK before this projection exists. */
  integrity: "verified";
}

export class ClaimsError extends Error {
  constructor(message: string) {
    super(`claims: ${message}`);
    this.name = "ClaimsError";
  }
}

const HEX32_RE = /^[0-9a-f]{64}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new ClaimsError(`${what} must be a non-empty string`);
  return v;
}

/** serde u64-as-number → exact BigInt. Rejects non-integers and negatives. */
function u64num(v: unknown, what: string): bigint {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ClaimsError(`${what} must be a non-negative integer (u64), got ${JSON.stringify(v)}`);
  }
  return BigInt(v);
}

/** u64-as-number constrained to the JS safe range (slots, counts). */
function safeUint(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) {
    throw new ClaimsError(`${what} must be a non-negative integer within the safe range, got ${JSON.stringify(v)}`);
  }
  return v;
}

function hex32(v: unknown, what: string): string {
  const s = str(v, what).toLowerCase();
  if (!HEX32_RE.test(s)) throw new ClaimsError(`${what} must be 32 bytes of lowercase hex`);
  return s;
}

/**
 * SECURITY (review 2026-10-31, F2): a pubkey-shaped STRING is not a pubkey.
 * The base58 regex alone accepts 32-44 char strings that decode to 23, 24, 31…
 * bytes — every later `new PublicKey()` on such a value throws. The Merkle
 * integrity gate does NOT cover pool_address/amm_program_id/lp_mint (only
 * owner+balance leaves), so a crafted artifact could pass integrity and then
 * blow up the route with an unhandled 500 instead of the honest corrupt
 * envelope. Every artifact pubkey is therefore constructed and CANONICALIZED
 * here — a value that cannot be a real key fails at the schema gate, before
 * any consumer can crash on it.
 */
function pubkeyStr(v: unknown, what: string): string {
  const s = str(v, what);
  if (!PUBKEY_RE.test(s)) throw new ClaimsError(`${what} is not a base58 pubkey`);
  let key: PublicKey;
  try {
    key = new PublicKey(s);
  } catch {
    throw new ClaimsError(`${what} is base58-shaped but not a valid Solana public key`);
  }
  return key.toBase58();
}

/**
 * SECURITY (review 2026-10-31, F1): the ?wallet= query gate. The regex alone
 * is not enough — a regex-passing string that is not a valid PublicKey made
 * walletClaimView throw (unhandled 500) the moment a distribution artifact
 * was configured, breaking the route's own "invalid wallet → wallet: null
 * envelope" promise and its "every outcome answers 200" rule. A string that
 * decodes to exactly 32 bytes is by construction the canonical encoding, so
 * the returned value is always canonical base58 — safe to string-compare
 * against artifact entry owners and safe for every downstream
 * PublicKey/PDA construction.
 */
export function canonicalQueryWallet(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (!PUBKEY_RE.test(raw)) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/**
 * Parse and fully schema-validate a raw distribution payload. Throws
 * ClaimsError. Integrity (hash re-derivation) is a separate step —
 * verifyDistributionIntegrity() — mirroring the upstream split between
 * serde decoding and artifact.rs::verify_integrity.
 */
export function parseDistributionArtifact(raw: unknown): DistributionArtifact {
  if (!isObj(raw)) throw new ClaimsError("root must be an object");
  if (raw.format_version !== DISTRIBUTION_FORMAT_VERSION) {
    throw new ClaimsError(
      `unsupported artifact format_version ${JSON.stringify(raw.format_version)} (expected ${DISTRIBUTION_FORMAT_VERSION}) — fail-closed on a format this contract cannot fully re-derive`,
    );
  }
  const poolAddress = pubkeyStr(raw.pool_address, "pool_address");
  const ammProgramId = pubkeyStr(raw.amm_program_id, "amm_program_id");
  const lpMint = pubkeyStr(raw.lp_mint, "lp_mint");
  const snapshotSlot = safeUint(raw.snapshot_slot, "snapshot_slot");
  const lpTotalSupplyAtSnapshot = u64num(raw.lp_total_supply_at_snapshot, "lp_total_supply_at_snapshot");
  if (lpTotalSupplyAtSnapshot <= 0n) throw new ClaimsError("lp_total_supply_at_snapshot must be positive");
  const merkleRoot = hex32(raw.merkle_root, "merkle_root");
  const leafCount = safeUint(raw.leaf_count, "leaf_count");
  const treeDepth = safeUint(raw.tree_depth, "tree_depth");

  if (!Array.isArray(raw.entries)) throw new ClaimsError("entries must be an array");
  if (raw.entries.length !== leafCount) {
    throw new ClaimsError(`leaf_count (${leafCount}) != entries.length (${raw.entries.length})`);
  }
  if (!isObj(raw.reconciliation)) throw new ClaimsError("reconciliation must be an object");

  const entries: DistributionEntry[] = raw.entries.map((e, i) => {
    if (!isObj(e)) throw new ClaimsError(`entries[${i}] must be an object`);
    if (!Array.isArray(e.proof)) throw new ClaimsError(`entries[${i}].proof must be an array`);
    return {
      // pubkeyStr canonicalizes: an artifact written with a non-canonical
      // owner encoding normalizes to the same canonical base58 the tree
      // builder derives, so entryForWallet's string compare stays exact.
      owner: pubkeyStr(e.owner, `entries[${i}].owner`),
      lpBalance: u64num(e.lp_balance, `entries[${i}].lp_balance`),
      leaf: hex32(e.leaf, `entries[${i}].leaf`),
      proof: e.proof.map((p, j) => hex32(p, `entries[${i}].proof[${j}]`)),
    };
  });
  if (entries.length === 0) throw new ClaimsError("empty entry set — no legitimate empty root");
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.lpBalance <= 0n) throw new ClaimsError(`entries[${i}].lp_balance must be strictly positive`);
    if (i > 0) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      if (prev.owner === cur.owner) throw new ClaimsError(`duplicate owner at entries[${i}]`);
      if (prev.owner > cur.owner) {
        throw new ClaimsError(
          `entries not in ascending-owner order at entries[${i}] (canonical order is ascending pubkey bytes; byte-order enforcement is the SDK tree builder's authority)`,
        );
      }
    }
  }

  const reconciliation = {
    enumeratedTotal: u64num(raw.reconciliation.enumerated_total, "reconciliation.enumerated_total"),
    entriesTotal: u64num(raw.reconciliation.entries_total, "reconciliation.entries_total"),
    sinkExclusionsTotal: u64num(raw.reconciliation.sink_exclusions_total, "reconciliation.sink_exclusions_total"),
  };
  // Closing identity (snapshotter/src/artifact.rs::verify_integrity):
  //   Σ entries + sinks == enumerated == supply.
  const sumEntries = entries.reduce((a, e) => a + e.lpBalance, 0n);
  if (sumEntries !== reconciliation.entriesTotal) {
    throw new ClaimsError(
      `Σ persisted balances (${sumEntries}) != reconciliation.entries_total (${reconciliation.entriesTotal})`,
    );
  }
  if (reconciliation.entriesTotal + reconciliation.sinkExclusionsTotal !== reconciliation.enumeratedTotal) {
    throw new ClaimsError("reconciliation identity entries + sinks != enumerated broken");
  }
  if (reconciliation.enumeratedTotal !== lpTotalSupplyAtSnapshot) {
    throw new ClaimsError("reconciliation.enumerated_total != lp_total_supply_at_snapshot");
  }

  return {
    formatVersion: DISTRIBUTION_FORMAT_VERSION,
    poolAddress,
    ammProgramId,
    lpMint,
    snapshotSlot,
    lpTotalSupplyAtSnapshot,
    merkleRoot,
    leafCount,
    treeDepth,
    entries,
    reconciliation,
  };
}

/**
 * Re-derive the whole artifact through the canonical SDK Merkle tree — the
 * console-side equivalent of snapshotter/src/artifact.rs::verify_integrity,
 * implemented BY CALLING THE SDK (SnapshotMerkleTree.fromEntries + leaf/proof
 * comparison). No hashing lives in this repo.
 *
 * Byte order note: the canonical order is ascending pubkey BYTES; the schema
 * layer's string-order check is advisory, the tree builder's byte-order
 * enforcement is the authority — an artifact sorted in string order but not
 * byte order fails HERE (fromEntries throws), which is the fail-closed path.
 */
export function verifyDistributionIntegrity(artifact: DistributionArtifact): void {
  const holderEntries: HolderEntry[] = artifact.entries.map((e) => ({
    owner: new PublicKey(e.owner),
    lpBalance: e.lpBalance,
  }));
  let tree: SnapshotMerkleTree;
  try {
    tree = SnapshotMerkleTree.fromEntries(holderEntries);
  } catch (e) {
    throw new ClaimsError(
      `artifact integrity failed — the SDK tree builder rejected the entry set: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const root = Buffer.from(tree.root()).toString("hex");
  if (root !== artifact.merkleRoot) {
    throw new ClaimsError("artifact integrity failed — root does not derive from the persisted entries");
  }
  if (tree.leafCount() !== artifact.leafCount) {
    throw new ClaimsError("artifact integrity failed — leaf_count disagrees with the persisted entries");
  }
  if (tree.treeDepth() !== artifact.treeDepth) {
    throw new ClaimsError("artifact integrity failed — tree_depth disagrees with the persisted entries");
  }
  for (let i = 0; i < artifact.entries.length; i++) {
    const e = artifact.entries[i]!;
    const leaf = Buffer.from(tree.leaf(i)!).toString("hex");
    if (leaf !== e.leaf) {
      throw new ClaimsError(`artifact integrity failed — leaf mismatch at entry ${i} (owner ${e.owner})`);
    }
    const proof = tree.proof(i)!.map((p) => Buffer.from(p).toString("hex"));
    if (proof.length !== e.proof.length || proof.some((p, j) => p !== e.proof[j])) {
      throw new ClaimsError(`artifact integrity failed — proof mismatch at entry ${i} (owner ${e.owner})`);
    }
  }
}

/** The privacy-stripped projection the transport may serve. */
export function publicDistribution(artifact: DistributionArtifact): DistributionPublic {
  return {
    formatVersion: artifact.formatVersion,
    poolAddress: artifact.poolAddress,
    ammProgramId: artifact.ammProgramId,
    lpMint: artifact.lpMint,
    snapshotSlot: artifact.snapshotSlot,
    lpTotalSupplyAtSnapshot: artifact.lpTotalSupplyAtSnapshot.toString(10),
    merkleRoot: artifact.merkleRoot,
    leafCount: artifact.leafCount,
    treeDepth: artifact.treeDepth,
    reconciliation: {
      enumeratedTotal: artifact.reconciliation.enumeratedTotal.toString(10),
      entriesTotal: artifact.reconciliation.entriesTotal.toString(10),
      sinkExclusionsTotal: artifact.reconciliation.sinkExclusionsTotal.toString(10),
    },
    integrity: "verified",
  };
}

/** The artifact entry for `wallet`, if it holds a leaf in the distribution. */
export function entryForWallet(artifact: DistributionArtifact, wallet: string): DistributionEntry | null {
  return artifact.entries.find((e) => e.owner === wallet) ?? null;
}

/**
 * The normative claimable-amount formula — a display mirror of
 * programs/grave-vault/src/instructions/claim_lp_proceeds.rs:
 *
 *   amount = lp_holder_pool_total_lamports * lp_balance_at_snapshot
 *            / lp_total_supply_at_snapshot      (u128 intermediate, floor)
 *
 * BigInt multiplication is the u128 intermediate. The final amount is
 * determined on-chain at claim time; this is the same arithmetic, not an
 * authority.
 */
export function expectedClaimAmountLamports(
  lpHolderPoolTotalLamports: bigint,
  lpBalanceAtSnapshot: bigint,
  lpTotalSupplyAtSnapshot: bigint,
): bigint {
  if (lpTotalSupplyAtSnapshot <= 0n) {
    throw new ClaimsError("lp_total_supply_at_snapshot must be positive (on-chain rejects it too)");
  }
  if (lpBalanceAtSnapshot <= 0n) {
    throw new ClaimsError("lp_balance_at_snapshot must be positive (on-chain rejects zero claims)");
  }
  return (lpHolderPoolTotalLamports * lpBalanceAtSnapshot) / lpTotalSupplyAtSnapshot;
}

/* ── Wallet claim view — the server-side state machine ────────────────
 *
 * The owner's vocabulary, one state per lookup outcome. The transaction
 * lifecycle (prepared / submitted / confirmed / failed) is a CLIENT-side
 * overlay on top of `claimable` / `claimed` — it never overrides what the
 * chain says, and "confirmed" requires the on-chain ClaimRecord (the client
 * re-reads claimRecordPda after confirmation; the server's claim-record read
 * is the resting-state authority).
 *
 *   claimed               — ClaimRecord exists on-chain: the canonical paid
 *                           evidence (amount, slot, ts). Checked FIRST: it is
 *                           a chain fact independent of artifact transport.
 *   no-claim-record       — nothing found: no settled distribution for this
 *                           pool on-chain (no PoolRegistry) and no claim
 *                           record. The honest "nothing here" answer.
 *   snapshot-unavailable  — the distribution side cannot be evaluated
 *                           (artifact missing/corrupt, undecodable on-chain
 *                           registry, or an artifact whose root does not
 *                           match the on-chain registry root). Eligibility
 *                           is UNKNOWN — fail-closed, never conflated with
 *                           ineligible.
 *   wallet-not-eligible   — a healthy, root-bound distribution exists and the
 *                           wallet holds no leaf in it: definitively not a
 *                           claimant of this distribution.
 *   proof-unavailable     — the wallet holds a leaf but its proof cannot be
 *                           verified (defense-in-depth: the artifact already
 *                           passed full integrity; a per-entry failure here
 *                           means an on-chain root mismatch or tampered row).
 *   claimable             — leaf present, proof verified against the on-chain
 *                           registry root through the SDK, no ClaimRecord:
 *                           expected amount computed from the normative
 *                           formula.
 */

export type WalletClaimState =
  | "claimed"
  | "no-claim-record"
  | "snapshot-unavailable"
  | "wallet-not-eligible"
  | "proof-unavailable"
  | "claimable";

export interface WalletClaimRecord {
  pda: string;
  amountLamports: string;
  lpBalanceAtSnapshot: string;
  claimedAtSlot: string;
  claimedAtTs: number | null;
}

/** The SDK-built claim_lp_proceeds instruction, serializable to the client. */
export interface PreparedClaimInstruction {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  /** borsh-encoded instruction data (base64). */
  data: string;
}

export interface WalletClaimView {
  wallet: string;
  /** The distribution's pool this view was computed against (empty when unknown). */
  poolAddress: string;
  /** The (pool, wallet) ClaimRecord PDA, derived server-side by the canonical
   * SDK — the client re-reads THIS address after a confirmed claim (the
   * honesty gate). Null when no distribution is bound. */
  claimRecordPda: string | null;
  state: WalletClaimState;
  /** Why the state is what it is — always present for the non-claimable states. */
  reason: string | null;
  /** The wallet's OWN row: balance, leaf, ready-to-submit proof (public data, own query only). */
  entry: { lpBalanceAtSnapshot: string; leaf: string; proof: string[] } | null;
  /** "verified" — the proof folds to the ON-CHAIN registry root via the SDK. */
  proofStatus: "verified" | "failed" | "absent" | null;
  claimRecord: WalletClaimRecord | null;
  /** Expected claimable amount from the normative formula (display only). */
  claimableLamports: string | null;
  claimedLamports: string | null;
  remainingLamports: string | null;
  /** The claim_lp_proceeds instruction — only when claimable. */
  preparedClaim: PreparedClaimInstruction | null;
  /** Fixed on-chain note for claimable rows: final amount decided at claim time. */
  amountNote: string | null;
}

/** On-chain registry facts the state machine consumes (pre-resolved by the route). */
export interface RegistryFacts {
  merkleRoot: string;
  lpTotalSupplyAtSnapshot: bigint;
  lpHolderPoolTotalLamports: bigint;
}

/** Inputs to the state machine — all pre-resolved by the route. */
export interface WalletClaimInput {
  wallet: string;
  /** The verified artifact (integrity-checked), or null when unusable. */
  artifact: DistributionArtifact | null;
  /** On-chain PoolRegistry facts for the artifact's pool. */
  registry: RegistryFacts | null;
  /** "absent" — no PoolRegistry on-chain; "error" — the read failed. */
  registryAbsent: boolean;
  registryError: string | null;
  /** The wallet's ClaimRecord, when it exists on-chain. */
  claimRecord: WalletClaimRecord | null;
  /** True when the ClaimRecord READ itself failed — fail-closed: an
   * unreadable record must never read as "never claimed", or a claimed
   * wallet could render as claimable. Blocks the claimable path. */
  claimRecordError: boolean;
  /** GraveVault program id (string) for instruction construction. */
  vaultProgramId: string;
}

/** Serialize the canonical SDK instruction into the transport shape. */
export function preparedInstruction(
  vaultProgramId: string,
  poolAddress: string,
  wallet: string,
  entry: DistributionEntry,
): PreparedClaimInstruction {
  const ix = buildClaimLpProceedsIx({
    vaultProgramId: new PublicKey(vaultProgramId),
    poolAddress: new PublicKey(poolAddress),
    lpHolder: new PublicKey(wallet),
    lpBalanceAtSnapshot: entry.lpBalance,
    merkleProof: entry.proof.map((h) => Uint8Array.from(Buffer.from(h, "hex"))),
  });
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

/** Verify one entry's proof against a root — through the canonical SDK. */
export function entryProofVerifies(entry: DistributionEntry, rootHex: string): boolean {
  const leaf = computeLeaf(new PublicKey(entry.owner), entry.lpBalance);
  const proof = entry.proof.map((h) => Uint8Array.from(Buffer.from(h, "hex")));
  return verifyMerkleProof(Uint8Array.from(Buffer.from(rootHex, "hex")), leaf, proof);
}

/**
 * The state machine. Order is normative:
 *   1. ClaimRecord on-chain            → claimed  (chain fact beats everything)
 *   2. ClaimRecord read failed         → snapshot-unavailable (fail-closed:
 *      an unreadable record must never read as "never claimed")
 *   3. registry absent on-chain        → no-claim-record (no distribution exists)
 *   4. artifact unusable OR registry read failed → snapshot-unavailable
 *   5. registry root ≠ artifact root   → snapshot-unavailable (unbound proofs)
 *   6. wallet not in leaf set          → wallet-not-eligible
 *   7. proof fails vs on-chain root    → proof-unavailable
 *   8. otherwise                       → claimable
 */
export function walletClaimView(input: WalletClaimInput): WalletClaimView {
  const { wallet, artifact, registry, registryAbsent, registryError, claimRecord, claimRecordError, vaultProgramId } = input;
  const poolAddress = artifact?.poolAddress ?? "";
  // Derived once, server-side, by the canonical SDK — the browser never
  // re-derives PDAs (it carries no SDK surface at all).
  const recordPda =
    artifact === null
      ? null
      : claimRecordPda(new PublicKey(vaultProgramId), new PublicKey(artifact.poolAddress), new PublicKey(wallet)).toBase58();

  // 1. The on-chain record is the canonical evidence a claim was PAID.
  if (claimRecord !== null) {
    const recordBalance = BigInt(claimRecord.lpBalanceAtSnapshot);
    const claimable =
      registry !== null && recordBalance > 0n
        ? expectedClaimAmountLamports(
            registry.lpHolderPoolTotalLamports,
            recordBalance,
            registry.lpTotalSupplyAtSnapshot,
          )
        : null;
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "claimed",
      reason: null,
      entry: null,
      proofStatus: null,
      claimRecord,
      claimableLamports: claimable === null ? null : claimable.toString(10),
      claimedLamports: claimRecord.amountLamports,
      remainingLamports: "0",
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 2. A failed record read is fail-closed: "unknown", never "never claimed".
  if (claimRecordError) {
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "snapshot-unavailable",
      reason:
        "Snapshot unavailable — the wallet's on-chain claim record could not be read, so a past claim cannot be ruled out and eligibility cannot be established (fail-closed).",
      entry: null,
      proofStatus: null,
      claimRecord: null,
      claimableLamports: null,
      claimedLamports: null,
      remainingLamports: null,
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 3. No settled distribution for this pool on-chain → there is nothing to
  //    claim and nothing to verify against: the honest "nothing found".
  if (registryAbsent) {
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "no-claim-record",
      reason:
        "No claim record found — no PoolRegistry exists for this pool on devnet (no salvage has settled), and the wallet holds no claim record.",
      entry: null,
      proofStatus: null,
      claimRecord: null,
      claimableLamports: null,
      claimedLamports: null,
      remainingLamports: null,
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 4. The distribution side cannot establish eligibility — unknown, not ineligible.
  if (artifact === null || registry === null) {
    const why =
      artifact === null
        ? "Snapshot unavailable — the distribution artifact is not in a verifiable state, so wallet eligibility cannot be established (fail-closed)."
        : `Snapshot unavailable — the on-chain PoolRegistry could not be read (${registryError ?? "unknown error"}), so wallet eligibility cannot be established (fail-closed).`;
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "snapshot-unavailable",
      reason: why,
      entry: null,
      proofStatus: null,
      claimRecord: null,
      claimableLamports: null,
      claimedLamports: null,
      remainingLamports: null,
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 5. The artifact must be bound to the on-chain root — proofs from an
  //    unbound artifact are unusable no matter how internally consistent.
  if (registry.merkleRoot !== artifact.merkleRoot) {
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "snapshot-unavailable",
      reason:
        "Snapshot unavailable — the distribution artifact's Merkle root does not match the on-chain PoolRegistry root. This artifact is not the sealed snapshot for this salvage, so no proof from it can be honored.",
      entry: null,
      proofStatus: null,
      claimRecord: null,
      claimableLamports: null,
      claimedLamports: null,
      remainingLamports: null,
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 6. Healthy distribution — is the wallet a claimant at all?
  const entry = entryForWallet(artifact, wallet);
  if (entry === null) {
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "wallet-not-eligible",
      reason: `Wallet not eligible — this wallet holds no leaf in the sealed distribution (${artifact.leafCount} claimants, root ${artifact.merkleRoot.slice(0, 12)}…); it was not an LP holder of this pool at the snapshot.`,
      entry: null,
      proofStatus: null,
      claimRecord: null,
      claimableLamports: null,
      claimedLamports: null,
      remainingLamports: null,
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 7. Defense-in-depth proof check: the entry's proof must fold, THROUGH
  //    THE SDK, to the on-chain registry root (verified integrity already
  //    binds it to the artifact root; this binds it to the chain).
  if (!entryProofVerifies(entry, registry.merkleRoot)) {
    return {
      wallet,
      poolAddress,
      claimRecordPda: recordPda,
      state: "proof-unavailable",
      reason:
        "Proof unavailable — the wallet's leaf is in the distribution but its Merkle proof does not verify against the on-chain registry root; the claim cannot be prepared from this artifact.",
      entry: { lpBalanceAtSnapshot: entry.lpBalance.toString(10), leaf: entry.leaf, proof: entry.proof },
      proofStatus: "failed",
      claimRecord: null,
      claimableLamports: null,
      claimedLamports: null,
      remainingLamports: null,
      preparedClaim: null,
      amountNote: null,
    };
  }

  // 8. Claimable — expected amount from the normative formula.
  const expected = expectedClaimAmountLamports(
    registry.lpHolderPoolTotalLamports,
    entry.lpBalance,
    registry.lpTotalSupplyAtSnapshot,
  );
  return {
    wallet,
    poolAddress,
    claimRecordPda: recordPda,
    state: "claimable",
    reason: null,
    entry: { lpBalanceAtSnapshot: entry.lpBalance.toString(10), leaf: entry.leaf, proof: entry.proof },
    proofStatus: "verified",
    claimRecord: null,
    claimableLamports: expected.toString(10),
    claimedLamports: "0",
    remainingLamports: expected.toString(10),
    preparedClaim: preparedInstruction(vaultProgramId, artifact.poolAddress, wallet, entry),
    amountNote:
      "Expected pro-rata amount (normative on-chain formula). The final amount is determined on-chain at claim time.",
  };
}
