# PILOT ACTIVATION & EMERGENCY STOP (F8.2) — the corrected sequence

Status: **CODE SHIPS DISARMED. FIRST FUNDED TEST — NOT YET AUTHORIZED.**

This document corrects the F8 preflight assumption that changing
`THENCE_PILOT_ENABLED` in the Vercel dashboard is an instantaneous
runtime emergency switch. **It is not.**

## 1. The correction: Vercel env changes need a redeploy

Vercel environment-variable changes — **including server-side variables**
— do not apply to existing deployments. A variable edited in the Vercel
dashboard only takes effect on a **new deployment** (redeploy or new
commit build). Consequences:

- Arming the pilot via Vercel (`THENCE_PILOT_ENABLED=1`) does nothing
  until that change is deployed. Activation is a **deploy step**, not a
  dashboard toggle.
- Disarming via Vercel (`THENCE_PILOT_ENABLED=0`) likewise does nothing
  for already-running deployments. It is **not an emergency stop**.
- Client flags (`NEXT_PUBLIC_THENCE_ENABLE_PAYMENT`,
  `NEXT_PUBLIC_THENCE_ENABLE_CLAIM`) are baked in at **build time**
  (`NEXT_PUBLIC_*` inlining). Changing them always requires a rebuild +
  redeploy — never instantaneous, never per-request.

The instantaneous emergency stop is therefore the **database kill
switch** (`pilot_controls.enabled`, KEY 2 below): one UPDATE, effective
on the next funded request on every already-running deployment, no
redeploy. Implemented in `src/lib/pilot.ts` (`assertPilotDbEnabled`),
seeded DISABLED by migration `0014`, operated via
`npm run pilot:{status,disable,enable}` (`scripts/pilot-switch.ts`).

## 2. Two-key rule

New funded execution requires BOTH keys. Either key alone stops it.

F8.3 PRODUCTION RULE: a production runtime (`NODE_ENV === "production"`)
never skips the pilot for missing configuration. Non-production keeps the
legacy not-configured skip (dev/test/CI quote-only flows), but in
production a missing allowlist throws `PILOT_NOT_AUTHORIZED` on every
funded path (create, requote, prepare, attach, authorize) — even with the
database switch ON. An enabled route plus a payment-capable client can
never bypass ownership checks by omission. Production must always carry
an explicit allowlist (disarmed via KEY 1 OFF + KEY 2 FALSE).

| Key | What | Where | Takes effect |
|-----|------|-------|--------------|
| KEY 1 — deployed env | `THENCE_PILOT_ENABLED=1` + owner allowlist + caps (`src/lib/pilot.ts`) | Vercel project settings | **Next deployment only** |
| KEY 2 — database | `pilot_controls` row `id='pilot'` has `enabled=TRUE` | Production Postgres | **Next request (seconds)** |

Funded-execution paths gated by both keys (env intent + DB switch, in
this order; idempotent replays stay first so crash recovery never
strands): `POST /api/transfers` (create, incl. in-transaction
re-check), `POST …/requote`, `POST …/prepare`, `POST …/attach`,
`POST …/authorize-handoff`.

NOT gated — deliberately, so they stay available after an emergency
stop for already-funded transfers: `GET …/attempt`, `POST …/reconcile`,
`GET …/reconciliation`, `POST …/handoff-result` (outcome reports only:
cancelled/initiated/unknown — funded claims are rejected),
`GET …/receipt`, `POST …/verify-settlement` (read-only chain proof),
`GET /api/verify/[token]`. All are session + `ownerUserId` bound; none
can move funds, authorize payment, or execute a claim.

Claims: there is **no server-side claim execution**. Claims run
client-side via the SDK gasless coordinator path
(`claimStoredSwap` in `src/ui/lib/satora-browser.ts`, created with
`gasless: true`), behind the claim gate
(`NEXT_PUBLIC_THENCE_ENABLE_CLAIM`, `src/ui/lib/claim-gate.ts`), and
are proven afterwards by read-only `verify-settlement`. Server-side
there is nothing to gate beyond the paths above.

## 3. Activation sequence (in order — do not reorder)

Preconditions: private PR merged to `main` with green CI, Vercel
production deployment of that commit finished.

1. **Set Vercel production env (KEY 1, still inert until deployed):**
   `THENCE_PILOT_ENABLED=1`,
   `THENCE_PILOT_OWNER_NIMIQ_ADDRESSES=<single test wallet>`,
   caps at defaults (`THENCE_PILOT_MAX_TARGET_ATOMIC=300000`,
   `THENCE_PILOT_MAX_SPEND_ATOMIC=300000`, `THENCE_PILOT_MAX_TRANSFERS=1`),
   `THENCE_ENABLED_ROUTES=usdc-polygon`,
   `THENCE_ROUTE_TOKENS_JSON={"usdc-polygon":"<verified-137-USDC>"}`,
   `THENCE_EVM_RPCS_JSON={"137":"<trusted-https-polygon-rpc>"}`,
   plus existing `THENCE_NIMIQ_RPC_URL`, `THENCE_APP_ORIGIN`,
   `THENCE_SATORA_BASE_URL`. Client flags
   `NEXT_PUBLIC_THENCE_ENABLE_PAYMENT=1` and
   `NEXT_PUBLIC_THENCE_ENABLE_CLAIM=1` **together** (never payment
   without claim — §5).
2. **Deploy** (redeploy with the new env, or merge the commit that
   carries it). Confirm the deployment serving traffic carries the new
   env: `GET /api/health` (config validity) and
   `GET /api/routes/public` (see §4) **on the production URL**.
   KEY 2 is still DISABLED, so no funding is possible yet.
