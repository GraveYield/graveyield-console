// Console formatters — lamports never ride floats in storage; display
// conversion happens only here, at the last moment.

export function fmtSol(lamports: bigint, maxFrac = 4): string {
  const sol = Number(lamports) / 1e9;
  return sol.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function fmtNum(n: number, maxFrac = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function shortAddr(a: string, head = 4, tail = 4): string {
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function fmtDays(days: number): string {
  if (days >= 365) {
    const y = Math.floor(days / 365);
    const d = days % 365;
    return d > 0 ? `${y}y ${d}d` : `${y}y`;
  }
  return `${days}d`;
}

/**
 * Graveyard table "Idle" cell. `lastSwapUnix` is unix SECONDS per the Pool
 * contract (snapshot loader stores seconds; criteriaOf normalizes ×1000).
 * A value ≤ 0 means "not derivable" — the indexer recorded an activity
 * failure for this pool — and must render as explicitly unavailable,
 * never as a day count. (Regression: the table used to subtract seconds
 * from Date.now() and rendered ~20,7xx fabricated days for unavailable
 * pools, and a ~53× inflated count for real ones.)
 */
export function formatIdleDaysCell(lastSwapUnix: number, nowMs: number): string {
  if (!Number.isFinite(lastSwapUnix) || lastSwapUnix <= 0) return "unavailable";
  const days = Math.floor((nowMs - lastSwapUnix * 1000) / 86_400_000);
  return `${Math.max(0, days)}d`;
}

/**
 * Graveyard table "Collapse" cell. Snapshot-derived rows carry C2 as
 * pending upstream (collapseBps is a 0 placeholder there), and a pending
 * evaluation must never render as a fabricated 0.0%. (Regression guard
 * for the same table cell.)
 */
export function formatCollapseCell(collapseBps: number, pending: boolean): string {
  if (pending) return "—";
  return `${(collapseBps / 100).toFixed(1)}%`;
}

export function fmtUtcClock(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export const POOL_STATE_META: Record<
  string,
  { label: string; tone: "ok" | "info" | "warn" | "bad" | "muted" | "brand" }
> = {
  discovered: { label: "Discovered", tone: "info" },
  "filtered-out": { label: "Filtered out", tone: "muted" },
  "evaluated-ineligible": { label: "Ineligible", tone: "bad" },
  "waiting-epochs": { label: "Waiting epochs", tone: "info" },
  "certification-ready": { label: "Certification ready", tone: "warn" },
  certified: { label: "Certified — window open", tone: "ok" },
  salvaged: { label: "Settled", tone: "brand" },
};
