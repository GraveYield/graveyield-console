"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Landmark,
  ListTree,
  Search,
  Siren,
} from "lucide-react";
import { CopyChip, SectionHead, ToneBadge } from "./widgets";
import { CHARTER_INVARIANTS, CONFIG, PROGRAM_IDS } from "@/lib/gy/data";

/* Error tables — transcribed from docs/error_codes.md (authoritative). */
const SCANNER_ERRORS: [number, string, string][] = [
  [6000, "Unauthorized", "Caller lacks the multisig authority required."],
  [6001, "PoolNotEligible", "Pool does not satisfy all six derelict-pool criteria."],
  [6002, "LaunchPriceNotFound", "LaunchPrice PDA missing for this pool."],
  [6003, "UnsupportedAmm", "AMM program mismatch or unsupported pool layout."],
  [6004, "MathOverflow", "Arithmetic overflow during eligibility computation."],
  [6005, "InvalidClock", "Clock sysvar unavailable or returned invalid data."],
  [6006, "InvariantViolation", "Config update violates a locked invariant; no-op pause toggle."],
  [6007, "AmmAdapterUnimplemented", "AMM adapter registered but parser is a pre-mainnet stub."],
  [6008, "LockerAdapterUnimplemented", "Locker adapter registered but not implemented."],
  [6009, "PoolDataParseError", "Pool account data did not match the expected layout."],
  [6010, "ProtocolPaused", "GraveScanner is paused; evaluate_pool_* reverts."],
  [6011, "CriteriaBitmapMismatch", "Phase 2 bitmap disagrees with the originating anchor."],
  [6015, "AnchorNotFound", "Phase 2 attempted without an EligibilityAnchor PDA."],
  [6016, "EpochConfirmationPending", "Phase 2 before anchor epoch + MIN_EPOCH_CONFIRMATION."],
  [6017, "AnchorInvalidated", "Anchor was invalidated by multisig."],
  [6018, "AnchorNotStale", "sweep_stale_anchor called before the staleness window elapsed."],
  [6019, "CertTtlBelowMinimum", "cert_ttl_seconds below the 600s floor."],
  [6020, "LockerMarkerAccountRequired", "UNCX per-pool lock marker PDA not supplied."],
  [6021, "LockerLockEvidenceRequired", "Locker marker exists but no TokenLock evidence supplied."],
  [6022, "InvalidLockerAccount", "Locker-program account failed validation."],
  [6023, "LockerAccountMismatch", "TokenLock bound to a different (amm_id, lp_mint) pair."],
  [6024, "AttestationMissing", "No ed25519 verify instruction precedes the scanner instruction."],
  [6025, "InvalidAttestationOffsets", "Precompile offsets malformed or non-canonical."],
  [6026, "AttestationOracleMismatch", "Signed key is not the configured activity oracle."],
  [6027, "AttestationBindingMismatch", "Attestation binds different values than the params echo."],
  [6028, "AttestationTimestampInvalid", "Attested last-swap ts is zero or in the future."],
  [6029, "AttestationStale", "issued_slot no longer in SlotHashes (~512-slot window)."],
  [6030, "AttestationSlotHashMismatch", "Slot hash does not match the chain entry."],
  [6031, "AttestationSlotInvalid", "issued_slot is zero or in the future."],
  [6032, "InvalidLaunchPrice", "Attested launch price is zero."],
  [6033, "LaunchPriceMintMismatch", "Recorded baseline belongs to a different token pair."],
  [6034, "CertStillValid", "Phase 2 re-run while a live cert exists — wait for TTL, then reissue."],
];

