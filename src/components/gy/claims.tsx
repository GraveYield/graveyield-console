"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
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

/* ── Transaction lifecycle — the client-side overlay ────────────────
 *
 * The owner's vocabulary, exactly: prepared → submitted → confirmed | failed.
 * HONESTY RULES baked in:
 *   - "prepared"  means only that the canonical-SDK instruction exists and is
 *     unsigned — nothing moved, nothing was promised.
 *   - "submitted" means the wallet broadcast a transaction — it is NOT a
 *     payment and the UI never words it as one.
 *   - "confirmed" is displayed ONLY after the client itself re-reads the
 *     ClaimRecord PDA from devnet — the on-chain record, not the transport's
 *     word and not the proof's existence, is the paid evidence.
 *   - "failed"    means no claim happened; a note states no lamports moved
 *     unless an earlier confirmed record exists on-chain.
 */
type TxStatus = "none" | "prepared" | "signing" | "submitted" | "confirmed" | "failed";

const TX_STATUS_META: Record<TxStatus, { label: string; tone: "ok" | "info" | "warn" | "bad" | "muted" | "brand"; note: string }> = {
  none: { label: "not prepared", tone: "muted", note: "" },
  prepared: {
    label: "transaction prepared",
    tone: "info",
    note: "The claim instruction is built from the sealed distribution via the canonical SDK. It is unsigned — nothing has moved.",
  },
  signing: { label: "awaiting wallet signature", tone: "info", note: "The wallet is asking for a signature — the claim is not submitted yet." },
  submitted: {
    label: "submitted — awaiting confirmation",
    tone: "warn",
    note: "The transaction was broadcast to devnet. Submitted is not paid — confirmation and the on-chain claim record are still pending.",
  },
  confirmed: { label: "confirmed", tone: "ok", note: "" },
  failed: { label: "failed", tone: "bad", note: "The claim did not go through — no lamports moved (unless an earlier confirmed claim record exists on-chain)." },
};

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

/* ── Wallet claim card — the state machine, rendered honestly ──────── */
function WalletClaimCard({ view, onRefresh }: { view: WalletClaimViewPayload; onRefresh: () => void }) {
  const { publicKey, wallet } = useWallet();
  const { connection } = useConnection();
  const meta = STATE_META[view.state];
  const [tx, setTx] = useState<TxStatus>(view.state === "claimable" ? "prepared" : "none");
  const [txNote, setTxNote] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [confirmedOnChain, setConfirmedOnChain] = useState<boolean | null>(null);
  const busy = tx === "signing" || tx === "submitted";
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The lifecycle resets per wallet+state payload: a fresh server view is the
  // resting truth; the client overlay only rides on top of `claimable`.
  useEffect(() => {
    setTx(view.state === "claimable" ? "prepared" : "none");
    setTxNote(null);
    setSignature(null);
    setConfirmedOnChain(null);
  }, [view.wallet, view.state, view.claimableLamports]);

  const prepared = view.preparedClaim;
  const canSign =
    view.state === "claimable" &&
    prepared !== null &&
    publicKey !== null &&
    publicKey.toBase58() === view.wallet &&
    tx !== "confirmed" &&
    !busy;

  const onClaim = useCallback(async () => {
    if (!prepared || !publicKey || !connection) return;
    const adapter = wallet?.adapter;
    if (!adapter) return;
    const pool = view.poolAddress;
    if (!pool) {
      setTx("failed");
      setTxNote("The payload does not carry the distribution's pool — refusing to build a claim record lookup blindly.");
      return;
    }
    setTxNote(null);
    try {
      setTx("signing");
      // Rebuild the canonical SDK instruction client-side from the transport
      // shape — the encoding was already proven against the golden vector.
      const ix = new TransactionInstruction({
        programId: new PublicKey(prepared.programId),
        keys: prepared.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from(Uint8Array.from(atob(prepared.data), (c) => c.charCodeAt(0))),
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const message = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(ix);
      setTx("submitted");
      // Wallet-adapter surface: the standard sendTransaction (signs + sends
      // via the wallet), per @solana/wallet-adapter-base Adapter.
      const sig = await adapter.sendTransaction(message, connection);
      if (!mountedRef.current) return;
      setSignature(sig);
      // Bounded confirmation loop — manual, no silent infinite polling.
      const deadline = Date.now() + 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2_000));
        if (!mountedRef.current) return;
        const statuses = await connection.getSignatureStatuses([sig]);
        const st = statuses.value[0] ?? null;
        if (st !== null) {
          if (st.err !== null && st.err !== undefined) {
            setTx("failed");
            setTxNote(`Devnet rejected the claim: ${JSON.stringify(st.err)}`);
            return;
          }
          if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
            break;
          }
        }
        if (Date.now() > deadline) {
          setTx("failed");
          setTxNote("Confirmation window elapsed — check the signature on Explorer; this console will not display paid without the on-chain record.");
          return;
        }
      }
      // THE HONESTY GATE: "confirmed" is only shown after the console itself
      // re-reads the ClaimRecord PDA (server-derived by the canonical SDK)
      // from devnet. A transaction confirming is not evidence a claim was
      // paid — the record is.
      if (!view.claimRecordPda) {
        setTx("failed");
        setTxNote("The payload carries no ClaimRecord PDA — the console will not display a paid claim it cannot verify on-chain.");
        return;
      }
      const info = await connection.getAccountInfo(new PublicKey(view.claimRecordPda));
      if (!mountedRef.current) return;
      if (info !== null) {
        setConfirmedOnChain(true);
        setTx("confirmed");
        onRefresh();
      } else {
        setTx("failed");
        setTxNote("Transaction confirmed but the ClaimRecord PDA is absent — the console will not display a paid claim without the on-chain record.");
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setTx("failed");
      setTxNote(e instanceof Error ? e.message : String(e));
    }
  }, [prepared, publicKey, connection, wallet?.adapter, onRefresh, view.poolAddress]);

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
                  disabled={!canSign}
                  onClick={() => void onClaim()}
                >
                  <HandCoins className="mr-2 h-4 w-4" />
                  {tx === "prepared" ? "Claim proceeds (devnet)" : tx === "signing" ? "Awaiting signature…" : tx === "submitted" ? "Submitted…" : "Claim proceeds"}
                </Button>
                {publicKey?.toBase58() !== view.wallet && (
                  <p className="text-[10.5px] text-amber-300/80">Connect as {shortAddr(view.wallet, 4, 4)} to sign this claim.</p>
                )}
              </div>
            </div>
            <TxStatusRow status={tx} note={txNote} signature={signature} />
            {confirmedOnChain === true && (
              <p className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                <ShieldCheck className="h-3.5 w-3.5" />
                ClaimRecord PDA re-read from devnet — the claim is on-chain record-backed.
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

/* ── Tx status row — prepared / submitted / confirmed / failed ─────── */
function TxStatusRow({ status, note, signature }: { status: TxStatus; note: string | null; signature: string | null }) {
  const meta = TX_STATUS_META[status];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
      {status === "confirmed" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
      {status === "failed" && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
      {(status === "submitted" || status === "signing") && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-300" />}
      {status === "prepared" && <Info className="h-3.5 w-3.5 shrink-0 text-cyan-400" />}
      {status === "none" && <CircleDashed className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
      <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>
      <p className="text-[11px] leading-relaxed text-slate-400">{note ?? meta.note}</p>
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
