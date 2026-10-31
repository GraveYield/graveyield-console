// Protocol OPS (P4.5) — pure helpers behind the Protocol view's live
// operations section (audit Phase 4.5 item 1).
//
// The view renders three kinds of facts and this module keeps the judgment
// logic pure and unit-tested:
//
//   · Oracle parity — presence/parity of the configured oracle keys versus
//     the config authority, displayed AS FACTS. The console never claims
//     "rotation readiness", never infers custody, and never suggests an
//     action: registration/rotation is an authority-side process (the
//     2026-10-27 assessment's B1/B2), not something a read-only view does.
//   · Live-vs-spec comparison — each documented config default is checked
//     against the live ProtocolConfig value and classified
//     match / differs / unavailable. "Differs" is NOT an error: the
//     authority may update config within Charter bounds; the view shows
//     both values honestly.
//   · A zeroed 32-byte key is "not registered" — a decoded all-zero pubkey
//     (base58 "1" × 32) is a placeholder, not a real key.

import type { ScannerConfigLive, VaultConfigLive } from "./protocolLive";

/** base58 of 32 zero bytes — what readPubkey yields for an unset key. */
export const ZERO_PUBKEY_BASE58 = "1".repeat(32);

/** A decoded key that is present and non-zero (i.e., actually registered). */
export function isRegisteredPubkey(addr: string | null | undefined): boolean {
  return typeof addr === "string" && addr.length > 0 && addr !== ZERO_PUBKEY_BASE58;
}

export interface OracleParity {
  /** activity oracle vs the scanner's own config authority. */
  activityEqualsScannerAuthority: boolean | null;
  /** launch-price oracle vs the scanner's own config authority. */
  launchEqualsScannerAuthority: boolean | null;
  /** the two oracle keys vs each other. */
  activityEqualsLaunch: boolean | null;
  /** scanner config authority vs vault config authority. */
  crossProgramAuthorityEqual: boolean | null;
  /** registered-or-not facts (null = the key read was unavailable). */
  activityOracleRegistered: boolean | null;
  launchOracleRegistered: boolean | null;
  /** One composed, honest sentence for the UI. */
  summary: string;
}

/** Parity facts from the live configs. `null` comparisons = a side was
 * unreadable (config decode failed) — unknown, never forced to false. */
export function oracleParity(
  scanner: ScannerConfigLive | null,
  vault: VaultConfigLive | null,
): OracleParity {
  const eq = (a: string | null, b: string | null): boolean | null =>
    a === null || b === null ? null : a === b;
  const reg = (a: string | null): boolean | null => (a === null ? null : isRegisteredPubkey(a));

  const activity = scanner?.activityOracle ?? null;
  const launch = scanner?.launchPriceOracle ?? null;
  const scannerAuthority = scanner?.authority ?? null;
  const vaultAuthority = vault?.authority ?? null;

  const activityEqualsScannerAuthority = eq(activity, scannerAuthority);
  const launchEqualsScannerAuthority = eq(launch, scannerAuthority);
  const activityEqualsLaunch = eq(activity, launch);
  const crossProgramAuthorityEqual = eq(scannerAuthority, vaultAuthority);
  const activityOracleRegistered = reg(activity);
  const launchOracleRegistered = reg(launch);

  const parts: string[] = [];
  if (activityOracleRegistered === false || launchOracleRegistered === false) {
    parts.push("at least one oracle key is an unregistered (zeroed) placeholder");
  } else if (activityOracleRegistered === null || launchOracleRegistered === null) {
    parts.push("oracle registration is unavailable from the live read");
  } else {
    parts.push("both oracle keys are registered");
  }
  if (activityEqualsScannerAuthority === true && launchEqualsScannerAuthority === true) {
    parts.push("both equal the scanner config authority");
  } else if (activityEqualsScannerAuthority === false || launchEqualsScannerAuthority === false) {
    parts.push("at least one differs from the scanner config authority");
  }
  if (activityEqualsLaunch === true && activityOracleRegistered === true) {
    parts.push("and share one key");
  }
  parts.push("parity is displayed as a fact — rotation/registration is an authority-side process, not a console action");

  return {
    activityEqualsScannerAuthority,
    launchEqualsScannerAuthority,
    activityEqualsLaunch,
    crossProgramAuthorityEqual,
    activityOracleRegistered,
    launchOracleRegistered,
    summary: parts.join("; ") + ".",
  };
}

/* ── Live-vs-spec comparison ─────────────────────────────────────────── */

export interface SpecRowCheck {
  label: string;
  /** The documented default, as displayed. */
  reference: string;
  /** The live value formatted for display; null = unavailable. */
  live: string | null;
  status: "match" | "differs" | "unavailable";
}

/** Compare one documented default against its live value. Numbers are
 * compared digit-normalized (units and grouping commas are display). */
export function specCheck(
  label: string,
  reference: string,
  referenceComparable: string,
  live: string | null,
): SpecRowCheck {
  if (live === null) {
    return { label, reference, live: null, status: "unavailable" };
  }
  const norm = (s: string) => s.replace(/[^0-9]/g, "");
  return {
    label,
    reference,
    live,
    status: norm(referenceComparable) === norm(live) ? "match" : "differs",
  };
}

/** Status → badge tone mapping for the comparison table. */
export function specCheckTone(status: SpecRowCheck["status"]): "ok" | "warn" | "muted" {
  switch (status) {
    case "match":
      return "ok";
    case "differs":
      return "warn";
    case "unavailable":
      return "muted";
  }
}
