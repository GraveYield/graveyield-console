"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "@/lib/gy/types";

/* ── Hydration-safe ticking clock ──────────────────────────────── */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // rAF defers the first sample out of the effect body — no cascading
    // synchronous render — and keeps countdowns hydration-safe (null → "—").
    const update = () => setNow(Date.now());
    const raf = requestAnimationFrame(update);
    const t = setInterval(update, intervalMs);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}

/* ── Tone system (skill palette: emerald/cyan/violet/amber/crimson) ── */
export type Tone = "ok" | "info" | "warn" | "bad" | "muted" | "brand";

const TONE_CHIP: Record<Tone, string> = {
  ok: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
  info: "bg-cyan-500/12 text-cyan-300 border-cyan-500/30",
  warn: "bg-amber-500/12 text-amber-300 border-amber-500/30",
  bad: "bg-red-500/12 text-red-300 border-red-500/30",
  muted: "bg-white/5 text-slate-400 border-white/10",
  brand: "bg-violet-500/15 text-violet-300 border-violet-500/30",
};

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-400",
  info: "bg-cyan-400",
  warn: "bg-amber-400",
  bad: "bg-red-400",
  muted: "bg-slate-500",
  brand: "bg-violet-400",
};

export function ToneBadge({
  tone,
  children,
  dot,
  className,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
  /* full-disclosure tooltip (used by the short header badge) */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        TONE_CHIP[tone],
        className,
      )}
    >
      {dot && <i className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} />}
      {children}
    </span>
  );
}

/* ── KPI card ──────────────────────────────────────────────────── */
export function KpiCard({
  label,
  value,
  sub,
  accent = "emerald",
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: "emerald" | "cyan" | "violet" | "amber";
  className?: string;
}) {
  const glow =
    accent === "emerald"
      ? "glow-emerald"
      : accent === "cyan"
        ? "glow-cyan"
        : accent === "violet"
          ? "glow-violet"
          : "glow-amber";
  return (
    <div
      data-testid={`kpi-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      className={cn(
        "glass-panel relative overflow-hidden rounded-xl p-4 sm:p-5",
        glow,
        className,
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="font-mono mt-2 text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
        {value}
      </p>
      {sub && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}

/* ── Section header ────────────────────────────────────────────── */
export function SectionHead({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <h2 className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl">
        {title}
      </h2>
      {right}
    </div>
  );
}

/* ── Six-criteria chips (compact row) ──────────────────────────── */
const CRIT_TONE = {
  pass: "ok",
  fail: "bad",
  pending: "muted",
} as const;

export function CriteriaChips({ criteria }: { criteria: Criterion[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="six derelict-pool criteria">
      {criteria.map((c) => (
        <span
          key={c.id}
          title={`${c.name}: ${c.value} (${c.state})`}
          className={cn(
            "inline-flex h-5 items-center rounded border px-1.5 font-mono text-[10px] font-semibold",
            c.state === "pass" && "border-emerald-500/30 bg-emerald-500/12 text-emerald-300",
            c.state === "fail" && "border-red-500/30 bg-red-500/12 text-red-300",
            c.state === "pending" && "border-white/10 bg-white/5 text-slate-400",
          )}
        >
          {c.id}
        </span>
      ))}
    </div>
  );
}

export function criterionTone(state: Criterion["state"]): Tone {
  return CRIT_TONE[state];
}

/* ── 40 / 40 / ≤20 split bar ───────────────────────────────────── */
export function SplitBar({ compact }: { compact?: boolean }) {
  const segs = [
    { w: 40, label: "40%", who: "LP holders", cls: "bg-emerald-500/80" },
    { w: 40, label: "40%", who: "Salvor", cls: "bg-cyan-500/80" },
    { w: 20, label: "≤20%", who: "Protocol", cls: "bg-violet-500/70" },
  ];
  return (
    <div>
      <div className={cn("flex w-full overflow-hidden rounded-lg", compact ? "h-2" : "h-3.5")}>
        {segs.map((s) => (
          <div key={s.who} style={{ width: `${s.w}%` }} className={s.cls} title={`${s.who} — ${s.label}`} />
        ))}
      </div>
      {!compact && (
        <div className="mt-2.5 grid grid-cols-[2fr_2fr_1fr] gap-2">
          {segs.map((s) => (
            <div key={s.who} className="min-w-0 text-center">
              <div className="flex items-center justify-center gap-1.5">
                <i className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.cls)} />
                <span className="font-mono text-xs font-semibold text-foreground">{s.label}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{s.who}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Copy-to-clipboard chip (skill: copy-to-clipboard badges) ──── */
export function CopyChip({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* clipboard unavailable — non-fatal */
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] text-slate-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
      aria-label={label ?? `Copy ${text}`}
    >
      {/* min-w-0 lets the ID shrink + ellipsize inside flex; copy still uses full text */}
      <span className="min-w-0 truncate">{text}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

/* ── Stat row for bot cards ────────────────────────────────────── */
export function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-2">
      <p className="truncate font-mono text-sm font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
