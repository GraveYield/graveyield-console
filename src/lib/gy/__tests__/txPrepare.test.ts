// P4.5 — prepare battery: serialization of the canonical-SDK claim
// instruction, blockhash freshness (fail-closed), transaction assembly, and
// the simulation wrapper's two-sided fail-closed rule (a tx error is a
// failure WITH logs; an RPC error is a failure WITHOUT pretending the
// simulation ran).

import { describe, expect, test } from "bun:test";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

import type { PreparedClaimInstruction } from "../claimsContract";
import {
  blockhashExpired,
  buildClaimTransaction,
  deserializeClaimInstruction,
  fetchFreshBlockhash,
  GyTxPrepareError,
  simulateClaimTransaction,
  type SimulatableConnection,
} from "../tx/prepare";

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Deterministic valid public keys — no base58 validity gambles. */
function keyOf(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) % 256));
}

const HOLDER = keyOf(1);
const PDA = keyOf(2);
const FEE_PAYER = keyOf(3);
const VAULT_PROGRAM = keyOf(4);

function makePreparedValid(): {
  prepared: PreparedClaimInstruction;
  data: Uint8Array;
  programId: PublicKey;
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
} {
  const programId = VAULT_PROGRAM;
  // Anchor discriminator shape (8 bytes) + args — bytes are arbitrary but
  // the transport shape is exactly what /api/gy/claims serves.
  const data = Uint8Array.from([0x5c, 0x1c, 0x42, 0x6d, 0x3c, 0x9a, 0x5c, 0x53, 0x2a, 0x01, 0x00, 0x00]);
  const keys = [
    { pubkey: HOLDER, isSigner: true, isWritable: true },
    { pubkey: PDA, isSigner: false, isWritable: true },
  ];
  const prepared: PreparedClaimInstruction = {
    programId: programId.toBase58(),
    keys: keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: base64Of(data),
  };
  return { prepared, data, programId, keys };
}

describe("deserializeClaimInstruction — the exact bytes survive the trip", () => {
  test("round-trips programId, account metas and wire data", () => {
    const { prepared, data, programId, keys } = makePreparedValid();
    const ix = deserializeClaimInstruction(prepared);
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.data.length).toBe(data.length);
    expect(Buffer.from(ix.data).equals(Buffer.from(data))).toBe(true);
    expect(ix.keys.length).toBe(keys.length);
    for (let i = 0; i < keys.length; i++) {
      expect(ix.keys[i].pubkey.equals(keys[i].pubkey)).toBe(true);
      expect(ix.keys[i].isSigner).toBe(keys[i].isSigner);
      expect(ix.keys[i].isWritable).toBe(keys[i].isWritable);
    }
  });

  test("rejects malformed payloads before anything reaches a wallet", () => {
    const good = makePreparedValid().prepared;
    const cases: Array<{ name: string; prepared: PreparedClaimInstruction; message: string }> = [
      { name: "empty data", prepared: { ...good, data: "" }, message: "data is empty" },
      { name: "bad base64", prepared: { ...good, data: "!!!not-base64!!!" }, message: "base64" },
      { name: "bad programId", prepared: { ...good, programId: "not!!a!!base58" }, message: "programId" },
      { name: "no keys", prepared: { ...good, keys: [] }, message: "no account keys" },
      { name: "bad key", prepared: { ...good, keys: [{ pubkey: "!!!", isSigner: false, isWritable: false }] }, message: "key[0]" },
      { name: "no signer", prepared: { ...good, keys: [{ pubkey: good.keys[0].pubkey, isSigner: false, isWritable: true }] }, message: "no signer" },
    ];
    for (const c of cases) {
      try {
        deserializeClaimInstruction(c.prepared);
        expect.unreachable(`${c.name} should have thrown`);
      } catch (err) {
        expect(err).toBeInstanceOf(GyTxPrepareError);
        expect((err as Error).message).toContain(c.message);
      }
    }
  });
});

