"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Fingerprint, RefreshCw, Scale, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KpiCard, SplitBar, ToneBadge, MiniStat } from "./widgets";
import { CONFIG, PROGRAM_IDS } from "@/lib/gy/data";
import { fetchProtocolPulse, type ProtocolPulse } from "@/lib/gy/protocolLive";
import type { BotEvent, Pool } from "@/lib/gy/types";
import { fmtSol, fmtUtcClock, shortAddr } from "@/lib/gy/format";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<BotEvent["kind"], string> = {
  discovery: "text-cyan-300",
  evaluation: "text-cyan-300",
  attestation: "text-emerald-300",
  lifecycle: "text-emerald-300",
  economics: "text-violet-300",
  settlement: "text-emerald-300",
  guard: "text-amber-300",
  alert: "text-amber-300",
};

export function Overview({ pools, events }: { pools: Pool[]; events: BotEvent[] }) {
  /* Live protocol pulse — read-only devnet reads, decoded with
     discriminator-checked layouts, partial availability preserved. */
  const [pulse, setPulse] = useState<ProtocolPulse | null>(null);
  const [pulseError, setPulseError] = useState<string | null>(null);
  const [pulseLoading, setPulseLoading] = useState(false);
  const refreshPulse = useCallback(() => {
    setPulseLoading(true);
    fetchProtocolPulse()
      .then((p) => {
        setPulse(p);
        setPulseError(null);
      })
      .catch((err) => setPulseError(String((err as Error).message ?? err).slice(0, 140)))
      .finally(() => setPulseLoading(false));
  }, []);
  useEffect(refreshPulse, [refreshPulse]);

  const certified = pools.filter((p) => p.state === "certified");
  const ready = pools.filter((p) => p.state === "certification-ready");
  const waiting = pools.filter((p) => p.state === "waiting-epochs");
  const settled = pools.filter((p) => p.state === "salvaged");
  const tracked = pools.filter(
    (p) => !["filtered-out", "evaluated-ineligible"].includes(p.state),
  );
  const trackedTvl = tracked.reduce((a, p) => a + p.quoteReserveLamports, 0n);
  const settledPool = settled[0];
  const receiptDemo = settledPool ? settledPool.quoteReserveLamports : 0n;
  const lpCut = (receiptDemo * 4000n) / 10000n;

  return (
    <div className="animate-fade-up space-y-6">
      {/* KPI grid — SIMULATED fixture data (snapshot pools live in the Graveyard) */}
      <section aria-label="Protocol KPIs" className="space-y-2">
        <div className="flex items-center gap-2">
          <ToneBadge tone="muted">simulated fixture data</ToneBadge>
          <span className="text-[11px] text-slate-500">
            real candidate pools are in the Graveyard view
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard
          label="Pools tracked"
          value={tracked.length}
          sub={`${waiting.length} waiting epochs · ${settled.length} settled`}
          accent="cyan"
        />
        <KpiCard
          label="Salvageable now"
          value={certified.length + ready.length}
          sub={`${certified.length} cert live · ${ready.length} ready`}
          accent="emerald"
        />
        <KpiCard
          label="Watch-set TVL"
          value={`${fmtSol(trackedTvl, 2)} SOL`}
          sub="quote reserves across tracked pools"
          accent="amber"
        />
        <KpiCard
          label="Settled"
          value={settled.length}
          sub={settledPool ? `${settledPool.baseSymbol} · claims open` : "none yet"}
          accent="violet"
        />
        </div>
      </section>

      {/* Protocol pulse — LIVE read-only devnet state (P3-A Task 3.3). */}
      <section>
        <Card className="glass-panel border-white/8">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-cyan-400" />
                Protocol pulse — live (read-only devnet)
              </span>
              <span className="flex items-center gap-2">
                <ToneBadge tone={pulseError ? "bad" : pulse ? "ok" : "muted"} dot={!pulseLoading}>
                  {pulseLoading ? "checking…" : pulseError ? "unavailable" : pulse ? "live" : "checking…"}
                </ToneBadge>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 border-white/10 px-2 text-[11px] text-slate-300 hover:bg-white/5"
                  onClick={refreshPulse}
                  disabled={pulseLoading}
                  aria-label="Re-check protocol pulse"
                >
                  <RefreshCw className={cn("h-3 w-3", pulseLoading && "animate-spin")} />
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pulseError ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
                unavailable — {pulseError}
              </p>
            ) : !pulse ? (
              <p className="text-xs text-slate-500">reading deployed programs…</p>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {[pulse.scanner, pulse.vault].map((p) => (
                    <div
                      key={p.programId}
                      className="space-y-1.5 rounded-lg border border-white/8 bg-white/[0.03] p-3 font-mono text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">{p === pulse.scanner ? "GraveScanner" : "GraveVault"}</span>
                        <ToneBadge tone={p.executable === null ? "muted" : p.executable ? "ok" : "bad"}>
                          {p.executable === null ? "lookup unavailable" : p.executable ? "deployed · executable" : "not executable"}
                        </ToneBadge>
                      </div>
                      <div className="text-slate-500">
                        program <span className="text-slate-300">{shortAddr(p.programId, 6, 6)}</span>
                      </div>
                      {p.config ? (
                        <>
                          <div className="text-slate-500">
                            authority <span className="text-slate-300">{shortAddr(p.config.authority, 4, 4)}</span>
                          </div>
                          {"inactivitySeconds" in p.config ? (
                            <>
                              <div className="text-slate-500">
                                C1 window <span className="text-slate-300">{Number(BigInt(p.config.inactivitySeconds) / 86_400n)} d</span>
                                {" · "}C3 floor <span className="text-slate-300">{fmtSol(BigInt(p.config.minTvlLamports))} SOL</span>
                              </div>
                              <div className="text-slate-500">
                                paused <span className={p.config.paused ? "text-amber-300" : "text-emerald-300"}>{String(p.config.paused)}</span>
                                {" · "}bump <span className="text-slate-300">{p.config.bump}</span>
                              </div>
                              <div className="text-slate-500">
                                activity oracle <span className="text-slate-300">{shortAddr(p.config.activityOracle, 4, 4)}</span>
                                {" · "}launch-price oracle <span className="text-slate-300">{shortAddr(p.config.launchPriceOracle, 4, 4)}</span>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-slate-500">
                                split <span className="text-slate-300">{p.config.lpHolderShareBps}/{p.config.salvorShareBps}/≤{p.config.protocolShareBps} bps</span>
                                {" · "}slippage cap <span className="text-slate-300">{p.config.maxSlippageBps} bps</span>
                              </div>
                              <div className="text-slate-500">
                                emergency paused <span className={p.config.emergencyPaused ? "text-amber-300" : "text-emerald-300"}>{String(p.config.emergencyPaused)}</span>
                                {" · "}bump <span className="text-slate-300">{p.config.bump}</span>
                              </div>
                            </>
                          )}
                        </>
                      ) : (
                        <div className="text-amber-300/80">config unavailable — {p.configError}</div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Decoded from the deployed ProtocolConfig PDAs via {pulse.rpcHost} at{" "}
                  {fmtUtcClock(new Date(pulse.fetchedAtUnixMs))} UTC — Anchor-discriminator checked,
                  layout-pinned by unit tests, cross-verified against the protocol SDK. Unavailable
                  rows are shown as such, never defaulted.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Split + receipt */}
      <section className="grid gap-4 lg:grid-cols-5">
        <Card className="glass-panel border-white/8 lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="h-4 w-4 text-emerald-400" />
              Salvage split
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SplitBar />
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="LP holders" value={`${CONFIG.sharesBps.lpHolders} bps`} />
              <MiniStat label="Salvor" value={`${CONFIG.sharesBps.salvor} bps`} />
              <MiniStat label="Protocol" value={`≤ ${CONFIG.protocolShareCeilingBps} bps`} />
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/8 lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Latest receipt
              </span>
              <ToneBadge tone="muted">simulated</ToneBadge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {settledPool ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-foreground">
                    {settledPool.baseSymbol} / {settledPool.quoteSymbol}
                  </span>
                  <ToneBadge tone="brand" dot>
                    SalvageCompleted
                  </ToneBadge>
                </div>
                <div className="space-y-1.5 rounded-lg border border-white/8 bg-white/[0.03] p-3 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">gross proceeds</span>
                    <span className="tabular-nums text-slate-200">
                      {fmtSol(receiptDemo)} SOL
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-emerald-400/80">lp_holder_pool_vault</span>
                    <span className="tabular-nums text-emerald-300">{fmtSol(lpCut)} SOL</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-cyan-400/80">salvor</span>
                    <span className="tabular-nums text-cyan-300">{fmtSol(lpCut)} SOL</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-violet-400/80">protocol treasury</span>
                    <span className="tabular-nums text-violet-300">
                      {fmtSol(receiptDemo - 2n * lpCut)} SOL
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No settlement recorded yet.</p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Fleet activity */}
      <section>
        <Card className="glass-panel border-white/8">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4 text-emerald-400" />
                Fleet activity
              </span>
              <ToneBadge tone="ok" dot>
                streaming
              </ToneBadge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="scroll-slim max-h-72 space-y-1.5 overflow-y-auto pr-1" aria-live="polite">
              {events.map((e) => (
                <div
                  key={e.id}
                  className="animate-row-in flex items-start gap-2.5 rounded-lg border border-white/6 bg-white/[0.02] px-3 py-2"
                >
                  <span className="mt-0.5 font-mono text-[10px] tabular-nums text-slate-500">
                    {e.ts}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                      KIND_STYLE[e.kind],
                    )}
                  >
                    {e.bot}
                  </span>
                  <span
                    className={cn(
                      "flex-1 text-[12.5px] leading-snug",
                      e.level === "warn" ? "text-amber-200/90" : "text-slate-300",
                    )}
                  >
                    {e.text}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Program IDs */}
      <section className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-xl p-4 sm:p-5">
        <p className="text-sm font-semibold text-foreground">
          Programs — devnet since {PROGRAM_IDS.deployedAt}
        </p>
        <div className="flex flex-col gap-1.5 font-mono text-[11px]">
          <span className="text-slate-500">
            Scanner{" "}
            <span className="text-emerald-300">{PROGRAM_IDS.graveScanner.slice(0, 12)}…</span>
          </span>
          <span className="text-slate-500">
            Vault <span className="text-cyan-300">{PROGRAM_IDS.graveVault.slice(0, 12)}…</span>
          </span>
        </div>
      </section>
    </div>
  );
}
