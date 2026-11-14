// Protocol reference data — instruction tables transcribed from the
// canonical programs (graveyield-protocol programs/*/src/lib.rs). Pure data,
// module-free: consumed by the Protocol view and pinned by tests so a
// missing or renamed instruction is a CI failure, not a silent omission.
//
// Audit finding 5.9 correction: VAULT_IX previously omitted `sweep_dust`
// (grave-vault lib.rs — the D6 dust-recovery path whose error codes 7020/
// 7021 the same view already listed). The canonical GraveVault exposes
// exactly six instructions; GraveScanner exactly eight.

export const SCANNER_IX = [
  ["initialize", "Creates ProtocolConfig — thresholds, cert TTL, pause flag."],
  ["record_launch_price", "Init-once LaunchPrice PDA (C2 baseline) from an oracle-signed attestation."],
  ["evaluate_pool_phase_1", "Evaluates all six criteria; writes the EligibilityAnchor (first_eligible_epoch)."],
  ["evaluate_pool_phase_2", "Re-evaluates after the epoch gap; bitmap equality required; issues the EligibilityCert."],
  ["invalidate_anchor", "Multisig-only censor of a wrong Phase 1 pass."],
  ["sweep_stale_anchor", "Permissionless rent reclaim for anchors older than 14 days."],
  ["update_protocol_config", "Multisig-only bounded threshold updates."],
  ["emergency_pause", "Multisig-only pause; gates evaluate_pool_* only."],
] as const;

export const VAULT_IX = [
  ["initialize", "Creates ProtocolConfig — 40/40/20 shares, fee/slippage/dust params, pause flag."],
  ["salvage_pool", "The settlement instruction. One salvage per pool, ever."],
  ["claim_lp_proceeds", "Merkle-verified pro-rata withdrawal — live during pause."],
  // Audit finding 5.9: the D6 dust-recovery instruction, previously omitted.
  // Canonical semantics (grave-vault/src/instructions/sweep_dust.rs):
  // permissionless; transfers the ENTIRE retained vault memecoin balance to
  // the protocol treasury's ATA, closes the vault memecoin ATA (rent to the
  // caller), stamps dust_swept_at_ts; mint-bound and one-shot (7020/7021).
  ["sweep_dust", "Permissionless D6 dust recovery — retained memecoin to the treasury ATA; one-shot per pool."],
  ["update_protocol_config", "Multisig-only share updates; 20% ceiling enforced on-chain."],
  ["emergency_pause", "Multisig-only pause; gates salvage_pool only."],
] as const;
