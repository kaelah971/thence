# OPERATIONS (B5.2) — Reliability, Recovery & Deployment Readiness

Backend-only operational contract. No frontend, no funded transactions,
no live money movement. Statuses: **VERIFIED**, **CONFIGURATION_REQUIRED**,
**HOST_INTEGRATION_PENDING**, **E2E_PENDING**.

## 1. Local vs production checklist

| Item | Local/dev | Production |
|------|-----------|------------|
| `DATABASE_URL` | Neon dev DB, pooled host OK | Pooled connection, least-privilege role, secret manager (CONFIGURATION_REQUIRED) |
| `THENCE_APP_ORIGIN` | empty/relative | `https://` origin (CONFIGURATION_REQUIRED) |
| `THENCE_SATORA_BASE_URL` | empty (SDK default) | Explicit, pinned (CONFIGURATION_REQUIRED) |
| Enabled routes + token map | any verified subset | Only routes proven end-to-end (CONFIGURATION_REQUIRED) |
| `THENCE_EVM_RPCS_JSON` | empty (fail-closed) or trusted | Trusted HTTPS RPCs per chain (CONFIGURATION_REQUIRED) |
| Finality policy | defaults | Reviewed per chain (CONFIGURATION_REQUIRED) |
| `THENCE_NIMIQ_RPC_URL` (F6, hardened F8.5) | empty, or a trusted Nimiq JSON-RPC | Trusted HTTPS Nimiq node for the read-only Home balance when the installed Nimiq Pay can't answer `getBalance`. Empty = honest "unavailable" (CONFIGURATION_REQUIRED). F8.5: server fallback retries transient 429/5xx/timeouts (bounded, honors capped Retry-After) and caches successes 60s in memory (failures never cached); failure classes log as static `thence balance fallback: rpc_*` codes (no addresses/URLs/bodies). F8.6: the server total is basic PLUS active Nimiq Pay-managed HTLC vaults funded by the session address (discovered from its history, read live, capped, cached with the balance); Nimiq Pay parks wallet funds in HTLC contracts, so a basic-only read mistakes managed funds for an empty wallet. Recipient-side locks are excluded as unilaterally unspendable; unknown vault coverage is flagged, never silently zeroed. A public rate-limited RPC behind shared serverless egress remains the residual risk — a trusted operator-owned node is the durable fallback (CONFIGURATION_REQUIRED) |
| Edge rate limiting / WAF | not needed | Required (HOST_INTEGRATION_PENDING, §3) |
| Nimiq Pay host | stubbed/absent | Real host integration (HOST_INTEGRATION_PENDING) |
| Funded settlement proof | mocks only | Real mainnet claim verification (E2E_PENDING) |

## 2. Connection pool strategy (VERIFIED in code, monitor in prod)

`src/lib/db.ts`: one lazily-created shared `pg` Pool per process —
`max: 10`, `connectionTimeoutMillis: 10s`, `idleTimeoutMillis: 30s`,
TCP keep-alive on, and an `error` listener that discards failed idle
clients with a static log line instead of crashing the process
unhandled (previously a viable crash vector under Neon idle kills).

- Migrations and app traffic share the pool; Drizzle transactions check
  out one client for their whole duration, so advisory locks
  (`pg_advisory_xact_lock`) are session-pinned and correct under
  transaction-pooling — VERIFIED by the concurrent default-switch and
  concurrent reconcile/verify suites.
- No statement timeout is set on purpose: bounded external calls use
  application timeouts instead; a DB statement timeout could abort
  legitimate long settlements mid-transaction.
- Advisory locks are single-lock-per-transaction (transfer- *or*
  recipient-scoped, never both): no lock-ordering deadlock hazard.
- Neon serverless notes: use the **pooled** connection string for all
  runtime traffic; run one-off migrations with either endpoint
  (`db:migrate` records in `__drizzle_migrations`, repeatable). Expect
  the proxy to terminate long-idle connections — handled, not fatal.

## 3. Rate-limit trust boundaries

- **Authenticated endpoints: VERIFIED.** Keys are `user:{id}` from the
  session (B5.1 + regression tests). Forged `x-forwarded-for`/`x-real-ip`
  cannot reset them.
- **Anonymous endpoints: layered, documented as incomplete.**
  Per-header key + one unforgeable dimension each:
  challenge issuance → shared `challenge:global` ceiling;
  session verify → per-challenge cap (`verify-challenge:{sha256}`);
  token submission → per-token cap; public reads/catalog →
  per-header + shared global ceiling. Tunables:
  `THENCE_ANON_GLOBAL_PER_MINUTE` (600),
  `THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE` (10),
  `THENCE_VERIFY_ATTEMPTS_PER_TOKEN` (10).
- **Explicit non-claim:** this code cannot authenticate an arbitrary
  client's IP. Production MUST add edge rules (exact policy below,
  HOST_INTEGRATION_PENDING):
  - Terminate TLS at the edge; strip inbound `x-forwarded-for`/`x-real-ip`, set them from the edge-observed peer.
  - Rate-limit `/api/session/*` and `/api/verify/*` per edge-IP with a WAF rule; alert on 429 spikes.
  - Never trust client-supplied IPs for identity — only for abuse telemetry.

## 4. Provider/RPC outage behavior (VERIFIED by tests)

