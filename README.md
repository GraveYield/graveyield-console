# GraveYield — Salvage Console

Operations console for the **GraveYield protocol** — certify and salvage derelict Solana LP pools.

GraveYield finds liquidity pools that have been abandoned by their communities, certifies them against an on-chain charter, and lets independent salvors recover the trapped liquidity under a fixed settlement split. This repository is the console UI that operators and salvors use to watch the graveyard, evaluate candidates, and drive the salvage flow.

![Overview](docs/overview.png)

## What's inside

Five views, one route:

| View | Purpose |
| --- | --- |
| **Overview** | Protocol pulse — **live** devnet reads of both deployed programs and their `ProtocolConfig` PDAs, plus KPI cards and a fleet activity feed that remain **simulated fixtures**. |
| **Graveyard** | Derelict pool explorer over **real indexer data** — the committed `grave-indexer console-snapshot` artifact, parsed by a fail-closed loader with per-pool provenance (sha256 account fingerprint, fetch timestamps) and a 24 h freshness budget shown as an honest stale badge. Search, state filters, sortable table (TVL / idle / collapse / score). Each pool opens a detail sheet with lifecycle position, six-criteria states, and the salvage estimator. |
| **Salvor Fleet** | The five-bot operations fleet (scout · conservative · sniper · experimental · monitor) with its standing runbook — **simulated**; live fleet-state ingestion is not built yet. |
| **LP Claims** | Merkle-verified claim lookup — **simulated**; real snapshot and on-chain claim integration is not built yet. |
| **Protocol** | Charter invariants register, deployed program IDs, config defaults, PDA map, and a full error decoder (6000–6034, 7000–7022). |

![Pool detail](docs/pool-detail.png)

## Salvage, briefly

A pool only becomes salvageable after passing **six criteria (C1–C6)** — trading inactivity, price collapse from launch, minimum residual TVL, unburned LP supply, no locked LP, and multi-epoch confirmation. Certification is two-phase: an on-chain anchor, an epoch confirmation gap, then a certificate with a **1-hour TTL** during which the salvage window is open.

Settlement is fixed on-chain: **40% LP holders · 40% salvor · ≤20% protocol treasury**. The built-in estimator is integer-exact (same arithmetic as the fleet-core off-chain estimator) — it walks direct WSOL withdrawal, the memecoin→WSOL leg with dust handling, slippage floors, and full cost accounting down to break-even.

## Real wallet, honest per-view data

The console connects to **real Solana wallets** via the Wallet Standard (Phantom, Solflare, Backpack, and any compatible wallet are auto-detected — no adapter packages required). Connecting shows your devnet SOL balance and links out to Solana Explorer.

Data honesty is per-view and labeled in the UI:

- **Graveyard pool rows are real**: a committed `ConsoleSnapshotV1` artifact produced by [`grave-indexer`](https://github.com/GraveYield/grave-indexer) `console-snapshot` (currently 12 of 118 supported WSOL pairs enriched), parsed by a fail-closed loader that rejects malformed records, fabricates nothing, renders missing activity as *unavailable* (never zero), and marks the artifact stale after its 24 h freshness budget. Provenance — generation time, slot bounds, per-pool sha256 fingerprint, recorded ingestion failures — is displayed. The artifact is currently refreshed **manually**; automated refresh transport is planned and **not built yet**.
- **The protocol pulse is live**: raw devnet JSON-RPC reads of both deployed programs and their `ProtocolConfig` PDAs, Anchor-discriminator-checked with byte-pinned decoders.
- **Everything else stays simulated on purpose**: overview KPIs and the fleet feed, the fleet view, the claims view, and all transaction actions are fixtures or dry-run toasts — this app never builds, signs, or submits a transaction today.

## Tech stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **Tailwind CSS** + shadcn/ui (Radix primitives) — dark-first flat neutral theme, Inter
- **@solana/web3.js** + **@solana/wallet-adapter-react** (Wallet Standard detection, devnet RPC)
- **Bun** as the package manager and runtime

## Getting started

```bash
# requires bun >= 1.1
bun install
bun run dev        # → http://localhost:3000
```

Optional: point the wallet connection at your own RPC by setting `NEXT_PUBLIC_SOLANA_RPC_URL` (defaults to the public devnet cluster).

```bash
bun run lint       # eslint
bun run test       # unit battery (bun test): estimator economics, criteria thresholds,
                   # snapshot artifact contract, program-ID pins, display formatters
bun run build      # production build (typecheck enforced)
```

## Project structure

```
src/
├── app/                  # single-route console + providers
├── components/
│   ├── gy/               # GraveYield views (overview, graveyard, fleet, claims, protocol) + shell/widgets
│   └── ui/               # shadcn/ui primitives
└── lib/
    └── gy/               # domain: types · snapshot loader + committed artifact (real
                          # indexer data) · protocolLive (live devnet config reads) ·
                          # estimator (integer-exact fleet-core port) · simulated
                          # fixtures · display formatters · __tests__ battery
```

## Related repositories

- [`graveyield-protocol`](https://github.com/GraveYield/graveyield-protocol) — Anchor programs (GraveScanner / GraveVault), canonical SDK, indexer, snapshotter
- [`grave-indexer`](https://github.com/GraveYield/grave-indexer) — pool discovery + oracle evidence pipeline; produces the console's `ConsoleSnapshotV1` artifact
- [`salvor-bots`](https://github.com/GraveYield/salvor-bots) — the five-bot salvor fleet and fleet-core estimator
- [`graveyield-site`](https://github.com/GraveYield/graveyield-site) — public landing site

## Status

**Research preview.** Devnet only — no mainnet deployment, unaudited. Graveyard rows are real indexer observations (staleness is badged, never hidden); fleet, claims, and overview KPIs remain simulated fixtures, and no transaction path exists in the app. Terminology is normative: pools are *derelict*, recovery is *salvage*, and the operators are *salvors*.
