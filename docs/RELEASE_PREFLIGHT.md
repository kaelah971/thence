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

## 10. Step 3 result — read-only production preflight (2026-11-04)

Run with the operator production env file, one `READ ONLY` transaction,
`ROLLBACK`; no credential, user id, address or hash printed.

- **Identity:** database `neondb`, owner role; no test anchor; the configured
  test URL is a different database. Postgres 18.6.
- **Pilot switch:** `DISABLED` since 2026-11-03T15:35:24Z ("P0 incident:
  recovery engineering in progress").
- **Migrations:** 15 tracked = local 0000–0014 exactly (LF-normalised hashes;
  this Windows tree holds 0011–0014 with CRLF, which only changes the raw
  hash). Pending: **0015, 0016, 0017** — the three objects are absent.
  Run the production migration from LF files (pin
  `src/db/migrations/*.sql eol=lf` before step 5).
- **Incidents:** 077770a1 `REFUNDED` (observations: serverfunded 21:30Z,
  clientfundedserverrefunded 2026-11-03 12:32Z; no settlement proof).
  eddaa6de `RECONCILING` since 2026-11-02 13:18Z; provider `expired` ×3, no
  fund/claim tx, invoice expired 2026-11-02 14:24Z — eligible for the P4
  evidence-gated owner close after deploy.
- **In flight:** no live handoff attempt. 22 rows in CLIENT_FUNDED /
  SERVER_FUNDED / CLAIMING and 16 other non-terminal rows are **pre-S0 test
  artifacts** (test swap-id patterns, owners created 2026-10-27/29, invoices
  expired). The only real non-terminal transfer is eddaa6de (unfunded).
- **Pilot exposure (owner):** eddaa6de only, 300000 atomic, no actual spend.
- **Audit/observations:** 70 observations (68 observation, 2 provider_error);
  no transition table yet.
- **Row counts (fingerprint):** transfers 90, swap_attachments 44,
  handoff_attempts 65, reconciliation_observations 70, transfer_proofs 48,
  users 537, sessions 619, recipients 40, recipient_destinations 33,
  pilot_controls 1.

**Verdict: GO to prepare the additive migrations** (steps 4–5, each still
needing approval). Not migration blockers, but decide before deploy (step 7):
the ~38 non-terminal **test-artifact rows** will become P6 cron candidates
(provider 404s recorded as `provider_error` observations, budget spent on
them) — quarantine/close them in a separately approved data operation, or
accept the noise.

## 11. Tracked reliability risk — recipient default switching

CI run 41871083400 attempt 1: `recipients.test.ts` "keeps exactly one default
under concurrent switches" (500 `DESTINATION_FAILED`) and `f3-data.test.ts`
preferred-wallet switch failed; both passed on re-run and locally. Code
unchanged since the initial release (`src/lib/recipients.ts`: advisory lock +
unique-index backstop + 3× retry on 23505). Root cause not established — it
may be retry exhaustion under remote DB latency, a different transient error
masked by the route's generic 500, or a real race. Not on the payment path.
Status: **open, tracked**; not classified as a database-only issue.

## 12. Step 4 status — backup branch (BLOCKED on control-plane access)

- **Not created.** Creating a Neon branch needs the Neon control plane (console,
  `neonctl` or an API key). None is configured on the operator machine; the
  production *database* credential cannot create branches, and no workaround
  was attempted. Production data, connections, pilot switch: unchanged.
- **Migration-hash finding resolved (commit `87cffea`):** `.gitattributes`
  pins `src/db/migrations/*.sql` (and journal JSON) to LF; the working tree was
  refreshed. All 18 files now hash identically raw and LF-normalised, so
  drizzle will record canonical hashes for 0015–0017 from this checkout, and
  0000–0014 match production's tracked hashes exactly.
- **To proceed (owner):** either (a) authenticate the CLI once —
  `npx neonctl@latest auth` (browser OAuth; no key is shown to the agent) — so
  the branch can be created and verified, or (b) create it in the Neon console
  (project containing the production database → Branches → Create branch from
  the production/primary branch, "current point in time", name
  `pre-release-0015-20261104`) and share only its name/ID for read-only
  verification.

## 13. Step 4 result — production backup branch (2026-11-04, VERIFIED)

Neon access via `neonctl` (owner OAuth). Production was identified by
matching the production `DATABASE_URL` endpoint, not by name:

| | |
|---|---|
| Organization | `Thence` (`org-polished-forest-85191582`) |
| Project | `thence` — `restless-haze-69652455` (aws-us-east-2, Postgres 18, PITR history 6 h) |
| Production endpoint | `ep-rapid-… (production read-write endpoint; full id in the operator env file)` (read_write) |
| Production branch | `production` — `br-crimson-term-b4l6luj2` (default, primary, the only branch) |
| **Backup branch** | **`pre-release-0015-20261104` — `br-odd-snow-b4w1k3i6`** |
| Parent / point | `br-crimson-term-b4l6luj2` at LSN `0/A82D600`, created 2026-11-04T18:16:35Z |
| Backup compute | `ep-weathered-… (backup read-only endpoint)`, **read_only** (verification cannot write) |

Verification (read-only transactions on both; credentials never printed):

- Backup is read-only (`transaction_read_only=on`, in recovery).
- 15 migrations tracked; 0015–0017 not applied; `transfer_transitions`,
  `job_leases`, `swap_attachments.evm_refund_locktime` absent — on both the
  backup and production.
- Records present: 077770a1 `REFUNDED`, eddaa6de `RECONCILING`; the same
  status distribution (90 transfers) as the step-3 preflight; pilot switch
  `DISABLED` (2026-11-03T15:35:24Z).
- **Row counts: identical** to production for all 15 tables (step-3
  fingerprint unchanged). **Content fingerprints identical** for transfers,
  swap_attachments, handoff_attempts, reconciliation_observations,
  transfer_proofs, pilot_controls, users, recipients, recipient_destinations.
- Production unchanged: no row, setting or switch differs; only a new branch
  was added to the project.

Migration hashes (corrects the `87cffea` message): production recorded
0000–0013 from LF files and **0014 from a CRLF copy** (its hash equals the
CRLF variant). Drizzle selects pending migrations by journal timestamp, not
hash, so step 5 applies exactly 0015–0017; from this LF-pinned checkout they
are recorded with canonical LF hashes. 0014's tracked hash stays as recorded
(cosmetic; do not edit it).

Recovery and limitations:

- Restore = Neon "restore branch" of `production` from
  `br-odd-snow-b4w1k3i6` (or repoint the app to it) — loses every production
  write after LSN `0/A82D600` (sessions, auth challenges, any later
  transfers). Prefer the additive-rollback SQL (§4) or a deployment rollback;
  this branch is the last resort.
- Independent of the 6 h PITR window; the branch has no expiry and counts
  toward the project's branch limit until deleted.
- Database only — not Vercel env, code or deployments.
- **Security:** the branch copied production's roles **with their current
  (exposed) passwords**. Resetting the password on `production` during
  credential rotation does **not** change it on this branch. During rotation
  Phase 1, also reset the role password on `br-odd-snow-b4w1k3i6` or delete
  its compute endpoint (keep the branch), and delete the branch once the
  release is stable.

## 14. Step 5 result — production migrations 0015–0017 APPLIED (2026-11-04)

Runner: the documented `src/db/migrate.ts` with
`THENCE_MIGRATE_PRODUCTION=I_UNDERSTAND`, invoked through a wrapper that loads
`DATABASE_URL` only from the operator production env file and refuses unless
its endpoint is `ep-rapid-… (production read-write endpoint; full id in the operator env file)` (branch `production`) and no test
anchor exists — instead of `--env-file`, so a CLI that ignored the flag could
never fall back to `.env`. Files: canonical LF (0016 is a single line).
Drizzle ran the three pending migrations in one transaction.

| Check | Before | After |
|---|---|---|
| Endpoint / branch | production / `br-crimson-term-b4l6luj2` | same |
| Backup `br-odd-snow-b4w1k3i6` | ready | (unchanged) |
| Pilot switch | DISABLED (2026-11-03T15:35:24Z) | **DISABLED**, unchanged |
| Tracked migrations | 15; pending 0015, 0016, 0017 | **18**; none pending |
| 0014 tracked hash | `e35a13d0…` (CRLF variant) | **unchanged** |
| 0015–0017 tracked hashes | — | canonical LF |
| `transfer_transitions`, `job_leases`, `swap_attachments.evm_refund_locktime` | absent | **present**; 0 rows / all NULL |
| Real in-flight | eddaa6de RECONCILING (unfunded); 0 live attempts | same |
| Row counts (10 money/account tables) | transfers 90 … payment_requests 8 | **identical** |
| Content fingerprints (pre-existing columns) | recorded | **identical** for all 10 tables |
| Live app (old build `1f28983`) | — | `/api/health` 200, db reachable |

No unexpected change. Nothing deployed; the new code is still undeployed.

## 15. Step 6 result — app role + Vercel Production env (2026-11-04)

**Database (project `restless-haze-69652455`, branch `production`):**
- Role `thence_app` created by SQL as the owner (Neon accepts only plaintext
  passwords; a locally generated 256-bit password was sent over TLS, never
  printed or logged). A first attempt with a client-computed SCRAM verifier
  was rejected by Neon and rolled back with no effect.
- Grants: `CONNECT` on `neondb`; `USAGE` on schema `public`;
  `SELECT, INSERT, UPDATE, DELETE` on all public tables; `USAGE, SELECT` on
  public sequences (none exist); default privileges from `neondb_owner` for
  future tables/sequences. Attributes: `NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS`. No DDL rights.
- Verified as `thence_app`: login OK; 17 tables incl. `transfer_transitions`
  and `job_leases` with exactly S/I/U/D (no TRUNCATE/REFERENCES); reads and
  transaction-scoped advisory locks work; CREATE/DROP/ALTER TABLE, TRUNCATE
  and `drizzle.__drizzle_migrations` access are refused.
- Owner role and its (exposed) password unchanged, as instructed. Backup
  branch untouched (it predates `thence_app`).

**Vercel (project `thence`), Production scope only, values via stdin:**
- `DATABASE_URL` → updated to the pooled `thence_app` URL (same host/options
  as before, only the role changed). `vercel env update` succeeded.
- `CRON_SECRET` → added, Sensitive, 64 chars (`base64url` of 48 random
  bytes).
- Flags: Vercel stores them as Sensitive (values not readable). The live
  production bundle inlines both `NEXT_PUBLIC_THENCE_ENABLE_PAYMENT` and
  `NEXT_PUBLIC_THENCE_ENABLE_CLAIM` as `"1"` (`{[M]:"1"}`, `{[v]:"1"}`), and the
  variables were not updated since — they already match the release plan; not
  changed. `THENCE_PILOT_ENABLED`, owner allowlist and caps: unreadable,
  **not changed** (financial limits untouched). Their values must be confirmed
  in the dashboard before the pilot (eddaa6de still counts as exposure).
- Preview scope still has only `THENCE_APP_ORIGIN`.

**Operator copies (outside the repo, owner-only ACL):**
`~/.thence/production-app.env` (app-role URL) and `~/.thence/cron-secret`
(for Hermes: copy into `/etc/thence/cron-secret` over SSH with an editor or
`scp`, never via shell history — see ops/hermes/README.md).

**No deployment / no activation:** env changes do not deploy. Production is
still `thence-5x3boyuyb` (old code, old env snapshot — still the owner URL, no
`CRON_SECRET`); both take effect only on the next production deployment
(step 7). `/api/health` 200 with db reachable on both public aliases. Pilot
switch `DISABLED`; data unchanged since step 5 (row counts + fingerprints of
10 money/account tables identical, 0014 hash unchanged); 0 live attempts.
Payment initiation stays blocked: `assertPilotDbEnabled` gates
create/requote/prepare/attach/authorize in both the deployed and release code
and the switch is FALSE.

## 16. Step 7 result — production deployment (2026-11-04)

**Pre-merge (read-only):** pilot switch DISABLED; 18 migrations, none pending;
genuine in-flight only eddaa6de (RECONCILING, unfunded); 0 live attempts; data
identical to step 5; `main`=`1f28983`, PR head=`e740dd7`. Rollback target:
`thence-5x3boyuyb` = `dpl_EAUWRHRGhH17wfsKVMMnuUQ3PmkP`.

**Cron paused before merge (owner-authorized):** the merge adds the
`/api/cron/reconcile` (`17 6 * * *`) definition and the deployment carries
`CRON_SECRET`, which would have made authenticated, record-writing runs from
the next 06:17 UTC. Project crons were disabled via the Vercel API
(`PATCH /v1/projects/{id}/crons enabled=false`, `disabledAt`
2026-11-04T19:33:20.804Z) **before** merging. Re-enabling needs separate
approval after the historical-test-row review.

**Merge/deploy:** PR #33 merged with a merge commit (head pinned to
`e740dd7`) → `main` = **`9fddc47`**. Vercel git deployment
**`dpl_2a5j43sdKneRfhWjUFC1soZusxzv`** (`thence-h9xqwvirj`), target
production, READY, source git `main`@`9fddc47`; aliases
`paywiththence.vercel.app`, `thence-two.vercel.app`,
`thence-kaelah-s-projects.vercel.app`. Project crons still disabled with the
new definition registered.

