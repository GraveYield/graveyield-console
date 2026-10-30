# Snapshot artifact transport (P4.1 Step 1)

How the console obtains the grave-indexer `ConsoleSnapshotV1` artifact at
runtime, what can go wrong, and why a stale or invalid artifact can never be
presented as fresh data.

## The question this answers

The console must not assume it can read a local directory of indexer output.
A Vercel (or any serverless) deployment has **no persistent local directory**:
files written by the indexer on some other machine simply are not there. The
transport therefore makes the artifact source an **explicit, configured
input** with two supported topologies, and refuses to guess when none (or
both) are configured.

The console is a **pull-only consumer**: it never writes artifacts, never
runs the indexer, and never accepts push. The indexer side (producing and
publishing `console-snapshot.json`) is owned by the
[`grave-indexer`](https://github.com/GraveYield/grave-indexer) repository.

## Sources

| Variable | Topology | Deployment | Semantics |
| --- | --- | --- | --- |
| `GY_SNAPSHOT_URL` | HTTPS artifact store | serverless (Vercel, etc.) and self-hosted | The indexer (or its CI) publishes `console-snapshot.json` to a release asset, object storage (R2/S3), or any GET endpoint; the route fetches it per request (10 s timeout, 8 MiB cap). Pre-signed URLs work; their query strings are fetched but never logged or echoed. |
| `GY_SNAPSHOT_PATH` | indexer output volume | self-hosted / Docker | Mount the indexer's output directory and point the env at `console-snapshot.json`. Read per request (8 MiB cap). |

Exactly one source may be configured:

- **neither** → `missing` / `NO_SOURCE_CONFIGURED` — a first-class state: the
  Graveyard renders an honest "unavailable" banner with fix-it instructions
  instead of pretending.
- **both** → `missing` / `SOURCE_CONFLICT` — ambiguity is a configuration
  error, not something to silently resolve.

## The four artifact states

`GET /api/gy/snapshot` always answers `200` with `Cache-Control: no-store`
and an explicit state envelope (the state machine lives in the payload, so
the response stays a single diagnostic surface):

| `artifactState` | `dataState` | `snapshot` payload | Meaning |
| --- | --- | --- | --- |
| `valid` | `real` | present | Contract-clean and inside its own freshness budget (`generatedAtUnixMs + freshness.maxAgeMs`). |
| `stale` | `stale` | present | Contract-clean but past budget. Data is served, explicitly labeled stale — **never presented as fresh**. |
| `missing` | `unavailable` | **null** | No source configured, source conflict, unreadable path, HTTP error from the store, network failure, or aborted fetch. |
| `corrupt` | `unavailable` | **null** | Bytes arrived but fail the fail-closed contract: invalid JSON, schema violation, fabricated criteria, non-u64 fields, future-dated `generatedAt`, oversized payload. |

Rule of thumb baked into the code and tests: **transport-level failures are
`missing`; contract-level rejections are `corrupt`; only `valid` can ever
carry `dataState: "real"`.**

Envelope shape (v1):

```json
{
  "artifactState": "valid",
  "dataState": "real",
  "reason": null,
  "reasonCode": null,
  "source": { "kind": "url", "uri": "https://artifacts.example/gy/console-snapshot.json" },
  "checkedAtUnixMs": 1793400000000,
  "ageMs": 60000,
  "maxAgeMs": 86400000,
  "snapshot": { "schemaVersion": 1, "generatedAtUnixMs": 1793399940000, "...": "ConsoleSnapshotV1" }
}
```

`reason` / `reasonCode` carry the diagnostic for every non-valid state
(`NO_SOURCE_CONFIGURED`, `SOURCE_CONFLICT`, `READ_FAILED`,
`FETCH_HTTP_STATUS`, `FETCH_FAILED`, `OVERSIZE`, `PARSE_FAILED`,
`FUTURE_GENERATED_AT`). A future-dated artifact (`generatedAt` more than 5
minutes ahead of the server clock) is rejected as corrupt — otherwise a bad
publisher could mint data that classifies as fresh forever.

## Defense in depth

1. **Route (server)** — `src/app/api/gy/snapshot/route.ts` resolves the
   source via `src/lib/gy/snapshotSource.ts` and validates the bytes with
   the same fail-closed parser (`parseSnapshot`) that has guarded the
   artifact since P3-A. `force-dynamic` + `no-store`: a cached stale
   response can never masquerade as a fresh check.
2. **Hydration (client)** — the browser treats the envelope as untrusted.
   `hydrateTransportPayload()` (`src/lib/gy/snapshotTransport.ts`) re-runs
   the full contract parser on any `snapshot` payload, enforces the
   envelope's internal consistency (`dataState` must equal the honest
   mapping of `artifactState`; failures carry no payload; the staleness
   verdict must match the artifact's own budget), and returns null —
   rendered as *unavailable* — on any violation.

So "stale/invalid artifact presented as fresh" is structurally impossible:
it would have to pass two independent applications of the same fail-closed
contract, plus the envelope-consistency checks.

## Refresh semantics

- **Manual only.** One fetch on page load plus the Graveyard's explicit
  **Refresh** button. There is no interval, no polling, no websocket — the
  console never implies automatic real-time ingestion.
- The banner always shows the checked-at time (server clock) and, for stale
  data, the age against the budget.
- Operators refresh the *data* by publishing a new artifact (URL topology)
  or letting the indexer regenerate the file (path topology), then pressing
  Refresh. Either `stable-latest` URLs/keys or fully versioned immutable
  artifacts work — the staleness badge is computed from the artifact's own
  timestamps either way.

## Operator runbook

**Serverless (Vercel):**

1. Indexer run finishes → CI (or the operator) uploads
   `console-snapshot.json` to the artifact store (GitHub Release asset on
   `grave-indexer`, R2/S3 object, …).
2. Set `GY_SNAPSHOT_URL` to the artifact URL in the Vercel project env.
3. Redeploy/restart the console once (env change), then use Refresh.
4. Monitoring: probe the route — a healthy deployment answers 200 with
   `artifactState` cycling only `valid`/`stale`; a persistent `missing` with
   `FETCH_HTTP_STATUS` means the store URL moved; `corrupt` with
   `PARSE_FAILED` means the contract drifted upstream (the console test
   battery will also go red on the committed seed).

**Self-hosted / Docker:**

1. Run the indexer with its output volume mounted at a known path.
2. Set `GY_SNAPSHOT_PATH=/…/console-snapshot.json` on the console container
   (same host or shared volume).
3. Restart once; use Refresh after each indexer run.

## What the test battery proves

`src/lib/gy/__tests__/snapshotTransport.test.ts` pins the mechanism:

- both topologies deliver a fresh artifact end to end (`valid` / `real`);
- **the committed artifact — real, already-past-budget bytes shipped in the
  repo — classifies `stale` through both the resolver and the route, and
  stays stale through client hydration**;
- staleness boundary honors the artifact's own budget (exactly `maxAge` is
  fresh, +1 ms is stale);
- every transport failure maps to `missing`/`corrupt` with the right
  `reasonCode`, no payload, and `dataState: "unavailable"`;
- the invariant sweep asserts `dataState === "real"` ⟺
  `artifactState === "valid"` for every outcome;
- fabricated criteria, wrong schema versions, non-u64 fields, invalid JSON,
  future-dated artifacts and oversized bodies are rejected as `corrupt`;
- URL diagnostics never leak credentials (userinfo/query redacted);
- the client hydration gate rejects lying envelopes, tampered payloads,
  clock-flipped staleness and malformed shapes;
- the route handler itself answers `200` + `no-store` in all four states.

## Explicitly out of scope (Step 1)

- Automatic/poll-based refresh or websocket push.
- Attestation-grade evidence transport (oracle-signed artifacts) — the
  snapshot artifact is honest observation, not yet an oracle attestation.
- Any transaction path: the console still never builds, signs, or submits.
- Cluster policy changes: the artifact remains mainnet-derived observation;
  protocol operations stay devnet-only per the project charter.