- All Satora reads bounded at 15s; chain reads at 15s (`withTimeout`).
- Provider errors classify to 503/404/409; reconciliation records the
  observation and never advances or erases prior state; settlement maps
  outages to `UNAVAILABLE`/`INCONCLUSIVE` — never `DELIVERED`, never
  proof deletion. No automatic retry of swap creation, payment,
  funding, claims, or authorization anywhere in the codebase.
- Expired provider data (stale quotes, dead invoices) blocks progress
  instead of authorizing it.

## 5. Safe operator recovery procedures

No terminal state is reachable from uncertainty: nothing here can mark
`FAILED`/`DELIVERED`/`USER_CANCELLED` without its evidence rule, and no
second funding can be authorized (prepare/attach/authorize gates require
`QUOTED`/`SWAP_CREATED` states that resolved transfers have left).

| # | Scenario | Retained state | Operator action |
|---|----------|----------------|-----------------|
| A | Browser closes before attach | Transfer `QUOTED`; `PREPARED` attempt + TTL server-side | Client re-prepares (idempotent replay) or re-quotes; nothing to unwind |
| B | Swap created provider-side, IndexedDB store fails | Nothing bound server-side; transfer `QUOTED` | Client must NOT ack recovery; re-create swap or abandon; no funds moved (nothing authorized) |
| C | Recovery readback fails | Same as B | Same as B — ack is forbidden without a verified readback |
| D | Authorize succeeds, response lost | Attempt `HANDOFF_AUTHORIZED` persisted | Client re-reads `GET /attempt` (durable status); re-authorize returns explicit `409 ALREADY_AUTHORIZED`, no side effects |
| E | Nimiq Pay result unknown | `OUTCOME_UNKNOWN → RECONCILING` chain | Reconcile; provider facts decide. Never failed, never re-authorized |
| F | Funding after apparent cancellation | `RECONCILING` (cancel from `AWAITING` is nonterminal) | Reconcile advances on `clientfunded` (regression-tested); never silently terminal |
| G | Provider vs chain disagree | Settlement `INCONCLUSIVE`, transfer stays put | Reconcile + re-verify later; investigate before any manual step |
| H | Resume after invoice expiry | Resume endpoint returns same attempt/swap + `invoiceExpired` + ambiguity reasons | Treat expiry as non-proof; reconcile, do not cancel-or-fund on expiry alone |

**Known residual risk (documented, not fixable without a real wallet):**
the Satora create-before-store crash window — a provider-side swap may
exist with no client recovery record (B4.2 contract). The SDK exposes
swap-tracking/recovery entry points (`SwapTracker`, `deriveSwapStatus`,
`getSwapDepositorKey`), but restoring a locally lost swap with a real
host wallet is HOST_INTEGRATION_PENDING / E2E_PENDING and is not claimed
as verified.

## 6. Logging and privacy boundaries

- No DATABASE_URL, tokens, mnemonics, preimages, or private keys in
  logs, errors, or responses (grep-verified; `SECRET_ENV_KEYS` guard).
  Pool errors log a static line only. Rate-limit counters store hashed
  challenges/tokens, never raw values.
- `Cache-Control: no-store` on auth-gated reads, receipts, resume, and
  public verification views. Public endpoints return terms only.

## 7. Readiness checks

- `GET /api/health`: liveness vs dependency readiness split
  (`ok`/`degraded` + DB reachability + config validity), no secrets,
  bounded 3s DB probe, no per-request external calls.
- Pre-deploy: `npm run typecheck && npm run lint && npm run build`,
  `npm run db:migrate` (repeatable), full `npm test` on a staging DB,
  confirm `THENCE_*` production values, edge/WAF rules from §3.

## 8. Pilot activation correction (F8.2)

Vercel environment-variable changes apply to NEW deployments only —
even server-side variables. Toggling `THENCE_PILOT_ENABLED` (or any
`THENCE_*` / `NEXT_PUBLIC_*` flag) in the Vercel dashboard is NOT an
instantaneous switch; it needs a redeploy (rebuild for `NEXT_PUBLIC_*`)
to take effect on serving traffic.

The instantaneous control is the database kill switch
(`pilot_controls.enabled`, KEY 2 of the two-key rule): one UPDATE,
effective on the next funded request, no redeploy. Emergency stop =
`npm run pilot:disable`; recovery (reconcile, resume, attempt status,
receipt, outcome reports, settlement verification) never reads the
switch and stays available for already-funded transfers.

F8.3 production rule: production never skips the pilot for missing
configuration — a missing allowlist fails closed (`PILOT_NOT_AUTHORIZED`)
on every funded path even with the database switch ON. Non-production
keeps the legacy skip for dev/test/CI flows.

Full ordered sequence — activation, pre-flight verification, emergency
stop, first-test procedure, blockers: `docs/PILOT_ACTIVATION.md`.
Do not activate from this section alone.

## 8. Verification gates for B6

B6 may not start until: real Nimiq Pay host signing works end-to-end;
one mainnet claim verifies through `verify-settlement` (no mocks);
edge rate limiting from §3 is live; pool sizing is re-confirmed under
production traffic; CCTP-bridged routes have a second-leg evidence rule.
Frontend may render receipts and drive the existing resume/verify
endpoints; it must never attest payment outcomes itself.
