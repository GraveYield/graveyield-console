// Claims TRANSPORT types + client-side hydration (P4.4 claims integration).
//
// /api/gy/claims answers with this envelope. The distribution-artifact half
// reuses the four artifact states the snapshot/fleet transports established
// (valid | stale | missing | corrupt) with the same honest dataState mapping.
//
// The payload is deliberately NOT the raw artifact: per-holder entries never
// leave the server (privacy). The client therefore CANNOT re-run the artifact
// integrity gate — it never receives the leaf set — so its re-validation
// covers everything it IS given:
//   - envelope well-formedness and internal honesty (dataState === the
//     mapping's promise; failed states carry no payload);
//   - the distribution projection's schema (no entries can hide in it — the
//     validator rejects unknown payloads that would carry one);
//   - the wallet view's own schema and state vocabulary;
//   - wall-clock freshness (effectiveClaimsState), which can degrade
//     valid→stale but never upgrade — same rule as the snapshot transport.
//
// The claim ACTION is separately honest: the client only shows a
// confirmed/paid claim after re-reading the ClaimRecord PDA from devnet with
// the console's own web3.js (see components/gy/claims.tsx) — the server's
// word is never the sole evidence that lamports moved.

import type { DataState } from "./types";
import type {
  DistributionPublic,
  PreparedClaimInstruction,
  WalletClaimRecord,
  WalletClaimState,
} from "./claimsContract";

/** The four artifact states the transport can report (snapshot/fleet vocabulary). */
export type ArtifactState = "valid" | "stale" | "missing" | "corrupt";

export type ClaimsReasonCode =
  | "NO_SOURCE_CONFIGURED"
  | "SOURCE_CONFLICT"
  | "READ_FAILED"
  | "FETCH_HTTP_STATUS"
  | "FETCH_FAILED"
  | "OVERSIZE"
  | "PARSE_FAILED"
  | "INTEGRITY_FAILED"
  | "FUTURE_ARTIFACT"
  | "MALFORMED_ENVELOPE";

export type ClaimsSourceKind = "path" | "url" | "none";

/** Envelope for the distribution-artifact half of the payload. */
export interface ClaimsTransport {
  artifactState: ArtifactState;
  /** honest UI-facing mapping: valid→real, stale→stale, missing/corrupt→unavailable */
  dataState: DataState;
  reason: string | null;
  reasonCode: ClaimsReasonCode | null;
  source: { kind: ClaimsSourceKind; uri: string | null };
  /** server clock at evaluation time (unix ms) — the client's "checked at" */
  checkedAtUnixMs: number;
  ageMs: number | null;
  maxAgeMs: number | null;
}

/** Live devnet settlement facts for the distribution's pool. */
export interface ClaimsOnchain {
  checkedAtUnixMs: number;
  rpcHost: string;
  poolRegistry: {
    pda: string;
    found: boolean;
    error: string | null;
    /** Present only when found — all u64s as exact decimal strings. */
    ammProgramId: string | null;
    salvor: string | null;
    merkleRoot: string | null;
    lpTotalSupplyAtSnapshot: string | null;
    lpHolderPoolTotalLamports: string | null;
    lpHolderPoolClaimedLamports: string | null;
    salvagedAtSlot: string | null;
    salvagedAtTs: number | null;
  };
  salvageReceipt: {
    pda: string;
    found: boolean;
    error: string | null;
    lpHolderAmountLamports: string | null;
    totalProceedsLamports: string | null;
    issuedAtSlot: string | null;
    issuedAtTs: number | null;
  };
  /** Native lamports in lp_holder_pool_vault (context for the distribution). */
  vaultLamports: string | null;
  vaultError: string | null;
  /** Current epoch telemetry (getEpochInfo) — for the "distribution epoch" row. */
  epoch: { epoch: number; slotsInEpoch: number } | null;
}

