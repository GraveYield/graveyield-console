"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowUpDown,
  Clock3,
  FlaskConical,
  Hourglass,
  PlayCircle,
  RefreshCw,
  Rocket,
  Search,
  Timer,
} from "lucide-react";
import { CriteriaChips, SectionHead, ToneBadge, CopyChip, criterionTone, useNow } from "./widgets";
import type { Pool, PoolState } from "@/lib/gy/types";
import { criteriaOf, estimateSalvageEconomics, WSOL_MINT } from "@/lib/gy/estimator";
import { snapshotCriteriaOf, type ConsoleSnapshot } from "@/lib/gy/snapshotContract";
import type { SnapshotTransportPayload } from "@/lib/gy/snapshotTransport";
import { fmtDuration, fmtNum, fmtSol, fmtUtcClock, formatCollapseCell, formatIdleDaysCell, POOL_STATE_META, shortAddr } from "@/lib/gy/format";
import { cn } from "@/lib/utils";

type SortKey = "score" | "tvl" | "inactivity";
const FILTERS: { id: string; label: string; match: (s: PoolState) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  {
    id: "salvageable",
    label: "Salvageable",
    match: (s) => s === "certified" || s === "certification-ready",
  },
  {
    id: "pipeline",
    label: "In pipeline",
    match: (s) => s === "discovered" || s === "waiting-epochs",
  },
  {
    id: "closed",
    label: "Ineligible / settled",
    match: (s) =>
      s === "filtered-out" || s === "evaluated-ineligible" || s === "salvaged",
  },
];

const EPOCHS_NOW = 713;