describe("fetchFreshBlockhash — fail-closed on any unusable answer", () => {
  test("returns a fresh blockhash with its expiry height", async () => {
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: "BLOCKHASHx".repeat(4), lastValidBlockHeight: 12345 }),
    } as never;
    const bh = await fetchFreshBlockhash(connection);
    expect(bh.blockhash).toBe("BLOCKHASHx".repeat(4));
    expect(bh.lastValidBlockHeight).toBe(12345);
    expect(bh.fetchedAtUnixMs).toBeGreaterThan(0);
  });

  test("an unusable blockhash throws — the caller stays unprepared", async () => {
    const empty = { getLatestBlockhash: async () => ({ blockhash: "", lastValidBlockHeight: 100 }) } as never;
    expect(await fetchFreshBlockhash(empty).catch((e: Error) => e)).toBeInstanceOf(GyTxPrepareError);
    const zero = { getLatestBlockhash: async () => ({ blockhash: "BH", lastValidBlockHeight: 0 }) } as never;
    expect(await fetchFreshBlockhash(zero).catch((e: Error) => e)).toBeInstanceOf(GyTxPrepareError);
  });

  test("an RPC failure throws — never a stale-blockhash hope", async () => {
    const connection = { getLatestBlockhash: async () => { throw new Error("rpc http 503"); } } as never;
    try {
      await fetchFreshBlockhash(connection);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("503");
    }
  });
});

describe("blockhashExpired — the re-preparation boundary", () => {
  test("valid strictly before the expiry height; expired at and after it", () => {
    expect(blockhashExpired(100, 99)).toBe(false);
    expect(blockhashExpired(100, 100)).toBe(true);
    expect(blockhashExpired(100, 101)).toBe(true);
  });
});

describe("buildClaimTransaction — unsigned, exactly one instruction", () => {
  test("carries fee payer, blockhash, expiry height and the single claim ix", () => {
    const { prepared, data } = makePreparedValid();
    const ix = deserializeClaimInstruction(prepared);
    const tx = buildClaimTransaction({
      instruction: ix,
      feePayer: FEE_PAYER,
      blockhash: "BLOCKHASHx".repeat(4),
      lastValidBlockHeight: 424242,
    });
    expect(tx.feePayer?.equals(FEE_PAYER)).toBe(true);
    expect(tx.recentBlockhash).toBe("BLOCKHASHx".repeat(4));
    expect(tx.lastValidBlockHeight).toBe(424242);
    expect(tx.signatures.length).toBe(0); // unsigned — the wallet signs
    expect(tx.instructions.length).toBe(1);
    expect(Buffer.from(tx.instructions[0].data).equals(Buffer.from(data))).toBe(true);
  });
});

describe("simulateClaimTransaction — fail-closed in both directions", () => {
  const makeTx = () => {
    const { prepared } = makePreparedValid();
    return buildClaimTransaction({
      instruction: deserializeClaimInstruction(prepared),
      feePayer: FEE_PAYER,
      blockhash: "BLOCKHASHx".repeat(4),
      lastValidBlockHeight: 1,
    });
  };

  test("a clean RPC answer is the ONLY path to ok:true", async () => {
    const conn: SimulatableConnection = {
      simulateTransaction: async () => ({ value: { err: null, logs: ["Program log: ok"] } }),
    };
    const out = await simulateClaimTransaction(conn, makeTx());
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
  });

  test("a program error is ok:false with the logs preserved", async () => {
    const conn: SimulatableConnection = {
      simulateTransaction: async () => ({
        value: { err: "0x1b6d", logs: ["Program log: InvalidClaimProof"] },
      }),
    };
    const out = await simulateClaimTransaction(conn, makeTx());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("0x1b6d");
    expect(out.logs).toEqual(["Program log: InvalidClaimProof"]);
  });

  test("an object error is stringified, never swallowed", async () => {
    const conn: SimulatableConnection = {
      simulateTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 7010 }] }, logs: null } }),
    };
    const out = await simulateClaimTransaction(conn, makeTx());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("7010");
  });

  test("a null simulation value is a failure, not a pass", async () => {
    const conn: SimulatableConnection = { simulateTransaction: async () => ({ value: null }) };
    const out = await simulateClaimTransaction(conn, makeTx());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no value");
  });

  test("an RPC failure is ok:false — an unreachable RPC never reads as simulated", async () => {
    const conn: SimulatableConnection = {
      simulateTransaction: async () => {
        throw new Error("socket hang up");
      },
    };
    const out = await simulateClaimTransaction(conn, makeTx());
    expect(out.ok).toBe(false);
    expect(out.error).toContain("could not run");
    expect(out.error).toContain("socket hang up");
  });
});
