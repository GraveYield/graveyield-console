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

Open register (NOT triaged in this pass — awaiting owner-scoped follow-up):

- 106 remaining findings across 26 packages, including 5 criticals, all in direct dependencies: `next >=16.0.0 <16.2.5` (4× unauthenticated RCE: image-optimization AVIF, image-optimization SVG, `use cache` typed arrays, Windows-hosted servers) and `next-auth >=4.10.3 <4.24.15` (Auth.js email-normalizer homoglyph `@` bypass, GHSA-7rqj-j65f-68wh). Both appear fixable by in-major version bumps (next → ≥16.2.5, next-auth → ≥4.24.15) but require their own triage pass with build + runtime verification. Further tail: brace-expansion, minimatch, picomatch (partially via `@solana-mobile/wallet-adapter-mobile → react-native → codegen`), diff, source-map-js, next-intl, zod, prismjs, sharp, nanoid, lodash, and others.