/** Server-side wallet claim view (mirrors claimsContract.WalletClaimView). */
export interface WalletClaimViewPayload {
  wallet: string;
  /** The distribution's pool this view was computed against (empty when unknown). */
  poolAddress: string;
  /** The (pool, wallet) ClaimRecord PDA, derived server-side by the canonical
   * SDK — the client's post-confirmation honesty gate reads THIS address. */
  claimRecordPda: string | null;
  state: WalletClaimState;
  reason: string | null;
  entry: { lpBalanceAtSnapshot: string; leaf: string; proof: string[] } | null;
  proofStatus: "verified" | "failed" | "absent" | null;
  claimRecord: WalletClaimRecord | null;
  claimableLamports: string | null;
  claimedLamports: string | null;
  remainingLamports: string | null;
  preparedClaim: PreparedClaimInstruction | null;
  amountNote: string | null;
}

/** Full route payload. */
export interface ClaimsTransportPayload extends ClaimsTransport {
  /** The privacy-stripped distribution — ONLY for valid | stale. */
  distribution: DistributionPublic | null;
  onchain: ClaimsOnchain | null;
  wallet: WalletClaimViewPayload | null;
}

/** Honest data-state mapping — single source of truth for UI badges. */
export function claimsTransportDataState(artifactState: ArtifactState): DataState {
  switch (artifactState) {
    case "valid":
      return "real";
    case "stale":
      return "stale";
    case "missing":
    case "corrupt":
      return "unavailable";
  }
}

/** Shared stale explanation — one wording for resolver and display. */
export function claimsStaleReason(ageMs: number, maxAgeMs: number): string {
  return `Distribution artifact age ${ageMs} ms exceeds its ${maxAgeMs} ms freshness budget — data is served as stale, never as fresh.`;
}

/**
 * Display-time freshness re-evaluation (P4.2 D5 rule, claims edition): a
 * payload that classified valid/real at fetch time degrades to stale once the
 * wall clock passes the artifact's own budget. Clock only moves forward —
 * this can downgrade, never upgrade.
 */
export function effectiveClaimsState(payload: ClaimsTransportPayload, nowMs: number): ClaimsTransportPayload {
  if (payload.artifactState !== "valid" && payload.artifactState !== "stale") return payload;
  if (payload.distribution === null) return payload;
  // The projection carries no generatedAt of its own; the check time + budget
  // were stamped by the server at evaluation. Age from the SERVER's anchor
  // (checkedAt), evaluated against the CURRENT clock.
  const checkedAt = payload.checkedAtUnixMs;
  const maxAgeMs = payload.maxAgeMs;
  if (maxAgeMs === null) return payload;
  const ageMs = Math.max(0, nowMs - checkedAt) + (payload.ageMs ?? 0);
  const fresh = ageMs <= maxAgeMs;
  if (fresh === (payload.artifactState === "valid")) {
    return { ...payload, ageMs };
  }
  if (fresh) {
    return { ...payload, artifactState: "valid", dataState: "real", reason: null, reasonCode: null, ageMs };
  }
  return {
    ...payload,
    artifactState: "stale",
    dataState: "stale",
    reason: claimsStaleReason(ageMs, maxAgeMs),
    reasonCode: null,
    ageMs,
    maxAgeMs,
  };
}

/**
 * D5 holding rule, claims edition: when the latest check produced no
 * envelope (unreachable / malformed) the last good payload stays on screen,
 * labeled "cached" — real facts from a previous successful check the latest
 * check could not reconfirm. Staleness still wins over cached.
 */
export function asCachedClaimsDisplay(payload: ClaimsTransportPayload, nowMs: number): ClaimsTransportPayload {
  const aged = effectiveClaimsState(payload, nowMs);
  if (aged.distribution === null) return aged;
  if (aged.dataState === "real") return { ...aged, dataState: "cached" };
  return aged;
}

/** The Graveyard's display rule, claims edition (pure, unit-tested). */
export function resolveDisplayClaimsPayload(
  latest: ClaimsTransportPayload | null,
  lastGood: ClaimsTransportPayload | null,
  nowMs: number,
): ClaimsTransportPayload | null {
  if (latest !== null && latest.distribution !== null) return effectiveClaimsState(latest, nowMs);
  if (lastGood !== null) return asCachedClaimsDisplay(lastGood, nowMs);
  return null;
}

export const CLAIMS_REASON_CODES: readonly ClaimsReasonCode[] = [
  "NO_SOURCE_CONFIGURED",
  "SOURCE_CONFLICT",
  "READ_FAILED",
  "FETCH_HTTP_STATUS",
  "FETCH_FAILED",
  "OVERSIZE",
  "PARSE_FAILED",
  "INTEGRITY_FAILED",
  "FUTURE_ARTIFACT",
  "MALFORMED_ENVELOPE",
];