const VAULT_ERRORS: [number, string, string][] = [
  [7000, "Unauthorized", "Caller lacks the multisig authority required."],
  [7001, "InvalidEligibilityCert", "Cert PDA missing, expired, or wrong program."],
  [7002, "EligibilityCertExpired", "Cert TTL passed — re-run phase 2 for a fresh cert."],
  [7003, "ProtocolPaused", "Protocol paused — only claim_lp_proceeds is callable."],
  [7004, "InvalidShareSplit", "Shares did not sum to 10,000 bps."],
  [7005, "ProtocolShareExceedsCeiling", "Attempted to raise the protocol share above the Charter ceiling."],
  [7006, "LpHolderPoolUnsweepable", "Attempted to sweep the LP vault — unsweepable, ever."],
  [7007, "SlippageExceeded", "Jupiter swap-leg slippage exceeded the configured maximum."],
  [7008, "PriorityFeeExceedsCeiling", "Priority fee above the Charter ceiling (SDK-enforced)."],
  [7009, "MathOverflow", "Overflow during distribution math."],
  [7010, "InvalidClaimProof", "Holder not in the snapshot tree, or proof invalid."],
  [7011, "ClaimAlreadyProcessed", "Already claimed for this (pool, holder) pair."],
  [7012, "BelowDustThreshold", "Quote output below the dust threshold (skipped in v1.0)."],
  [7013, "PreflightFailed", "Pre-flight check against the on-chain pool failed."],
  [7014, "TimelockNotElapsed", "72h timelock window not yet elapsed (multisig-enforced)."],
  [7015, "AmmRedemptionFailed", "remove_liquidity CPI errored or returned zero."],
  [7016, "JupiterSwapFailed", "Jupiter v6 swap CPI errored or returned zero."],
  [7017, "AmmCpiUnimplemented", "CPI adapter is a pre-mainnet stub — not Raydium V4."],
  [7018, "InvalidSnapshotData", "Snapshot LP supply does not match on-chain mint supply."],
  [7019, "UnsupportedBaseToken", "Pool does not have exactly one WSOL side."],
  [7020, "DustNothingToSweep", "sweep_dust found no retained memecoin."],
  [7021, "DustAlreadySwept", "sweep_dust already ran for this pool — one-shot by design."],
  [7022, "InvariantViolation", "No-op emergency_pause toggle — refuses first."],
];

const ALL_ERRORS: { program: string; code: number; name: string; condition: string }[] = [
  ...SCANNER_ERRORS.map(([code, name, condition]) => ({ program: "GraveScanner", code, name, condition })),
  ...VAULT_ERRORS.map(([code, name, condition]) => ({ program: "GraveVault", code, name, condition })),
];

const SCANNER_IX = [
  ["initialize", "Creates ProtocolConfig — thresholds, cert TTL, pause flag."],
  ["record_launch_price", "Init-once LaunchPrice PDA (C2 baseline) from an oracle-signed attestation."],
  ["evaluate_pool_phase_1", "Evaluates all six criteria; writes the EligibilityAnchor (first_eligible_epoch)."],
  ["evaluate_pool_phase_2", "Re-evaluates after the epoch gap; bitmap equality required; issues the EligibilityCert."],
  ["invalidate_anchor", "Multisig-only censor of a wrong Phase 1 pass."],
  ["sweep_stale_anchor", "Permissionless rent reclaim for anchors older than 14 days."],
  ["update_protocol_config", "Multisig-only bounded threshold updates."],
  ["emergency_pause", "Multisig-only pause; gates evaluate_pool_* only."],
] as const;

const VAULT_IX = [
  ["initialize", "Creates ProtocolConfig — 40/40/20 shares, fee/slippage/dust params, pause flag."],
  ["salvage_pool", "The settlement instruction. One salvage per pool, ever."],
  ["claim_lp_proceeds", "Merkle-verified pro-rata withdrawal — live during pause."],
  ["update_protocol_config", "Multisig-only share updates; 20% ceiling enforced on-chain."],
  ["emergency_pause", "Multisig-only pause; gates salvage_pool only."],
] as const;

const PDAS = [
  ["ProtocolConfig", "both", "[\"protocol_config\"]", "governance-writable"],
  ["LaunchPrice", "scanner", "[\"launch_price\", amm_program_id, pool]", "init-once"],
  ["EligibilityAnchor", "scanner", "[\"eligibility_anchor\", amm_program_id, pool]", "per-epoch; sweepable when stale"],
  ["EligibilityCert", "scanner", "[\"eligibility_cert\", amm_program_id, pool]", "expiry-gated reissue"],
  ["PoolRegistry", "vault", "[\"pool_registry\", pool]", "init-once at salvage"],
  ["SalvageReceipt", "vault", "[\"salvage_receipt\", pool]", "init-once at salvage"],
  ["lp_holder_pool_vault", "vault", "[\"lp_holder_pool\", pool]", "claim-only debits"],
  ["vault_sol_holding", "vault", "[\"vault_sol_holding\", pool]", "transient; drained by distribution"],
  ["vault_authority", "vault", "[\"vault_authority\"]", "signer-only PDA"],
  ["protocol_treasury", "vault", "[\"protocol_treasury\"]", "receives protocol share"],
  ["ClaimRecord", "vault", "[\"claim_record\", pool, holder]", "init-once; double-claim defense"],
] as const;

