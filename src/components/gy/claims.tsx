"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { type Transaction } from "@solana/web3.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileSearch,
  HandCoins,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
  XCircle,
} from "lucide-react";
import { CopyChip, KpiCard, MiniStat, SectionHead, ToneBadge } from "./widgets";
import type { ClaimsOnchain, ClaimsTransportPayload, WalletClaimViewPayload } from "@/lib/gy/claimsTransport";
import { PROGRAM_IDS } from "@/lib/gy/data";
import { fmtSol, fmtUtcClock, shortAddr } from "@/lib/gy/format";
import { cn } from "@/lib/utils";
import {
  TX_STATE_META,
  initialTxState,
  isTerminalTxState,
  reduceTx,
  type TxMachineState,
} from "@/lib/gy/tx/machine";
import {
  blockhashExpired,
  buildClaimTransaction,
  deserializeClaimInstruction,
  fetchFreshBlockhash,
  simulateClaimTransaction,
} from "@/lib/gy/tx/prepare";
import {
  awaitSignatureConfirmation,
  reconcileClaimRecord,
  type StatusConnection,
} from "@/lib/gy/tx/reconcile";

/* ── Transaction lifecycle (P4.5) — the shared state machine ────────
 *
 * The claim card no longer carries its own vocabulary: it drives the one
 * console machine in src/lib/gy/tx/machine.ts —
 *
 *   not-prepared → prepared → simulated → awaiting-wallet-approval →
 *   submitted → reconciling → confirmed | failed | confirmation-unknown
 *
 * The P4.4 honesty rules are unchanged and are now structural (machine
 * transitions, test-pinned): prepared is unsigned, submitted is not paid,
 * and "confirmed" is reachable ONLY through the reconciliation step — the
 * console re-reading the ClaimRecord PDA from devnet. P4.5 adds the two
 * stages the audit required: a real simulation of the exact transaction
 * before approval, and "confirmation-unknown" as a first-class outcome that
 * never masquerades as "failed" (a broadcast transaction may still settle). */

const STATE_META: Record<WalletClaimViewPayload["state"], { label: string; tone: "ok" | "info" | "warn" | "bad" | "muted" | "brand" }> = {
  claimable: { label: "claimable", tone: "ok" },
  claimed: { label: "claimed — on-chain record", tone: "brand" },
  "wallet-not-eligible": { label: "wallet not eligible", tone: "muted" },
  "proof-unavailable": { label: "proof unavailable", tone: "warn" },
  "snapshot-unavailable": { label: "snapshot unavailable", tone: "warn" },
  "no-claim-record": { label: "no claim record found", tone: "muted" },
};

/** Root cross-check between artifact and registry — the UI states agreement,
 * the server state machine already refuses unbound proofs. */
function rootsMatch(p: ClaimsTransportPayload): boolean | null {
  if (p.distribution === null || p.onchain === null) return null;
  if (!p.onchain.poolRegistry.found || p.onchain.poolRegistry.merkleRoot === null) return null;
  return p.onchain.poolRegistry.merkleRoot === p.distribution.merkleRoot;
}