export function Graveyard({
  pools,
  snapshot,
  transport,
  transportLoading,
  transportError,
  refreshing,
  onRefresh,
  selected,
  onSelect,
}: {
  pools: Pool[];
  snapshot: ConsoleSnapshot | null;
  transport: SnapshotTransportPayload | null;
  transportLoading: boolean;
  transportError: "unreachable" | "malformed" | null;
  refreshing: boolean;
  onRefresh: () => void;
  selected: Pool | null;
  onSelect: (p: Pool | null) => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  // Snapshot rows carry no fabricated score — default to sorting by real TVL.
  const [sortKey, setSortKey] = useState<SortKey>("tvl");

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    const q = query.trim().toLowerCase();
    return pools
      .filter((p) => f.match(p.state))
      .filter(
        (p) =>
          !q ||
          p.baseSymbol.toLowerCase().includes(q) ||
          p.address.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        if (sortKey === "score") return b.score - a.score;
        if (sortKey === "tvl") {
          const d = b.quoteReserveLamports - a.quoteReserveLamports;
          return d > 0n ? 1 : d < 0n ? -1 : 0;
        }
        return a.lastSwapUnix - b.lastSwapUnix;
      });
  }, [pools, filter, query, sortKey]);

  const cycle = (key: SortKey) => setSortKey(key);

  const searchBox = (
    <div className="relative w-full sm:w-64">
      <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search symbol or pool address"
        className="border-white/10 bg-white/5 pl-8 font-mono text-xs placeholder:text-slate-600"
        aria-label="Search pools"
      />
    </div>
  );

  /* Fail-closed, no-fabrication: without a contract-clean artifact there is
     no pool data at all — the view renders the transport's honest state and
     a fix-it hint instead of a table. */
  if (!snapshot) {
    return (
      <div className="animate-fade-up space-y-5">
        <SectionHead title="Graveyard" right={searchBox} />
        <TransportBanner
          transport={transport}
          loading={transportLoading}
          error={transportError}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
        <Card className="glass-panel border-white/8 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No snapshot artifact is being served — pool data is withheld (fail-closed).
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            Configure one artifact source — GY_SNAPSHOT_URL (HTTPS artifact store, serverless) or
            GY_SNAPSHOT_PATH (indexer output volume, self-hosted). See docs/snapshot-transport.md,
            then use Refresh.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-5">
      <SectionHead title="Graveyard" right={searchBox} />

      {/* Data provenance banner — REAL snapshot data, four artifact states,
          freshness explicit, manual refresh only. */}
      <TransportBanner
        transport={transport}
        loading={transportLoading}
        error={transportError}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter pools">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "min-h-9 rounded-full border px-3.5 text-xs font-medium transition-all",
              filter === f.id
                ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200",
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          {rows.length} pool{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Desktop table */}
      <Card className="glass-panel hidden overflow-hidden border-white/8 md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/8 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-medium">Pool</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 font-medium">C1–C6</th>
                <th className="px-4 py-3 text-right font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-slate-300" onClick={() => cycle("tvl")}>
                    TVL <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-slate-300" onClick={() => cycle("inactivity")}>
                    Idle <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium">Collapse</th>
                <th className="px-4 py-3 text-right font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-slate-300" onClick={() => cycle("score")}>
                    Score <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const meta = POOL_STATE_META[p.state];
                return (
                  <tr
                    key={p.address}
                    onClick={() => onSelect(p)}
                    className="group cursor-pointer border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.04]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-mono text-[10px] font-bold text-slate-300">
                          {p.baseSymbol.slice(0, 3)}
                        </span>
                        <span>
                          <span className="block font-mono text-[13px] font-semibold text-foreground">
                            {p.baseSymbol} / {p.quoteSymbol}
                          </span>
                          <span className="block font-mono text-[10.5px] text-slate-500">
                            {shortAddr(p.address, 6, 4)} · {p.amm}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StateBadge state={p.state} />
                    </td>
                    <td className="px-4 py-3">
                      <CriteriaRow pool={p} snapshot={snapshot} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-slate-200">
                      {fmtSol(p.quoteReserveLamports, 2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-slate-400">
                      {formatIdleDaysCell(p.lastSwapUnix, Date.now())}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-slate-300">
                      {formatCollapseCell(p.collapseBps, p.snapshotMeta !== undefined)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={cn(
                          "font-mono text-[13px] font-semibold tabular-nums",
                          p.score >= 0.8
                            ? "text-emerald-300"
                            : p.score >= 0.5
                              ? "text-cyan-300"
                              : "text-slate-400",
                        )}
                      >
                        {p.score.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Mobile cards */}
      <div className="grid gap-3 md:hidden">
        {rows.map((p) => (
          <button
            key={p.address}
            type="button"
            onClick={() => onSelect(p)}
            className="glass-panel rounded-xl p-4 text-left transition-shadow active:glow-cyan"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">
                {p.baseSymbol} / {p.quoteSymbol}
              </span>
              <StateBadge state={p.state} />
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <CriteriaRow pool={p} snapshot={snapshot} />
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {fmtSol(p.quoteReserveLamports, 2)} SOL
              </span>
            </div>
          </button>
        ))}
      </div>

      {rows.length === 0 && (
        <Card className="glass-panel border-white/8 p-10 text-center">
          <p className="text-sm text-muted-foreground">No pools match.</p>
        </Card>
      )}

      {selected && snapshot && (
        <PoolSheet
          pool={selected}
          snapshot={snapshot}
          open={!!selected}
          onClose={() => onSelect(null)}
          toast={toast}
        />
      )}
    </div>
  );
}

function StateBadge({ state }: { state: PoolState }) {
  const meta = POOL_STATE_META[state];
  return (
    <ToneBadge tone={meta.tone} dot={state === "certified"}>
      {meta.label}
    </ToneBadge>
  );
}

/* ── Snapshot transport banner (P4.1 Step 1) ────────────────────
   Four explicit artifact states — valid / stale / missing / corrupt.
   Stale, missing and corrupt data can never present as fresh: the
   badge says which state is served, and missing/corrupt carry the
   route's diagnostic reason. Manual refresh only — the console
   never polls the indexer. */
function TransportBanner({
  transport,
  loading,
  error,
  refreshing,
  onRefresh,
}: {
  transport: SnapshotTransportPayload | null;
  loading: boolean;
  error: "unreachable" | "malformed" | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const state = loading
    ? { tone: "muted" as const, label: "checking snapshot…" }
    : error === "unreachable"
      ? { tone: "bad" as const, label: "snapshot transport unreachable" }
      : error === "malformed"
        ? { tone: "bad" as const, label: "transport payload rejected" }
        : transport === null
          ? { tone: "muted" as const, label: "checking snapshot…" }
          : transport.artifactState === "valid"
            ? { tone: "ok" as const, label: "snapshot fresh" }
            : transport.artifactState === "stale"
              ? { tone: "warn" as const, label: "snapshot stale" }
              : transport.artifactState === "missing"
                ? { tone: "warn" as const, label: "snapshot unavailable" }
                : { tone: "bad" as const, label: "snapshot corrupt" };

  const checkedAt =
    transport === null ? null : (
      <>checked {fmtUtcClock(new Date(transport.checkedAtUnixMs))} UTC</>
    );

  let detail: React.ReactNode = null;
  if (!loading && error === null && transport !== null) {
    const s = transport.snapshot;
    if (transport.artifactState === "valid" && s) {
      detail = (
        <span>
          <span className="font-semibold text-slate-200">Real mainnet Raydium V4 pools</span> — indexer
          snapshot {s.counts.enriched} of {s.counts.supportedWsolPairs} WSOL-supported pools enriched ·
          generated {fmtUtcClock(new Date(s.generatedAtUnixMs))} UTC · slots{" "}
          {s.provenance.slotLowerBound.toLocaleString()}–{s.provenance.slotUpperBound.toLocaleString()}
          {checkedAt !== null && (
            <>
              {' '}· {checkedAt}
            </>
          )}
          {s.failures.length > 0 && (
            <span className="text-slate-500">
              {' '}· {s.failures.length} field(s) unavailable (recorded per pool, shown as “unavailable”)
            </span>
          )}
        </span>
      );
    } else if (transport.artifactState === "stale") {
      detail = (
        <span>
          <span className="font-semibold text-amber-200">Real but stale</span> — artifact age{" "}
          {transport.ageMs !== null ? fmtDuration(transport.ageMs) : "unknown"} exceeds its{" "}
          {transport.maxAgeMs !== null ? fmtDuration(transport.maxAgeMs) : "24h"} freshness budget.
          Figures remain labeled stale — never presented as fresh.
          {checkedAt !== null && (
            <>
              {' '}· {checkedAt}
            </>
          )}
        </span>
      );
    } else {
      // missing | corrupt — the route's reason is the diagnostic surface.
      detail = (
        <span>
          {transport.reason ?? "No artifact available."}
          {checkedAt !== null && (
            <>
              {' '}· {checkedAt}
            </>
          )}
          {' '}·{' '}
          <span className="text-slate-500">
            source: {transport.source.kind === "none" ? "none configured" : `${transport.source.kind} ${transport.source.uri ?? ""}`}
          </span>
        </span>
      );
    }
  } else if (error === "unreachable") {
    detail = <span>The console could not reach /api/gy/snapshot — the snapshot transport itself is down. Retry with Refresh.</span>;
  } else if (error === "malformed") {
    detail = <span>The transport payload failed client-side re-validation (fail-closed) — treated as unavailable. Retry with Refresh.</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-slate-400">
      <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
      {detail}
      <Button
        variant="outline"
        size="sm"
        className="ml-auto min-h-8 shrink-0 border-white/10 bg-white/[0.04] px-3 text-xs text-slate-300 hover:bg-white/10 hover:text-foreground"
        onClick={onRefresh}
        disabled={refreshing || loading}
        aria-label="Manually refresh snapshot"
      >
        <RefreshCw className={`h-3.5 w-3.5${refreshing ? " animate-spin" : ""}`} />
        Refresh
      </Button>
      <span className="text-[10.5px] text-slate-600">manual — no auto-polling</span>
    </div>
  );
}

function CriteriaRow({ pool, snapshot }: { pool: Pool; snapshot: ConsoleSnapshot }) {
  const now = Date.now();
  const criteria = pool.snapshotCriteria
    ? snapshotCriteriaOf(pool, now, snapshot)
    : criteriaOf(pool, now);
  return <CriteriaChips criteria={criteria} />;
}

/* ── Pool detail sheet ─────────────────────────────────────────── */
function PoolSheet({
  pool,
  snapshot,
  open,
  onClose,
  toast,
}: {
  pool: Pool;
  snapshot: ConsoleSnapshot;
  open: boolean;
  onClose: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const now = useNow();
  const criteria = useMemo(
    () =>
      pool.snapshotCriteria
        ? snapshotCriteriaOf(pool, now ?? Date.now(), snapshot)
        : criteriaOf(pool, now ?? Date.now()),
    [pool, now, snapshot],
  );
  const [lpPct, setLpPct] = useState([100]);
  const [slippageOverride, setSlippageOverride] = useState<number>(300);

  const estimate = useMemo(() => {
    // Full-reserve quote at pool price — indicative, integer-exact.
    const quoteOut = pool.quoteReserveLamports;
    const quoteIn = pool.baseReserve;
    return estimateSalvageEconomics({
      pool: {
        coinReserve: pool.baseReserve,
        pcReserve: pool.quoteReserveLamports,
        lpSupply: BigInt(pool.lpSupply),
        // Oriented per the 7019 guard: quote side is WSOL.
        coinMint: pool.baseSymbol,
        pcMint: WSOL_MINT,
        wsolMint: WSOL_MINT,
      },
      quoteInAmount: quoteIn,
      quoteOutLamports: quoteOut,
      salvorLpAmount: BigInt(Math.max(1, Math.floor((pool.lpSupply * lpPct[0]) / 100))),
      config: {
        salvorShareBps: 4000,
        maxSlippageBps: 300,
        jupiterDustThresholdLamports: 10_000n,
      },
      costs: {
        priorityFeeBudgetLamports: 3_000_000n, // D3 plan — Charter-guarded
        signatureCount: 2,
        frontedRentLamports: 1_441_080n,
      },
      slippageBpsOverride: slippageOverride,
      minNetProfitLamports: 0n,
    });
  }, [pool, lpPct, slippageOverride]);

  const certMsLeft = pool.certExpiresAt && now ? pool.certExpiresAt - now : null;
  const actionable = pool.state === "certification-ready" || pool.state === "certified";

  /* Browser/OS back button closes the sheet instead of leaving the app. */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    history.pushState({ gyPoolSheet: true }, "");
    const onPop = () => onCloseRef.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (history.state?.gyPoolSheet) history.back();
    };
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="scroll-slim w-full overflow-y-auto border-white/10 bg-[#1E1E1E] p-0 sm:max-w-xl"
      >
        <div className="sticky top-0 z-10 border-b border-white/8 bg-[#1E1E1E]/95 px-5 py-4 backdrop-blur">
          <SheetHeader className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-8">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Back to Graveyard"
                  className="inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-slate-300 transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span className="hidden text-xs font-semibold sm:inline">Graveyard</span>
                </button>
                <SheetTitle className="truncate font-display text-lg font-bold text-foreground">
                  {pool.baseSymbol} / {pool.quoteSymbol}
                </SheetTitle>
              </div>
              <StateBadge state={pool.state} />
            </div>
            <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-2">
              <CopyChip text={pool.address} />
              <span className="font-mono text-[10.5px] text-slate-500">{pool.amm}</span>
            </SheetDescription>
          </SheetHeader>
          {pool.state === "certified" && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
              <Timer className="h-4 w-4 shrink-0 text-emerald-400" />
              <p className="font-mono text-xs text-emerald-200">
                cert TTL{" "}
                <span className="font-semibold tabular-nums">
                  {certMsLeft === null ? "—" : fmtDuration(certMsLeft)}
                </span>{" "}
                — salvage window open
              </p>
            </div>
          )}
        </div>

        <div className="space-y-6 px-5 py-5">
          {/* Live evidence — real snapshot facts + provenance (P3-A). */}
          {pool.snapshotReserves && pool.snapshotMeta && (
            <section>
              <SheetSectionTitle icon={FlaskConical}>Live evidence (indexer snapshot)</SheetSectionTitle>
              <Card className="border-white/8">
                <CardContent className="space-y-1.5 p-4 font-mono text-xs">
                  <Row
                    k="WSOL reserve (vault)"
                    v={`${fmtSol(pool.quoteReserveLamports)} SOL`}
                    strong
                  />
                  <Row
                    k="memecoin reserve (vault)"
                    v={`${pool.snapshotReserves.memecoinReserveRaw} raw · ${pool.baseDecimals} decimals`}
                  />
                  <Row k="LP supply" v={`${pool.snapshotReserves.lpSupplyRaw} raw`} />
                  <Row
                    k="last swap"
                    v={
                      pool.snapshotReserves.lastSwap
                        ? `${fmtUtcClock(new Date(pool.snapshotReserves.lastSwap.unixTs * 1000))} UTC (slot ${pool.snapshotReserves.lastSwap.slot.toLocaleString()})`
                        : "unavailable — not derivable in this run"
                    }
                  />
                  <div className="my-1.5 border-t border-white/8" />
                  <Row
                    k="fetched at"
                    v={`${fmtUtcClock(new Date(pool.snapshotMeta.fetchedAtUnixMs))} UTC`}
                  />
                  <Row
                    k="artifact generated"
                    v={`${fmtUtcClock(new Date(pool.snapshotMeta.generatedAtUnixMs))} UTC · stale after ${fmtDuration(pool.snapshotMeta.maxAgeMs)}`}
                  />
                  <Row
                    k="cluster / source"
                    v={`${snapshot.cluster} · ${snapshot.provenance.endpointKind} · ${snapshot.provenance.source}`}
                  />
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-slate-500">account fingerprint (sha256)</span>
                    <span className="truncate font-mono text-[10.5px] text-slate-400">
                      {pool.snapshotFingerprint ? shortAddr(pool.snapshotFingerprint, 10, 8) : "—"}
                    </span>
                  </div>
                  {pool.snapshotFingerprint && (
                    <div className="pt-1">
                      <CopyChip text={pool.snapshotFingerprint} label="Copy account fingerprint" />
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          )}

          {/* Lifecycle stepper */}
          <section>
            <SheetSectionTitle icon={Hourglass}>Lifecycle position</SheetSectionTitle>
            <LifecycleStepper state={pool.state} anchorEpoch={pool.anchorEpoch} />
          </section>

          {/* Criteria */}
          <section>
            <SheetSectionTitle icon={FlaskConical}>Six-criteria evaluation</SheetSectionTitle>
            <div className="space-y-2">
              {criteria.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-white/8 bg-white/[0.03] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] font-semibold",
                        c.state === "pass" && "border-emerald-500/30 bg-emerald-500/12 text-emerald-300",
                        c.state === "fail" && "border-red-500/30 bg-red-500/12 text-red-300",
                        c.state === "pending" && "border-white/10 bg-white/5 text-slate-400",
                      )}
                    >
                      {c.id}
                    </span>
                    <span className="text-[13px] font-medium text-foreground">{c.name}</span>
                    <ToneBadge tone={criterionTone(c.state)} className="ml-auto">
                      {c.value}
                    </ToneBadge>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {c.detail}
                  </p>
                  <p className="mt-1 font-mono text-[10.5px] text-slate-500">
                    threshold {c.threshold}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* Estimator */}
          <section>
            <SheetSectionTitle icon={PlayCircle}>Salvage estimate</SheetSectionTitle>
            <Card className="border-white/8">
              <CardContent className="space-y-4 p-4">
                <div>
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Salvor LP to burn</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {lpPct[0]}% ·{" "}
                      {fmtNum(Math.floor((pool.lpSupply * lpPct[0]) / 100), 0)} LP
                    </span>
                  </div>
                  <Slider
                    value={lpPct}
                    onValueChange={setLpPct}
                    min={5}
                    max={100}
                    step={5}
                    className="mt-2"
                    aria-label="Salvor LP percentage"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Slippage floor (≤ config 300 bps)</span>
                    <span className="font-mono tabular-nums text-slate-200">
                      {slippageOverride} bps
                    </span>
                  </div>
                  <Slider
                    value={[slippageOverride]}
                    onValueChange={(v) => setSlippageOverride(v[0])}
                    min={50}
                    max={300}
                    step={10}
                    className="mt-2"
                    aria-label="Slippage override"
                  />
                </div>

                {estimate.status === "reject" ? (
                  <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    reject — {estimate.reason}
                  </p>
                ) : (
                  <div className="space-y-1.5 rounded-lg border border-white/8 bg-[#1E1E1E] p-3 font-mono text-xs">
                    <Row k="direct WSOL withdraw" v={`${fmtSol(estimate.directWsolOut ?? 0n)} SOL`} />
                    <Row
                      k={estimate.swapLegBelowDust ? "swap leg (below dust — skipped, D6)" : "memecoin → WSOL leg"}
                      v={
                        estimate.swapLegBelowDust
                          ? "retained as dust"
                          : `${fmtSol((estimate.grossProceedsWsolLamports ?? 0n) - (estimate.directWsolOut ?? 0n))} SOL`
                      }
                    />
                    <div className="my-1.5 border-t border-white/8" />
                    <Row
                      k="gross proceeds"
                      v={`${fmtSol(estimate.grossProceedsWsolLamports ?? 0n)} SOL`}
                      strong
                    />
                    <Row
                      k="salvor share (40%)"
                      v={`${fmtSol(estimate.salvorGrossShareLamports ?? 0n)} SOL`}
                      tone="text-cyan-300"
                    />
                    <Row
                      k="costs (fee plan + base + rent)"
                      v={`−${fmtSol(estimate.costs?.total ?? 0n)} SOL`}
                      tone="text-amber-300"
                    />
                    <div className="my-1.5 border-t border-white/8" />
                    <Row
                      k="net profit"
                      v={`${fmtSol(estimate.netProfitLamports ?? 0n)} SOL`}
                      tone={(estimate.netProfitLamports ?? 0n) > 0n ? "text-emerald-300" : "text-red-300"}
                      strong
                    />
                    <Row
                      k="break-even gross"
                      v={`${fmtSol(estimate.breakEvenGrossWsolLamports ?? 0n)} SOL`}
                    />
                    <Row
                      k="min_quote_output floor"
                      v={`${fmtSol(estimate.minQuoteOutputLamports ?? 0n)} SOL @ ${estimate.effectiveSlippageBps} bps`}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Actions */}
          <section>
            <SheetSectionTitle icon={Rocket}>Salvor actions</SheetSectionTitle>
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <Button
                variant="outline"
                className="min-h-11 flex-1 border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:text-cyan-100"
                onClick={() =>
                  toast({
                    title: "Dry-run queued",
                    description: `${pool.baseSymbol} re-evaluated read-only — nothing submitted.`,
                  })
                }
              >
                <PlayCircle className="mr-2 h-4 w-4" />
                Evaluate (dry-run)
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    className="min-h-11 flex-1 bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
                    disabled={!actionable}
                  >
                    <Rocket className="mr-2 h-4 w-4" />
                    Certify &amp; salvage
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="border-white/10 bg-[#1E1E1E] text-foreground">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="font-display">
                      Submit certify-and-salvage?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="leading-relaxed text-slate-400">
                      Bundles <span className="font-mono text-slate-300">evaluate_pool_phase_2</span>{" "}
                      + <span className="font-mono text-slate-300">salvage_pool</span> into one
                      atomic transaction. If any check fails, everything reverts.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400"
                      onClick={() =>
                        toast({
                          title: "Simulated",
                          description: "Devnet executors stay dry-run — nothing was submitted.",
                        })
                      }
                    >
                      Simulate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {!actionable && (
              <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-slate-500">
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Unlocks when the pool is certification-ready or certified.
              </p>
            )}
            {pool.note && (
              <p className="mt-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed text-slate-400">
                {pool.note}
              </p>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({
  k,
  v,
  tone,
  strong,
}: {
  k: string;
  v: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{k}</span>
      <span
        className={cn(
          "tabular-nums",
          strong ? "font-semibold" : "font-normal",
          tone ?? "text-slate-200",
        )}
      >
        {v}
      </span>
    </div>
  );
}

function SheetSectionTitle({
  icon: Icon,
  children,
}: {
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <h3 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-slate-300">
      <Icon className="h-4 w-4 text-emerald-400" />
      {children}
    </h3>
  );
}

const STEPS: { id: string; label: string }[] = [
  { id: "discovered", label: "Discovered" },
  { id: "phase1", label: "Phase 1 · anchor" },
  { id: "epochs", label: "Epoch gap" },
  { id: "certified", label: "Certified" },
  { id: "salvaged", label: "Settled" },
];

function stepIndex(pool: Pool): number {
  switch (pool.state) {
    case "discovered":
    case "filtered-out":
      return 0;
    case "waiting-epochs":
      return 2;
    case "certification-ready":
      return 2;
    case "certified":
      return 3;
    case "salvaged":
      return 4;
    default:
      return pool.anchorEpoch !== null ? 1 : 0;
  }
}

function LifecycleStepper({ state, anchorEpoch }: { state: PoolState; anchorEpoch: number | null }) {
  const idx = stepIndex({ state, anchorEpoch } as Pool);
  const failed = state === "filtered-out" || state === "evaluated-ineligible";
  return (
    <ol className="flex items-stretch gap-1.5">
      {STEPS.map((s, i) => {
        const done = !failed && i <= idx;
        const current = !failed && i === idx && state !== "salvaged";
        return (
          <li key={s.id} className="min-w-0 flex-1">
            <div
              className={cn(
                "h-1.5 rounded-full transition-colors",
                failed && i === 1
                  ? "bg-red-500/60"
                  : done
                    ? "bg-gradient-to-r from-emerald-500 to-cyan-400"
                    : "bg-white/10",
              )}
            />
            <p
              className={cn(
                "mt-1.5 truncate text-center text-[10px] leading-tight",
                current ? "font-semibold text-emerald-300" : done ? "text-slate-300" : "text-slate-600",
              )}
            >
              {failed && i === 1 ? "rejected" : s.label}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
