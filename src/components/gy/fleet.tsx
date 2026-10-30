"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bot as BotIcon, RefreshCw, ShieldAlert, Eye } from "lucide-react";
import { MiniStat, SectionHead, ToneBadge } from "./widgets";
import { FLEET_IDENTITY, type FleetAlert, type FleetTrailEvent } from "@/lib/gy/fleetContract";
import type { FleetTransportPayload } from "@/lib/gy/fleetTransport";
import { fmtDuration, fmtUtcClock } from "@/lib/gy/format";
import { cn } from "@/lib/utils";

/* Severity → tone. The mapping is transparent styling, not re-evaluation:
   the trail's own severity field is shown verbatim next to it. */
const SEVERITY_TONE = {
  critical: "bad",
  warn: "warn",
  info: "info",
} as const;

function fmtClockMs(unixMs: number): string {
  return fmtUtcClock(new Date(unixMs));
}

export function Fleet({
  fleet,
  latestTransport,
  cachedAtUnixMs,
  latestFailure,
  loading,
  error,
  refreshing,
  onRefresh,
}: {
  /** Effective display payload — freshness re-evaluated against the wall
      clock; dataState may be "cached" when held from a prior good check. */
  fleet: FleetTransportPayload | null;
  /** Raw latest check result — diagnostics for the no-data banner. */
  latestTransport: FleetTransportPayload | null;
  /** When the display payload is held from a previous successful check
      (D5 "cached" state), the unix-ms time of that check. */
  cachedAtUnixMs: number | null;
  /** Why the latest check did not produce a trail (while cached data is on
      screen). Null when the display payload is from the latest check. */
  latestFailure: string | null;
  loading: boolean;
  error: "unreachable" | "malformed" | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const trails = fleet?.fleet ?? null;

  /* Fail-closed, no-fabrication: without a contract-clean trail there is
     no fleet data at all — the view renders the transport's honest state
     and a fix-it hint instead of bot cards. */
  if (!fleet || !trails) {
    return (
      <div className="animate-fade-up space-y-5">
        <SectionHead title="Salvor Fleet" />
        <FleetBanner
          transport={fleet}
          latestTransport={latestTransport}
          cachedAtUnixMs={cachedAtUnixMs}
          latestFailure={latestFailure}
          loading={loading}
          error={error}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
        <Card className="glass-panel border-white/8 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No fleet trail is being served — fleet data is withheld (fail-closed).
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            Configure GY_FLEET_STATE_PATH — the salvor fleet&apos;s FLEET_STATE_DIR
            (mounted volume, self-hosted deploys). See docs/fleet-ingestion.md, then use
            Refresh. The console never substitutes simulated bots for the real fleet.
          </p>
        </Card>
      </div>
    );
  }

  const newestAge = fleet.ageMs;
  const events = trails.events;
  const alerts = trails.alerts;
  const visibleEvents = events.slice(-12);

  return (
    <div className="animate-fade-up space-y-5">
      <SectionHead title="Salvor Fleet" />

      {/* Data provenance banner — REAL fleet trails, four artifact states
          plus the cached holding state, freshness re-evaluated against the
          wall clock, manual refresh only. */}
      <FleetBanner
        transport={fleet}
        latestTransport={latestTransport}
        cachedAtUnixMs={cachedAtUnixMs}
        latestFailure={latestFailure}
        loading={loading}
        error={error}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      {/* Observer card — only trail-derived numbers. */}
      <Card className="glass-panel border-white/8 glow-violet">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-black">
                <Eye className="h-5 w-5 text-slate-200" />
              </span>
              <div>
                <CardTitle className="font-display text-base font-bold">
                  Observer trail — Monitor / Risk
                </CardTitle>
                <p className="font-mono text-[10.5px] text-slate-500">
                  fleet-ops · monitor-events.jsonl + alerts.jsonl
                </p>
              </div>
            </div>
            <ToneBadge tone="brand" dot>
              ingested state dir
            </ToneBadge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat label="Trail events" value={events.length.toLocaleString()} />
            <MiniStat label="Alerts on file" value={alerts.length.toLocaleString()} />
            <MiniStat
              label="Newest line"
              value={fleet.newestTsMs !== null ? `${fmtClockMs(fleet.newestTsMs)} UTC` : "none yet"}
            />
            <MiniStat
              label="Trail age"
              value={
                newestAge !== null
                  ? fmtDuration(newestAge)
                  : "no events yet"
              }
            />
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Every number above is counted from the ingested trail lines — nothing is
            estimated, extrapolated, or carried over from a fixture. The freshness
            budget ({fmtDuration(fleet.maxAgeMs)}) is console-side; the fleet stamps
            no freshness header of its own.
          </p>
        </CardContent>
      </Card>

      {/* Alert log — the fleet-ops alert trail, verbatim. */}
      <Card className="glass-panel border-white/8">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-300" />
            <CardTitle className="font-display text-sm font-bold">Alert trail</CardTitle>
            {alerts.length === 0 && (
              <ToneBadge tone="muted">
                {loading ? "…" : "zero alerts on file — a legal empty state (fleet-ops creates alerts.jsonl on the first alert)"}
              </ToneBadge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-slate-500">
              No alert has ever been raised in the ingested trail. Shown as zero —
              never as “all clear”, which the console cannot verify.
            </p>
          ) : (
            <div className="space-y-1.5">
              {alerts.slice(-6).reverse().map((a, i) => (
                <AlertRow key={`${a.atMs}-${a.code}-${i}`} alert={a} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Event trail — the Monitor's FleetEvent log, verbatim types. */}
      <Card className="glass-panel border-white/8">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <BotIcon className="h-4 w-4 text-cyan-300" />
            <CardTitle className="font-display text-sm font-bold">
              Event trail (JSONL · newest {visibleEvents.length} of {events.length.toLocaleString()})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-slate-500">
              The monitor trail is contract-clean but has zero lines — fleet-ops
              created it at process start and has emitted nothing yet. Zero is the
              trail&apos;s honest content.
            </p>
          ) : (
            <div className="space-y-1.5">
              {visibleEvents.map((e, i) => (
                <EventRow key={`${e.tsMs}-${i}`} event={e} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Documented fleet identity — reference, not telemetry. Numbers are
          counted from the trail only; a bot with zero trail events is the
          documented default (scout reports to SCOUT_REPORT_FILE upstream;
          executors emit only when operator-enabled). */}
      <div>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-slate-600">
          Documented fleet identity (salvor-bots README) — per-bot numbers are trail counts, not status
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {FLEET_IDENTITY.map((bot) => {
            const botEvents = events.filter((e) => e.botId === bot.id);
            const lastTs = botEvents.length > 0 ? botEvents[botEvents.length - 1].tsMs : null;
            return (
              <Card
                key={bot.id}
                className={cn(
                  "glass-panel border-white/8 transition-shadow",
                  "mx-auto w-full max-w-[28rem] md:max-w-none",
                  bot.id === "monitor" && "glow-violet",
                )}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-black">
                        <BotIcon className="h-5 w-5 text-slate-200" />
                      </span>
                      <div>
                        <CardTitle className="font-display text-base font-bold">{bot.name}</CardTitle>
                        <p className="font-mono text-[10.5px] text-slate-500">{bot.pkg}</p>
                      </div>
                    </div>
                    <ToneBadge tone="muted">reference</ToneBadge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3.5">
                  <p className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500">
                    {bot.role}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <MiniStat label="Trail events (botId)" value={botEvents.length.toLocaleString()} />
                    <MiniStat
                      label="Last trail event"
                      value={lastTs !== null ? `${fmtClockMs(lastTs)} UTC` : "— none in trail"}
                    />
                  </div>
                  <p className="text-[11px] leading-relaxed text-slate-500">{bot.description}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
          Attribution note: the ingested state dir carries the Monitor&apos;s trail
          (fleet-ops) plus any operator-enabled executor trails. The Scout&apos;s own
          report file (SCOUT_REPORT_FILE) is a separate upstream sink and is not part
          of this ingestion — an empty Scout card reports exactly that, not a guess.
        </p>
      </div>
    </div>
  );
}

/* ── Event row — verbatim trail fields ─────────────────────────── */
function EventRow({ event }: { event: FleetTrailEvent }) {
  const warn = event.failureClass !== undefined || event.type === "error" || event.type === "monitor-anomaly" || event.type === "monitor-mismatch";
  return (
    <div className="flex items-start gap-2 text-[11.5px] leading-snug">
      <span className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-slate-600">
        {fmtClockMs(event.tsMs)}
      </span>
      <span className="mt-0.5 shrink-0 font-mono text-[9px] font-semibold uppercase text-slate-500">
        {event.botId}
      </span>
      <span
        className={cn(
          "mt-0.5 shrink-0 font-mono text-[9px] font-semibold uppercase",
          warn ? "text-amber-300" : "text-cyan-300",
        )}
        title={event.failureClass ? `failureClass: ${event.failureClass}` : undefined}
      >
        {event.type}
      </span>
      <span className={cn("min-w-0 flex-1 truncate font-mono text-[10.5px]", warn ? "text-amber-200/80" : "text-slate-400")}>
        {event.pool
          ? `pool ${event.pool}`
          : event.identityKey
            ? event.identityKey
            : event.data
              ? JSON.stringify(event.data).slice(0, 120)
              : ""}
      </span>
    </div>
  );
}

/* ── Alert row — verbatim trail fields ─────────────────────────── */
function AlertRow({ alert }: { alert: FleetAlert }) {
  return (
    <div className="flex items-start gap-2 text-[11.5px] leading-snug">
      <span className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-slate-600">
        {fmtClockMs(alert.atMs)}
      </span>
      <ToneBadge tone={SEVERITY_TONE[alert.severity]}>{alert.severity}</ToneBadge>
      <span className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold text-slate-300">
        {alert.code}
      </span>
      <span className={cn("min-w-0 flex-1", alert.severity === "info" ? "text-slate-400" : "text-amber-200/80")}>
        {alert.message}
        {alert.suppressed && <span className="ml-1 text-slate-600">(suppressed-repeat)</span>}
      </span>
    </div>
  );
}

/* ── Provenance banner (mirrors the Graveyard's TransportBanner) ── */
function FleetBanner({
  transport,
  latestTransport,
  cachedAtUnixMs,
  latestFailure,
  loading,
  error,
  refreshing,
  onRefresh,
}: {
  transport: FleetTransportPayload | null;
  latestTransport: FleetTransportPayload | null;
  cachedAtUnixMs: number | null;
  latestFailure: string | null;
  loading: boolean;
  error: "unreachable" | "malformed" | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const cached = transport !== null && cachedAtUnixMs !== null;
  const state = loading
    ? { tone: "muted" as const, label: "checking fleet state…" }
    : cached
      ? transport.artifactState === "stale"
        ? { tone: "warn" as const, label: "fleet cached (stale)" }
        : { tone: "info" as const, label: "fleet cached" }
      : error === "unreachable"
        ? { tone: "bad" as const, label: "fleet transport unreachable" }
        : error === "malformed"
          ? { tone: "bad" as const, label: "transport payload rejected" }
          : transport === null
            ? latestTransport === null
              ? { tone: "muted" as const, label: "checking fleet state…" }
              : latestTransport.artifactState === "missing"
                ? { tone: "warn" as const, label: "fleet unavailable" }
                : { tone: "bad" as const, label: "fleet corrupt" }
            : transport.artifactState === "valid"
              ? { tone: "ok" as const, label: "fleet trail fresh" }
              : transport.artifactState === "stale"
                ? { tone: "warn" as const, label: "fleet trail stale" }
                : transport.artifactState === "missing"
                  ? { tone: "warn" as const, label: "fleet unavailable" }
                  : { tone: "bad" as const, label: "fleet corrupt" };

  const checkedAt =
    transport === null ? null : (
      <>checked {fmtUtcClock(new Date(transport.checkedAtUnixMs))} UTC</>
    );
  const lastGoodCheckedAt =
    cachedAtUnixMs === null ? null : fmtUtcClock(new Date(cachedAtUnixMs));

  let detail: React.ReactNode = null;
  if (!loading && cached && transport !== null) {
    // D5 — cached holding state: the trail on screen is from a previous
    // successful check and the latest check failed. Its own freshness
    // verdict (fresh vs stale) is still stated explicitly.
    detail = (
      <span>
        <span className="font-semibold text-cyan-200">Held from the last good check</span> — fetched{" "}
        {lastGoodCheckedAt ?? "unknown"} UTC · trail{" "}
        {transport.artifactState === "stale"
          ? `stale (newest line ${
              transport.ageMs !== null ? fmtDuration(transport.ageMs) : "unknown"
            } ago exceeds the ${
              transport.maxAgeMs !== null ? fmtDuration(transport.maxAgeMs) : "30m"
            } budget — never presented as fresh)`
          : `still inside its ${
              transport.maxAgeMs !== null ? fmtDuration(transport.maxAgeMs) : "30m"
            } freshness budget, but not reconfirmed`}
        {latestFailure !== null && (
          <>
            {" "}
            · <span className="text-amber-200">latest check failed: {latestFailure}</span>
          </>
        )}
        {" "}· Retry with Refresh.
      </span>
    );
  } else if (!loading && error === null && transport !== null) {
    if (transport.artifactState === "valid") {
      detail = (
        <span>
          <span className="font-semibold text-slate-200">Real fleet-ops trails</span> —{" "}
          {transport.fleet !== null
            ? `${transport.fleet.counts.eventLines.toLocaleString()} events · ${transport.fleet.counts.alertLines.toLocaleString()} alerts`
            : "no trail"}
          {transport.newestTsMs !== null && (
            <> · newest line {fmtClockMs(transport.newestTsMs)} UTC</>
          )}
          {transport.newestTsMs === null && (
            <> · zero lines yet — no events are invented for an empty trail</>
          )}
          {checkedAt !== null && (
            <>
              {" "}· {checkedAt}
            </>
          )}
        </span>
      );
    } else if (transport.artifactState === "stale") {
      detail = (
        <span>
          <span className="font-semibold text-amber-200">Real but stale</span> — trail age{" "}
          {transport.ageMs !== null ? fmtDuration(transport.ageMs) : "unknown"} since its newest
          line exceeds the{" "}
          {transport.maxAgeMs !== null ? fmtDuration(transport.maxAgeMs) : "30m"} freshness budget.
          Figures remain labeled stale — never presented as fresh.
          {checkedAt !== null && (
            <>
              {" "}· {checkedAt}
            </>
          )}
        </span>
      );
    } else {
      // missing | corrupt — the route's reason is the diagnostic surface.
      detail = (
        <span>
          {transport.reason ?? "No fleet trail available."}
          {checkedAt !== null && (
            <>
              {" "}· {checkedAt}
            </>
          )}
          {" "}·{" "}
          <span className="text-slate-500">
            source: {transport.source.kind === "none" ? "none configured" : `${transport.source.kind} ${transport.source.uri ?? ""}`}
          </span>
        </span>
      );
    }
  } else if (error === "unreachable") {
    detail = <span>The console could not reach /api/gy/fleet — the fleet transport itself is down. Retry with Refresh.</span>;
  } else if (error === "malformed") {
    detail = <span>The transport payload failed client-side re-validation (fail-closed) — treated as unavailable. Retry with Refresh.</span>;
  } else if (transport === null && latestTransport !== null) {
    // No trail is on screen — the latest raw check's reason is the
    // diagnostic surface (missing | corrupt).
    detail = (
      <span>
        {latestTransport.reason ?? "No fleet trail available."}
        {" "}· checked {fmtUtcClock(new Date(latestTransport.checkedAtUnixMs))} UTC
        {" "}·{" "}
        <span className="text-slate-500">
          source: {latestTransport.source.kind === "none" ? "none configured" : `${latestTransport.source.kind} ${latestTransport.source.uri ?? ""}`}
        </span>
      </span>
    );
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
        aria-label="Manually refresh fleet state"
      >
        <RefreshCw className={`h-3.5 w-3.5${refreshing ? " animate-spin" : ""}`} />
        Refresh
      </Button>
      <span className="text-[10.5px] text-slate-600">manual — no auto-polling</span>
    </div>
  );
}
