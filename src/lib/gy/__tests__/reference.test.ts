// Protocol reference-data pins (audit finding 5.9) — the Protocol view's
// instruction tables must list EXACTLY the canonical instruction sets of the
// deployed programs (graveyield-protocol programs/*/src/lib.rs), no more and
// no fewer. The omission class is real: `sweep_dust` was missing from the
// vault table while its error codes (7020/7021) were displayed on the same
// view. These pins turn any future drift between the reference data and the
// canonical programs into a CI failure.

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

import { SCANNER_IX, VAULT_IX } from "../reference";

/** Canonical GraveScanner instructions (grave-scanner/src/lib.rs, verified 2026-11). */
const CANONICAL_SCANNER_IX = [
  "initialize",
  "record_launch_price",
  "evaluate_pool_phase_1",
  "evaluate_pool_phase_2",
  "invalidate_anchor",
  "sweep_stale_anchor",
  "update_protocol_config",
  "emergency_pause",
];

/** Canonical GraveVault instructions (grave-vault/src/lib.rs, verified 2026-11). */
const CANONICAL_VAULT_IX = [
  "initialize",
  "update_protocol_config",
  "emergency_pause",
  "salvage_pool",
  "claim_lp_proceeds",
  "sweep_dust",
];

describe("protocol reference — instruction tables (audit finding 5.9)", () => {
  test("vault table lists exactly the six canonical GraveVault instructions", () => {
    // The display order is a presentation choice; the SET must equal the
    // canonical instruction set exactly (this is the pin that fails when an
    // instruction like sweep_dust is omitted).
    expect((VAULT_IX.map(([name]) => name) as string[]).slice().sort()).toEqual(
      CANONICAL_VAULT_IX.slice().sort(),
    );
  });

  test("scanner table lists exactly the eight canonical GraveScanner instructions", () => {
    expect((SCANNER_IX.map(([name]) => name) as string[]).slice().sort()).toEqual(
      CANONICAL_SCANNER_IX.slice().sort(),
    );
  });

  test("sweep_dust is present with a non-empty description (the audit's omission)", () => {
    const row = VAULT_IX.find(([name]) => name === "sweep_dust");
    expect(row).toBeDefined();
    expect(row![1].length).toBeGreaterThan(10);
    // The described semantics match the canonical one-shot, permissionless,
    // treasury-directed D6 recovery path.
    expect(row![1]).toContain("dust");
  });

  test("every instruction row carries a description; names are unique per program", () => {
    for (const table of [SCANNER_IX, VAULT_IX]) {
      const names = table.map(([name]) => name);
      expect(new Set(names).size).toBe(names.length);
      for (const [name, desc] of table) {
        expect(name.length).toBeGreaterThan(0);
        expect(desc.length).toBeGreaterThan(0);
      }
    }
  });

  test("snake_case instruction names (canonical Anchor naming, no invented camelCase)", () => {
    for (const [name] of [...SCANNER_IX, ...VAULT_IX]) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
