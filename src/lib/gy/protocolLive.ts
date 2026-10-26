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

export const DEFAULT_DEVNET_RPC_HOST = "api.devnet.solana.com";

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
async function getAccountInfo(host: string, address: string): Promise<RpcAccountInfo | null> {
  const res = await fetch(`https://${host}`, {
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
  host: string,
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
    const prog = await getAccountInfo(host, programId);
    pulse.executable = prog ? prog.executable : false;
  } catch {
    pulse.executable = null; // lookup unavailable — recorded, not guessed
  }
  try {
    const cfg = await getAccountInfo(host, configPda);
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

/** Fetch the full pulse. Partial availability is preserved per program. */
export async function fetchProtocolPulse(rpcHost: string = DEFAULT_DEVNET_RPC_HOST): Promise<ProtocolPulse> {
  const [scanner, vault] = await Promise.all([
    readProgram(rpcHost, PROGRAM_IDS.graveScanner, PROGRAM_IDS.scannerConfigPda, decodeScannerConfigLive),
    readProgram(rpcHost, PROGRAM_IDS.graveVault, PROGRAM_IDS.vaultConfigPda, decodeVaultConfigLive),
  ]);
  return { fetchedAtUnixMs: Date.now(), rpcHost, scanner, vault };
}
