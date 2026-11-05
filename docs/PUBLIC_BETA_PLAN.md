# Public beta — findings and release plan

Status: **PLAN ONLY — approved for documentation 2026-11-05.** Nothing here is
activated. Public payments stay OFF; production limits and the payment mode are
not changed until the security, recovery and operational requirements below are
verified and the owner approves each phase.

## Objective

- Any supported Nimiq Pay user can pay.
- Any amount the live Satora quote, liquidity and provider limits support.
- Payments continuously available (not supervised windows).
- No single-wallet allowlist, one-transfer limit or 300000-atomic pilot caps.

Preserved: provider minimum/maximum, quote expiry and swap identity validation,
idempotent/atomic transfer handling, claim deadlines, on-chain settlement proofs
and refund verification, per-user concurrency protection, anti-abuse controls and
rate limits, Hermes reconciliation and the database emergency kill switch.

## Key finding: public access is a code change, not a configuration change

`src/lib/pilot.ts` (F8.3) fails **closed** in production when the owner
allowlist is empty: every funded path (create, requote, prepare, attach,
authorize) throws `403 PILOT_NOT_AUTHORIZED`. Emptying
`THENCE_PILOT_OWNER_NIMIQ_ADDRESSES` therefore blocks all payments rather than
opening them. Public access needs an explicit, tested payment mode.

## What already holds independently of the pilot (verified in code, 2026-11-05)

| Protection | Where | Notes |
|---|---|---|
| Provider min/max | `assertSourceBounds` (`src/lib/quotes.ts`) | Every quote; currently 356 – 20,000,000 sats on `usdc-polygon` |
| Quote expiry, swap identity, idempotency, claim deadline, settlement proof, refund verification | transfers / handoff / claim-intent / settlement / reconcile | Not pilot-gated |
| **One unresolved payment per user** | `assertFundingExposure` | Applies with the pilot OFF (limit 1). Keep as the per-user concurrency limit |
| Per-user rate limits | `THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE` 60, `THENCE_QUOTES_RATE_PER_MINUTE` 30, `THENCE_TRANSFERS_READ_RATE_PER_MINUTE` 120 | Keys `user:{id}` |
| Anonymous limits | challenge 30/min per key, `THENCE_ANON_GLOBAL_PER_MINUTE` 600 | Stored in Postgres; no edge enforcement yet |
| Emergency stop | `pilot_controls.enabled` (KEY 2) | Instant, every deployment, recovery paths unaffected |
| Hermes | `/api/cron/reconcile`, 2-minute timer | Read/verify only; never claims or pays |

## Required code changes (one public-beta PR, draft + CI only)

1. **Explicit payment mode** — `THENCE_PAYMENTS_MODE = off | pilot | public`
   (missing/invalid ⇒ off, fail-closed). `pilot` keeps today's allowlist and
   caps; `public` admits any authenticated Nimiq Pay wallet. KEY 2 (database
   switch) remains mandatory on top in every mode.
2. **Pilot limits removed in `public` only** — no allowlist, no one-transfer
   limit, no 300000-atomic per-transfer/cumulative caps. Amounts bounded by the
   provider quote limits.
