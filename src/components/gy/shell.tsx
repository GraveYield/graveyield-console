"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { WalletName } from "@solana/wallet-adapter-base";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  LayoutDashboard,
  Landmark,
  Loader2,
  Bot,
  HandCoins,
  FileLock2,
  LogOut,
  Wallet,
} from "lucide-react";
import { ToneBadge } from "./widgets";
import { fetchEpochTelemetry, type EpochTelemetry } from "@/lib/gy/protocolLive";

export type ViewId = "overview" | "graveyard" | "fleet" | "claims" | "protocol";

export const NAV: { id: ViewId; label: string; icon: React.ElementType; hint: string }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, hint: "Protocol pulse" },
  { id: "graveyard", label: "Graveyard", icon: Landmark, hint: "Derelict pool explorer" },
  { id: "fleet", label: "Salvor Fleet", icon: Bot, hint: "Live fleet-state ingest" },
  { id: "claims", label: "LP Claims", icon: HandCoins, hint: "Merkle-verified claims" },
  { id: "protocol", label: "Protocol", icon: FileLock2, hint: "Invariants · config · errors" },
];

function NavList({
  active,
  onSelect,
}: {
  active: ViewId;
  onSelect: (v: ViewId) => void;
}) {
  return (
    <nav aria-label="Console sections" className="flex flex-col gap-1">
      {NAV.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-left transition-all",
              isActive
                ? "border border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
                : "border border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200",
            )}
          >
            <Icon
              className={cn(
                "h-4 w-4 shrink-0 transition-colors",
                isActive ? "text-emerald-400" : "text-slate-500 group-hover:text-slate-300",
              )}
            />
            <span className="flex-1">
              <span className="block text-sm font-semibold leading-tight">{item.label}</span>
              <span className="block text-[10.5px] leading-tight text-muted-foreground">
                {item.hint}
              </span>
            </span>
            {isActive && <i className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />}
          </button>
        );
      })}
    </nav>
  );
}