const WALLET_CLAIM_STATES: readonly WalletClaimState[] = [
  "claimed",
  "no-claim-record",
  "snapshot-unavailable",
  "wallet-not-eligible",
  "proof-unavailable",
  "claimable",
];

const PROOF_STATUSES: readonly ("verified" | "failed" | "absent")[] = ["verified", "failed", "absent"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function optU64Str(v: unknown): string | null {
  return typeof v === "string" && /^[0-9]+$/.test(v) ? v : null;
}

function optHex32(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** Exact-u64 decimal string field that MUST be present when `present` is true. */
function reqU64Str(v: unknown, what: string): string {
  const s = optU64Str(v);
  if (s === null) throw new Error(`${what} must be an exact u64 decimal string`);
  return s;
}

function validateDistribution(d: unknown): DistributionPublic {
  if (!isObj(d)) throw new Error("distribution must be an object");
  if (d.formatVersion !== 1) throw new Error("distribution.formatVersion must be 1");
  if (typeof d.poolAddress !== "string" || d.poolAddress.length < 32) throw new Error("distribution.poolAddress invalid");
  if (typeof d.ammProgramId !== "string" || d.ammProgramId.length < 32) throw new Error("distribution.ammProgramId invalid");
  if (typeof d.lpMint !== "string" || d.lpMint.length < 32) throw new Error("distribution.lpMint invalid");
  const snapshotSlot = optFinite(d.snapshotSlot);
  if (snapshotSlot === null || snapshotSlot < 0 || !Number.isInteger(snapshotSlot)) throw new Error("distribution.snapshotSlot invalid");
  if (optHex32(d.merkleRoot) === null) throw new Error("distribution.merkleRoot must be 32-byte hex");
  const leafCount = optFinite(d.leafCount);
  const treeDepth = optFinite(d.treeDepth);
  if (leafCount === null || !Number.isInteger(leafCount) || leafCount <= 0) throw new Error("distribution.leafCount invalid");
  if (treeDepth === null || !Number.isInteger(treeDepth) || treeDepth < 0) throw new Error("distribution.treeDepth invalid");
  if (d.integrity !== "verified") throw new Error("distribution must carry integrity \"verified\"");
  if (!isObj(d.reconciliation)) throw new Error("distribution.reconciliation must be an object");
  const rec = d.reconciliation as Record<string, unknown>;
  const reconciliation = {
    enumeratedTotal: reqU64Str(rec.enumeratedTotal, "distribution.reconciliation.enumeratedTotal"),
    entriesTotal: reqU64Str(rec.entriesTotal, "distribution.reconciliation.entriesTotal"),
    sinkExclusionsTotal: reqU64Str(rec.sinkExclusionsTotal, "distribution.reconciliation.sinkExclusionsTotal"),
  };
  // Privacy, structurally: a projection carrying per-holder rows is not a
  // projection — reject it rather than render it.
  for (const forbidden of ["entries", "holders", "leafs", "proofs"]) {
    if (forbidden in d) throw new Error(`distribution must not carry "${forbidden}" (privacy projection only)`);
  }
  return {
    formatVersion: 1,
    poolAddress: d.poolAddress as string,
    ammProgramId: d.ammProgramId as string,
    lpMint: d.lpMint as string,
    snapshotSlot,
    lpTotalSupplyAtSnapshot: reqU64Str(d.lpTotalSupplyAtSnapshot, "distribution.lpTotalSupplyAtSnapshot"),
    merkleRoot: d.merkleRoot as string,
    leafCount,
    treeDepth,
    reconciliation,
    integrity: "verified",
  };
}

function validateWalletClaim(w: unknown): WalletClaimViewPayload {
  if (!isObj(w)) throw new Error("wallet must be an object");
  if (typeof w.wallet !== "string" || w.wallet.length < 32) throw new Error("wallet.wallet invalid");
  if (typeof w.poolAddress !== "string") throw new Error("wallet.poolAddress must be a string (may be empty)");
  if (w.claimRecordPda !== null && w.claimRecordPda !== undefined && typeof w.claimRecordPda !== "string") {
    throw new Error("wallet.claimRecordPda must be a string or null");
  }
  const state = w.state;
  if (typeof state !== "string" || !WALLET_CLAIM_STATES.includes(state as WalletClaimState)) {
    throw new Error(`wallet.state ${JSON.stringify(state)} is not in the claim-state vocabulary`);
  }
  const reason = w.reason === null ? null : optStr(w.reason);
  if (reason === undefined) throw new Error("wallet.reason must be null or a string");
  const proofStatus = w.proofStatus === null ? null : w.proofStatus;
  if (proofStatus !== null && (typeof proofStatus !== "string" || !PROOF_STATUSES.includes(proofStatus as "verified"))) {
    throw new Error("wallet.proofStatus invalid");
  }
  let entry: WalletClaimViewPayload["entry"] = null;
  if (w.entry !== null && w.entry !== undefined) {
    if (!isObj(w.entry)) throw new Error("wallet.entry must be an object or null");
    const e = w.entry as Record<string, unknown>;
    if (!Array.isArray(e.proof) || !e.proof.every((p) => optHex32(p) !== null)) {
      throw new Error("wallet.entry.proof must be hex32 elements");
    }
    entry = {
      lpBalanceAtSnapshot: reqU64Str(e.lpBalanceAtSnapshot, "wallet.entry.lpBalanceAtSnapshot"),
      leaf: optHex32(e.leaf) ?? (() => { throw new Error("wallet.entry.leaf must be hex32"); })(),
      proof: (e.proof as unknown[]).map((p) => p as string),
    };
  }
  let claimRecord: WalletClaimRecord | null = null;
  if (w.claimRecord !== null && w.claimRecord !== undefined) {
    if (!isObj(w.claimRecord)) throw new Error("wallet.claimRecord must be an object or null");
    const cr = w.claimRecord as Record<string, unknown>;
    claimRecord = {
      pda: optStr(cr.pda) ?? (() => { throw new Error("wallet.claimRecord.pda invalid"); })(),
      amountLamports: reqU64Str(cr.amountLamports, "wallet.claimRecord.amountLamports"),
      lpBalanceAtSnapshot: reqU64Str(cr.lpBalanceAtSnapshot, "wallet.claimRecord.lpBalanceAtSnapshot"),
      claimedAtSlot: reqU64Str(cr.claimedAtSlot, "wallet.claimRecord.claimedAtSlot"),
      claimedAtTs: optFinite(cr.claimedAtTs),
    };
  }
  let preparedClaim: PreparedClaimInstruction | null = null;
  if (w.preparedClaim !== null && w.preparedClaim !== undefined) {
    if (!isObj(w.preparedClaim)) throw new Error("wallet.preparedClaim must be an object or null");
    const pc = w.preparedClaim as Record<string, unknown>;
    if (typeof pc.programId !== "string" || typeof pc.data !== "string" || !Array.isArray(pc.keys)) {
      throw new Error("wallet.preparedClaim shape invalid");
    }
    const keys = pc.keys.map((k) => {
      if (!isObj(k)) throw new Error("wallet.preparedClaim.keys[i] must be an object");
      const kk = k as Record<string, unknown>;
      if (typeof kk.pubkey !== "string" || typeof kk.isSigner !== "boolean" || typeof kk.isWritable !== "boolean") {
        throw new Error("wallet.preparedClaim.keys[i] fields invalid");
      }
      return { pubkey: kk.pubkey, isSigner: kk.isSigner, isWritable: kk.isWritable };
    });
    preparedClaim = { programId: pc.programId, keys, data: pc.data as string };
  }
  const amountNote = w.amountNote === null ? null : optStr(w.amountNote);
  if (amountNote === undefined) throw new Error("wallet.amountNote must be null or a string");
  return {
    wallet: w.wallet as string,
    poolAddress: w.poolAddress as string,
    claimRecordPda: (w.claimRecordPda as string | null) ?? null,
    state: state as WalletClaimState,
    reason,
    entry,
    proofStatus: proofStatus as WalletClaimViewPayload["proofStatus"],
    claimRecord,
    claimableLamports: optU64Str(w.claimableLamports),
    claimedLamports: optU64Str(w.claimedLamports),
    remainingLamports: optU64Str(w.remainingLamports),
    preparedClaim,
    amountNote,
  };
}

function validateOnchain(o: unknown): ClaimsOnchain {
  if (!isObj(o)) throw new Error("onchain must be an object");
  const checkedAtUnixMs = optFinite(o.checkedAtUnixMs);
  if (checkedAtUnixMs === null || checkedAtUnixMs <= 0) throw new Error("onchain.checkedAtUnixMs invalid");
  if (typeof o.rpcHost !== "string") throw new Error("onchain.rpcHost invalid");
  if (!isObj(o.poolRegistry)) throw new Error("onchain.poolRegistry must be an object");
  const pr = o.poolRegistry as Record<string, unknown>;
  const prFound = pr.found === true;
  const poolRegistry: ClaimsOnchain["poolRegistry"] = {
    pda: optStr(pr.pda) ?? "",
    found: prFound,
    error: pr.error === null ? null : optStr(pr.error),
    ammProgramId: prFound ? optStr(pr.ammProgramId) : null,
    salvor: prFound ? optStr(pr.salvor) : null,
    merkleRoot: prFound ? optHex32(pr.merkleRoot) : null,
    lpTotalSupplyAtSnapshot: prFound ? optU64Str(pr.lpTotalSupplyAtSnapshot) : null,
    lpHolderPoolTotalLamports: prFound ? optU64Str(pr.lpHolderPoolTotalLamports) : null,
    lpHolderPoolClaimedLamports: prFound ? optU64Str(pr.lpHolderPoolClaimedLamports) : null,
    salvagedAtSlot: prFound ? optU64Str(pr.salvagedAtSlot) : null,
    salvagedAtTs: prFound ? optFinite(pr.salvagedAtTs) : null,
  };
  if (prFound) {
    if (!poolRegistry.merkleRoot || !poolRegistry.lpTotalSupplyAtSnapshot || !poolRegistry.lpHolderPoolTotalLamports) {
      throw new Error("onchain.poolRegistry found without its required facts");
    }
  }
  if (!isObj(o.salvageReceipt)) throw new Error("onchain.salvageReceipt must be an object");
  const sr = o.salvageReceipt as Record<string, unknown>;
  const srFound = sr.found === true;
  const salvageReceipt: ClaimsOnchain["salvageReceipt"] = {
    pda: optStr(sr.pda) ?? "",
    found: srFound,
    error: sr.error === null ? null : optStr(sr.error),
    lpHolderAmountLamports: srFound ? optU64Str(sr.lpHolderAmountLamports) : null,
    totalProceedsLamports: srFound ? optU64Str(sr.totalProceedsLamports) : null,
    issuedAtSlot: srFound ? optU64Str(sr.issuedAtSlot) : null,
    issuedAtTs: srFound ? optFinite(sr.issuedAtTs) : null,
  };
  if (typeof o.vaultLamports !== "string" && o.vaultLamports !== null) throw new Error("onchain.vaultLamports invalid");
  if (o.vaultError !== null && o.vaultError !== undefined && typeof o.vaultError !== "string") {
    throw new Error("onchain.vaultError invalid");
  }
  let epoch: ClaimsOnchain["epoch"] = null;
  if (o.epoch !== null && o.epoch !== undefined) {
    if (!isObj(o.epoch)) throw new Error("onchain.epoch must be an object or null");
    const e = o.epoch as Record<string, unknown>;
    const epochNum = optFinite(e.epoch);
    const slots = optFinite(e.slotsInEpoch);
    if (epochNum === null || slots === null || !Number.isInteger(epochNum) || !Number.isInteger(slots) || slots <= 0) {
      throw new Error("onchain.epoch fields invalid");
    }
    epoch = { epoch: epochNum, slotsInEpoch: slots };
  }
  return {
    checkedAtUnixMs,
    rpcHost: o.rpcHost as string,
    poolRegistry,
    salvageReceipt,
    vaultLamports: optU64Str(o.vaultLamports),
    vaultError: o.vaultError === undefined ? null : (o.vaultError as string | null),
    epoch,
  };
}

/**
 * Client-side gate for the route payload. Returns null (→ render
 * "unavailable") unless the envelope is well-formed, internally honest, and
 * every served projection re-validates against its schema. This is the
 * client-half of the fail-closed contract: whatever fails is rendered as
 * unavailable, never as data.
 */
export function hydrateClaimsPayload(json: unknown, nowMs: number): ClaimsTransportPayload | null {
  try {
    return hydrateClaimsPayloadInner(json, nowMs);
  } catch {
    // Fail-closed boundary: any validation failure — envelope dishonesty,
    // vocabulary violation, broken projection — renders as unavailable,
    // never as data.
    return null;
  }
}

function hydrateClaimsPayloadInner(json: unknown, nowMs: number): ClaimsTransportPayload {
  if (!isObj(json)) throw new Error("payload must be an object");
  const artifactState = json.artifactState;
  if (artifactState !== "valid" && artifactState !== "stale" && artifactState !== "missing" && artifactState !== "corrupt") {
    throw new Error("payload rejected by the client-side gate");
  }
  const dataState = json.dataState;
  if (dataState !== "real" && dataState !== "stale" && dataState !== "unavailable") throw new Error("payload rejected by the client-side gate");
  if (dataState !== claimsTransportDataState(artifactState)) throw new Error("payload rejected by the client-side gate"); // envelope honesty
  const checkedAtUnixMs = optFinite(json.checkedAtUnixMs);
  if (checkedAtUnixMs === null || checkedAtUnixMs <= 0) throw new Error("payload rejected by the client-side gate");
  const reasonCode = json.reasonCode;
  if (reasonCode !== null && !CLAIMS_REASON_CODES.includes(reasonCode as ClaimsReasonCode)) throw new Error("payload rejected by the client-side gate");
  const reason = json.reason === null ? null : optStr(json.reason);
  if (reason === undefined) throw new Error("payload rejected by the client-side gate");
  const src = json.source;
  if (!isObj(src)) throw new Error("payload rejected by the client-side gate");
  if (src.kind !== "path" && src.kind !== "url" && src.kind !== "none") throw new Error("payload rejected by the client-side gate");
  const uri = src.uri === null ? null : optStr(src.uri);
  if (uri === undefined) throw new Error("payload rejected by the client-side gate");
  const ageMs = json.ageMs === null ? null : optFinite(json.ageMs);
  if (ageMs === undefined) throw new Error("payload rejected by the client-side gate");
  const maxAgeMs = json.maxAgeMs === null ? null : optFinite(json.maxAgeMs);
  if (maxAgeMs === undefined) throw new Error("payload rejected by the client-side gate");

  const transport: ClaimsTransport = {
    artifactState,
    dataState,
    reason,
    reasonCode: (reasonCode as ClaimsReasonCode) ?? null,
    source: { kind: src.kind, uri },
    checkedAtUnixMs,
    ageMs,
    maxAgeMs,
  };

  // Failed artifact states carry no distribution — but the on-chain
  // settlement facts and the wallet view are an independent data plane
  // (live RPC), so they may still ride along. Either half being
  // present-but-invalid poisons the whole envelope (fail-closed — a
  // half-broken payload is not data).
  if (artifactState === "missing" || artifactState === "corrupt") {
    if (json.distribution !== null && json.distribution !== undefined) throw new Error("payload rejected by the client-side gate");
    return {
      ...transport,
      distribution: null,
      onchain: validateOptStrict(json.onchain, validateOnchain),
      wallet: validateOptStrict(json.wallet, validateWalletClaim),
    };
  }

  // valid | stale: the distribution projection must validate, and a
  // future-dated check must never classify as fresh.
  let distribution: DistributionPublic;
  try {
    distribution = validateDistribution(json.distribution);
  } catch {
    throw new Error("payload rejected by the client-side gate");
  }
  if (checkedAtUnixMs > nowMs + 5 * 60_000) throw new Error("payload rejected by the client-side gate");

  return {
    ...transport,
    distribution,
    onchain: validateOptStrict(json.onchain, validateOnchain),
    wallet: validateOptStrict(json.wallet, validateWalletClaim),
  };
}

/** An optional payload half: null rides as null; anything present must fully
 * validate or the WHOLE payload is rejected (fail-closed). */
function validateOptStrict<T>(raw: unknown, validate: (v: unknown) => T): T | null {
  if (raw === null || raw === undefined) return null;
  return validate(raw);
}