3. **Service-wide circuit breakers** (bounds on the system, not per-user caps;
   configurable, fail-closed, refusal message "Payments are temporarily
   limited"):
   - total open funding exposure across all users;
   - daily volume across all users;
   - payments per user per day;
   - optional beta per-transfer ceiling (default = provider maximum).
4. **Anti-abuse** — new-account velocity limit before the first funded payment;
   edge rate limiting / WAF (OPERATIONS.md §3, still HOST_INTEGRATION_PENDING —
   today's limits are Postgres rows, so spam becomes database load);
   quarantine or clean the pre-S0 test rows in production (33 malformed swap
   ids, 2026-10-27 test users/transfers).
5. **Reconciliation capacity** — today ≤ 10 transfers per run, 45 s budget,
   every 2 min from one Hermes host (≈ 10 concurrent in-flight payments before
   updates lag). Raise the batch (code allows up to 50), add a second scheduler
   (Vercel Pro cron as backup), alert on backlog / stale lease.
6. **Dependencies** — keyed Polygon RPC with an independent fallback (replace
   the shared keyless gateway); confirm Satora rate limits from shared Vercel
   egress; trusted Nimiq RPC for balances.
7. **Observability** — log drain (Hobby keeps ~1 h of runtime logs) and alerts:
   Hermes failure/stale lease; funded payment within 15 min of its deadline;
   refunds; settlement `INVALID`; 5xx; rate-limit spikes; database
   connections; exposure near a circuit breaker.

## Prerequisites before any public activation

| # | Requirement | Work | Owner |
|---|---|---|---|
| 1 | Release the mobile UX fixes (PR #37) | CI green on head → merge → production deploy with KEY 2 DISABLED → smoke | Approved 2026-11-05 |
| 2 | Resolve the exposed production database credential | `docs/CREDENTIAL_ROTATION_PLAN.md` phases 1–3, **plus** reset/remove the endpoint of backup branch `br-odd-snow-b4w1k3i6` (copied the exposed password) | Approved as a launch milestone; executed separately |
| 3 | iOS recovery-material persistence | No-money diagnostic page (IndexedDB / localStorage / cookie markers) tested in Nimiq Pay iOS across app switch, lock, swipe-away, memory pressure; document the safe failure path | Build: engineering. Device test: owner |
| 4 | Public-access risk audit | Spam, cost exhaustion (Vercel invocations, DB, RPC, Satora calls per payment), concurrency, reconciler capacity; load test on the TEST database | Engineering |
| 5 | Alerts and bounded service limits | Items 3, 5, 7 above | Engineering + owner alert channel |
| 6 | Public-beta configuration, tests, rollback | Mode + breakers unit tests; multi-user E2E; failure-injection (RPC / provider / Hermes down); rollback runbook | Engineering |

### Safe failure path if iOS loses recovery material (to verify in #3)

Finish delivery is refused before anything is revealed (vault/readback gate) →
the provider refunds its Polygon lock after the claim deadline → the Lightning
hold invoice is not settled → Nimiq Pay returns the NIM on its own HTLC timer.
Outcome: not delivered, no double payment, no loss to a third party — the
2026-11-02 (077770a1) path. Until verified: stay in Nimiq Pay between approval
and Finish delivery (`docs/RISK_IOS_WEBVIEW_STORAGE.md`).

## Owner decisions

- **Hosting:** the Vercel team is on **Hobby** (verified 2026-11-03), intended
  for personal non-commercial use, daily-only cron. A public payment product
  should move to **Pro** (also per-minute cron, firewall).
- **Legal / compliance:** public, any-amount money movement may carry money
  transmission, sanctions and KYC/AML obligations; terms of service and privacy
  policy. Owner/counsel decision; nothing in code addresses it.
- **Initial circuit-breaker values** (cautious start, raised with evidence).
- **Paid RPC provider** and **alert channel**.
- **Accepted limitation:** every payment needs the sender's explicit Finish
  delivery on the same device within ≈ 1 h of swap creation. Missed claims end
  as refunds (support load, not loss).

## Release plan (each phase needs owner approval)

1. **UX release** — PR #37 merged and deployed; KEY 2 DISABLED; smoke.
2. **Security** — credential rotation; WAF/edge limits; test-data cleanup;
   hosting plan.
3. **iOS storage diagnostic** — page built and device-tested; failure path
   documented.
4. **Public-beta PR** — mode, circuit breakers, reconciler scaling, keyed RPC,
   alerts, tests, load test (draft PR + CI; no production change).
5. **Staging** — deploy public-mode configuration with KEY 2 DISABLED; verify
   fail-closed behaviour, breakers and alerts.
6. **Soft open** — KEY 2 ON with conservative breakers under monitoring;
   raise limits stepwise on evidence.
7. **Rollback (any phase)** — KEY 2 OFF (instant; claims, verification and
   refunds keep working) → mode back to `pilot`/`off` + redeploy → promote the
   previous deployment. Never manual SQL on funded transfers.

## Current recommendation

**NO-GO for public payments** until phases 1–3, the hosting decision and the
legal decision are complete. Phase 4 can proceed as a draft PR without touching
production.
