// RPC configuration + cluster-identity tests (audit findings 5.4 / 5.5).
//
// Finding 5.4 — the console has ONE documented RPC configuration source
// (NEXT_PUBLIC_SOLANA_RPC_URL → public devnet fallback). Every read surface
// (protocol pulse, epoch telemetry, genesis verification, and by
// construction the wallet connection via providers.tsx) resolves through
// `configuredRpcEndpoint()`; a configured endpoint must actually be used
// (no silent fallback to a different host), and displayed host values are
// redacted (credentials/query strings never render).
//
// Finding 5.5 — cluster identity is verified against the endpoint's genesis
// hash, never asserted. Matching → verified devnet; mismatching, missing,
// unusable, or unreachable → explicit unverified. Read-only.

/// <reference types="bun-types" />
import { describe, test, expect, afterEach } from "bun:test";

import {
  configuredRpcEndpoint,
  redactRpcEndpoint,
  fetchProtocolPulse,
  fetchEpochTelemetry,
  fetchGenesisHash,
  classifyCluster,
  decodeScannerConfigLive,
  decodeVaultConfigLive,
  PROTOCOL_CONFIG_DISCRIMINATOR,
  DEFAULT_DEVNET_RPC_URL,
  DEVNET_GENESIS_HASH,
} from "../protocolLive";

const ENV_KEY = "NEXT_PUBLIC_SOLANA_RPC_URL";
const originalEnv = process.env[ENV_KEY];
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  globalThis.fetch = originalFetch;
});

/** Mock fetch capturing the endpoint it was called with. */
function mockFetch(handler: (endpoint: string, body: unknown) => unknown | Promise<unknown>) {
  const calledWith: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input);
    calledWith.push(endpoint);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const result = await Promise.resolve(handler(endpoint, body));
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
  return calledWith;
}

function rpcOk(value: unknown): unknown {
  return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } };
}

/* ── Finding 5.4: one configuration source ────────────────────────── */

describe("configuredRpcEndpoint — single documented RPC source (finding 5.4)", () => {
  test("default: public devnet endpoint when no env is set", () => {
    delete process.env[ENV_KEY];
    expect(configuredRpcEndpoint()).toBe(DEFAULT_DEVNET_RPC_URL);
    expect(configuredRpcEndpoint()).toBe("https://api.devnet.solana.com");
  });

  test("custom endpoint is honored exactly", () => {
    process.env[ENV_KEY] = "https://solana-devnet.private.example/v2/rpc";
    expect(configuredRpcEndpoint()).toBe("https://solana-devnet.private.example/v2/rpc");
  });

  test("whitespace-only env falls back to the default — never an empty endpoint", () => {
    process.env[ENV_KEY] = "   ";
    expect(configuredRpcEndpoint()).toBe(DEFAULT_DEVNET_RPC_URL);
  });
});

describe("redactRpcEndpoint — no credentials in display surfaces (finding 5.4)", () => {
  test("strips query strings (API-key-style providers)", () => {
    const out = redactRpcEndpoint("https://devnet.helius-rpc.com/?api-key=SECRET-KEY-123");
    expect(out).toBe("https://devnet.helius-rpc.com");
    expect(out).not.toContain("SECRET");
  });

  test("strips userinfo credentials and keeps the path", () => {
    expect(redactRpcEndpoint("https://user:hunter2@rpc.example/v2/rpc")).toBe(
      "https://<redacted>@rpc.example/v2/rpc",
    );
    expect(redactRpcEndpoint("https://user:hunter2@rpc.example/v2/rpc")).not.toContain("hunter2");
  });

  test("plain endpoints pass through unchanged", () => {
    expect(redactRpcEndpoint("https://api.devnet.solana.com")).toBe("https://api.devnet.solana.com");
    expect(redactRpcEndpoint("http://localhost:8899")).toBe("http://localhost:8899");
  });

  test("unparsable input never throws — a placeholder, not a guess", () => {
    expect(redactRpcEndpoint("not a url")).toBe("<unparsable endpoint>");
  });
});

