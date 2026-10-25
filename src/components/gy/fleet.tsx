"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot as BotIcon, Eye, ShieldAlert, Telescope, Crosshair, FlaskConical } from "lucide-react";
import { MiniStat, SectionHead, ToneBadge } from "./widgets";
import type { Bot, BotEvent } from "@/lib/gy/types";
import { cn } from "@/lib/utils";

const BOT_ICON: Record<string, React.ElementType> = {
  scout: Telescope,
  conservative: ShieldAlert,
  sniper: Crosshair,
  experimental: FlaskConical,
  monitor: Eye,
};

const MODE_TONE = {
  "dry-run": "info",
  live: "ok",
  "read-only": "brand",
} as const;

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

export function Fleet({ bots }: { bots: Bot[] }) {
  return (
    <div className="animate-fade-up space-y-5">
      <SectionHead title="Salvor Fleet" />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {bots.map((bot) => {
          const Icon = BOT_ICON[bot.id] ?? BotIcon;
          return (
            <Card
              key={bot.id}
              className={cn(
                "glass-panel border-white/8 transition-shadow",
                /* mobile: each card is a centered block, not edge-to-edge */
                "mx-auto w-full max-w-[28rem] md:max-w-none",
                bot.id === "scout" && "glow-cyan",
                bot.id === "monitor" && "glow-violet",
              )}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-black">
                      <Icon className="h-5 w-5 text-slate-200" />
                    </span>
                    <div>
                      <CardTitle className="font-display text-base font-bold">{bot.name}</CardTitle>
                      <p className="font-mono text-[10.5px] text-slate-500">{bot.pkg}</p>
                    </div>
                  </div>
                  <ToneBadge tone={MODE_TONE[bot.mode]} dot={bot.mode === "read-only"}>
                    {bot.mode}
                  </ToneBadge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3.5">
                <p className="font-mono text-[10.5px] uppercase tracking-wider text-slate-500">
                  {bot.role}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {bot.stats.map((s) => (
                    <MiniStat key={s.label} label={s.label} value={s.value} />
                  ))}
                </div>
                <div className="space-y-1 border-t border-white/8 pt-3">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                    Event trail (JSONL)
                  </p>
                  {bot.events.slice(-3).map((e) => (
                    <div key={e.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
                      <span className="mt-0.5 font-mono text-[10px] tabular-nums text-slate-600">
                        {e.ts}
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 font-mono text-[9px] font-semibold uppercase",
                          KIND_STYLE[e.kind],
                        )}
                      >
                        {e.kind}
                      </span>
                      <span
                        className={cn(
                          "flex-1",
                          e.level === "warn" ? "text-amber-200/80" : "text-slate-400",
                        )}
                      >
                        {e.text}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}

      </div>
    </div>
  );
}
