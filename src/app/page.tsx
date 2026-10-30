"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { snapshotPools, type ConsoleSnapshot } from "@/lib/gy/snapshotContract";
import { hydrateTransportPayload, type SnapshotTransportPayload } from "@/lib/gy/snapshotTransport";
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

  /* P4.1 Step 1 — the Graveyard reads /api/gy/snapshot. Manual refresh
     only: an initial fetch on mount plus the view's explicit Refresh
     button. There is NO polling — the console never implies automatic
     real-time ingestion. The payload is re-validated client-side through
     the same fail-closed parser the server used (hydrateTransportPayload);
     anything that fails is rendered as unavailable, never as data. */
  const [transport, setTransport] = useState<SnapshotTransportPayload | null>(null);
  const [transportLoading, setTransportLoading] = useState(true);
  const [transportError, setTransportError] = useState<"unreachable" | "malformed" | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setRefreshing(true);
    setTransportError(null);
    try {
      const res = await fetch("/api/gy/snapshot", { cache: "no-store" });
      const json: unknown = await res.json();
      const payload = hydrateTransportPayload(json, Date.now());
      setTransport(payload);
      setTransportError(payload === null ? "malformed" : null);
    } catch {
      setTransport(null);
      setTransportError("unreachable");
    } finally {
      setTransportLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const graveyardSnapshot: ConsoleSnapshot | null =
    transport !== null && (transport.artifactState === "valid" || transport.artifactState === "stale")
      ? transport.snapshot
      : null;

  const graveyardPools = useMemo(
    () => (graveyardSnapshot ? snapshotPools(graveyardSnapshot) : []),
    [graveyardSnapshot],
  );

  /* Streaming fleet feed — the Scout bridge feeding the Monitor.
     (Simulated fixture feed for the Overview/Fleet views — unrelated to
     the snapshot transport, which never auto-polls.) */
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
        <Graveyard
          pools={graveyardPools}
          snapshot={graveyardSnapshot}
          transport={transport}
          transportLoading={transportLoading}
          transportError={transportError}
          refreshing={refreshing}
          onRefresh={() => void loadSnapshot()}
          selected={selected}
          onSelect={(p) => setSelectedAddr(p?.address ?? null)}
        />
      )}
      {view === "fleet" && <Fleet bots={bots} />}
      {view === "claims" && <Claims />}
      {view === "protocol" && <Protocol />}
    </Shell>
  );
}
