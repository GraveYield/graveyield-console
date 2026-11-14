// Protocol pulse — LIVE read-only devnet reads for the Overview (P3-A Task 3.3).
//
// Every value here is independently verifiable: it is decoded from the
// deployed GraveScanner / GraveVault ProtocolConfig PDAs via a public devnet
// RPC, with Anchor-discriminator checks before any field is read. Nothing is
// cached across reloads, nothing is estimated, and any failure degrades the
// affected row to an explicit "unavailable" — never to a default or a guess.
//
// Layouts mirror graveyield-protocol sdk/src/accountDecoders.ts exactly
// (field order is locked by Anchor's #[account] derivation). The console
// intentionally does NOT import the protocol SDK (browser bundle, separate
// repo) — the discriminator + field layout are pinned by unit tests instead.

import { PROGRAM_IDS } from "./data";

export const PROTOCOL_CONFIG_DISCRIMINATOR = new Uint8Array([
  0xcf, 0x5b, 0xfa, 0x1c, 0x98, 0xb3, 0xd7, 0xd1,
]); // sha256("account:ProtocolConfig")[0..8] — same account name in both programs

/**
 * Single documented RPC configuration source (audit finding 5.4).
 *
 * The wallet connection (providers.tsx), the protocol pulse, the epoch
 * telemetry AND the cluster-identity verification (finding 5.5) all resolve
 * to the SAME endpoint: `NEXT_PUBLIC_SOLANA_RPC_URL` when set, otherwise the
 * public devnet host. There is deliberately no second configuration
 * variable — a private/quota-ed endpoint configured for the wallet must
 * serve every read this console makes, so all data surfaces come from one
 * place and the displayed host always corresponds to the endpoint used.
 */
export const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";

/** The one RPC endpoint the console reads from (env-overridable, devnet fallback). */
export function configuredRpcEndpoint(): string {
  const raw = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return DEFAULT_DEVNET_RPC_URL;
}

/**
 * Redacted endpoint for display and diagnostics (finding 5.4): scheme +
 * host (+ path) with credentials and query strings stripped — some devnet
 * providers carry API keys in the query string, and no key may leak into a
 * client-visible surface. Unparsable input never throws; it renders a
 * placeholder instead of a guess.
 */
export function redactRpcEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const auth = u.username || u.password ? "<redacted>@" : "";
    const path = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.protocol}//${auth}${u.host}${path}`;
  } catch {
    return "<unparsable endpoint>";
  }
}

export interface ScannerConfigLive {
  authority: string;
  pendingAuthority: string;
  inactivitySeconds: string;
  priceCollapseBps: number;
  minTvlLamports: string;
  anchorStalenessSeconds: string;
  lpBurnDustThreshold: string;
  certTtlSeconds: string;
  paused: boolean;
  activityOracle: string;
  launchPriceOracle: string;
  bump: number;
}

export interface VaultConfigLive {
  authority: string;
  lpHolderShareBps: number;
  salvorShareBps: number;
  protocolShareBps: number;
  maxPriorityFeeCeilingLamports: string;
  maxSlippageBps: number;
  jupiterDustThresholdLamports: string;
  timelockSeconds: string;
  emergencyPaused: boolean;
  bump: number;
}

export interface ProgramPulse<C> {
  programId: string;
  /** Program account exists on devnet and is executable. */
  executable: boolean | null; // null = lookup unavailable
  configPda: string;
  config: C | null;
  configError: string | null;
}

export interface ProtocolPulse {
  fetchedAtUnixMs: number;
  rpcHost: string;
  scanner: ProgramPulse<ScannerConfigLive>;
  vault: ProgramPulse<VaultConfigLive>;
}

export type PulseResult =
  | { ok: true; pulse: ProtocolPulse }
  | { ok: false; reason: string };

/** Exact u64 LE read as a decimal string — BigInt keeps full precision. */
function readU64(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

/** base58 (Bitcoin alphabet) — cross-checked against @solana/web3.js in tests. */
export function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes encode as '1'.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}

function readPubkey(data: Uint8Array, offset: number): string {
  return base58Encode(data.subarray(offset, offset + 32));
}

