# Adversarial payment audit checkpoint

Started 2026-11-16 in `C:\dev\thence-public-release`.
Baseline: `077051242fa9c1eb917efaf6ef013a0ff3d2455f` (open PR #84).
Production reference supplied by owner: `2052989`, not queried on the host.
No merge, deployment, production writes, configuration changes, financial
transactions, secret export or live canary authorization. Preserve all existing
untracked `scripts/_tmp-*` incident files.

## Initial evidence-based gap map

| Area | Observed evidence | Gap / next check |
| --- | --- | --- |
| PR #84 | GitHub build, lint, integration, E2E SUCCESS at baseline SHA | Not evidence for new changes or live settlement |
| Production delta | 36 files, three commits after 2052989 | Safety fixes not established as deployed |
| Arbitrum | v6/v7 unproven in CLAIM_PATHS; preflight gates before handoff | Historical exception absent; real sponsorship and iOS host unproven |
| Polygon | 137:6 marked proven using older deliveries | Independently verify current SDK relay and contract/recipient/amount proofs |
| Atlas | 20 machines, M9 combines multiple execution boundaries | Split SDK lifecycle, signing, delegation, sponsorship, submission and receipt |
| Harness | Existing actual-SDK Arbitrum fault tests | Check negative paths, mock limits and Polygon coverage |
| Historical conclusions | Prior summary equates no chain inclusion with no submission | No chain event does NOT rule out accepted-but-never-included operations |
| Recovery | EVM refund and NIM return are separate | EVM refund establishes neither incident's NIM return |
| Retained evidence | Incident directory: monitor log, public-provider responses | No retained browser exception established; never dump secret-bearing data |

## In progress

Updated 2026-11-17. Current branch: `fix/payment-integrity-audit`, dependent on
PR84 `fix/arbitrum-claim-execution`. PR84 now at `7a26fe9` after the narrow
classification correction (`459d7d7`) and a submission-fixture correction.
At 459d7d7 CI build/lint passed; integration S1 failed one UI test using SDK
success without an acceptance hash, so E2E skipped. That fixture is corrected
at 7a26fe9; do not report its CI green without checking the exact head.

Independent read-only reviews completed for domain/DB/reconciliation,
browser/storage/host, and Polygon SDK/chain proofs. Implementation agents hit
rate limits, then auto-resumed and completed partial changes; parent reconciled
the overlapping edits. No agents remain needed for implementation.

### Implemented, verification still in progress

- PR84: unanswered send cannot become refused after a rejected retry; matching
  RPC IDs required; success boolean alone is not acceptance; receipt reversion
  wins; concurrent observers refused; free-form provider text discarded;
  preflight errors no longer consume durable claim-report slots.
- Full and short delivery both require bound SwapRedeemed; Arbitrum delivery
  cannot weaken L1 finality via a confirmation override. Receipt fixtures and
  exact/no-redeem/foreign-redeem regressions updated by reviewer.
- Native handoff requires replay-marker write/readback before host invocation.
- Recovery validation checks local SHA256, claim key (legacy wallet fallback
  for existing swaps only), invoice checksum/hash/amount, and response ID.
  Invoice signature is NOT verified; synthetic fixtures are not valid invoices
  for any real payment.
- Claim authorization and reconciler recheck stored SWAP_ATTACHED HTLC terms.
  Missing historical records remain legacy-pinned; partial records fail closed.
- SDK observer enforces fresh terms and exact-output floor before disclosure;
  relay destination/preimage and decoded Kernel/redeem calls also checked.
  Actual installed SDK guarded-path tests added for Polygon and Arbitrum.
- Claim safety marker written before SDK invocation, not only after it returns.
- Only VERIFIED NIM source attributions block another transfer, not client
  hash hints; R2 now uses the same verified attribution query.
- New Polygon payments fail closed in this branch pending corrected-path proof.
  Only test-process simulator settings opt into 137:6; no production config changed.

### Verification performed so far

- Five classification regressions failed before fixes; 104 focused claim tests
  passed after (PR84 implementation). Original suite also had 31 UI progress
  tests pass; the separately discovered reload fixture now passes its focused run.
- Browser reviewer reports 73 tests across handoff/integrity/f42; parent ran
  12 independent integrity tests successfully. Broader rerun in progress.
- Registered payment-browser-integrity, payment-handoff-integrity,
  payment-server-integrity, payment-claim-safety in release shards.
- Do not claim current typecheck, release shards, build, E2E or live-provider
  canaries passed yet. Run all against the finished audit branch.

### Remaining engineering and evidence gaps

1. Finish guarded real-SDK tests; update legitimate simulated fixtures/E2E to
   supply correct invoice and authorized facts rather than bypassing safeguards.
2. Verify settlement also compares persisted terms, not only current provider
   facts; evaluate legacy/public proof attribution explicitly.
3. Resolve full-NIM-return closure for refund statuses with no EVM funding,
   retaining independent return and no-activity proofs; no false REFUNDED state.
4. Review Polygon first-claim lifecycle proof, historical RPC/refund scan limits,
   post-submission retries and report persistence. Do not invent terminal proof.
5. Full focused/live-TEST DB shards, typecheck/lint/build, E2E, read-only contract
   and provider checks; before-state regressions where feasible.
6. Revised atlas, chain reports, evidence/fault/invariant/defect matrices,
   rollback checklist and independent challenge review; bounded dependent PR.
7. Actual iOS Nimiq Pay behavior, live sponsorship, opaque Polygon relay policy
   and historical f1ca exception remain external unknowns. Both routes are
   FAIL-CLOSED / NOT READY for new payments in the audit branch. Production
   deployment/configuration is unchanged and has NOT been certified safe.

## Resume

Read this checkpoint, git status and final audit report when present. Preserve
unrelated work. Reuse retained evidence and harnesses rather than restarting.
Check exact SHA for CI. Continue authorized engineering without production
actions. Never invent the historical exception from a simulated fault.
