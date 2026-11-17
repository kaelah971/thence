# Payment readiness, Hermes deployment plan and controlled-test procedures (2026-11-17)

This document holds only verified repository, CI and on-chain facts. The progress
log is `docs/architecture/PAYMENT_AUDIT_CHECKPOINT.md`. Nothing here has been
deployed, merged or executed with money.

## 1. Readiness dashboard

| | Polygon (137, HTLC v6) | Arbitrum (42161, HTLC v6/v7) |
|---|---|---|
| **Verdict** | **READY FOR CONTROLLED TEST, after deploy and owner opt-in** | **BLOCKED BY EXTERNAL EVIDENCE (live sponsorship), testable as a controlled canary** |
| Historically demonstrated | 7 verified deliveries (public proofs; on-chain minAmountOut = 99%) | None. af9dc922 (contract trust) and f1ca0926 (claim never submitted) both refunded |
| Claim mechanism | Satora gasless relay (`POST /swap/:id/claim-gasless`) | Sponsored ERC-4337 UserOp (EIP-7702 Kernel v3.3, EntryPoint v0.7, Satora's Alchemy bundler and policy) plus Uniswap v3 |
| Installed SDK exercised | Yes: real `Client.claim()` against a local relay (payment-claim-safety) | Yes: real `Client.claim()` in Node, Chromium and WebKit; on-chain `eth_call` of the exact redeem with a state override passes; Alchemy accepts and estimates the operation |
| Not provable without money | Relay acceptance of the corrected guarded path; current relay policy | Live Gas Manager sponsorship and bundler inclusion for a real funded swap |
| Nimiq Pay iOS webview | Not verified (Chromium/WebKit are stand-ins) | Not verified |
| f1ca0926 root cause | n/a | **Not determinable.** The SDK error was never persisted. The only remaining evidence is Satora's logs (see §6) |

**Why Polygon can be tested but isn't "proven":** the corrected code adds guards before the
preimage is revealed. These are bound terms, a decoded-calldata check, and the output floor.
They reject only inputs that differ from the authorized terms. The realistic 99% floor of the
historical deliveries passes automatically, in tests and in E2E. What remains is the first
live run through the guarded path.

## 2. What changed since production 2052989 (PRs #84 then #85)

- No database migration and no schema change.
- New optional env var: `THENCE_CLAIM_EXECUTION_CANARY`.
- **Payment behaviour changes:**
  1. **New payments on unproven claim paths are refused before any NIM moves (`CLAIM_PATH_UNPROVEN`).**
     - With #84 alone: Arbitrum v6/v7.
     - With #85: Polygon v6 as well.
     - ⚠️ **This conflicts with the owner's "both routes stay enabled" decision.** To keep both open after deploy, set
       `THENCE_CLAIM_EXECUTION_CANARY=137:6,42161:6,42161:7` in `production.env` (owner-installed). Without it, new payments on both chains are refused.
       Existing transfers are never gated.
  2. The claim outcome is classified from evidence (submitted / not sent / unknown). "Delivery submitted" now requires acceptance evidence.
  3. Claim reports (`POST /api/transfers/:id/claim-report`) give a secret-free stage, failing step and code, plus a `thence claim-report:` journal line.
  4. Output floor:
     - ≥ 99% of the request: automatic.
     - 97–99%: only after the payer explicitly accepts the exact minimum in the app.
     - < 97%: refused before disclosure.
  5. Bound settlement terms are re-checked at claim, settlement and reconcile. Delivery requires the bound `SwapRedeemed` event. Arbitrum delivery always uses L1 finality.
  6. Recovery integrity checks; handoff and claim markers are written before invocation.
  7. A source-side refund (`clientrefunded`) closes only after the verified full NIM return.
  8. Activity shows the correct network, and the finality wait survives transient provider errors.

## 3. Verification status (exact commits)

- **PR #84 `7a26fe9`:** build, lint, integration and e2e all **SUCCESS**.
- **PR #85 `f1fef58`:** build, lint and integration (all release shards) **SUCCESS**. E2E was superseded by the next push.
- **PR #85 `d0ef632`:** build, lint, integration and **e2e** all **SUCCESS** (run 44092025907).
- **PR #85 `c7e01b0`:** e2e was cancelled because of the test-environment issues fixed in `d0ef632`. Local typecheck and lint pass. Focused suites:
  - claim-output-floor 19/19;
  - payment-claim-safety 44/44 (installed SDK, both chains);
  - ui-p3-claim-completion 25/25 (consent flow included);
  - ui-reauth-recovery 7/7;
  - R2 10/10, P4 11/11, reconciliation 21/21, p6 18/18, a3a 10/10.
- **Known local limitation:** one `settlement.test.ts` loop test exceeds its 300 s limit from the operator PC (remote DB latency). It passes in CI.

## 4. Hermes deployment plan (requires owner approval for every step)

**Preconditions:**
- The owner approves merging #84, then #85 (or #84 alone).
- CI is green on the exact head being merged.
- The owner decides on `THENCE_CLAIM_EXECUTION_CANARY`.

**Steps** (the established flow; see the Hermes notes):
1. `git -c core.autocrlf=false archive` of the merged `main` commit, then record its sha256.
2. `scp` to Hermes `/tmp`, then `sudo -n -u thence-prod /opt/thence/bin/thence-deploy production /tmp/<archive>.tgz`.
3. Owner only: install the canary value in `production.env` via the hash-verified env install, if chosen.
4. Restart at a clean reconcile boundary (`/tmp/thence-restart2.sh`). Retry if a cycle reports errors.

**Post-deploy evidence:**
- `/api/health` returns 200.
- The served chunk fingerprint matches the merged commit.
- `GET /api/routes/public`:
  - with the canary set: Polygon and Arbitrum `live`;
  - without it: both `disabled` with "paused".
- The reconciler journal shows clean cycles.
- `/api/proofs` is unchanged (same sha).
- A read-only DB fingerprint of the payment tables is identical before and after.

**Rollback:** `thence-deploy production rollback` to release `20261116T172309Z` (2052989), then restart. There is no migration to undo. Remove the canary env line if it was added.

## 5. Controlled payment test procedures (one payment at a time; owner authorization required for each)

Common to both routes:
- Use the smallest amount the route accepts (0.30 USDC; Satora minimum about 356 sats).
- Use the owner's Nimiq Pay iOS app.
- One payment only. Stop at the first unexplained result.
- Operator side, read-only: watch the reconciler journal, the `thence claim-report:` lines, and the transfer's DB state.

| Step | Check | Pass condition |
|---|---|---|
| 1 Quote | App quote vs `GET /api/routes/public` and a Satora quote | Exact-receive amount; NIM shown in Nimiq Pay before approval |
| 2 Bind | `SWAP_ATTACHED` evidence has a complete `htlc` record | Pinned HTLC/coordinator for the chain; deadline ≥ runway |
| 3 NIM | Nimiq HTLC tx verified by the reconciler (`SOURCE_EVIDENCE_RECORDED`) | Amount equals Nimiq Pay's figure; owner wallet is the sender |
| 4 Funding | Provider `serverfunded`; HTLC `SwapCreated` for the bound SwapKey | Polygon: 32 confirmations. Arbitrum: L1-finalized (about 20 min) |
| 5 Floor | The app's Finish delivery: automatic (≥ 99%) or a consent prompt with amounts | Below 97% means no claim; the payment refunds |
| 6 Claim | `thence claim-report:` line | `submitted:…` with a userop hash (Arbitrum) or relay accept (Polygon). Anything else: stop and record stage, step and code |
| 7 Inclusion | Arbitrum: EntryPoint `UserOperationEvent` for the sender. Polygon: relay tx | Success flag true; HTLC `SwapRedeemed` for the bound key |
| 8 Delivery | Recipient USDC `Transfer` in the claim tx; verify-settlement | DELIVERED (or DELIVERED_SHORT with exact amounts) only after finality |
| Recovery | If not delivered by the deadline | Provider refund is recognized (REFUNDED). NIM is reclaimable in Nimiq Pay after the Nimiq HTLC timeout, then verified on-chain (R2) |

**Arbitrum-specific prerequisites:**
- Run the AA preflight first (it's automatic in the app: chain id, EntryPoint, sponsorship stub).
- Know that live sponsorship is the one unproven external step.
- If the claim report shows `AA_SPONSORSHIP_REJECTED`, `AA_ESTIMATE_FAILED` or `RATE_LIMITED`, that is the answer the f1ca0926 incident lacked. Stop and send it to Satora.

## 6. External evidence request for Satora (f1ca0926)

Swap `347deeb2-e5ec-42ed-a846-d835b1a4eea1`, claim party `0xaE3Dd68638C7326Ad3fD2C4c9201b6437f4DfCe7`,
window **2026-11-16 18:17:50–18:20:00 UTC**. Please provide, without any secrets:
- Satora API logs for `GET /swap/347deeb2…` and `POST /dex-calldata/fund` (status, timestamp).
- Alchemy Gas Manager (policy `878b1c90-…`) decisions for sender `0xaE3D…`: stub and data requests, accept or reject, and the reason.
- Bundler `eth_estimateUserOperationGas` / `eth_sendUserOperation` from that sender: accepted or rejected, error code, userOp hash if any.
- Any rate-limit (HTTP 429 or compute-unit) events for the shared key in that window.

## 7. Required owner actions

1. Decide on the route-gate conflict (§2): the canary value, or changed defaults.
2. Review and approve merging #84 and #85 (draft).
3. Approve the Hermes deployment (§4).
4. Authorize each controlled test payment (§5), Polygon first.
5. Optional: send the §6 request to Satora.
6. Reclaim the f1ca0926 NIM in Nimiq Pay after 2026-11-19 04:55:01Z (and af9dc922 after 2026-11-18 04:54:46Z).
