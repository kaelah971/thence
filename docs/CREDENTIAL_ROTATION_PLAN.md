# Credential rotation plan — Neon production + test (prepared 2026-11-03)

**Status: Phases 1–2 EXECUTED 2026-11-05 (owner-approved); Phase 3 (deleting
historical deployments) NOT executed.** See "Execution record" at the end. No
secret values appear in this document.

## Why

`docs/S0_SECURITY_LOG.md` §3: until S0, Vercel CLI deployments uploaded the
repo `.env` (the CLI ignores `.gitignore`). Production deployment
`dpl_EAUWRHRGhH17wfsKVMMnuUQ3PmkP` — and very likely most of the ≥100 CLI
deployments — contain:

| Secret | Where it still lives | Exposure |
|---|---|---|
| Production Neon `DATABASE_URL` (role + password) | old deployment sources; `~/.thence/production.env`; Vercel env `DATABASE_URL` (Production) | Vercel team members with project access (source is private) |
| Test Neon URL (`THENCE_TEST_DATABASE_URL`) | old deployment sources; local `.env`; GitHub Actions secret `THENCE_TEST_DATABASE_URL` | same, plus anyone with repo-admin secret access |

Not exposed: `.env.local` keys (excluded by the CLI default), and `.env` was
never committed to git. The repo is private.

## Preconditions (verify immediately before Phase 1)

1. Production payments disabled: `npx tsx scripts/pilot-switch.ts status --production` → `DISABLED`.
2. No funded payment in flight (a brief recovery-endpoint outage is then
   harmless): read-only query — no transfer in `CLIENT_FUNDED`,
   `SERVER_FUNDED`, `CLAIMING`; today only eddaa6de (`RECONCILING`, unfunded).
3. A deployable commit containing the `.vercelignore` fix exists and the
   owner has approved which commit the rotation redeploy uses. Recommended:
   a hotfix branch = deployed `1f28983` + the `.vercelignore` change ONLY
   (no P4 code, no new payment capability).
4. Read-only production fingerprint taken (for before/after comparison).

## Phase 1 — production, zero-downtime role swap

Rationale: Neon password resets invalidate the old password immediately, so
resetting first would take production down until a redeploy finishes.
Instead, introduce a NEW least-privilege runtime role, switch to it, verify,
and only then invalidate the exposed credential.

1. **Neon console (production project):** create role `thence_app`
   (generated password; copy via the console's copy button straight into the
   next step — never into chat, tickets or shell history).
2. **Grants** (Neon SQL editor, as the owner role):
   ```sql
   GRANT USAGE ON SCHEMA public TO thence_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thence_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO thence_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO thence_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO thence_app;
   ```
   No DDL rights: migrations keep running as the owner role, operator-only.
3. **Vercel:** `vercel env rm DATABASE_URL production` then
   `vercel env add DATABASE_URL production` (interactive prompt; paste the
   pooled `thence_app` URL; the value is never echoed).
4. **Redeploy (approved commit only):** `vercel deploy --prod` from the
   approved hotfix checkout. Confirm the new deployment's file list (API,
   names only) contains no `.env`.
5. **Verify connectivity, read-only:** `GET /api/health` reports the
   database reachable; `vercel logs` shows no pool errors; Activity loads
   for the owner; `pilot-switch status --production` still `DISABLED`.
6. **Invalidate the exposed credential:** Neon console → reset the password
   of the previously exposed owner role. From this moment every URL in old
   deployment sources is dead.
7. **Operator file:** write the owner role's NEW URL into
   `~/.thence/production.env` with an editor (never `echo`). Verify:
   `npx tsx scripts/pilot-switch.ts status --production` → reads `DISABLED`.
8. **Post-check:** read-only fingerprint — only expected rows changed
   (sessions/auth from verification logins, if any). Neon monitoring: review
   connections since 2026-10-26 for unexpected clients (also relevant to the
   six unattributed users).

**Rollback** (any failure in 4–5, before step 6): restore the previous Vercel
`DATABASE_URL` value and redeploy; the old credential is still valid until
step 6. After step 6 there is no rollback to the old password — only forward
fixes with the new roles.

## Phase 2 — test project

1. Neon console (test project `empty-wildflower-93415146`): reset the test
   role's password.
2. Update local `.env` (`THENCE_TEST_DATABASE_URL` and `DATABASE_URL`, which
   point at the same test database) with an editor.
