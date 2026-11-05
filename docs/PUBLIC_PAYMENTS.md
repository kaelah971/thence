# Public payments — mode, safeguards and enablement runbook

Status (2026-11-05): **implemented, not enabled.** Production has no
`THENCE_PAYMENTS_MODE`, which resolves to `off`, and the database emergency
switch is DISABLED.

## What public mode is

`THENCE_PAYMENTS_MODE=public` (`src/lib/pilot.ts`): any authenticated Nimiq Pay
wallet can pay any valid recipient wallet on an enabled route, for any amount
the provider's live quote accepts.

| Removed in public mode | Kept in every mode |
|---|---|
| Owner wallet allowlist | Wallet-signature sign-in; owner checks on every transfer |
| 0.30 USDC per-payment cap (`THENCE_PILOT_MAX_TARGET_ATOMIC`) | Provider minimum/maximum per quote (`assertSourceBounds`: `BELOW_MINIMUM` / `ABOVE_MAXIMUM`) |
| Pilot total-spend cap (`THENCE_PILOT_MAX_SPEND_ATOMIC`) | Route enablement and token configuration (`THENCE_ENABLED_ROUTES`, `THENCE_ROUTE_TOKENS_JSON`) |
| Pilot transfer-count cap (`THENCE_PILOT_MAX_TRANSFERS`) | **One unresolved payment per user** (`PAYMENT_EXPOSURE_UNCERTAIN`): double-payment protection, not a volume cap |
| Single-route restriction (`PILOT_ROUTE_ONLY`) | **Database emergency switch** (`pilot_controls`, `PILOT_DISABLED`): administrator kill switch |
| — | Quote expiry, swap identity, single handoff authorization, recovery vault, claim intent and lease, settlement proof (256 confirmations), refunds, Hermes reconciliation, receipts, rate limits |

No per-user daily limit and no service-wide volume ceiling exist in public
mode.

## Modes (fail-closed)

| `THENCE_PAYMENTS_MODE` | Behaviour |
|---|---|
| `public` | As above |
| `pilot` | Previous restricted pilot, unchanged (`THENCE_PILOT_ENABLED=1`, allowlist, caps) |
| `off` | Every funded path refused: `403 PAYMENTS_OFF` |
| any other value | `off` |
| missing, production | `off` |
| missing, development/test | Pre-mode ("legacy") behaviour, for local and test fixtures only |

The UI shows "Payments temporarily unavailable" for `PAYMENTS_OFF`,
`PAYMENTS_NOT_AUTHORIZED` and `PILOT_DISABLED`; `/api/pilot/status` returns
`paused`.

## Verification (simulated, no money)

- `tests/payments-mode.test.ts` (pure): mode resolution, each mode's gates,
  pilot unchanged, the old pilot env ignored in public mode.
- `tests/public-payments-mode.test.ts` (live test database, provider quotes
  mocked): a non-allowlisted wallet creates and prepares a 25 USDC payment;
  a second payment for the same user is refused while a second user pays
  independently; above the provider maximum is refused; switch off → refused
  and `paused`; mode `off` or invalid → `PAYMENTS_OFF`; pilot mode still
  refuses the stranger.
- E2E (`e2e/global-setup.ts`): the server runs `THENCE_PAYMENTS_MODE=public`
  with **no** pilot variables; the simulated wallet is on no allowlist and
  completes approve → fund → Finish delivery → verified Delivered.

## Enable public payments (owner approval required at each step)

1. Merge the PR once CI is green. Production deploys with no
   `THENCE_PAYMENTS_MODE`, so it resolves to `off`.
2. Vercel Production env: add `THENCE_PAYMENTS_MODE` = `public`. The value
   is not secret. The `THENCE_PILOT_*` variables are ignored in public mode;
   remove them later if desired.
3. Redeploy production (environment changes apply only to a new
   deployment), then check: `/api/health` ok, pages 200, and
   `/api/pilot/status` for a signed-in wallet returns `paused` (switch still
   off).
4. Turn on the emergency switch:
   `npx tsx scripts/pilot-switch.ts enable --production --yes --note "public launch"`.
   `/api/pilot/status` then returns `available` for **any** signed-in wallet.
5. Supervised first public payment from a non-owner wallet. Watch Activity,
   Hermes (`job_leases` `server-reconciler`) and Vercel logs to Delivered.
6. **Emergency stop at any time:**
   `npx tsx scripts/pilot-switch.ts disable --production --yes --note "<reason>"`.
   It takes effect on the next request with no redeploy. Recovery, claims,
   verification and refunds keep working.
7. Full rollback: set `THENCE_PAYMENTS_MODE=off` and redeploy, or promote the
   previous deployment.

## Known limits that remain (not Thence caps)

- Only `usdc-polygon` is enabled in production.
- **Finish delivery** must be tapped on the paying device before the claim
  deadline (about 1 hour). On iOS, survival of the real claim store across a
  mini-app relaunch is not yet observed (`docs/RISK_IOS_WEBVIEW_STORAGE.md`).
  A missed claim refunds; it does not lose funds.
- Reconciliation capacity: Hermes every 2 minutes, at most 10 transfers per
  run.
