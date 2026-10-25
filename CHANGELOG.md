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

### Security — 2026-10-25 (full register triage: 62 findings → 0, owner-approved)

- Owner approved triage of the entire remaining register ("patch all valid vulns"). Outcome: `bun audit` **62 (0 critical, 41 high, 19 moderate, 2 low) → 0**. Every finding was traced to its consuming chain and patched; no accepted risks remain in this tree.

Triage ledger (all 24 packages):

| Package | Vulnerable resolution | Chain | Fixed to | Mechanism |
|---|---|---|---|---|
| ajv | 6.12.6 | eslint › eslintrc | 6.15.0 | override `>=6.14.0 <7` |
| brace-expansion | 1.1.12 | minimatch (eslint tree) | 1.1.21 | override `>=1.1.17 <2` |
| minimatch | 3.1.2 | eslintrc, ts-estree, 4 more | 3.1.5 | override `>=3.1.3 <4` |
| picomatch | 2.3.1 | @parcel/watcher, tinyglobby/fdir, jest/micromatch | 2.3.2 | override `>=2.3.2 <3` |
| postcss | 8.5.6 (+ next's exact 8.5.23) | @tailwindcss/postcss, next | 8.5.31 | override `>=8.5.23 <9` |
| nanoid | 3.3.11 | postcss | 3.3.20 | override `>=3.3.16 <4` |
| prismjs | 1.27.0 (refractor `~1.27` pin) | react-syntax-highlighter, @lexical/code | 1.30.0 | override `>=1.30.0 <2` |
| js-yaml | 4.1.1 (mdxeditor exact pin) | @mdxeditor, eslintrc | 4.3.2 | override `>=4.1.2 <5` |
| source-map-js | 1.2.1 | postcss chains | 1.2.2 | override `>=1.2.2 <2` |
| lodash | 4.17.21 | recharts | 4.18.1 | override `>=4.17.23 <5` |
| lodash-es | 4.17.22 | @reactuses/core | 4.18.1 | override `>=4.17.23 <5` |
| js-cookie | 3.0.5 | @reactuses/core | 3.0.8 | override `>=3.0.6 <4` |
| flatted | 3.3.3 | eslint › flat-cache | 3.4.4 | override `>=3.4.0 <4` |
| diff | 5.2.0 | @mdxeditor › unidiff, uvu | 5.2.2 | override `>=5.2.2 <6` |
| @babel/core | 7.28.6 | react-native codegen, metro ×5, react-hooks | 7.29.7 | override `>=7.29.1 <8` |
| browserslist | 4.28.1 | @babel/helper-compilation-targets | 4.29.4 | override `>=4.28.7 <5` |
| baseline-browser-mapping | 2.9.15 | next, browserslist chains | 2.11.32 | override `>=2.11.0 <3` |
| @humanfs/node | 0.16.7 | eslint | 0.16.8 | override `>=0.16.8 <0.17` |
| defu | 6.1.4 | prisma › @prisma/config › c12/giget/rc9 | 6.1.7 | override `>=6.1.5 <7` |
| effect | 3.18.4 (exact pin) | prisma › @prisma/config | 3.22.4 | override `>=3.20.0 <4` |
| deepmerge-ts | 7.1.5 (exact pin) | prisma › @prisma/config | 8.0.2 | override `>=8.0.0 <9` — see note |
| zod | 4.3.5 | DIRECT + eslint-plugin-react-hooks union spec | 4.6.7 | re-resolution + override `>=4.6.6 <5` |
| next-intl | 4.7.0 | DIRECT | 4.14.9 | in-range re-resolution |
| sharp | 0.34.5 | DIRECT + next | 0.35.5 | manifest bump `^0.35.5` |

Notes and trade-offs:

- **deepmerge-ts is the only cross-major force** (7 → 8). Upstream validates it: `@prisma/config` 7.10.1 pins 8.0.2. Runtime-verified here via `bunx prisma generate` (green) on `@prisma/config` 6.19.2.
- **bun 1.3.14 ignores npm-style scoped (nested) overrides** — the tree flattens to single resolutions. Cross-major consumers now run the older-but-patched majors: `@typescript-eslint/typescript-estree` on minimatch 3.1.5 (spec was ^9.0.5), `@parcel/watcher` + `tinyglobby` on picomatch 2.3.2 (spec was ^4.0.3). Verified functionally: `bun run build` and `bun run lint` (exit 0) exercise ts-estree, tinyglobby globbing, and the full eslint chain. Recorded as an accepted functional trade-off; re-triage if eslint tooling misbehaves on minimatch/picomatch APIs.
- The fleet's three original floors (toml/uuid/stream-json) are unchanged and toml remains a documented no-op here (no anchor in tree).
- bigint-buffer accepted-risk (GHSA-3gc7-fjrx-p6mg) does not apply: no spl-token/buffer-layout-utils path exists.

Evidence:

- `bun audit`: **0 vulnerabilities** (final listing retained out-of-repo as console_audit_FINAL, 2026-10-25; earlier stages: baseline 110 → 106 after fleet overrides → 62 after criticals pass → 0).
- `bun install --frozen-lockfile` reproduces clean (1267 installs, no changes).
- `bunx prisma generate` green; `bun run build` (Next 16.4.3) green, all routes prerendered; `bun run lint` green (exit 0).
