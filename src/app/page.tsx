"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Shell, type ViewId } from "@/components/gy/shell";
import { Overview } from "@/components/gy/overview";
import { Graveyard } from "@/components/gy/graveyard";
import { Fleet } from "@/components/gy/fleet";
import { Claims } from "@/components/gy/claims";
import { Protocol } from "@/components/gy/protocol";
import {
  BOTS,
  EVENT_GENERATOR,
  INITIAL_EVENTS,
  resolvePools,
} from "@/lib/gy/data";
import { SNAPSHOT, snapshotPools } from "@/lib/gy/snapshot";
import type { BotEvent, Pool } from "@/lib/gy/types";
import { fmtUtcClock } from "@/lib/gy/format";

export default function GraveYieldConsole() {
  const [view, setView] = useState<ViewId>("overview");
  const [pools, setPools] = useState<Pool[]>(() => resolvePools());
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);
  const [events, setEvents] = useState<BotEvent[]>(INITIAL_EVENTS);
  const nextId = useRef(INITIAL_EVENTS.length + 1);

  /* Resolve client-relative timestamps (hydration-safe: values are
     stable within a render day; countdowns render post-mount only). */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPools(resolvePools()));
    return () => cancelAnimationFrame(raf);
  }, []);

  /* Graveyard runs on the REAL indexer snapshot (P3-A) — provenance-backed,
     fail-closed at module load. Static artifact → hydration-safe. */
  const graveyardPools = useMemo(() => snapshotPools(SNAPSHOT), []);

  /* Streaming fleet feed — the Scout bridge feeding the Monitor. */
  useEffect(() => {
    const t = setInterval(() => {
      const pick = EVENT_GENERATOR[Math.floor(Math.random() * EVENT_GENERATOR.length)];
      const ev: BotEvent = {
        ...pick,
        id: nextId.current++,
        ts: fmtUtcClock(new Date()),
      };
      setEvents((prev) => [...prev.slice(-40), ev]);
    }, 4500);
    return () => clearInterval(t);
  }, []);

  const bots = useMemo(
    () =>
      BOTS.map((b) => ({
        ...b,
        events: events.filter((e) => e.bot === b.id).slice(-4),
      })),
    [events],
  );

  const selected = selectedAddr
    ? (graveyardPools.find((p) => p.address === selectedAddr) ?? null)
    : null;

  return (
    <Shell active={view} onSelect={(v) => setView(v)}>
      {view === "overview" && <Overview pools={pools} events={events} />}
      {view === "graveyard" && (
        <Graveyard pools={graveyardPools} selected={selected} onSelect={(p) => setSelectedAddr(p?.address ?? null)} />
      )}
      {view === "fleet" && <Fleet bots={bots} />}
      {view === "claims" && <Claims />}
      {view === "protocol" && <Protocol />}
    </Shell>
  );
}
