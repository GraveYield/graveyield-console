# GraveYield — Salvage Console

Operations console for the **GraveYield protocol** — certify and salvage derelict Solana LP pools.

GraveYield finds liquidity pools that have been abandoned by their communities, certifies them against an on-chain charter, and lets independent salvors recover the trapped liquidity under a fixed settlement split. This repository is the console UI that operators and salvors use to watch the graveyard, evaluate candidates, and drive the salvage flow.

![Overview](docs/overview.png)

## What's inside

Five views, one route:

| View | Purpose |
| --- | --- |
| **Overview** | Protocol pulse — epoch progress, tracked pools, salvageable count, watch-set TVL, 40/40/20 salvage split, latest settlement receipt, live fleet activity feed. |
| **Graveyard** | Derelict pool explorer — search, state filters, sortable table (TVL / idle time / score). Each pool opens a detail sheet with lifecycle position, six-criteria evaluation, and the salvage estimator. |
| **Salvor Fleet** | The five-bot operations fleet (scout · conservative · sniper · experimental · monitor) with its standing runbook. |
| **LP Claims** | Merkle-verified claim lookup — LPs of settled pools check their claim against the snapshot root. |
| **Protocol** | Charter invariants register, deployed program IDs, config defaults, PDA map, and a full error decoder (6000–6034, 7000–7022). |

![Pool detail](docs/pool-detail.png)

## Salvage, briefly

A pool only becomes salvageable after passing **six criteria (C1–C6)** — trading inactivity, price collapse from launch, minimum residual TVL, unburned LP supply, no locked LP, and multi-epoch confirmation. Certification is two-phase: an on-chain anchor, an epoch confirmation gap, then a certificate with a **1-hour TTL** during which the salvage window is open.

Settlement is fixed on-chain: **40% LP holders · 40% salvor · ≤20% protocol treasury**. The built-in estimator is integer-exact (same arithmetic as the fleet-core off-chain estimator) — it walks direct WSOL withdrawal, the memecoin→WSOL leg with dust handling, slippage floors, and full cost accounting down to break-even.

## Real wallet, simulated telemetry

The console connects to **real Solana wallets** via the Wallet Standard (Phantom, Solflare, Backpack, and any compatible wallet are auto-detected — no adapter packages required). Connecting shows your devnet SOL balance and links out to Solana Explorer.

Everything else is deliberately honest: the header carries a **"Simulated telemetry"** badge, pool data is a devnet-era fixture, and both the dry-run evaluation and the certify-and-salvage action stay **read-only / dry-run on devnet** — nothing is ever submitted.

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
bun run build      # production build
```

## Project structure

```
src/
├── app/                  # single-route console + providers
├── components/
│   ├── gy/               # GraveYield views (overview, graveyard, fleet, claims, protocol) + shell/widgets
│   └── ui/               # shadcn/ui primitives
└── lib/
    └── gy/               # domain: types, estimator (integer-exact), telemetry fixtures, formatting
```

## Related repositories

- [`graveyield-protocol`](https://github.com/GraveYield/graveyield-protocol) — Anchor programs (GraveScanner / GraveVault), SDK, indexer
- [`salvor-bots`](https://github.com/GraveYield/salvor-bots) — the five-bot salvor fleet and fleet-core estimator
- [`graveyield-site`](https://github.com/GraveYield/graveyield-site) — public landing site

## Status

**Research preview.** Devnet only — no mainnet deployment, unaudited, all telemetry simulated. Terminology is normative: pools are *derelict*, recovery is *salvage*, and the operators are *salvors*.
