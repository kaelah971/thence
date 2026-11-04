# Resource-bounded full verification (before any production rollout)

Prepared 2026-11-03. A single `vitest run` of all 58 files took ~22 min and
was once stopped by the host's low-memory guard (P4 run). Full verification
is therefore split into bounded shards that each finish well under 10 min,
run sequentially, with results recorded per shard. Every shard runs against
the anchor-proven ISOLATED test database only (tests/global-setup.ts);
production is fingerprinted read-only before and after.

## Preconditions

1. Clean tree on the release commit; `npm ci` done.
2. `npx tsx tests/ci-verify-test-db.ts` → test project verified, migrations N/N.
3. Read-only production fingerprint (row count + content hash per table).
4. Close other memory-heavy processes (dev servers, browsers, builds).

## Static gates (sequential)

```
npm run typecheck
npm run lint
npm run build
```

## Test shards (sequential, `--maxWorkers=2`, one shard at a time)

| Shard | Files | Notes |
|---|---|---|
| S1 pure + UI | everything that is database-free: `ui-*`, `incident-2026-11-02`, `p5-chain-timeout`, `p5-refund-consistency`, `p3-claim-verification` (`ui-*` includes `ui-p3-claim-completion`), `test-db-guard`, `satora-swap-verify`, `transfer-handoff`, `f43-settlement`, `f810-*`, `f811-*`, `copy-guard`, `auth-errors`, `activity-archive`, `provider-evidence-ui`, `money`, `nimiq`, `address-format`, `env`, `routes`, `root-redirect`, `send-navigation`, `public-request-cta`, `rate-limit`, `db-pool`, `schema` | ~4 min (transfer-handoff dominates) |
| S2 money path (live) | `reconciliation`, `settlement`, `f42-handoff`, `f812-attach-recovery`, `f812-retire-replace` | live quotes + test DB |
| S3 pilot + recovery (live) | `f81-pilot-attempt-limits`, `f8-pilot-gates`, `f82-pilot-kill-switch`, `p2-claim-deadline`, `p4-expiry-resolution`, `p5-locking-audit`, `p3-claim-intent`, `p6-server-reconciler`, `f41-prepare-flow`, `f41-recovery-vault` | |
| S4 data + accounts (live) | `transfers`, `transfer-intents`, `quotes`, `quotes-multiroute`, `f3-data`, `f32-requests-quotes`, `recipients`, `requests`, `verification`, `profile`, `auth`, `f6-balance`, `f7-send-flow` | |

Command per shard: `npx vitest run --maxWorkers=2 <files…>`. A shard that is
stopped by the memory guard is re-run alone with `--maxWorkers=1`; it is not
counted as passed until it completes.

Coverage check: the union of S1–S4 must equal `ls tests/*.test.ts*` (65 files
at P3). Any new test file must be assigned to a shard.

## Acceptance

- All shards pass; no `it.fails` markers remain (P4, P2 and P1 converted them all).
- Production fingerprint unchanged (no table differs).
- Then, and only with explicit approval: production migrations 0015 + 0016 + 0017
  (operator, `THENCE_MIGRATE_PRODUCTION=I_UNDERSTAND`), deploy, and the
  credential rotation sequence in docs/CREDENTIAL_ROTATION_PLAN.md.

## Browser E2E (P7)

Real production build (`.next-e2e`, payment + claim flags on), real backend,
real browser Satora SDK, anchor-proven TEST database; SIMULATED Nimiq Pay host,
Satora API and Polygon RPC (see `e2e/README.md` — this is not proof of the real
wallet, provider or chain). On a memory-constrained machine run ONE scenario per
invocation, one worker, after a free-memory check:

```
E2E_SKIP_BUILD=1 npx playwright test --project=chromium-desktop --workers=1 -g "<scenario>"
```

Build `.next-e2e` once per code change (global setup rebuilds unless
`E2E_SKIP_BUILD=1`). Projects: `chromium-desktop` (all 14 scenarios),
`webkit-iphone` (6), `chromium-mobile` (2). `scripts/release-shards.ts --check`
must report every test file in exactly one shard.
