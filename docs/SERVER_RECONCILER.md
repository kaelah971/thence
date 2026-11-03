# Server-side reconciliation (P6)

`GET /api/cron/reconcile` runs one bounded batch of the SAME reconciliation
core the owner route uses (`reconcileCore` in `src/lib/reconcile.ts`, system
actor), so payments advance from provider and chain evidence even when no
browser is open. No second state machine exists.

## Scheduling constraint — verified 2026-11-03

The project's Vercel team (`kaelah-s-projects`) is on the **Hobby** plan
(read via the Vercel API: `billing.plan = "hobby"`, active, no trial).
Vercel's documentation (cron-jobs/usage-and-pricing) states:

- Hobby: cron jobs run **at most once per day**, invoked **anywhere within
  the scheduled hour (±59 min)**; "Cron expressions that would run more
  frequently will fail during deployment."
- Pro: once per minute, per-minute precision.
- Vercel does **not retry** failed invocations, may **overlap** long runs,
  and may **deliver the same run more than once** (best effort).

**Therefore a two-minute reconciliation objective is NOT achievable with
Vercel Cron on the current plan.** `vercel.json` ships a Hobby-valid daily
schedule (`17 6 * * *`) so the deployment does not fail. A `*/2 * * * *`
schedule would break the deployment on Hobby.

Options (owner decision; none implemented beyond the endpoint):

| Option | Cadence | Notes |
|---|---|---|
| Upgrade the team to Pro | every 1–2 min (`*/2 * * * *`) | Change `vercel.json` schedule only; no code change |
| External scheduler calling the endpoint with the bearer secret (e.g. GitHub Actions `schedule`, an uptime/cron service) | GitHub Actions: ≥ 5 min and best-effort (often delayed); dedicated cron services: 1 min | Same endpoint and auth; the lease absorbs overlap and duplicates. Requires storing `CRON_SECRET` in that service |
| Keep Hobby daily cron | ~daily | Browser-driven P1 tracking remains the timely path while the owner has the app open; the cron is a safety net for abandoned payments |

Note the claim window is ~1 h from swap creation (P2). Even with a 1–2 min
cron the server only *observes* — claiming is an owner action (P3 not
started), so server cadence affects how quickly status/exposure is updated,
not whether a claim happens.

## Configuration

- `CRON_SECRET` (Vercel env, Production; ≥ 32 random characters). Vercel
  sends it as `Authorization: Bearer <secret>`. Without it the endpoint
  returns 503 and does nothing (fail closed). Never logged or returned.
- Migration 0017 (`job_leases`) must be applied before the first run
  (operator, explicit approval).

## Safety properties

- Never claims, releases preimages, pays, creates swaps/invoices, refunds,
  clears uncertain exposure, or applies P4's owner-only `EXPIRED_UNFUNDED`
  close. Not gated by the pilot kill switch (recovery, not new funding).
- Terminal transitions (e.g. `REFUNDED`) require the same identity checks
  and independent on-chain refund verification as the owner route.
- Two-phase core: provider/RPC calls happen with NO lock held; the commit is
  a short transaction under the per-transfer advisory lock that re-reads
  state and plans from the current status — concurrent browser (P1) and cron
  reconciliations converge to one transition (audit rows prove it).
- Identical observations within 60 s are not re-inserted.
- Single runner: an atomic lease upsert (`job_leases`), TTL 5 min, minimum
  spacing 30 s between run starts (absorbs duplicate deliveries/replays).
- Bounded work: ≤ 10 transfers per run, 45 s budget, sequential; due
  intervals per transfer — funded 1 min (2 min after the deadline), pre-
  funding 2 min (10 min after invoice expiry), provider `expired` 6 h,
  failed reads ≥ 5 min; priority = soonest open claim deadline first.

## Observability

Each run returns and logs one line `thence-reconciler {json}` with: run id,
duration, candidates, due, reconciled, deferred-by-budget, error counts by
code, and `{transferId, from, to}` for each advance. The same summary is
stored in `job_leases.last_summary`. No invoices, hashes, addresses, tokens
or credentials are included.