3. **Apply migrations to production** (`npm run db:migrate` with the
   production `DATABASE_URL`): creates `pilot_controls` seeded DISABLED
   (repeatable; never re-enables).
4. **Pre-flight verification** (§4). All checks must pass.
5. **Arm KEY 2** (`npm run pilot:enable -- --note "…" --yes` against
   production, or the documented single UPDATE). Confirm with
   `npm run pilot:status`.
6. **First funded test** (§6): exactly $0.30 USDC, single attempt.
7. **Planned stop:** `npm run pilot:disable` immediately after the test
   (or after diagnosing any anomaly), then defense-in-depth:
   `THENCE_PILOT_ENABLED=0` + client flags OFF in Vercel + redeploy.

## 4. Pre-flight verification (all must pass, in production)

- **Route config:** `GET /api/routes/public` lists `usdc-polygon` as the
  only quoteable route; every other route non-quoteable.
- **Canonical USDC contract:** the `usdc-polygon` token in
  `THENCE_ROUTE_TOKENS_JSON` matches the address the live Satora
  catalogue reports for USDC on chain 137 at verification time
  (identity is contract + chain, never bare ticker — `resolveRoute` in
  `src/lib/satora.ts`). Re-check on the day: catalogue listings can
  change; a mismatch blocks quoting fail-closed.
- **Trusted Polygon RPC:** `THENCE_EVM_RPCS_JSON["137"]` is an https
  endpoint you operate or explicitly trust (there is no built-in default;
  empty = `verify-settlement` returns `UNAVAILABLE`, fail-closed, never
  `DELIVERED`). It must support 2000-block `eth_getLogs` — Alchemy Free
  (10 blocks) cannot run the P4 scan. Requirements, the 2026-11-05
  evaluation, the chosen endpoint and public-RPC risks:
  `docs/POLYGON_RPC.md`. Polygon finality here is 256 confirmations (~9 min at
  2s/block) — evidence of inclusion, documented as NOT L1 finality.
- **Owner allowlist:** exactly the one test wallet; canonical-compare
  verified (spacing/case-insensitive, `canonicalKey`).
- **Gasless claim readiness:** creation path pins `gasless: true`
  (`createExactReceiveSwap`); `claimStoredSwap` + claim gate +
  verify-after-claim wiring is implemented and mock-tested
  (`tests/` claim/reclaim suites); both client flags deploy together.
- **Payment + claim code present before any NIM is spent:** the
  activation deployment carries BOTH `NEXT_PUBLIC_THENCE_ENABLE_PAYMENT`
  and `NEXT_PUBLIC_THENCE_ENABLE_CLAIM`; the funded test funds only via
  the authorized handoff invoice and claims only via the gasless path,
  proven by `verify-settlement` (`DELIVERED` only on matching on-chain
  Transfer events + finality).
- **Kill-switch drill (TEST database first):** arm both keys on the
  isolated test DB, create a transfer, flip KEY 2 off, confirm the next
  funded call is `403 PILOT_DISABLED` while reconcile/resume/verify
  still answer (covered by `tests/f82-pilot-kill-switch.test.ts`).

## 5. Emergency stop behavior (memorize this)

1. **Immediate:** set KEY 2 FALSE (`npm run pilot:disable` or
   `UPDATE pilot_controls SET enabled=FALSE, updated_at=NOW() WHERE
   id='pilot'`). Effect: the next create/requote/prepare/attach/
   authorize on ANY running deployment returns `403 PILOT_DISABLED`.
   In-flight same-key replays still deduplicate safely (no new spend).
2. **Confirm:** `npm run pilot:status` → DISABLED; attempt one funded
   call and confirm `PILOT_DISABLED`.
3. **Defense in depth (minutes, needs redeploy):** set
   `THENCE_PILOT_ENABLED=0` (+ client flags OFF) in Vercel and redeploy.
4. **Recover the funded transfer:** reconcile (`POST …/reconcile`),
   resume (`GET …/reconciliation`, `GET …/attempt`), verify settlement
   (`POST …/verify-settlement`) — all ungated and owner-bound, all keep
   working while stopped. Never retry blindly after an unknown claim
   outcome: fresh verify round first (`mayRetryClaim` discipline).

## 6. First funded test (NOT YET AUTHORIZED — procedure only)

Recipient: **0.30 USDC on Polygon**. Wallet: ~8,837 NIM. Maximum
acceptable debit: **1,900 NIM including fees**. The NIM debit is set
inside Nimiq Pay (host converts NIM→Lightning sats and shows the exact
figure on its own approval screen); the server never sees a NIM number,
so no server gate can enforce a NIM ceiling — the $/NIM budget is
**procedural**: the operator reads the host approval screen and
**aborts when it exceeds 1,900 NIM**. Never represent the atomic caps
as a NIM-spend guarantee. Payment and claim flags deploy together so a
funded swap can always be finished and proven.

## 7. Remaining blockers (as of this change)

- Activation itself (Vercel env + deploy + KEY 2 + funded test) is
  explicitly **not authorized by this task** — a human go-ahead starts §3.
- Production values (allowlist address, token address, RPC URLs) must be
  confirmed at activation time against live provider/catalogue state.
- Edge rate limiting / WAF per `docs/OPERATIONS.md` §3 remains
  HOST_INTEGRATION_PENDING for real traffic.
- The Satora create-before-store crash window (provider-side swap with
  no client recovery record) remains documented residual risk
  (`docs/OPERATIONS.md` §5A–H); the funded test is the first live
  evidence for it.

---

STOP: no funded transaction, swap, invoice, payment or claim is
authorized by this document. It describes the sequence only.