3. GitHub: `gh secret set THENCE_TEST_DATABASE_URL -R kaelah971/thence`
   (reads the value from stdin/prompt; never pass it on the command line).
4. Verify: `npx tsx tests/ci-verify-test-db.ts` → test project verified;
   `npm run db:guard`; re-run the CI workflow (`workflow_dispatch`).

## Phase 3 — historical deployments

After Phase 1 step 6 the leaked credentials are inert; removing old
sources is defense in depth.

1. Inventory (read-only): `vercel api /v6/deployments?projectId=…` + per
   deployment file listing (names only) → list every deployment containing
   `.env`.
2. Keep: the current production deployment and one known-good rollback
   target built AFTER the `.vercelignore` fix.
3. Remove the rest with `vercel remove <deployment-url> --yes`
   (irreversible; owner approval with the explicit list).
4. Confirm Vercel project settings keep source protection on, and review
   team membership/access.

## Phase 4 — prevent recurrence (already done in code)

- `.vercelignore` excludes `.env`, `.env.*`, key material (S0 commit).
- Production URL lives only in `~/.thence/production.env` (outside the repo).
- Optional: a pre-deploy check that lists the build's file names and fails
  on any `.env*` other than `.env.example`.

## Approval checkpoints

| Step | Irreversible? | Needs explicit approval |
|---|---|---|
| Phase 1.1–1.2 (new role) | no | yes |
| Phase 1.3–1.4 (Vercel env + redeploy) | reversible until 1.6 | yes (names the commit) |
| Phase 1.6 (reset exposed password) | **yes** | yes |
| Phase 2 (test rotation) | yes (old test password) | yes |
| Phase 3.3 (delete deployments) | **yes** | yes (explicit list) |

## Execution record — 2026-11-05 (owner-approved)

All secret values were generated by Neon, held in process memory, and written
only to owner-only operator files or piped to `gh secret set` on stdin. None
was printed or logged, and none appears in git.

**Already in place before today (2026-11-04, `RELEASE_PREFLIGHT.md` §15):**
production runs as the least-privilege role `thence_app`, created after the
packaging fix and stored only as a Sensitive Vercel variable. Not exposed.
Confirmed today from `pg_stat_activity` during live requests: the app connects
as `thence_app`. Hermes holds only `CRON_SECRET` (created 2026-11-04, not
exposed) and no database credential.

| Step | Result |
|---|---|
| Preconditions | Payment switch DISABLED; no real payment in flight; read-only fingerprint 18:54:25Z |
| Exposed production owner role `neondb_owner` (branch `production`) | Password reset via the Neon API; new URL verified; `~/.thence/production.env` updated in place |
| Backup branch `br-odd-snow-b4w1k3i6` (read-only endpoint `ep-weathered-flower-b4n6nc9j`, full data copy) | Neon refuses role changes without a read-write compute, so a temporary read-write endpoint was created, the role reset, and the temporary endpoint deleted. New credential in `~/.thence/backup-branch.env`. Only the original read-only endpoint remains |
| Test project `staging_owner` (`empty-wildflower-93415146`) | Password reset; local `.env` (2 lines) updated in place; GitHub secret `THENCE_TEST_DATABASE_URL` updated via stdin; `tests/ci-verify-test-db.ts`: test project verified, 18/18 migrations |
| **Leaked credentials are dead** | The `.env` bundled into `dpl_EAUWRHRGhH17wfsKVMMnuUQ3PmkP` (the leak itself, read in memory only): its production `DATABASE_URL` is rejected on the production **and** backup endpoints, and its `THENCE_TEST_DATABASE_URL` on the test endpoint, all with `28P01 password authentication failed` |
| After | `/api/health` ok with database reachable (the app is unaffected; it uses `thence_app`); Hermes run completed 19:01:10Z with no errors; financial fingerprint unchanged; switch DISABLED |

**Rollback:** none needed. The production app never used the rotated role.
If an operator file is lost, reset the role again in the Neon console.

**Not done:** Phase 3 (delete historical deployments that bundle `.env`).
They now hold only dead credentials; deletion is defence in depth and
irreversible, so it needs the explicit list approved first. Other local
checkouts (`C:/dev/thence`, `C:/dev/thence-docs-beta`) still hold the old,
now-dead test URL.