/* ── Wallet connect (real adapter stack, custom flat UI) ─────────── */
const INSTALL_SUGGESTIONS = [
  { name: "Phantom", url: "https://phantom.app/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/downloads" },
];

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function WalletButton() {
  const { wallets, wallet, select, connect, disconnect, connecting, connected, publicKey } =
    useWallet();
  const { connection } = useConnection();
  const [open, setOpen] = useState(false);
  const [bal, setBal] = useState<{ key: string; value: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const address = publicKey?.toBase58() ?? null;
  /* derived: only fresh for the currently-connected key — auto-stales on switch */
  const balance = address && bal?.key === address ? bal.value : null;

  /* close on outside pointer / Escape */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* devnet SOL balance for the connected wallet (graceful on RPC failure) */
  useEffect(() => {
    if (!publicKey) return;
    let alive = true;
    connection
      .getBalance(publicKey)
      .then((b) => {
        if (alive) setBal({ key: publicKey.toBase58(), value: b });
      })
      .catch(() => {
        /* leave staled → balance renders "—" */
      });
    return () => {
      alive = false;
    };
  }, [publicKey, connection]);

  const detected = wallets.filter((w) => w.readyState !== WalletReadyState.NotDetected);

  const onPick = (name: WalletName) => {
    setOpen(false);
    if (wallet?.adapter.name === name) {
      connect().catch(() => {
        /* user rejected — stays disconnected; button remains "Connect wallet" */
      });
    } else {
      /* selecting a wallet triggers the provider's autoConnect */
      select(name);
    }
  };

  const onCopy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      /* clipboard unavailable — non-fatal */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={connected ? "Wallet menu" : "Connect wallet"}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
          connected
            ? "border-white/10 bg-white/5 font-mono text-slate-200 hover:bg-white/10"
            : "border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25",
        )}
      >
        {connected && address ? (
          <>
            <i className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
            {shortAddr(address)}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </>
        ) : connecting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            <Wallet className="h-3.5 w-3.5" />
            Connect wallet
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="glass-panel absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 rounded-xl p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]"
        >
          {connected && address ? (
            <div className="p-1">
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 font-mono text-[11px] break-all text-slate-200">
                    {address}
                  </span>
                  <button
                    type="button"
                    onClick={onCopy}
                    aria-label="Copy address"
                    className="shrink-0 text-slate-500 transition-colors hover:text-emerald-300"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <p className="mt-1 font-mono text-[11px] tabular-nums text-slate-500">
                  {balance === null ? "—" : (balance / 1e9).toFixed(4)} SOL · devnet
                </p>
              </div>
              <a
                role="menuitem"
                href={`https://explorer.solana.com/address/${address}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-slate-300 transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5 text-slate-500" />
                View on explorer
              </a>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  disconnect().catch(() => {});
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-slate-300 transition-colors hover:bg-red-500/10 hover:text-red-300"
              >
                <LogOut className="h-3.5 w-3.5 text-slate-500" />
                Disconnect
              </button>
            </div>
          ) : (
            <div className="p-1">
              <p className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                {detected.length ? "Detected wallets" : "No wallet detected"}
              </p>
              {detected.map((w) => (
                <button
                  key={w.adapter.name}
                  type="button"
                  role="menuitem"
                  onClick={() => onPick(w.adapter.name)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-slate-200 transition-colors hover:bg-white/5"
                >
                  {w.adapter.icon && (
                    /* adapter-provided data-URI icon */
                    <img src={w.adapter.icon} alt="" className="h-5 w-5 rounded" />
                  )}
                  <span className="flex-1 truncate">{w.adapter.name}</span>
                  {wallet?.adapter.name === w.adapter.name && (
                    <span className="font-mono text-[10px] text-emerald-300">selected</span>
                  )}
                </button>
              ))}
              {detected.length === 0 && (
                <p className="px-2 py-1.5 text-[11.5px] leading-relaxed text-slate-500">
                  Install a Solana wallet extension, then reload the page.
                </p>
              )}
              <p className="px-2 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                Popular wallets
              </p>
              {INSTALL_SUGGESTIONS.map((s) => (
                <a
                  key={s.name}
                  role="menuitem"
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
                >
                  <Wallet className="h-3.5 w-3.5 text-slate-600" />
                  <span className="flex-1">{s.name}</span>
                  <ArrowUpRight className="h-3 w-3 text-slate-600" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TopBar() {
  /* P4.2 (audit D6) — live epoch telemetry: one read-only getEpochInfo per
     mount against the configured devnet RPC. No polling, and no fabricated
     constant: an unreachable RPC renders "—" (unavailable), never a stale
     epoch number. */
  const [epoch, setEpoch] = useState<EpochTelemetry | null>(null);
  const [epochState, setEpochState] = useState<"checking" | "live" | "unavailable">("checking");
  useEffect(() => {
    let alive = true;
    fetchEpochTelemetry()
      .then((e) => {
        if (alive) {
          setEpoch(e);
          setEpochState("live");
        }
      })
      .catch(() => {
        if (alive) setEpochState("unavailable");
      });
    return () => {
      alive = false;
    };
  }, []);
  const pct =
    epochState === "live" && epoch !== null
      ? Math.min(100, Math.max(0, Math.round(epoch.progress * 100)))
      : null;
  return (
    <header className="sticky top-0 z-30 border-b border-white/8 bg-[#161616]/85 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        {/* mobile brand */}
        <div className="flex items-center gap-2 lg:hidden">
          <BrandMark />
        </div>
        {/* desktop: epoch telemetry — live from the devnet RPC (P4.2 D6) */}
        <div className="hidden min-w-0 flex-1 items-center gap-4 lg:flex">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              Epoch
            </span>
            <span
              className="font-mono text-sm font-semibold text-foreground"
              title={
                epochState === "live"
                  ? `live getEpochInfo from ${epoch?.rpcHost} (read-only; fetched once per load)`
                  : epochState === "unavailable"
                    ? "epoch lookup unavailable — the RPC did not answer; no value is fabricated"
                    : "checking the RPC…"
              }
            >
              {epochState === "live" && epoch !== null ? (
                epoch.epoch
              ) : epochState === "unavailable" ? (
                <span className="text-slate-500">—</span>
              ) : (
                <span className="text-slate-600">…</span>
              )}
            </span>
            <div className="relative h-1.5 w-40 overflow-hidden rounded-full bg-white/8">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400"
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              {pct !== null ? `${pct}%` : epochState === "unavailable" ? "unavailable" : "…"}
            </span>
          </div>
          <div className="hidden items-center gap-2 xl:flex">
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              Cluster
            </span>
            <ToneBadge tone="brand" dot>
              Solana devnet
            </ToneBadge>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <ToneBadge
            tone="warn"
            className="hidden sm:inline-flex"
          >
            Mixed data — per-view labels: Graveyard real (snapshot), epoch live (RPC), fleet ingested or withheld (FLEET_STATE_DIR), claims/overview simulated
          </ToneBadge>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black">
        {/* Official GraveYield mark — white cut on transparent, subtle cyan underglow */}
        <Image
          src="/gy-mark-white.png"
          alt=""
          aria-hidden="true"
          width={512}
          height={478}
          priority
          className="h-4 w-auto drop-shadow-[0_0_10px_rgba(0,242,254,0.35)]"
        />
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="font-display block text-sm font-bold tracking-tight text-foreground">
            GraveYield
          </span>
          <span className="block font-mono text-[9.5px] uppercase tracking-[0.18em] text-slate-500">
            Salvage console
          </span>
        </span>
      )}
    </div>
  );
}

export function Shell({
  active,
  onSelect,
  children,
}: {
  active: ViewId;
  onSelect: (v: ViewId) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1440px] flex-1">
        {/* Desktop sidebar */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col border-r border-white/8 bg-[#161616]/60 px-4 py-5 lg:flex">
          <div className="mb-6 hidden items-center px-1 lg:flex">
            <BrandMark />
          </div>
          <NavList active={active} onSelect={onSelect} />
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 px-4 pb-28 pt-5 sm:px-6 lg:pb-10">{children}</main>
          <footer className="mt-auto border-t border-white/8 bg-[#161616]/70 px-4 pt-5 pb-28 sm:px-6 lg:pb-24">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11.5px] text-slate-500">
                Simulated telemetry · not financial advice
              </p>
              <p className="font-mono text-[10.5px] text-slate-600">Apache-2.0</p>
            </div>
          </footer>
        </div>
      </div>

      {/* Mobile bottom dock (skill: thumb-zone navigation) */}
      <nav
        aria-label="Console sections"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#161616]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
      >
        <div className="grid grid-cols-5">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-2 transition-colors",
                  isActive ? "text-emerald-300" : "text-slate-500",
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px] font-semibold leading-none">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