export function Protocol() {
  const [errQuery, setErrQuery] = useState("");

  const errMatches = useMemo(() => {
    const q = errQuery.trim().toLowerCase();
    if (!q) return [];
    return ALL_ERRORS.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.condition.toLowerCase().includes(q) ||
        (/^\d+$/.test(q) && e.code === Number(q)),
    ).slice(0, 8);
  }, [errQuery]);

  const codeMatch = useMemo(() => {
    if (!/^\d+$/.test(errQuery.trim())) return null;
    const n = Number(errQuery.trim());
    return ALL_ERRORS.find((e) => e.code === n) ?? null;
  }, [errQuery]);

  return (
    <div className="animate-fade-up space-y-6">
      <SectionHead title="Protocol" />

      {/* Invariants — compact register */}
      <Card className="glass-panel border-white/8 mx-auto w-full max-w-[28rem] lg:max-w-none">
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-2.5 sm:px-5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
              Charter invariants
            </span>
            <span className="font-mono text-[11px] tabular-nums text-slate-600">
              {CHARTER_INVARIANTS.length}
            </span>
          </div>
          <ul className="divide-y divide-white/6">
            {CHARTER_INVARIANTS.map((inv) => (
              <li key={inv.id} className="px-4 py-2.5 sm:px-5">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="font-mono text-[10.5px] font-semibold text-slate-500">
                    {inv.id}
                  </span>
                  <span className="text-[13px] font-semibold text-foreground">
                    {inv.title}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {inv.error && (
                      <span className="font-mono text-[10px] tabular-nums text-red-300/80">
                        {inv.error.split(" · ")[0]}
                      </span>
                    )}
                    <ToneBadge
                      tone={
                        inv.enforcement === "bytecode"
                          ? "ok"
                          : inv.enforcement === "multisig"
                            ? "info"
                            : "muted"
                      }
                    >
                      {inv.enforcement}
                    </ToneBadge>
                  </span>
                </div>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  {inv.detail}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Programs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="glass-panel border-white/8 mx-auto w-full max-w-[28rem] lg:max-w-none">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4 text-emerald-400" />
              GraveScanner · eligibility
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <CopyChip text={PROGRAM_IDS.graveScanner} label="Copy scanner program ID" />
              <ToneBadge tone="brand">devnet</ToneBadge>
            </div>
            <ul className="space-y-1.5">
              {SCANNER_IX.map(([name, desc]) => (
                <li key={name} className="text-[12.5px] leading-relaxed">
                  <span className="font-mono text-emerald-300">{name}</span>
                  <span className="text-slate-500"> — {desc}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="glass-panel border-white/8 mx-auto w-full max-w-[28rem] lg:max-w-none">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4 text-cyan-400" />
              GraveVault · settlement
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <CopyChip text={PROGRAM_IDS.graveVault} label="Copy vault program ID" />
              <ToneBadge tone="brand">devnet</ToneBadge>
            </div>
            <ul className="space-y-1.5">
              {VAULT_IX.map(([name, desc]) => (
                <li key={name} className="text-[12.5px] leading-relaxed">
                  <span className="font-mono text-cyan-300">{name}</span>
                  <span className="text-slate-500"> — {desc}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Reference tables */}
      <Tabs defaultValue="config" className="w-full">
        <TabsList className="flex h-auto flex-wrap gap-1 border-white/10 bg-white/[0.04] p-1">
          <TabsTrigger value="config" className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-200">Config</TabsTrigger>
          <TabsTrigger value="pdas" className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-200">PDA map</TabsTrigger>
          <TabsTrigger value="errors" className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-200">Error decoder</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="glass-panel border-white/8 mx-auto w-full max-w-[28rem] lg:max-w-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ListTree className="h-4 w-4 text-emerald-400" />
                  ProtocolConfig defaults
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-white/6 font-mono text-[12.5px]">
                  {[
                    ["C1 inactivity window", "7,776,000 s (90 days)"],
                    ["C2 price collapse", "≥ 9,900 bps (99%)"],
                    ["C3 minimum residual TVL", "500,000,000 lamports (0.5 SOL)"],
                    ["C4 LP burn dust threshold", "1,000 raw LP units"],
                    ["C5 locked LP", "exactly zero"],
                    ["C6 epoch confirmation", "2 consecutive epochs"],
                    ["cert_ttl_seconds", "3,600 s (floor 600 s)"],
                    ["anchor_staleness_seconds", "1,209,600 s (14 days, floor 6)"],
                    ["shares (LP/salvor/protocol)", "4000 / 4000 / 2000 bps"],
                    ["protocol share ceiling", "2,000 bps — Charter"],
                    ["max slippage", "300 bps"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className="text-right tabular-nums text-slate-200">{v}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            <div className="mx-auto w-full max-w-[28rem] space-y-4 lg:max-w-none">
              <Card className="glass-panel border-white/8">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Governance parameters</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="divide-y divide-white/6 font-mono text-[12.5px]">
                    {[
                      ["timelock (parameter changes)", `${CONFIG.timelockHours} h`],
                      ["public notice (standard upgrades)", `${CONFIG.noticeDays} days`],
                      ["emergency timelock", `${CONFIG.emergencyTimelockHours} h + ${CONFIG.postMortemDays}-day post-mortem`],
                      ["multisig", CONFIG.multisig],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3 py-1.5">
                        <dt className="text-slate-500">{k}</dt>
                        <dd className="text-right tabular-nums text-slate-200">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="pdas" className="mt-4">
          <Card className="glass-panel border-white/8 mx-auto w-full max-w-[28rem] lg:max-w-none">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-white/8 text-[11px] uppercase tracking-wider text-slate-500">
                      <th className="px-4 py-3 font-medium">PDA</th>
                      <th className="px-4 py-3 font-medium">Program</th>
                      <th className="px-4 py-3 font-medium">Seeds</th>
                      <th className="px-4 py-3 font-medium">Mutability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PDAS.map(([name, prog, seeds, mut]) => (
                      <tr key={name} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2.5 font-mono text-slate-200">{name}</td>
                        <td className="px-4 py-2.5">
                          <ToneBadge tone={prog === "scanner" ? "ok" : "info"}>{prog}</ToneBadge>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{seeds}</td>
                        <td className="px-4 py-2.5 text-slate-400">{mut}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors" className="mt-4">
          <Card className="glass-panel border-white/8 mx-auto w-full max-w-[28rem] lg:max-w-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
                <span className="flex items-center gap-2">
                  <Siren className="h-4 w-4 text-amber-400" />
                  On-chain error decoder
                </span>
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <Input
                    value={errQuery}
                    onChange={(e) => setErrQuery(e.target.value)}
                    placeholder="Code or name — try 7005"
                    className="border-white/10 bg-white/5 pl-8 font-mono text-xs placeholder:text-slate-600"
                    aria-label="Decode error code"
                  />
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {codeMatch && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-lg font-bold tabular-nums text-amber-200">
                      {codeMatch.code}
                    </span>
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {codeMatch.name}
                    </span>
                    <ToneBadge tone={codeMatch.program === "GraveScanner" ? "ok" : "info"}>
                      {codeMatch.program}
                    </ToneBadge>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-300">
                    {codeMatch.condition}
                  </p>
                </div>
              )}
              {errMatches.length > 0 && !codeMatch && (
                <ul className="space-y-1.5">
                  {errMatches.map((e) => (
                    <li
                      key={`${e.program}-${e.code}`}
                      className="flex flex-wrap items-baseline gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[12.5px]"
                    >
                      <span className="font-mono font-semibold tabular-nums text-amber-300">
                        {e.code}
                      </span>
                      <span className="font-mono text-slate-200">{e.name}</span>
                      <span className="flex-1 text-slate-500">{e.condition}</span>
                      <ToneBadge tone={e.program === "GraveScanner" ? "ok" : "info"}>
                        {e.program === "GraveScanner" ? "scanner" : "vault"}
                      </ToneBadge>
                    </li>
                  ))}
                </ul>
              )}
              {!errQuery && (
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  Scanner codes run 6000–6034, vault codes 7000–7022.
                </p>
              )}
              {errQuery && errMatches.length === 0 && !codeMatch && (
                <p className="text-[12.5px] text-slate-500">
                  No match — codes run 6000–6034 (GraveScanner) and 7000–7022 (GraveVault).
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