describe("fetchProtocolPulse — reads the configured endpoint (finding 5.4)", () => {
  test("custom endpoint is used verbatim — no accidental fallback to devnet", async () => {
    const custom = "https://solana-devnet.private.example/v2/rpc";
    const called = mockFetch((_endpoint, body) => {
      const method = (body as { method: string }).method;
      if (method === "getAccountInfo") return rpcOk(null); // no accounts — honest unavailable
      throw new Error(`unexpected method ${method}`);
    });
    const pulse = await fetchProtocolPulse(custom);
    expect(called.length).toBeGreaterThan(0);
    for (const endpoint of called) {
      expect(endpoint).toBe(custom);
      expect(endpoint).not.toContain("api.devnet.solana.com");
    }
    // Per-program partial availability preserved (existing behavior).
    expect(pulse.scanner.executable).toBe(false);
    expect(pulse.scanner.config).toBeNull();
    expect(pulse.scanner.configError).toBe("config PDA not found on devnet");
  });

  test("host reporting: rpcHost is the redacted endpoint actually fetched", async () => {
    const secret = "https://devnet.helius-rpc.com/?api-key=TOPSECRET";
    mockFetch(() => rpcOk(null));
    const pulse = await fetchProtocolPulse(secret);
    expect(pulse.rpcHost).toBe("https://devnet.helius-rpc.com");
    expect(pulse.rpcHost).not.toContain("TOPSECRET");
  });

  test("RPC failure degrades per-program (fail-closed), never fabricates a config", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const pulse = await fetchProtocolPulse("https://down.example");
    expect(pulse.scanner.executable).toBeNull();
    expect(pulse.scanner.config).toBeNull();
    expect(pulse.scanner.configError).toContain("rpc http 503");
    expect(pulse.vault.config).toBeNull();
  });

  test("a live config decodes through the same path (bytes → config)", async () => {
    // Build a minimal vault config payload via the decoder's expectations.
    const buf = new Uint8Array(210);
    buf.set(PROTOCOL_CONFIG_DISCRIMINATOR, 0);
    const dv = new DataView(buf.buffer);
    dv.setUint16(80, 4_000, true); // lp_holder
    dv.setUint16(82, 4_000, true); // salvor
    dv.setUint16(84, 2_000, true); // protocol
    dv.setBigUint64(86, 1_000_000_000n, true); // priority ceiling
    dv.setUint16(94, 300, true); // slippage
    dv.setBigUint64(96, 666_666n, true); // dust threshold
    dv.setBigUint64(104, 259_200n, true); // timelock
    buf[112] = 0; // not paused
    buf[113] = 255; // bump
    const b64 = Buffer.from(buf).toString("base64");
    mockFetch(() => rpcOk({ executable: true, owner: "program", data: [b64, "base64"] }));
    const pulse = await fetchProtocolPulse("https://api.devnet.solana.com");
    expect(pulse.vault.executable).toBe(true);
    expect(pulse.vault.config?.jupiterDustThresholdLamports).toBe("666666");
    // Decoder parity: the pulse path decodes to the same shape as the
    // direct decoder over the same bytes.
    expect(pulse.vault.config).toEqual(decodeVaultConfigLive(buf));
  });
});

describe("fetchEpochTelemetry — reads the configured endpoint (finding 5.4)", () => {
  test("custom endpoint is used and host reporting is redacted", async () => {
    const called = mockFetch((_e, body) => {
      expect((body as { method: string }).method).toBe("getEpochInfo");
      return rpcOk({ epoch: 810, slotIndex: 100_000, slotsInEpoch: 432_000, absoluteSlot: 1, blockHeight: 1 });
    });
    const tel = await fetchEpochTelemetry("https://private.example/rpc?key=x");
    expect(called[0]).toBe("https://private.example/rpc?key=x");
    expect(tel.rpcHost).toBe("https://private.example/rpc");
    expect(tel.epoch).toBe(810);
  });

  test("RPC failure throws — the caller renders unavailable, no fallback number", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchEpochTelemetry("https://down.example")).rejects.toThrow("rpc http 429");
  });
});

/* ── Finding 5.5: genesis-hash cluster verification ─────────────────── */

describe("classifyCluster — verified/unverified mapping (finding 5.5)", () => {
  test("matching hash → verified devnet", () => {
    const id = classifyCluster(DEVNET_GENESIS_HASH);
    expect(id).toEqual({ status: "verified", cluster: "devnet", genesisHash: DEVNET_GENESIS_HASH });
  });

  test("mismatching hash → explicit unverified with a reason (never verified)", () => {
    const id = classifyCluster("5eykt4UrF6xjLc5Ls66R26cUC2a6tyyVa67zbC7BGkgn"); // mainnet
    expect(id.status).toBe("unverified");
    if (id.status === "unverified") expect(id.reason).toContain("does not match");
    expect(id).not.toHaveProperty("cluster", "devnet");
  });

  test("missing / empty / non-string hashes are unverified", () => {
    for (const bad of [null, undefined, "", 42 as unknown as string]) {
      const id = classifyCluster(bad);
      expect(id.status).toBe("unverified");
      if (id.status === "unverified") expect(id.reason).toBe("genesis hash unavailable");
    }
  });
});

describe("fetchGenesisHash — fail-closed genesis read (finding 5.5)", () => {
  test("returns the hash on a well-formed answer", async () => {
    mockFetch((_e, body) => {
      expect((body as { method: string }).method).toBe("getGenesisHash");
      return rpcOk(DEVNET_GENESIS_HASH);
    });
    expect(await fetchGenesisHash("https://api.devnet.solana.com")).toBe(DEVNET_GENESIS_HASH);
  });

  test("unusable payloads throw — never a guess", async () => {
    for (const bad of [null, 123, "", "short", "a".repeat(500)]) {
      mockFetch(() => rpcOk(bad));
      await expect(fetchGenesisHash("https://x.example")).rejects.toThrow(/unusable/);
    }
  });

  test("RPC errors and HTTP failures throw (caller renders unverified)", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchGenesisHash("https://down.example")).rejects.toThrow("rpc http 500");
    mockFetch(() => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "limited" } }));
    await expect(fetchGenesisHash("https://limited.example")).rejects.toThrow("rpc returned an error");
  });

  test("end-to-end: a matching live hash classifies verified; a failure classifies unverified", async () => {
    mockFetch(() => rpcOk(DEVNET_GENESIS_HASH));
    expect(classifyCluster(await fetchGenesisHash("https://api.devnet.solana.com")).status).toBe("verified");
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    let unverified = false;
    await fetchGenesisHash("https://down.example").catch(() => {
      unverified = true;
    });
    expect(unverified).toBe(true);
  });
});
