# S0 security and operations log (2026-11-03)

Recovery engineering after the 2026-11-02 incident (077770a1 refunded
unclaimed; eddaa6de stale in RECONCILING). Facts only; identifiers that are
personal data (wallet addresses, user ids) are deliberately omitted.

## 1. Production pilot kill switch — DISABLED

| | |
|---|---|
| Authorized by | Owner, explicit written approval (2026-11-03) |
| Command | `npx tsx scripts/pilot-switch.ts disable --production --yes --note "P0 incident: recovery engineering in progress"` |
| Pre-check | target = production (no test anchor); state `ENABLED`, updated 2026-11-02T12:51:52Z, note "Authorized 0.30 USDC owner pilot" |
| Change | `UPDATE pilot_controls SET enabled=false, updated_at=NOW(), note=… WHERE id='pilot'` — single row |
| Result | `DISABLED`, updated 2026-11-03T15:35:24Z, note recorded |
| Collateral | Read-only fingerprint (row count + content hash of every public table) before/after: only `pilot_controls` changed. No transfer, attempt, attachment, observation, proof or session row changed. |

Effect (code at deployed commit 1f28983): `assertPilotDbEnabled` now throws
`403 PILOT_DISABLED` in `createTransfer`, `requoteTransfer`, `prepareHandoff`
(new attempts), `attachSwap` and `authorizeHandoff`. Not affected (they never
read the switch): reconcile, reconciliation view, provider evidence,
verify-settlement, receipts, attempt status, handoff-result reporting, the
browser-side Satora claim, and Nimiq-side HTLC timeout refunds (Nimiq Pay,
independent of Thence). Re-enable only with `enable --production --yes` after
P1–P7 and an explicit GO.

## 2. Unattributed production users (PRESERVED — do not delete)

Six `users` rows were created in production on 2026-11-03 between
09:31:46Z and 09:33:50Z (five within ~10 s, ~2.5 s apart, then one at
09:33:50Z). Each has exactly one session, zero transfers and zero
recipients. The cadence suggests automation (scripted wallet sign-ins), not
organic users.

Open attribution question: what created them? Candidates, none verified:
(a) a local `next dev`/`next start` or QA script running while the repo
`.env` still pointed at production (true until S0 earlier today);
(b) an automated check against the deployed app; (c) genuine users.
Vercel runtime logs from that time are no longer retained (~1 h retention).
Evidence to collect: the owner's shell/agent history around 10:31 local
time (UTC+1), and any QA scripts run then. Rows are untouched.

Context: the production database also holds 361 users created on
2026-10-27 and 61 transfers that day — consistent with it having been the
development/test database before promotion. Production data therefore mixes
historical test rows with real ones.

## 3. Deployment packaging exposed `.env` (FIXED for future deploys)

- The Vercel CLI does not read `.gitignore`; its built-in ignore list excludes
  only `.env.local` and `.env.*.local`. The repo `.vercelignore` did not list
  `.env`.
- Verified via the Vercel API (file names only): production deployment
  `dpl_EAUWRHRGhH17wfsKVMMnuUQ3PmkP` contains `.env`. At that time `.env`
  held the PRODUCTION `DATABASE_URL` and the test-database URL. The project
  has ≥100 deployments (61 production); older CLI deployments very likely
  contain the same file.
- Source visibility: project `publicSource` is unset (private) — visible to
  members of the Vercel team, not the public. `.env` was never committed to
  git.
- Fix: `.vercelignore` now excludes `.env`, `.env.*` (except `.env.example`),
  key/cert files, `.npmrc`, build caches and `.claude/`. Verified with the
  CLI's ignore semantics. `.env`'s only keys absent from Vercel env
  (`APP_VERSION`, `THENCE_QUOTE_TTL_SECONDS`) equal the code defaults, so
  runtime behavior is unchanged.
- Still required (owner decision): rotate the production Neon role password
  and the test-database password, update Vercel `DATABASE_URL`, and remove or
  restrict old deployments. Rotation needs a redeploy of the existing code.
