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

## Session 2026-11-17 (Opus/Fable takeover) — shard regressions on ce3847c

Owner decision (2026-11-17): Polygon and Arbitrum stay ENABLED in production as
configured. No route changes. The audit branch's `137:6 proven: false` gate is a
code-level change only; it must be raised with the owner before any deploy.

Full release-shard run on ce3847c (log: ~/.thence/incident-f1ca0926/shards-ce3847c-partial.log,
stopped during S3 to fix failures): S1 1 failed / 905 passed; S2 2 failed /
142 passed; S3 partial: p4 11 failed, p6 1 failed, a3a 1 failed.

Diagnosis and resolution (none weakens a safety invariant):

| Failure | Root cause | Resolution |
| --- | --- | --- |
| ui-reauth-recovery "same wallet signs in again" | Not a blocked recovery: claim ran once; the test expected the old one-argument call | Assert the claim runs with the authorized terms for THIS transfer/swap |
| NEW defect N1 (P0 for delivery): claim-safety output floor = 100% of request | Decoded on-chain: all 7 Thence Polygon deliveries had provider minAmountOut = exactly 99%; f1ca0926 quotes were 98.48-98.72%. A 100% floor refuses every real claim (NIM locked until timeout) | `CLAIM_OUTPUT_FLOOR_BPS = 9700` in src/domain/claim-deadline.ts; guard uses `minimumClaimOutput`; tests accept 300000/297000/296150/295446/291000 and refuse 290999/150000/1 before disclosure |
| NEW defect N2 (P1): omitted provider term treated as durable SWAP_MISMATCH | An incomplete provider answer (missing address/version/amount) was recorded as identity_mismatch, blocking later evidence-gated closes | `providerTermsIncomplete()` (htlc-preflight.ts): reconcile records PROVIDER_UNAVAILABLE (transient); settlement skips the drift verdict (delivery still needs full bound identity) |
| settlement.test wrong-chain reason | Chain is a bound term; drift check precedes route check | Expect "settlement terms differ from the bound payment" (still INVALID, 422, state unchanged) |
| reconciliation refund-unverified | Changed contract is now SWAP_MISMATCH (409) before refund evidence; foreign-event receipt is INCONCLUSIVE via pointer fallback + scan | Test asserts both, plus no state change |
| p4 (11) | Suite canary "42161:6,42161:7" replaced the test-wide 137:6 opt-in | Suite canary includes 137:6 |
| p6 unverifiable refund | Same as reconciliation (SWAP_MISMATCH) | Expect SWAP_MISMATCH; SERVER_FUNDED, no terminal row |
| a3a wrong HTLC / amount | Bound-terms check refuses before the funding verifier | Expect HTLC_TERMS_MISMATCH (409), state unchanged |
| settlement "ignores forged" / "reports pending" / F9.2 in one run | Knock-on of the loop test exceeding 300 s on this PC; both pass alone | Re-run file in isolation (in progress) |

Correction to earlier reports: "no on-chain operation" does NOT rule out a bundler
accepting the operation and never including it.

## Session 2026-11-17 (continued) — state at c7e01b0

PR #84 head 7a26fe9: build, lint, integration, e2e all SUCCESS.
PR #85 (draft, base fix/arbitrum-claim-execution) heads:
- 646ea18: CI integration failed only on r2-nim-return-resolution (:310, :383).
- f1fef58: fixed R2 (Codex's B15 edit had dropped the client-side movement
  invariant; clientrefunded was counted as server-side). CI build/lint/
  integration SUCCESS on f1fef58 (all shards, incl. the settlement loop test
  that times out from the operator PC); e2e superseded by the next push.
- c7e01b0: output floor replaced by a quote-bound policy (see below). CI pending.

Output floor (supersedes the fixed 97% of 646ea18): auto >= 99%; 97-99% only
after explicit payer acceptance of the exact minimum (claim bound to it,
0.25% re-quote tolerance, never < 97%); < 97% refused before disclosure.
Preview runs BEFORE claim-intent (no lease) via the same public endpoints the
SDK uses (Arbitrum /dex-calldata/fund estimated_amount_out; Polygon
redeem-and-swap-calldata min_amount_out). Preview unavailable => strict 99%.
E2E simulator now uses a realistic 99% min_amount_out.

Owner decision conflict (unresolved, owner must choose before deploy): #84
gates new Arbitrum payments in code; #85 also gates Polygon (137:6 unproven).
Keeping both routes open after deploy needs
THENCE_CLAIM_EXECUTION_CANARY=137:6,42161:6,42161:7 (or changed defaults).

Next: CI on c7e01b0; production build; readiness report, Hermes deployment
plan and per-chain controlled-test procedures (docs/PAYMENT_READINESS_2026-11-17.md);
independent challenge review; remaining atlas/matrix deliverables.

## Resume

Read this checkpoint, git status and final audit report when present. Preserve
unrelated work. Reuse retained evidence and harnesses rather than restarting.
Check exact SHA for CI. Continue authorized engineering without production
actions. Never invent the historical exception from a simulated fault.