**Smoke (no financial action):**
- `/api/health` 200, env production, db reachable — both public aliases.
- Database access is via `thence_app` (server connections: the app's only
  connection is `thence_app`).
- Compiled bundle: payment flag `"1"`, claim flag `"1"`; P7 code present.
- `/api/cron/reconcile`: no auth → 401, wrong bearer → 401. The authenticated
  call was **not** made (it writes production records).
- Pages `/app/welcome`, `/app/send`, `/app/activity` 200; `/` 307 → app.
- Pilot switch DISABLED; payment preparation is refused server-side
  (`assertPilotDbEnabled` → 403 `PILOT_DISABLED`) before any record or Nimiq
  Pay call.
- Data: row counts and content fingerprints of 10 money/account tables
  identical to step 5; `transfer_transitions`/`job_leases` empty; 0014 hash
  unchanged.
- Runtime logs (24 entries): 0 × 5xx, 0 permission errors, 0 secret leaks;
  only the `pg` sslmode deprecation warning (benign; set
  `sslmode=verify-full` explicitly in a later change).

**Open items:** owner phone checks (below); the `PILOT_DISABLED` refusal
renders as the generic "Check the details" copy (safe, misleading — copy fix
later); recipients default-switch risk (accepted, open); historical test rows
(preserved; cron/Hermes paused until a plan exists); owner credential
rotation (deferred until smoke passes).
