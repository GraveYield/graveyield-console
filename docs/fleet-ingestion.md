# Fleet ingestion — the Salvor Fleet view's data contract (P4.3)

How the console obtains the salvor fleet's real operational state, and the
guarantees it makes about what it shows. Read this before configuring
`GY_FLEET_STATE_PATH`.

## What the fleet actually writes

`graveyield-fleet` (salvor-bots `@graveyield/fleet-ops`) persists its state
into `FLEET_STATE_DIR` (default `./fleet-state`, env-configurable upstream):

| File | Created | Content |
|---|---|---|
| `monitor-events.jsonl` | at process start (always) | the Monitor's `FleetEvent` trail — one JSON object per line, append-only |
| `alerts.jsonl` | lazily, on the **first alert** | `Alert` objects — one per line, append-only |

Both schemas are transcribed verbatim into `src/lib/gy/fleetContract.ts`
from `fleet-core/src/events.ts` and `fleet-ops/src/alerts.ts`:
`tsMs`/`botId`/`type` (+ optional `identityKey`/`pool`/`state`/
`failureClass`/`data`) for events; `code`/`severity`/`message`/`atMs`/
`context`/`suppressed` for alerts. The parser rejects any vocabulary value
outside the upstream unions — a drifted or fabricated trail cannot render
as fleet truth.

**Attribution note (verified against `fleet-ops/src/cli.ts`):** the trail
carries the Monitor's events (`botId: "fleet-ops"`) plus any
operator-enabled executor events bridged through
`FleetRunner.bridgeFleetEvent`. The **Scout's own trail is a separate
upstream sink** (`SCOUT_REPORT_FILE`, default unset) and is not part of
this ingestion premise. A Scout card showing "none in trail" reports
exactly that fact — not a malfunction, not a guess.

## Console configuration

```
GY_FLEET_STATE_PATH=/var/lib/salvor-bots/fleet-state   # the mounted FLEET_STATE_DIR
GY_FLEET_MAX_AGE_MS=1800000                            # optional; default 30 min
```

- `GY_FLEET_STATE_PATH` must be a **directory** holding the two files
  above. Point it at a read-only mount of the fleet's state dir
  (bind mount / Docker volume).
- There is deliberately **no URL topology** (unlike the snapshot
  transport): no upstream publisher of fleet trails exists today.
  Inventing one would be scope fabrication; if the fleet later grows an
  artifact publisher, the transport gains a second source kind the same
  way the snapshot transport did.
- `GY_FLEET_MAX_AGE_MS` must be a positive integer; anything else is
  rejected (`GY_FLEET_MAX_AGE_MS` falls back to the 30-minute default,
  which is 30× the monitor sweep and 6× the scout cycle cadence — a
  healthy quiet fleet is not flagged, a dead one cannot masquerade as
  current).

The freshness budget is **console-side**: the trail carries no freshness
header of its own. The budget rides in every transport envelope so the
client re-evaluates it against the wall clock on every render (a payload
valid at fetch degrades to stale mid-session; the clock can never upgrade
stale back to valid — same rule as the snapshot transport since P4.2).

## The state machine

`/api/gy/fleet` answers `200` in every state (force-dynamic, `no-store`);
the envelope is the single diagnostic surface:

| artifactState | dataState | Meaning |
|---|---|---|
| `valid` | `real` | both trails parsed, contract-clean, newest line inside the budget. An **empty** monitor trail is also `valid` — "no events yet" is the file's honest content; the console invents no age for it. |
| `stale` | `stale` | parsed and contract-clean, but the newest line (events **or** alerts) is older than the budget. Served, flagged, never presented as fresh. |
| `missing` | `unavailable` | no source configured (`NO_SOURCE_CONFIGURED`), path is not a readable directory, monitor trail absent (`TRAIL_ABSENT` — this is not the fleet's state dir), or I/O failure (`READ_FAILED`). |
| `corrupt` | `unavailable` | bytes arrived but fail the contract: bad JSON (`PARSE_FAILED`, with the offending line number), unknown vocabulary, non-scalar alert context, future-dated trail (`FUTURE_TRAIL_TS`), oversize file (`OVERSIZE`, 8 MiB/file cap). |

Mapping rules pinned by tests: `real ⟺ valid`; `missing`/`corrupt`
never carry a payload; one bad line rejects the whole file (an
append-only trail is the fleet's record — serving a partial record would
be fabrication by omission; a torn tail write is reported as corrupt,
not skipped).

## Client-side double gate

The browser re-validates every `/api/gy/fleet` payload through the same
fail-closed parsers the server used (`hydrateFleetPayload`), re-derives
the newest timestamp from the re-validated lines, and refuses any
envelope whose `dataState` disagrees with `artifactState` or whose
staleness verdict contradicts the payload's own budget. A stale or
invalid trail rendered as fresh fleet data is structurally impossible —
two independent applications of the same contract.

`cached` (D5 semantics): when a manual refresh fails after a good one,
the last good trail stays on screen labeled **cached**, with its own
freshness verdict restated and the latest failure reason shown. One-way
precedence: past-budget still reads `stale`; failed states stay
`unavailable`; `cached` replaces `real` only.

## What the view does and does not show

- Shown: trail-derived counts (events, alerts, newest line, per-botId
  event counts), the latest events and alerts verbatim (timestamps,
  types, severities, failure classes, suppressed flags), and the
  documented five-bot identity (transcribed from the salvor-bots README,
  labeled **reference** — not telemetry).
- Never shown: bot "modes" (dry-run/live/read-only), invented statuses,
  or any counter the trail does not carry. The pre-P4.3 fixture bot
  cards are gone; a regression grep pins that the Fleet view cannot
  import the simulated fixtures again.
- Manual refresh only — the console never auto-polls the fleet's state
  dir, never writes to it, and never implies real-time ingestion.

## Operator runbook

1. Run the fleet somewhere persistent:
   `FLEET_STATE_DIR=/var/lib/salvor-bots/fleet-state graveyield-fleet run`
2. Mount that dir read-only into the console host and set
   `GY_FLEET_STATE_PATH` to it (see `.env.example`).
3. Open the Fleet view → **Refresh**. The banner states the verdict:
   fresh / stale / cached / unavailable / corrupt, with the route's
   reason as the diagnostic when something is wrong.
4. If the banner reads `unavailable · TRAIL_ABSENT`, the configured path
   is not the `FLEET_STATE_DIR` fleet-ops actually runs with.
   If it reads `corrupt · PARSE_FAILED`, the trail failed the contract —
   check the server log (`[gy/fleet] corrupt trail …`) for the exact
   line; the trail file itself, not the console, is the thing to fix.

## Explicit out of scope

- No URL/artifact-store topology for trails (no upstream publisher).
- No Scout-report ingestion (`SCOUT_REPORT_FILE` is a separate upstream
  sink; wiring it would need its own verified contract).
- No writes to the state dir, no polling, no push/websocket ingestion.
- No transaction capability anywhere in the console (unchanged charter).
