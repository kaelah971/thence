# Release preflight and execution plan (prepared 2026-11-04)

**Status: PLAN ONLY.** Nothing in production, Vercel, Neon, GitHub or Hermes
has been changed. Every step marked **[APPROVE]** needs the owner's explicit
go-ahead at the time it runs.

## 1. Release candidate

| Item | Value |
|---|---|
| Branch | `s0-recovery-test-foundation` (clean tree) |
| Head | `78b3fc9` P7 + this preflight commit |
| Base | `main` = `origin/main` = `1f28983` (the deployed incident build) |
| Ahead of main | 11 commits: S0, P4, P2, P1, P6, P5 (×2), P3, P7 (×3) — fast-forward, no merge conflicts |
| Verified | 782 tests / 65 files (S1–S4), 22 browser E2E runs (simulated host/provider/chain), typecheck, lint, build |
| Not verified | remote CI (never pushed); real Nimiq Pay, Satora, Lightning, Polygon |

The release artifact is whatever Vercel builds from the merged commit with the
Production env. The local P7 release build had the payment/claim flags OFF;
production's flags come from Vercel env (§5).

## 2. GitHub and Vercel behaviour (observed, read-only)

- Remote `origin` = `github.com/kaelah971/thence`, **private**, default `main`.
- Vercel project `thence` (team `kaelah-s-projects`) is **git-connected**:
  Vercel posts commit statuses on `main`, and the current Production
  deployment was created 17 s after `1f28983` was pushed.
  - **Push/merge to `main` ⇒ automatic Production deployment.**
  - **Push of any other branch ⇒ Preview deployment** (Vercel default).
- Vercel env scopes: `DATABASE_URL`, all pilot vars and both
  `NEXT_PUBLIC_THENCE_ENABLE_*` flags are **Production-only**; only
  `THENCE_APP_ORIGIN` is also in Preview. A preview of this branch therefore
  has **no database URL** and cannot reach production data (it fails closed).
- **`CRON_SECRET` is not set in Production** — the P6 cron endpoint
  currently answers 503 (fail-closed). Required for Hermes.
- Production also has no `THENCE_SATORA_BASE_URL` (defaults to Satora) and
  no `THENCE_ALLOWED_ORIGINS` (defaults to the app origin) — as intended.
- GitHub Actions triggers: `push` to `main`, `pull_request`,
  `workflow_dispatch`. A PR runs CI **without** a production deployment
  (it does create a Preview, see above).

## 3. Remote CI isolation

`.github/workflows/staging-build.yml`: `build` (dummy DB URL), `lint`,
`integration` (anchor-proven TEST DB → shards S1–S4) and `e2e` (TEST DB +
simulated externals). The only repository secret is
`THENCE_TEST_DATABASE_URL`; no production credential, no Vercel token, no
financial execution. Every live job first runs `tests/ci-verify-test-db.ts`,
which refuses any database without the `__thence_test_anchor` row. Jobs
sharing the test DB are serialized (`concurrency: thence-test-database`).
Remote CI has never run with these jobs — first run happens on the PR (§9
step 2).

## 4. Production migrations 0015 · 0016 · 0017

| File | Change | Additive | Used by |
|---|---|---|---|
| 0015_p4_transfer_transitions | `CREATE TABLE transfer_transitions` (+FKs, 2 indexes, actor CHECK) | yes | P4/P5/P3 audit — every status write |
| 0016_p2_claim_deadline | `ALTER TABLE swap_attachments ADD COLUMN evm_refund_locktime timestamptz NULL` | yes | P2 deadline, P3 claim gate |
| 0017_p6_job_leases | `CREATE TABLE job_leases` | yes | P6 cron lease, P3 claim lease |

**Compatibility.** The live build (`1f28983`) never references these objects,
so the schema can be migrated **before** the deploy with no downtime. The new
build **requires** them (status writes insert audit rows), so the order is
strictly *migrate → deploy*. Existing rows need no backfill: P2 backfills
`evm_refund_locktime` on the next verified provider read; legacy transfers
without audit rows are checked non-strictly by `src/lib/consistency.ts`.

**Procedure [APPROVE]** — operator laptop, owner role, production env file
loaded only for this process:

1. Pre-checks (read-only): pilot switch `DISABLED`
   (`npx tsx scripts/pilot-switch.ts status --production`);
   `SELECT count(*) FROM drizzle.__drizzle_migrations` = **15** (0000–0014);
   `transfer_transitions`, `job_leases` and `swap_attachments.evm_refund_locktime`
   absent; no transfer in `CLIENT_FUNDED`/`SERVER_FUNDED`/`CLAIMING`; table
   row-count + content fingerprint recorded.