export function decodeScannerConfigLive(data: Uint8Array): ScannerConfigLive {
  if (data.length < 8 + 32 + 32 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 1) {
    throw new Error(`scanner ProtocolConfig too short (${data.length} bytes)`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PROTOCOL_CONFIG_DISCRIMINATOR[i]) {
      throw new Error("scanner config discriminator mismatch — not a ProtocolConfig account");
    }
  }
  let o = 8;
  const authority = readPubkey(data, o); o += 32;
  const pendingAuthority = readPubkey(data, o); o += 32;
  o += 8; // pending_authority_eta (i64) — reserved state (GOV-001)
  const inactivitySeconds = readU64(data, o); o += 8;
  const priceCollapseBps = readU16(data, o); o += 2;
  const minTvlLamports = readU64(data, o); o += 8;
  const anchorStalenessSeconds = readU64(data, o); o += 8;
  const lpBurnDustThreshold = readU64(data, o); o += 8;
  const certTtlSeconds = readU64(data, o); o += 8;
  const paused = data[o] === 1; o += 1;
  const activityOracle = readPubkey(data, o); o += 32;
  const launchPriceOracle = readPubkey(data, o); o += 32;
  const bump = data[o];
  if (authority.length === 0) throw new Error("decode produced empty authority");
  return {
    authority,
    pendingAuthority,
    inactivitySeconds: inactivitySeconds.toString(),
    priceCollapseBps,
    minTvlLamports: minTvlLamports.toString(),
    anchorStalenessSeconds: anchorStalenessSeconds.toString(),
    lpBurnDustThreshold: lpBurnDustThreshold.toString(),
    certTtlSeconds: certTtlSeconds.toString(),
    paused,
    activityOracle,
    launchPriceOracle,
    bump,
  };
}

export function decodeVaultConfigLive(data: Uint8Array): VaultConfigLive {
  if (data.length < 8 + 32 + 32 + 8 + 2 + 2 + 2 + 8 + 2 + 8 + 8 + 1 + 1) {
    throw new Error(`vault ProtocolConfig too short (${data.length} bytes)`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PROTOCOL_CONFIG_DISCRIMINATOR[i]) {
      throw new Error("vault config discriminator mismatch — not a ProtocolConfig account");
    }
  }
  let o = 8;
  const authority = readPubkey(data, o); o += 32;
  o += 32; // pending_authority
  o += 8; // pending_authority_eta
  const lpHolderShareBps = readU16(data, o); o += 2;
  const salvorShareBps = readU16(data, o); o += 2;
  const protocolShareBps = readU16(data, o); o += 2;
  const maxPriorityFeeCeilingLamports = readU64(data, o); o += 8;
  const maxSlippageBps = readU16(data, o); o += 2;
  const jupiterDustThresholdLamports = readU64(data, o); o += 8;
  const timelockSeconds = readU64(data, o); o += 8;
  const emergencyPaused = data[o] === 1; o += 1;
  const bump = data[o];
  return {
    authority,
    lpHolderShareBps,
    salvorShareBps,
    protocolShareBps,
    maxPriorityFeeCeilingLamports: maxPriorityFeeCeilingLamports.toString(),
    maxSlippageBps,
    jupiterDustThresholdLamports: jupiterDustThresholdLamports.toString(),
    timelockSeconds: timelockSeconds.toString(),
    emergencyPaused,
    bump,
  };
}

interface RpcAccountInfo {
  executable: boolean;
  data: [string, string];
  owner: string;
}