export function Claims({
  transport,
  latestTransport,
  cachedAtUnixMs,
  latestFailure,
  loading,
  error,
  refreshing,
  onRefresh,
  walletQuery,
  onWalletQueryChange,
}: {
  /** Effective display payload — freshness re-evaluated against the wall clock. */
  transport: ClaimsTransportPayload | null;
  latestTransport: ClaimsTransportPayload | null;
  cachedAtUnixMs: number | null;
  latestFailure: string | null;
  loading: boolean;
  error: "unreachable" | "malformed" | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** The wallet address the lookup runs against (connected wallet or pasted). */
  walletQuery: string | null;
  onWalletQueryChange: (w: string | null) => void;
}) {
  const { publicKey } = useWallet();
  const address = publicKey?.toBase58() ?? null;
  const [pasted, setPasted] = useState("");

  const dist = transport?.distribution ?? null;
  const onchain: ClaimsOnchain | null = transport?.onchain ?? null;
  const walletView: WalletClaimViewPayload | null = transport?.wallet ?? null;
  const match = transport ? rootsMatch(transport) : null;

  const lookupWallet = walletQuery?.trim() ? walletQuery.trim() : null;
  const lookupIsConnected = lookupWallet !== null && lookupWallet === address;

  return (
    <div className="animate-fade-up space-y-5">
      <SectionHead
        title="LP Claims"
        right={
          <div className="flex items-center gap-2">
            <ToneBadge tone="brand" dot>
              sealed distribution · devnet
            </ToneBadge>
            <Button
              variant="outline"
              size="sm"
              className="border-white/10 bg-white/5 hover:bg-white/10"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        }
      />

      {/* Data provenance banner — same four-state discipline as the Graveyard
          and the Fleet: fresh / stale / cached / unavailable, never disguised. */}
      <ClaimsBanner
        transport={transport}
        latestTransport={latestTransport}
        cachedAtUnixMs={cachedAtUnixMs}
        latestFailure={latestFailure}
        loading={loading}
        error={error}
        refreshing={refreshing}
      />

      {/* ── Distribution facts (only where the underlying data exists) ── */}
      {dist !== null ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <KpiCard
            label="Merkle root"
            value={<span className="font-mono text-base">{`${dist.merkleRoot.slice(0, 8)}…${dist.merkleRoot.slice(-6)}`}</span>}
            sub={
              <span className="flex items-center gap-1">
                <ShieldCheck className="mr-1 h-3 w-3 text-emerald-400" />
                integrity verified · canonical SDK
              </span>
            }
            accent="emerald"
          />
          <KpiCard
            label="Distribution"
            value={epochLabel(transport)}
            sub={`snapshot slot ${dist.snapshotSlot.toLocaleString()}`}
            accent="cyan"
          />
          <KpiCard
            label="Claimants"
            value={dist.leafCount.toLocaleString()}
            sub={`tree depth ${dist.treeDepth} · SHA-256 sorted-pair`}
            accent="violet"
          />
          <KpiCard
            label="Expiry"
            value="never"
            sub="non-expiring claim — live even under pause"
            accent="amber"
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <KpiCard label="Merkle root" value="—" sub="snapshot unavailable" accent="emerald" />
          <KpiCard label="Distribution" value="—" sub="snapshot unavailable" accent="cyan" />
          <KpiCard label="Claimants" value="—" sub="snapshot unavailable" accent="violet" />
          <KpiCard label="Expiry" value="never" sub="non-expiring claim model" accent="amber" />
        </div>
      )}

      {/* ── Sealed distribution + on-chain settlement detail ──────────── */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="glass-panel border-white/8">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-emerald-400" />
              Sealed distribution
              <ToneBadge tone={transport?.artifactState === "valid" ? "ok" : transport?.artifactState === "stale" ? "warn" : "muted"}>
                {transport?.artifactState ?? "unavailable"}
              </ToneBadge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {dist !== null ? (
              <>
                <FactRow label="Pool" value={<span className="font-mono">{shortAddr(dist.poolAddress, 8, 8)}</span>} />
                <FactRow label="AMM program" value={<span className="font-mono">{shortAddr(dist.ammProgramId, 6, 6)}</span>} />
                <FactRow label="LP mint" value={<span className="font-mono">{shortAddr(dist.lpMint, 6, 6)}</span>} />
                <FactRow label="LP supply at snapshot" value={<span className="font-mono">{dist.lpTotalSupplyAtSnapshot}</span>} />
                <FactRow
                  label="Reconciliation"
                  value={<span className="font-mono text-[11px]">Σ {dist.reconciliation.entriesTotal} + sinks {dist.reconciliation.sinkExclusionsTotal} = {dist.reconciliation.enumeratedTotal}</span>}
                />
                <p className="pt-1 text-[11px] leading-relaxed text-slate-500">
                  Sealed by grave-snapshotter, integrity re-derived through the canonical SDK Merkle tree before display.
                  Per-holder rows are not served — only the queried wallet&apos;s own row ever leaves the server.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No verified distribution artifact is being served — the sealed snapshot facts are withheld (fail-closed).
                Configure GY_CLAIMS_URL or GY_CLAIMS_PATH, then Refresh.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/8">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-cyan-400" />
              On-chain settlement
              <ToneBadge tone={onchain?.poolRegistry.found ? "ok" : "muted"}>
                {onchain === null ? "unavailable" : onchain.poolRegistry.found ? "PoolRegistry" : "no registry"}
              </ToneBadge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {onchain !== null ? (
              <>
                {onchain.poolRegistry.found ? (
                  <>
                    <FactRow label="Registry PDA" value={<span className="font-mono">{shortAddr(onchain.poolRegistry.pda, 6, 6)}</span>} />
                    <FactRow label="Salvage reference" value={<span className="font-mono">{shortAddr(PROGRAM_IDS.graveVault, 6, 6)} · salvor {shortAddr(onchain.poolRegistry.salvor ?? "—", 4, 4)}</span>} />
                    <FactRow
                      label="On-chain root"
                      value={
                        <span className="flex items-center gap-1.5 font-mono">
                          {`${(onchain.poolRegistry.merkleRoot ?? "").slice(0, 8)}…`}
                          {match === true && <ToneBadge tone="ok">matches artifact</ToneBadge>}
                          {match === false && <ToneBadge tone="bad">root mismatch</ToneBadge>}
                        </span>
                      }
                    />
                    <FactRow label="LP-holder bucket" value={<span className="font-mono">{fmtSol(BigInt(onchain.poolRegistry.lpHolderPoolTotalLamports ?? "0"))} SOL</span>} />
                    <FactRow label="Claimed so far" value={<span className="font-mono">{fmtSol(BigInt(onchain.poolRegistry.lpHolderPoolClaimedLamports ?? "0"))} SOL</span>} />
                    <FactRow
                      label="Salvaged at"
                      value={<span className="font-mono">{onchain.poolRegistry.salvagedAtTs !== null ? fmtUtcClock(new Date(onchain.poolRegistry.salvagedAtTs)) : `slot ${onchain.poolRegistry.salvagedAtSlot}`}</span>}
                    />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No PoolRegistry exists on devnet for the artifact&apos;s pool — no salvage has settled on-chain yet.
                    {onchain.poolRegistry.error ? ` (${onchain.poolRegistry.error})` : ""}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <MiniStat
                    label="lp_holder_pool_vault"
                    value={onchain.vaultLamports !== null ? `${fmtSol(BigInt(onchain.vaultLamports))} SOL` : "unavailable"}
                  />
                  <MiniStat
                    label="Salvage receipt"
                    value={onchain.salvageReceipt.found ? fmtSol(BigInt(onchain.salvageReceipt.lpHolderAmountLamports ?? "0")) + " SOL" : onchain.salvageReceipt.error ? "error" : "absent"}
                  />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                On-chain settlement facts ride only with a usable distribution artifact — without it the console does not
                know which settlement to read.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Wallet lookup ─────────────────────────────────────────────── */}
      <Card className="glass-panel border-white/8">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4 text-emerald-400" />
            Check claim eligibility
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <FileSearch className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="Paste an LP-holder wallet address"
                className="border-white/10 bg-white/5 pl-8 font-mono text-xs placeholder:text-slate-600"
                aria-label="Wallet address"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pasted.trim()) onWalletQueryChange(pasted.trim());
                }}
              />
            </div>
            {address !== null && (
              <Button
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 font-semibold text-emerald-200 hover:bg-emerald-500/20"
                onClick={() => onWalletQueryChange(address)}
              >
                <Wallet className="mr-2 h-4 w-4" />
                Use connected wallet
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
            <Info className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <p className="text-[11.5px] text-slate-400">
              Lookup shows only the queried wallet&apos;s own row — the distribution&apos;s other holders never leave the server.
              {lookupWallet !== null && (
                <>
                  {" "}Querying <span className="font-mono text-slate-300">{shortAddr(lookupWallet, 6, 6)}</span>
                  {lookupIsConnected ? " (connected wallet)" : ""}
                </>
              )}
            </p>
          </div>

          {walletView !== null && <WalletClaimCard view={walletView} onRefresh={onRefresh} />}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Distribution epoch label — live epoch-of-slot, honest about gaps ── */
function epochLabel(transport: ClaimsTransportPayload | null): string {
  const dist = transport?.distribution ?? null;
  const epoch = transport?.onchain?.epoch ?? null;
  const registrySlot = transport?.onchain?.poolRegistry.salvagedAtSlot ?? null;
  if (dist === null) return "—";
  if (epoch !== null && registrySlot !== null) {
    const e = Math.floor(Number(registrySlot) / epoch.slotsInEpoch);
    return `epoch ${e}`;
  }
  return "epoch —";
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/5 pb-1.5 last:border-0 last:pb-0">
      <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="text-right text-[12.5px] text-slate-200">{value}</span>
    </div>
  );
}

/* ── Wallet claim card — the P4.5 machine, rendered honestly ──────────
 * One operator action per stage: prepare+simulate → review → approve in
 * wallet → the machine handles confirmation and reconciliation. */
function WalletClaimCard({ view, onRefresh }: { view: WalletClaimViewPayload; onRefresh: () => void }) {
  const { publicKey, wallet } = useWallet();
  const { connection } = useConnection();
  const meta = STATE_META[view.state];
  const [tx, setTx] = useState<TxMachineState>(() => initialTxState(Date.now()));
  /** Retryable preparation hiccup (RPC unreachable, malformed payload) — the
   * machine has no transition for it because NOTHING was wrong with the
   * claim itself; the operator retries with no false "failed" claim. */
  const [prepError, setPrepError] = useState<string | null>(null);
  /** The exact unsigned transaction the RPC simulated — what the wallet will
   * be asked to sign is byte-for-byte what was shown. */
  const [staged, setStaged] = useState<{ tx: Transaction; blockhash: string; lastValidBlockHeight: number } | null>(null);
  const [simulation, setSimulation] = useState<{ ok: boolean; error: string | null; logs: string[] | null } | null>(null);
  /** A fresh machine run on explicit operator request after a terminal state. */
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dispatch = useCallback((event: Parameters<typeof reduceTx>[1]) => {
    setTx((prev) => reduceTx(prev, event, Date.now()));
  }, []);

  // The lifecycle resets per wallet+state payload and per explicit new run:
  // a fresh server view is the resting truth; the client overlay only rides
  // on top of `claimable`.
  useEffect(() => {
    setTx(initialTxState(Date.now()));
    setPrepError(null);
    setStaged(null);
    setSimulation(null);
    setRunning(false);
  }, [view.wallet, view.state, view.claimableLamports, runId]);

  const prepared = view.preparedClaim;
  const canOperate =
    view.state === "claimable" &&
    prepared !== null &&
    publicKey !== null &&
    publicKey.toBase58() === view.wallet &&
    !isTerminalTxState(tx.state) &&
    !running;
  /* The primary button advances the machine one stage at a time; it is only
   * clickable in the three operator-decision states. */
  const primaryEnabled =
    canOperate &&
    !running &&
    (tx.state === "not-prepared" || tx.state === "prepared" || tx.state === "simulated");

  /* Stage the exact unsigned transaction: canonical-SDK instruction →
   * fresh blockhash → transaction. Throws on malformed payload or RPC
   * failure (fail-closed — nothing reaches the wallet unshown). */
  const stage = useCallback(async () => {
    if (!prepared || !connection || !publicKey) throw new Error("claim is not operable");
    const ix = deserializeClaimInstruction(prepared);
    const bh = await fetchFreshBlockhash(connection, "confirmed");
    const stagedTx = buildClaimTransaction({
      instruction: ix,
      feePayer: publicKey,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    });
    setStaged({ tx: stagedTx, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
    return stagedTx;
  }, [prepared, connection, publicKey]);

  const runSimulation = useCallback(
    async (stagedTx: Transaction) => {
      if (!connection) return;
      const sim = await simulateClaimTransaction(connection, stagedTx);
      setSimulation(sim);
      if (sim.ok) {
        dispatch({ type: "simulate-ok" });
      } else {
        dispatch({ type: "simulate-failed", reason: sim.error ?? "simulation failed" });
      }
    },
    [connection, dispatch],
  );

  /* Stage 1 — not-prepared → prepared → simulated. */
  const onPrepareAndSimulate = useCallback(async () => {
    setPrepError(null);
    if (!view.claimRecordPda) {
      setPrepError("The payload carries no ClaimRecord PDA — the console will not build a claim it could not reconcile on-chain.");
      return;
    }
    setRunning(true);
    try {
      dispatch({ type: "prepare" });
      const stagedTx = await stage();
      await runSimulation(stagedTx);
    } catch (e) {
      setPrepError(String((e as Error).message ?? e));
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [dispatch, stage, runSimulation, view.claimRecordPda]);

  /* Stage 1b — prepared → simulated (after a prep hiccup or a re-prepare). */
  const onRetrySimulation = useCallback(async () => {
    setPrepError(null);
    setRunning(true);
    try {
      const stagedTx = await stage();
      await runSimulation(stagedTx);
    } catch (e) {
      setPrepError(String((e as Error).message ?? e));
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [stage, runSimulation]);

  /* Stage 2 — simulated → awaiting-wallet-approval → submitted. The blockhash
   * is re-checked at approval time: one that expired before the wallet was
   * asked is re-prepared, never submitted hoping it still lands. */
  const onApproveAndSubmit = useCallback(async () => {
    const adapter = wallet?.adapter;
    if (!adapter || !staged || !connection) return;
    if (tx.state !== "simulated") return; // one stage per click — never a hidden re-submit
    setPrepError(null);
    setRunning(true);
    try {
      let height: number | null = null;
      try {
        height = await connection.getBlockHeight("confirmed");
      } catch {
        height = null; // unreadable — the send path reports any real failure
      }
      if (height !== null && blockhashExpired(staged.lastValidBlockHeight, height)) {
        dispatch({ type: "re-prepare", reason: "blockhash expired before approval" });
        setStaged(null);
        setSimulation(null);
        setPrepError("The prepared blockhash expired before approval — the claim was re-prepared with a fresh one. Review and approve again.");
        return;
      }
      dispatch({ type: "request-approval" });
      try {
        const sig = await adapter.sendTransaction(staged.tx, connection);
        if (!mountedRef.current) return;
        dispatch({ type: "submit-ok", signature: sig });
      } catch (e) {
        if (!mountedRef.current) return;
        const msg = String((e as Error).message ?? e);
        const rejected = /reject|denied|cancel|dismiss/i.test(msg);
        dispatch(rejected ? { type: "wallet-rejected", reason: msg } : { type: "submit-failed", reason: msg });
      }
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [wallet?.adapter, staged, connection, tx.signature, dispatch]);

  /* Stage 3 — submitted → reconciling | failed | confirmation-unknown. */
  useEffect(() => {
    if (tx.state !== "submitted" || tx.signature === null || !connection) return;
    let cancelled = false;
    void (async () => {
      const outcome = await awaitSignatureConfirmation(connection as unknown as StatusConnection, tx.signature as string, {
        timeoutMs: 60_000,
        pollMs: 2_000,
        isAborted: () => cancelled,
      });
      if (cancelled) return;
      if (outcome.kind === "seen") {
        dispatch({ type: "confirm-seen", commitment: outcome.commitment });
      } else if (outcome.kind === "on-chain-failed") {
        dispatch({ type: "on-chain-failed", reason: `Devnet rejected the claim: ${outcome.err}` });
      } else {
        dispatch({ type: "confirm-timeout" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tx.state, tx.signature, connection, dispatch]);

  /* Stage 4 — the honesty gate: reconciling → confirmed | failed | unknown. */
  useEffect(() => {
    if (tx.state !== "reconciling" || !connection) return;
    let cancelled = false;
    void (async () => {
      if (!view.claimRecordPda) {
        dispatch({
          type: "reconcile-absent",
          reason: "The payload carries no ClaimRecord PDA — the console will not display a paid claim it cannot verify on-chain.",
        });
        return;
      }
      const rec = await reconcileClaimRecord(connection as unknown as StatusConnection, view.claimRecordPda);
      if (cancelled) return;
      if (rec.kind === "found") {
        dispatch({ type: "reconcile-found", atUnixMs: rec.atUnixMs });
        onRefresh();
      } else if (rec.kind === "absent") {
        dispatch({
          type: "reconcile-absent",
          reason: "Transaction confirmed but the ClaimRecord PDA is absent — the console will not display a paid claim without the on-chain record.",
        });
      } else {
        dispatch({
          type: "reconcile-inconclusive",
          reason: `The ClaimRecord read failed (${rec.error}) — that is unknown, not failed; re-check to retry the reconciliation.`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tx.state, connection, view.claimRecordPda, dispatch, onRefresh]);

  /* Recovery — confirmation-unknown → (re-check) reconciling. */
  const onRecheck = useCallback(async () => {
    if (tx.signature === null || !connection) return;
    setRunning(true);
    try {
      const outcome = await awaitSignatureConfirmation(connection as unknown as StatusConnection, tx.signature, {
        timeoutMs: 30_000,
        pollMs: 2_000,
      });
      if (!mountedRef.current) return;
      if (outcome.kind === "seen") {
        dispatch({ type: "confirm-seen", commitment: outcome.commitment });
      } else if (outcome.kind === "on-chain-failed") {
        dispatch({ type: "on-chain-failed", reason: `Devnet rejected the claim: ${outcome.err}` });
      } else {
        setPrepError("Still unseen — the transaction may settle later. Check Explorer; the console keeps displaying unknown.");
      }
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [tx.signature, connection, dispatch]);

  const onReprepare = useCallback(() => {
    setPrepError(null);
    setStaged(null);
    setSimulation(null);
    dispatch({ type: "re-prepare", reason: "operator: fresh blockhash after an unknown confirmation" });
  }, [dispatch]);

  const actionLabel =
    tx.state === "not-prepared"
      ? "Claim proceeds (devnet)"
      : tx.state === "prepared"
        ? "Simulate on devnet"
        : tx.state === "simulated"
          ? "Approve in wallet & submit"
          : tx.state === "awaiting-wallet-approval"
            ? "Awaiting signature…"
            : tx.state === "submitted"
              ? "Submitted…"
              : tx.state === "reconciling"
                ? "Reconciling…"
                : "Claim proceeds";

  const onPrimary = useCallback(() => {
    if (tx.state === "not-prepared" || tx.state === "prepared") {
      void (tx.state === "not-prepared" ? onPrepareAndSimulate() : onRetrySimulation());
      return;
    }
    if (tx.state === "simulated") {
      void onApproveAndSubmit();
      return;
    }
    if (tx.state === "submitted" || tx.state === "awaiting-wallet-approval") {
      if (tx.signature !== null) dispatch({ type: "duplicate-submit-refused" });
      return;
    }
  }, [tx.state, tx.signature, onPrepareAndSimulate, onRetrySimulation, onApproveAndSubmit, dispatch]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/10 bg-[#1E1E1E] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-mono text-sm font-semibold text-foreground">{view.wallet}</p>
            <p className="font-mono text-[10.5px] text-slate-500">
              {view.entry !== null
                ? `leaf ${view.entry.leaf.slice(0, 8)}… · proof ${view.entry.proof.length} element${view.entry.proof.length === 1 ? "" : "s"}`
                : "no wallet row is served in this state (eligibility not established)"}
            </p>
          </div>
          <ToneBadge tone={meta.tone} dot={view.state === "claimable"}>
            {meta.label}
          </ToneBadge>
        </div>

        {view.reason !== null && (
          <p className="mt-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-300">
            {view.reason}
          </p>
        )}

        {view.state === "claimable" && view.claimableLamports !== null && (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-500">Expected claimable</p>
                <p className="font-mono text-xl font-bold tabular-nums text-emerald-300">
                  {fmtSol(BigInt(view.claimableLamports))} SOL
                </p>
                <p className="mt-1 max-w-md text-[11px] leading-relaxed text-slate-500">{view.amountNote}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Button
                  className="min-h-11 bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                  disabled={!primaryEnabled}
                  onClick={onPrimary}
                >
                  <HandCoins className="mr-2 h-4 w-4" />
                  {running && (tx.state === "not-prepared" || tx.state === "prepared") ? "Preparing…" : actionLabel}
                </Button>
                {publicKey?.toBase58() !== view.wallet && (
                  <p className="text-[10.5px] text-amber-300/80">Connect as {shortAddr(view.wallet, 4, 4)} to sign this claim.</p>
                )}
              </div>
            </div>

            {/* The exact unsigned transaction the wallet will see — shown
                before approval, never after the fact. */}
            {staged !== null && (
              <div className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5 font-mono text-[10.5px] text-slate-400">
                staged · program {shortAddr(prepared?.programId ?? "", 6, 6)} · blockhash {shortAddr(staged.blockhash, 6, 6)} · valid until slot{" "}
                {staged.lastValidBlockHeight.toLocaleString()} · unsigned
              </div>
            )}

            <TxStatusRow tx={tx} simulation={simulation} />

            {tx.state === "confirmation-unknown" && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                  disabled={running}
                  onClick={() => void onRecheck()}
                >
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Re-check confirmation
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                  disabled={running}
                  onClick={onReprepare}
                >
                  Re-prepare with fresh blockhash
                </Button>
              </div>
            )}

            {tx.state === "failed" && (
              <Button
                variant="outline"
                size="sm"
                className="border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                onClick={() => setRunId((r) => r + 1)}
              >
                Start a new claim run
              </Button>
            )}

            {prepError !== null && (
              <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-200">
                {prepError}
              </p>
            )}
          </div>
        )}

        {view.state === "claimed" && (
          <div className="mt-3 space-y-2.5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniStat label="Claimed" value={view.claimedLamports !== null ? `${fmtSol(BigInt(view.claimedLamports))} SOL` : "—"} />
              <MiniStat label="Remaining claimable" value={view.remainingLamports !== null ? `${fmtSol(BigInt(view.remainingLamports))} SOL` : "—"} />
              <MiniStat label="Record slot" value={view.claimRecord?.claimedAtSlot ?? "—"} />
              <MiniStat
                label="Claimed at"
                value={view.claimRecord?.claimedAtTs !== null && view.claimRecord?.claimedAtTs !== undefined ? fmtUtcClock(new Date(view.claimRecord.claimedAtTs)) : "—"}
              />
            </div>
            <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              The ClaimRecord PDA on devnet ({shortAddr(view.claimRecord?.pda ?? "", 6, 6)}) is the canonical paid evidence —
              the console shows &ldquo;claimed&rdquo; only from that record, never from a proof or a prepared transaction.
            </p>
          </div>
        )}

        {view.state !== "claimable" && view.state !== "claimed" && (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
            <CircleDashed className="h-3.5 w-3.5" />
            No claim transaction is prepared in this state — the console never builds a claim from an unverified premise.
          </p>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Non-expiring: this distribution stays claimable indefinitely — claim_lp_proceeds is live even while the vault is
        under emergency pause. Claims are irreversible on-chain; the console submits to devnet only after an explicit
        wallet signature.
      </p>
    </div>
  );
}

/* ── Tx status row — the shared machine's vocabulary ──────────────────
 * Every state renders its honest standing note; failures render their
 * reason; the tracked signature links to Explorer. Simulation logs are
 * shown verbatim when devnet reported any. */
function TxStatusRow({
  tx,
  simulation,
}: {
  tx: TxMachineState;
  simulation: { ok: boolean; error: string | null; logs: string[] | null } | null;
}) {
  const meta = TX_STATE_META[tx.state];
  const signature = tx.signature;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
        {tx.state === "confirmed" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
        {tx.state === "failed" && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
        {(tx.state === "submitted" || tx.state === "reconciling" || tx.state === "awaiting-wallet-approval") && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />
        )}
        {(tx.state === "prepared" || tx.state === "simulated") && <Info className="h-3.5 w-3.5 shrink-0 text-cyan-400" />}
        {tx.state === "not-prepared" && <CircleDashed className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
        {tx.state === "confirmation-unknown" && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
        <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>
        <p className="text-[11px] leading-relaxed text-slate-400">{tx.reason ?? meta.note}</p>
        {signature !== null && (
          <a
            className="ml-auto font-mono text-[10.5px] text-cyan-300 underline-offset-2 hover:underline"
            href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            tx {shortAddr(signature, 6, 6)} ↗
          </a>
        )}
      </div>
      {simulation !== null && (simulation.ok || simulation.error !== null) && (
        <div className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-slate-400">
          simulation {simulation.ok ? "passed — devnet dry-ran the exact unsigned transaction with no error" : `failed — ${simulation.error ?? "unknown error"}`}
          {simulation.logs !== null && simulation.logs.length > 0 && (
            <span className="mt-1 block whitespace-pre-wrap text-slate-500">{simulation.logs.slice(-6).join("\n")}</span>
          )}
        </div>
      )}
      {(tx.reprepareCount > 0 || tx.duplicateSuppressedCount > 0 || tx.signatureHistory.length > 1) && (
        <p className="font-mono text-[10px] text-slate-500">
          {tx.signatureHistory.length > 1 ? `signature attempts ${tx.signatureHistory.length}` : null}
          {tx.reprepareCount > 0 ? `${tx.signatureHistory.length > 1 ? " · " : ""}re-prepared ×${tx.reprepareCount}` : null}
          {tx.duplicateSuppressedCount > 0 ? `${tx.reprepareCount > 0 || tx.signatureHistory.length > 1 ? " · " : ""}duplicate submits suppressed ×${tx.duplicateSuppressedCount}` : null}
        </p>
      )}
    </div>
  );
}

/* ── Provenance banner ─────────────────────────────────────────────── */
function ClaimsBanner({
  transport,
  latestTransport,
  cachedAtUnixMs,
  latestFailure,
  loading,
  error,
  refreshing,
}: {
  transport: ClaimsTransportPayload | null;
  latestTransport: ClaimsTransportPayload | null;
  cachedAtUnixMs: number | null;
  latestFailure: string | null;
  loading: boolean;
  error: "unreachable" | "malformed" | null;
  refreshing: boolean;
}) {
  void refreshing;
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
        <p className="text-[12px] text-slate-400">Checking the distribution source and devnet settlement…</p>
      </div>
    );
  }
  if (error === "unreachable" || error === "malformed") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <p className="text-[12px] leading-relaxed text-amber-200">
          {error === "unreachable"
            ? "The claims transport could not be reached — eligibility is unknown, never guessed."
            : "The claims transport payload failed client-side re-validation (fail-closed) — nothing is rendered as data."}
          {latestFailure ? ` (${latestFailure})` : ""}
        </p>
      </div>
    );
  }
  // No display payload: either nothing has completed, or the latest check
  // carried no distribution (missing/corrupt) — show the latest check's
  // honest verdict + reason (same fallback discipline as the Graveyard).
  if (transport === null) {
    if (latestTransport === null) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
          <Info className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <p className="text-[12px] text-slate-400">No claims check has completed yet.</p>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <ToneBadge tone="warn" dot>
          {latestTransport.artifactState === "corrupt" ? "distribution corrupt" : "distribution unavailable"}
        </ToneBadge>
        <p className="text-[11.5px] leading-relaxed text-amber-200/90">
          {latestTransport.reason ?? latestFailure ?? "The latest check carried no verifiable distribution."}
        </p>
      </div>
    );
  }
  const badge =
    transport.dataState === "real"
      ? { tone: "ok" as const, text: "verified distribution" }
      : transport.dataState === "stale"
        ? { tone: "warn" as const, text: "stale distribution — past its freshness budget" }
        : transport.dataState === "cached"
          ? { tone: "info" as const, text: `cached distribution${cachedAtUnixMs !== null ? ` · held from ${fmtUtcClock(new Date(cachedAtUnixMs))}` : ""}` }
          : { tone: "warn" as const, text: "unavailable" };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5",
        transport.dataState === "real" ? "border-emerald-500/20 bg-emerald-500/[0.06]" : "border-white/8 bg-white/[0.03]",
      )}
    >
      {transport.dataState === "real" ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
      )}
      <ToneBadge tone={badge.tone} dot>
        {badge.text}
      </ToneBadge>
      {transport.reason !== null && <p className="text-[11.5px] leading-relaxed text-slate-400">{transport.reason}</p>}
      <p className="ml-auto font-mono text-[10.5px] text-slate-500">
        source {transport.source.kind}
        {transport.source.kind !== "none" && transport.source.uri !== null ? ` · ${shortAddr(transport.source.uri, 12, 8)}` : ""}
      </p>
    </div>
  );
}
