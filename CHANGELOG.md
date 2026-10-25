# Changelog

All notable changes to graveyield-console are documented here. Dates are UTC.
Commit identity convention: all GraveYield engineering commits are authored as sethoshi.eth.

## [Unreleased]

### Security — 2026-10-25 (dependency triage: fleet override treatment)

Baseline: this repository had never been dependency-triaged (static-review-only in the Phase 0 audit, commit e34b1df in graveyield-protocol). Toolchain is bun (bun.lock); the tree consumes `@solana/web3.js` 1.99.0 and the wallet-adapter family, which carries the same `web3.js → jayson → uuid / stream-json` transitive chain patched in salvor-bots (32e913a) and graveyield-protocol (69ac241).

Changes:

- Added bun-style top-level `overrides` to package.json, floors identical to the fleet block used in salvor-bots and graveyield-protocol:
  - `toml >= 5.0.1` — documented no-op in this tree: `@coral-xyz/anchor` is not a dependency here, so toml is absent. Kept for fleet-wide override parity so future anchor adoption inherits the safe floor.
  - `uuid >= 11.1.1` — unified the split resolution (direct `^11.1.0` → 11.1.0, transitive via jayson → 8.3.2 vulnerable) into a single `uuid@14.0.3`. GHSA-w5hq-g745-h8pq (missing buffer bounds check) closed. No source in `src/` imports uuid directly; consumer is jayson's `require('uuid').v4`, runtime-verified on the 14.x line by the salvor-bots triage.
  - `stream-json >= 3.6.0` — 1.9.1 → 3.7.0. The three stream-json GHSAs (528h-pc64-c93x, hqr4-qq8f-hg3x, mjw6-4jj6-33hc) closed. 3.7.0 is the exact resolution runtime-verified by the salvor-bots triage.
- `jayson` itself unchanged (4.3.0); only its transitive subgraph moved.
- `bigint-buffer` accepted-risk (GHSA-3gc7-fjrx-p6mg) does not apply here: no `@solana/spl-token` / `@solana/buffer-layout-utils` path exists in this tree.

Evidence:

- `bun audit`: 110 findings (5 critical, 57 high, 42 moderate, 6 low) → 106 (5 critical, 57 high, 38 moderate, 6 low). The delta is exactly the 4 closed web3.js→jayson-chain advisories (uuid ×1, stream-json ×3).
- `bun install --frozen-lockfile` reproduces clean after re-resolution.
- `bun run build` (Next 16) green on the patched resolutions.
- Full before/after audit listings retained out-of-repo as engagement evidence (console_audit_BASELINE / console_audit_AFTER-OVERRIDES, 2026-10-25).

### Security — 2026-10-25 (criticals pass: next + next-auth, owner-approved)

- Owner approved a follow-up pass scoped to the 5 critical advisories, all carried by direct dependencies. Manifest floors raised (bun update semantics) and lockfile re-resolved:
  - `next ^16.1.1 → ^16.4.3` (resolved 16.1.3 → 16.4.3; advisory fix floor ≥16.2.5). Closes 4× unauthenticated RCE: image-optimization AVIF (GHSA-2xp9-vwfh-vxw4), image-optimization SVG (GHSA-2464-fhr4-w9xw), `use cache` functions returning typed arrays (GHSA-673q-mjm6-r5xr), Windows-hosted servers (GHSA-p293-qw3h-jr36).
  - `next-auth ^4.24.11 → ^4.24.15` (resolved 4.24.13 → 4.24.15; fix floor ≥4.24.15). Closes the Auth.js email-normalizer homoglyph `@` bypass (GHSA-7rqj-j65f-68wh).
- Tree check: the only installed `next` is 16.4.3, single copy. The remaining `@next/eslint-plugin-next@16.1.3` pin under eslint-config-next is the ESLint plugin (not the framework), carries no RCE surface, and is not audit-flagged; untouched in this pass.
- Evidence: `bun audit` 106 (5 critical, 57 high, 38 moderate, 6 low) → **62 (0 critical, 41 high, 19 moderate, 2 low)** — the 44-finding delta is the entire advisory set attached to the old next/next-auth versions. `bun install --frozen-lockfile` green; `bun run build` on Next 16.4.3 green (all routes prerendered). Audit listing retained out-of-repo (console_audit_AFTER-CRITICALS, 2026-10-25).

Open register (updated 2026-10-25 after the criticals pass — still awaiting owner-scoped triage):

- 62 remaining findings (0 critical, 41 high, 19 moderate, 2 low) across 24 packages: @babel/core, @humanfs/node, ajv, baseline-browser-mapping, brace-expansion, browserslist, deepmerge-ts, defu, diff, effect, flatted, js-cookie, js-yaml, lodash, lodash-es, minimatch, nanoid, next-intl, picomatch, postcss, prismjs, sharp, source-map-js, zod. Highest-value next targets are the two direct deps: `next-intl <4.9.1` (open redirect + prototype pollution, fix ≥4.9.1) and `zod <4.6.6`; picomatch arrives partly via `@solana-mobile/wallet-adapter-mobile → react-native → codegen`.