/** Minimal JSON-RPC getAccountInfo — base64 payload, no web3.js dependency. */
async function getAccountInfo(rpcEndpoint: string, address: string): Promise<RpcAccountInfo | null> {
  const res = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const json = (await res.json()) as { result?: { value?: RpcAccountInfo | null }; error?: unknown };
  if (json.error) throw new Error("rpc returned an error");
  return json.result?.value ?? null;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readProgram<C>(
  rpcEndpoint: string,
  programId: string,
  configPda: string,
  decode: (data: Uint8Array) => C,
): Promise<ProgramPulse<C>> {
  const pulse: ProgramPulse<C> = {
    programId,
    executable: null,
    configPda,
    config: null,
    configError: null,
  };
  try {
    const prog = await getAccountInfo(rpcEndpoint, programId);
    pulse.executable = prog ? prog.executable : false;
  } catch {
    pulse.executable = null; // lookup unavailable — recorded, not guessed
  }
  try {
    const cfg = await getAccountInfo(rpcEndpoint, configPda);
    if (!cfg) {
      pulse.configError = "config PDA not found on devnet";
    } else {
      pulse.config = decode(b64ToBytes(cfg.data[0]));
    }
  } catch (err) {
    pulse.configError = String((err as Error).message ?? err).slice(0, 140);
  }
  return pulse;
}

/** Fetch the full pulse. Partial availability is preserved per program.
 * Reads the console's single configured RPC endpoint by default
 * (audit finding 5.4); `rpcHost` in the result is the REDACTED endpoint
 * actually fetched (query strings/credentials never render). */
export async function fetchProtocolPulse(rpcEndpoint: string = configuredRpcEndpoint()): Promise<ProtocolPulse> {
  const [scanner, vault] = await Promise.all([
    readProgram(rpcEndpoint, PROGRAM_IDS.graveScanner, PROGRAM_IDS.scannerConfigPda, decodeScannerConfigLive),
    readProgram(rpcEndpoint, PROGRAM_IDS.graveVault, PROGRAM_IDS.vaultConfigPda, decodeVaultConfigLive),
  ]);
  return { fetchedAtUnixMs: Date.now(), rpcHost: redactRpcEndpoint(rpcEndpoint), scanner, vault };
}

/* ── Cluster identity (P4.2, audit finding 5.5) ────────────────────
   The console serves an operational UI whose reads must land on the cluster
   they claim to. A hardcoded "Solana devnet" badge asserts an identity it
   never verifies — a misconfigured NEXT_PUBLIC_SOLANA_RPC_URL would run
   wallet reads against a foreign cluster under a devnet label. The endpoint's
   genesis hash is the chain-level identity anchor (a URL is not; a wallet
   connection is not): read it once per load, compare against the canonical
   devnet genesis, and let the UI show verified/unverified — never an
   unverified assertion. Read-only; no polling. */

/** Canonical Solana devnet genesis hash — pinned in graveyield-protocol
 * scripts/devnet/ns3_identities.mjs (the deployment tooling's own
 * --expected-genesis-hash check). */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Read the connected endpoint's genesis hash via JSON-RPC getGenesisHash.
 * Fails closed: a non-ok/error/unusable answer throws (the caller renders
 * an explicit unverified state — never a guess).
 */
export async function fetchGenesisHash(
  rpcEndpoint: string = configuredRpcEndpoint(),
): Promise<string> {
  const res = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const json = (await res.json()) as { result?: { value?: unknown }; error?: unknown };
  if (json.error) throw new Error("rpc returned an error");
  const value = json.result?.value;
  // Structural validation: a genesis hash is a non-trivial base58 string.
  if (typeof value !== "string" || value.length < 32 || value.length > 50 || /\s/.test(value)) {
    throw new Error("getGenesisHash returned an unusable payload");
  }
  return value;
}

export type ClusterIdentity =
  | { status: "verified"; cluster: "devnet"; genesisHash: string }
  | { status: "unverified"; reason: string };

/**
 * Classify an endpoint's genesis hash against the canonical devnet genesis.
 * Pure and total: any non-matching / missing input maps to an explicit
 * unverified state with a reason — the caller can never accidentally render
 * a verified badge from unverified data.
 */
export function classifyCluster(genesisHash: string | null | undefined): ClusterIdentity {
  if (typeof genesisHash !== "string" || genesisHash.length === 0) {
    return { status: "unverified", reason: "genesis hash unavailable" };
  }
  if (genesisHash === DEVNET_GENESIS_HASH) {
    return { status: "verified", cluster: "devnet", genesisHash };
  }
  return { status: "unverified", reason: "endpoint genesis hash does not match Solana devnet" };
}

/* ── Epoch telemetry (P4.2, audit D6) ────────────────────────────
   The C6 epoch gap and the shell's epoch bar need the CURRENT epoch.
   It is read live from the same public devnet RPC (getEpochInfo) —
   never baked into the source as a constant. A failed or malformed
   lookup degrades to "unavailable" at the call site; it never falls
   back to a stale number. One read per mount — no polling. */
export interface EpochTelemetry {
  fetchedAtUnixMs: number;
  rpcHost: string;
  /** Current epoch number as reported by the RPC. */
  epoch: number;
  /** slotIndex / slotsInEpoch, clamped to [0, 1]. */
  progress: number;
}

interface EpochInfoValue {
  absoluteSlot?: unknown;
  blockHeight?: unknown;
  epoch?: unknown;
  slotIndex?: unknown;
  slotsInEpoch?: unknown;
}

function asNonNegativeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export async function fetchEpochTelemetry(
  rpcEndpoint: string = configuredRpcEndpoint(),
): Promise<EpochTelemetry> {
  const res = await fetch(rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getEpochInfo", params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const json = (await res.json()) as { result?: { value?: EpochInfoValue }; error?: unknown };
  if (json.error) throw new Error("rpc returned an error");
  const value = json.result?.value;
  const epoch = asNonNegativeInt(value?.epoch);
  const slotIndex = asNonNegativeInt(value?.slotIndex);
  const slotsInEpoch = asNonNegativeInt(value?.slotsInEpoch);
  // Fail-closed: an unusable answer is an error, not a zero — the caller
  // renders "unavailable" instead of any substitute number.
  if (epoch === null || slotIndex === null || slotsInEpoch === null || slotsInEpoch <= 0) {
    throw new Error("getEpochInfo returned an unusable payload");
  }
  return {
    fetchedAtUnixMs: Date.now(),
    rpcHost: redactRpcEndpoint(rpcEndpoint),
    epoch,
    progress: Math.min(1, Math.max(0, slotIndex / slotsInEpoch)),
  };
}
