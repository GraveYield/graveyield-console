"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  FileSearch,
  HandCoins,
  Info,
  Lock,
  Search,
  Wallet,
} from "lucide-react";
import { CopyChip, KpiCard, SectionHead, ToneBadge } from "./widgets";
import { CLAIM_POSITIONS, CLAIM_SNAPSHOT, DEMO_WALLET } from "@/lib/gy/data";
import { fmtSol, shortAddr } from "@/lib/gy/format";

export function Claims() {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    return CLAIM_POSITIONS.filter(
      (c) => c.holder.toLowerCase() === q || q.length >= 20 && c.holder.toLowerCase().includes(q),
    );
  }, [q]);

  const total = matches.reduce((a, c) => a + c.claimableLamports, 0n);
  const vaultSOL = fmtSol(CLAIM_SNAPSHOT.vaultBalanceLamports);

  return (
    <div className="animate-fade-up space-y-5">
      <SectionHead title="LP Claims" />

      {/* Snapshot facts */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard
          label="Vault balance"
          value={`${vaultSOL} SOL`}
          sub="lp_holder_pool_vault"
          accent="emerald"
        />
        <KpiCard
          label="Snapshot root"
          value={`${CLAIM_SNAPSHOT.root.slice(0, 6)}…${CLAIM_SNAPSHOT.root.slice(-4)}`}
          sub={`slot ${CLAIM_SNAPSHOT.snapshotSlot.toLocaleString()} · ${CLAIM_SNAPSHOT.holders} holders`}
          accent="cyan"
        />
        <KpiCard
          label="Proof depth"
          value="6 levels"
          sub="SHA-256 Merkle tree"
          accent="violet"
        />
        <KpiCard
          label="Expiry"
          value="never"
          sub="no deadline"
          accent="amber"
        />
      </div>

      {/* Lookup */}
      <Card className="glass-panel border-white/8">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4 text-emerald-400" />
            Check a wallet
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearched(false);
                }}
                placeholder="Paste an LP-holder wallet address"
                className="border-white/10 bg-white/5 pl-8 font-mono text-xs placeholder:text-slate-600"
                aria-label="Wallet address"
                onKeyDown={(e) => e.key === "Enter" && setSearched(true)}
              />
            </div>
            <Button
              className="min-h-11 bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400"
              onClick={() => setSearched(true)}
            >
              <FileSearch className="mr-2 h-4 w-4" />
              Look up claims
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2.5">
            <Info className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <p className="text-[11.5px] text-slate-400">
              Demo snapshot — try this wallet:
            </p>
            <CopyChip text={DEMO_WALLET} label="Copy demo wallet" />
          </div>

          {searched && q && matches.length === 0 && (
            <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-200">
              No claim records for this wallet in the current snapshot.
            </p>
          )}

          {matches.length > 0 && (
            <div className="space-y-3">
              {matches.map((c) => (
                <div
                  key={c.holder + c.poolAddress}
                  className="rounded-xl border border-emerald-500/20 bg-[#1E1E1E] p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-mono text-sm font-semibold text-foreground">{c.poolLabel}</p>
                      <p className="font-mono text-[10.5px] text-slate-500">
                        holder {shortAddr(c.holder, 6, 4)} · {c.balanceAtSnapshot.toLocaleString()} LP
                        at snapshot ({(c.shareBps / 100).toFixed(2)}%)
                      </p>
                    </div>
                    {c.claimed ? (
                      <ToneBadge tone="muted">
                        <CheckCircle2 className="mr-1 h-3 w-3" /> claimed
                      </ToneBadge>
                    ) : (
                      <ToneBadge tone="ok" dot>
                        claimable
                      </ToneBadge>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-slate-500">
                        {c.claimed ? "Claimed" : "Your pro-rata share"}
                      </p>
                      <p className="font-mono text-xl font-bold tabular-nums text-emerald-300">
                        {fmtSol(c.claimableLamports)} SOL
                      </p>
                    </div>
                    <Button
                      disabled={c.claimed}
                      className="min-h-11 bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                      onClick={() =>
                        toast({
                          title: "Simulated claim",
                          description: "Simulated on devnet — no transaction submitted.",
                        })
                      }
                    >
                      <HandCoins className="mr-2 h-4 w-4" />
                      {c.claimed ? "Already processed" : "Claim proceeds"}
                    </Button>
                  </div>
                  <p className="mt-3 flex items-center gap-1.5 font-mono text-[10.5px] text-slate-500">
                    <Lock className="h-3 w-3" />
                    root {c.root.slice(0, 10)}… · proof depth {c.proofDepth}
                  </p>
                </div>
              ))}
              <p className="text-right font-mono text-xs text-slate-400">
                total claimable <span className="font-semibold text-emerald-300">{fmtSol(total)} SOL</span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