2. Backup **[APPROVE]**: in the existing Neon project, create a branch from
   production `main` at the current point in time (e.g.
   `pre-0015-2026-11-xx`). No new project. Note the branch id.
3. Apply (all pending migrations in one drizzle transaction):
   `THENCE_MIGRATE_PRODUCTION=I_UNDERSTAND npx tsx --env-file=%USERPROFILE%\.thence\production.env src/db/migrate.ts`
   (`npm run db:migrate` refuses production by design; `dotenv/config` does
   not override the already-set production `DATABASE_URL`).
4. Post-checks: tracked = **18**; the three objects exist; fingerprint shows
   only the new empty objects; the live build still serves (`/api/health`).
5. Rollback: none expected (additive). If required before the new build has
   written anything: `DROP TABLE job_leases; DROP TABLE transfer_transitions;
   ALTER TABLE swap_attachments DROP COLUMN evm_refund_locktime;` and delete
   the last three `drizzle.__drizzle_migrations` rows — or restore from the
   step-2 Neon branch. After the new build has written audit rows, roll the
   *deployment* back instead and keep the schema (old code ignores it).

## 5. Feature flags and pilot keys

| Key | Where | Release value | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_THENCE_ENABLE_PAYMENT` | Vercel Prod (build-time) | `1` | inlined at build; value currently unknown (sensitive) — owner confirms in dashboard |
| `NEXT_PUBLIC_THENCE_ENABLE_CLAIM` | Vercel Prod (build-time) | `1` | must be ON in the artifact used for the pilot, or Finish delivery is paused |
| `THENCE_PILOT_ENABLED` (KEY 1) | Vercel Prod | `1` | inert without KEY 2 |
| `THENCE_PILOT_OWNER_NIMIQ_ADDRESSES` | Vercel Prod | owner's address only | |
| `THENCE_PILOT_MAX_TARGET_ATOMIC` / `_MAX_TRANSFERS` / `_MAX_SPEND_ATOMIC` | Vercel Prod | `300000` / `1`¹ / `300000`¹ | ¹ eddaa6de is still `RECONCILING` and counts as exposure until closed (P4 owner close, or raise to 2 / 600000) |
| `CRON_SECRET` | Vercel Prod | new, ≥ 32 random chars | needed by Hermes and the daily Vercel cron |
| KEY 2 `pilot_controls.enabled` | production DB | **FALSE** during deploy and smoke | flipped only for the payment window, then back |

**Recommendation: one artifact.** Deploy the release with the flags and KEY 1
already in their pilot values and KEY 2 **DISABLED**. The server then refuses
every new funded step (`403 PILOT_DISABLED`), so the pilot later runs the
exact build that was smoke-tested; opening the window is a single
KEY 2 flip, with no redeploy.

## 6. Credential rotation (prepared — docs/CREDENTIAL_ROTATION_PLAN.md)

Unchanged plan, re-sequenced into this release:

- **Phase 1 (production) [APPROVE]**: create `thence_app` least-privilege
  role (no DDL) → grants (run *after* the migrations, so the new tables are
  covered; default privileges cover future ones) → set Vercel Prod
  `DATABASE_URL` to the pooled `thence_app` URL (interactive, never echoed)
  → the release deploy picks it up → verify → **reset the exposed owner
  password** (kills every URL in old deployment sources) → update
  `~/.thence/production.env` with an editor. Rollback is possible only until
  the password reset.
- **Phase 2 (test) [APPROVE]**: reset test-project password, update local
  `.env` and `gh secret set THENCE_TEST_DATABASE_URL`, re-verify the anchor.
- **Phase 3 (historical deployments) [APPROVE]**: inventory, keep current +
  one rollback target, remove the rest; confirm source protection.
- Separation: production URL only in Vercel Prod + operator file; test URL
  only in local `.env` + GitHub secret; Preview scope gets neither.
  `.vercelignore` now also excludes `e2e/.run/` (run-only test keys/certs)
  and `.next-e2e/`.

## 7. Hermes (prepared — ops/hermes/)

`thence-reconcile.timer` (every 2 min, `AccuracySec=10s`, no replay burst)
→ `thence-reconcile.service` (oneshot, dedicated user, systemd hardening,
`LoadCredential` for the secret) → `thence-reconcile.sh` (https-only URL,
`flock -n`, secret piped to `curl --header @-` so it never appears in argv or
logs, 10 s connect / 75 s total, one retry for transient errors, one-line JSON
summary to journald, alerts on 401/503/other). Server-side protection is the
existing lease (5 min TTL, 30 s spacing). Install and verification steps are in
`ops/hermes/README.md` — **not executed**.

## 8. Smoke tests, rollback gates, pilot acceptance

**Read-only smoke (KEY 2 DISABLED), within 15 min of deploy:**

1. `GET /api/health` → database reachable; `GET /api/routes/public` → only
   `usdc-polygon` enabled.
2. Build ref in the app equals the merged commit's short SHA.
3. Owner signs in inside Nimiq Pay; Home and Activity load.
4. 077770a1 shows **"Not delivered — Polygon lock refunded"** with the
   Polygon-only refund text; eddaa6de shows "Checking your payment" (P4 close
   offered only with fresh expired evidence — not exercised in smoke).
5. Starting a payment is refused with the paused/disabled message (server
   `PILOT_DISABLED`); nothing is created.
6. `GET /api/cron/reconcile` without auth → **401**; with the secret (Hermes
   manual run) → **200** `completed`; `job_leases` row advances.
7. `vercel logs` (15 min): no 5xx, no pool errors, no unexpected
   `RECONCILE_FAILED`.

**Rollback gates** — any of: smoke 1–6 fails; sustained 5xx; audit-insert or
schema errors; a status change without an audit row. Action: promote the
previous production deployment in Vercel (instant; the additive schema is
compatible with `1f28983`), keep KEY 2 DISABLED, stop the Hermes timer,
investigate. Before the owner-password reset, the env change can also be
reverted.

**One-payment pilot acceptance [APPROVE]** — KEY 2 enabled for this window only:

- Exactly one transfer of 0.30 USDC to the owner-chosen Polygon address; one
  Nimiq Pay approval; NIM debit equals the amount Nimiq Pay displayed.
- Funding observed (UI shows **Finish delivery** with the correct Polygon
  deadline, ≥ 10 min before the unsafe window); owner taps once.
- One claim; transfer reaches `DELIVERED` with a receipt whose tx hash, token
  (canonical Polygon USDC), recipient and amount (= 300000 atomic) match
  **Polygonscan** independently.
- Audit trail complete and consistent (`checkTransferConsistency` strict);
  Hermes runs every ~2 min during the window; no duplicate attempt, no error.
- KEY 2 back to **DISABLED** immediately after (`pilot-switch disable`).
- **Abort** at any deviation: disable KEY 2, do not retry or start another
  payment, follow docs/PILOT_ACTIVATION.md recovery (reconcile; never manual
  claims or SQL).

## 9. Ordered execution checklist

| # | Step | Approval | Reversible |
|---|---|---|---|
| 1 | Commit this preflight locally (done in this change) | — | yes |
| 2 | **Push branch + open PR to `main` (no merge)** → first remote CI run (build, lint, S1–S4 on TEST DB, E2E) + a Preview that has no DB | **[APPROVE] push** | yes (close PR) |
| 3 | Read-only production preflight: pilot status, migration count, no funded in-flight, fingerprint | **[APPROVE] prod read** | n/a (read-only) |
| 4 | Neon backup branch of production (same project) | **[APPROVE]** | yes |
| 5 | Apply 0015–0017 to production | **[APPROVE]** | yes (additive; §4 rollback) |
| 6 | Create `thence_app` role + grants; set Vercel Prod `DATABASE_URL`, `CRON_SECRET`, flags/KEY 1 per §5 | **[APPROVE]** | yes until step 9 |
| 7 | Merge PR → automatic Production deploy | **[APPROVE] deploy** | yes (promote previous) |
| 8 | Read-only smoke §8 (KEY 2 DISABLED) | — (part of 7) | — |
| 9 | Reset exposed owner password; update operator file | **[APPROVE]** | **no** |
| 10 | Install Hermes, one manual run, enable timer | **[APPROVE]** | yes (disable timer) |
| 11 | Test-credential rotation; historical deployment cleanup | **[APPROVE]** | partially |
| 12 | Close/settle eddaa6de exposure or set caps (§5 note) | **[APPROVE]** | — |
| 13 | **One supervised 0.30 USDC payment** (§8), then KEY 2 DISABLED | **[APPROVE] real money** | **no** |

**First safe action:** step 2 — push the branch and open a PR *without
merging*. It deploys nothing to production (Preview only, which has no
database URL) and gives the first remote CI evidence. It still needs approval
because it uploads the code to GitHub and starts a Preview build.
