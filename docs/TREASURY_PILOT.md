# Polygon treasury pilot

This is a separate, disabled-by-default route at `/app/desk`. It accepts native NIM into an operator wallet, verifies the deposit, then sends native USDC on Polygon from the operator's funded wallet. It does not use Lightning, Satora, Fastspot, an HTLC swap or CCTP. The operator owes delivery or a full NIM return once a valid deposit is received. Existing Lightning transfers retain their original recovery paths.

Implementation is a pilot, **deployed with the desk disabled and not yet proven with real funds**. The payout signer is supplied only through the guarded operator command and is never stored in the repository. Migration 0019 has been applied to production (it may be applied by hand with a migration-capable role, because the app role `thence_app` has no DDL rights and cannot create drizzle's ledger schema).

## Intended public wallets

- Polygon USDC payout: `0x21e5fc03e4305cc8cfb874253c6d66a8bdb0bcda`
- NIM collection: `NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ`

The collection address passed the repository's Nimiq checksum validation. A read-only check at 2026-11-18 20:22 UTC observed **2.520329 native USDC and 1 POL** at finalized Polygon block 97551902 (block timestamp 20:22:02Z). The existing balance RPC reported the NIM collection account as `basic`. These are observations, not reservations or proof of signing control. The dedicated NIM proof RPC and treasury signing key are not configured; balances must be checked again during activation.

## Flow and promises

| Action | Observable result |
| --- | --- |
| Owner gets quote | Reserve exact recipient USDC against finalized treasury balance; return exact NIM amount and included fee. No wallet request. |
| Owner accepts custody disclosure and continues | Server authorizes exactly one wallet prompt. Nimiq Pay confirms ordinary NIM transfer with unique text reference. |
| Wallet response is lost, cancelled or interrupted | Keep the order and reservation. Never offer a second payment prompt. Check the same order; worker searches collection history. Cancellation does not prove no transaction was broadcast. |
| NIM deposit found | Verify successful mainnet transaction, exact collection recipient, value and reference, owner binding (including authenticated vault HTLC EarlyResolve if applicable), minimum confirmations and justified macro-block finality. A trusted node supplies this evidence; this is not independent multi-node verification. |
| Delivery | Prepare exact native-USDC `transfer`, allocate Polygon nonce under shared DB lock, persist signed bytes/hash/nonce before broadcast. Retries use identical signed bytes. |
| Successful receipt | Mark delivered only after canonical finalized Polygon receipt and matching native-USDC Transfer event. No receipt or RPC error remains unresolved. |
| Late deposit or finalized reverted payout | Refund due. No automatic NIM signing. A full operator-sent return must be verified before marking refunded. |

Quotes expire after 60 seconds before authorization. Authorization grants five minutes to have the deposit included on Nimiq; inclusion after that queues a refund. Once authorized, reservations do not expire automatically—even if the user closes the app or the deadline passes. Time passing never proves non-payment or a refund. Unknown/incorrect/duplicate deposits require operator investigation. Only exact quoted deposits can be processed automatically; underpayments/overpayments and wrong references require manual recovery. Collection history discovery reads the most recent 500 transactions, uses positive matches only, and cannot prove absence of an older payment. A known hash can be reported later.

Default pilot limits are a configurable minimum (0.01 USDC by default, 0.01 floor), a configurable per-payment maximum (5 USDC by default, 1000 USDC hard maximum) and a 0.5% included desk fee. There is no per-owner or daily budget: the treasury balance is the only aggregate bound, and a single payment may consume all of it. Rate quotes use fresh NIM and USDC USD observations from a separate CoinGecko adapter (five-minute maximum age and USDC peg guard). The operator bears market movement and liquidity risk. Legacy sats quotes and display-only prices are unchanged.

## Configuration and activation

Set server-only variables from `.env.example`:

- `THENCE_DESK_ENABLED=false` during setup.
- `THENCE_DESK_NIM_ADDRESS`, `THENCE_DESK_POLYGON_ADDRESS` to the public addresses above.
- `THENCE_DESK_OWNER_ADDRESSES` to the public **signed-in** Nimiq wallet(s) allowed to test, comma separated. Ignored when open mode is on. Keep authorized owners listed until their pending payments are resolved. Collection address and signed-in address can differ.
- `THENCE_DESK_OPEN=true` removes the invite list: every signed-in wallet may quote and pay. This is a product decision, not a safety default — the only remaining spend bound is the on-chain USDC balance, so anyone can draw the treasury down. Closed mode (the default) is the safe posture for an unfunded or unproven desk.
- `THENCE_DESK_MIN_USDC_ATOMIC` is the per-payment floor (default `10000`, 0.01 USDC; hard floor 0.01 USDC).
- `THENCE_DESK_MAX_USDC_ATOMIC` is the per-payment ceiling (default `5000000`, 5 USDC; hard limit 1000 USDC). It must be at least the floor.
- `THENCE_DESK_POLYGON_RPC` to a trusted HTTPS Polygon mainnet RPC supporting finalized blocks.
- `THENCE_NIMIQ_PROOF_RPC_URL` to a trusted HTTPS archive/history-capable Nimiq mainnet node.
- `THENCE_DESK_POLYGON_PRIVATE_KEY` through secure server secret configuration only. It must derive the payout address. No NIM key is needed for this implementation; NIM returns are operator-sent.
- `CRON_SECRET` with at least 32 random characters, securely configured.

Use the payout wallet exclusively for this desk. Manual sends, nonce replacements, token approvals or sharing its signer with another service can invalidate reservation/nonce assumptions. Keep enough **native** Polygon USDC and POL; the quote path requires at least 0.05 POL at finalized balance. Bridged USDC.e does not count. Never give this service a general-purpose personal-wallet key.

Before enabling, review migration 0019 and apply it to production only with explicit deployment authorization (`configure-desk migrate`, below). The scheduler ships in `ops/selfhost/`: `thence-desk-worker.cjs` calls authenticated `GET /api/cron/desk` over loopback, reading `CRON_SECRET` from a systemd credential, and `thence-desk-worker.timer` runs it 45s after boot and every 30s after each completed run. **This endpoint can move treasury USDC.** The legacy `/api/cron/reconcile` stays read-only and does not call it. Vercel Hobby daily cron is unsuitable. The units are installed by hand during activation, not by the app deploy; verify scheduler access, clean summaries and restart recovery before enabling customer deposits.

Operator activation runs only as root on the VPS through `ops/selfhost/configure-desk.cjs`. The signing key enters from a mode-0600 `/tmp/thence-desk-signing-<32 hex>` file, which the command deletes unread by anything else and never writes to argv or logs:

1. `node configure-desk.cjs stage <secret-file>` — verifies the collection address, that the key derives the payout address, HTTPS RPCs and a ≥32-character `CRON_SECRET`; writes the env file atomically with `THENCE_DESK_ENABLED=false` and stages the cron secret as `/etc/thence-web-prod/desk-cron-secret` (0600).
2. Install `thence-desk-worker.cjs`, `.service` and `.timer`; `systemctl daemon-reload && systemctl enable --now thence-desk-worker.timer`.
3. `node configure-desk.cjs migrate` — applies migrations with the production env.
4. `node configure-desk.cjs preflight` — finalized-block signer/chain, native USDC ≥ 3 USDC and POL ≥ 0.05 at that block, collection account is `basic`, history readable, `desk_orders` present.
5. Restart `thence-web-production`, confirm one worker run logs `"errors":0` and `"ambiguous":0`, then `node configure-desk.cjs enable`, restart again, and place the approved small live payment.

`node configure-desk.cjs pause` writes `THENCE_DESK_ENABLED=false` and needs the same restart. Every failure prints a stable code (for example `TREASURY_BALANCE_LOW`) and never echoes secrets.

After setup, run a read-only balance/network/signer preflight; arrange the operator refund procedure and review fee/caps. Then enable only the owner's pilot wallet and run a separately approved small end-to-end payment. This real Nimiq Pay handoff and payout remains outstanding; mocks cannot prove it. Do not enable broadly until that completes.

To pause new quotes and authorizations set `THENCE_DESK_ENABLED=false` in the service's active environment (a restart/redeployment may be needed to reload environment variables). This is not an instantaneous database kill switch. Recovery remains available while paused, provided RPC, allowlist and wallet configuration remain present. Do not remove credentials or stop the worker while payouts are unresolved.

## Recovery and refunds

`GET /api/desk` lists only the authenticated owner's last 30 desk orders. `POST /api/desk` accepts strict owner-scoped commands `quote`, `authorize`, `report`, `check`, `request-refund`, `refund`. Same-origin protection and rate limits apply. `check` can advance a verified payout; it is not a read-only status request. GET never signs or broadcasts.

Worker logs `thence-desk` aggregate counters. `errors` or `ambiguous` require investigation, not an assumption of failure or delivery. Inspect `desk_orders` and ordered `desk_events` by order ID through authorized read-only access. Do not log private keys or signed transaction bytes. Signed payout bytes stay server-side and are omitted from API responses; they contain a reusable broadcast authorization, although not a private key.

For `AWAITING_NIM`, use the exact memo and known hash to investigate. Never create a replacement payment or mark refunded from elapsed time. An authorized unpaid order currently stays unresolved until operator investigation; automatic no-payment closure is intentionally absent. For `PAYOUT_PREPARED` / `PAYOUT_SUBMITTED`, rebroadcast only the saved bytes. Do not send an alternative transfer or refund while the saved payout might still execute. Fee-bumping, lost/replaced nonce resolution and automatic treasury rebalancing are outside this pilot. A low-fee pending transaction can therefore require operator recovery.

For a `VERIFIED` deposit whose payout cannot be prepared (for example, gas estimation fails), the owner can choose **Request NIM return instead**. Under the same signing lock, `request-refund` queues a return only while no signed payout or payout hash exists. If a worker prepared the payout first, the request is refused. It does not send NIM.

For `REFUND_DUE`, first confirm no payout was prepared, or independently verify the saved payout's **finalized reverted** receipt. From the NIM collection wallet, send the full `payload.nimLuna` back to `payload.ownerAddress`, paying any NIM network fee separately. Attach text `THENCE:R:<order-id>`. After macro finality, the authenticated owner can report its hash using `POST /api/desk` `{ "action": "refund", "id": "<order-id>", "hash": "<NIM transaction hash>" }`. This verifies the exact full return and records `REFUNDED`; it never sends money. If a payout is unknown, the API refuses to close a refund. Refund queue monitoring and operator availability are required before activation.

Arbitrum and Base treasury delivery are future work. Existing live routes are not switched by this branch.

## Development verification

Targeted tests cover exact amounts, stale/depegged pricing, wrong sender/amount/reference/network, macro finality, authenticated vault owner signatures, saved signed payout terms, finalized Transfer evidence, owner-scoped APIs, reservation races, one prompt authorization, nonce allocation, unknown broadcast recovery, late deposits, return queues, discovery after a wrong hash and worker fairness.

Production build, standalone typecheck and lint passed on this branch. Phone-size Chromium QA against the production server used fake API data: review and pending states rendered, custody consent was required, no horizontal overflow or page exceptions occurred, and reopening a pending payment offered no new wallet prompt. No real Nimiq Pay approval or treasury broadcast was performed.

All **47 pilot tests passed**: 42 pricing/policy/proof/API/worker/UI tests and five isolated TEST DB ledger tests. A focused rerun of the restructured legacy settlement file passed all **21 tests**. After adding a per-run fixture identifier guard, the final targeted rerun passed **11 tests** (ten invalid-settlement scenarios plus one matcher; ten other tests intentionally filtered out). The original full-project test run hit a 300-second timeout in a ten-scenario settlement test, followed by a provider-override setup failure; it was stopped for investigation. Those scenarios now run as individual sequential tests with the same assertions and separate lifecycle budgets. Fixture claim hashes keep a short case tag so the per-run identifier cannot be truncated.

After dependency remediation the **full suite completed green**: 117 files (116 passed, 1 skipped) and 1705 tests (1703 passed, 2 skipped), 0 failed, 37 minutes, against the isolated test database and live providers.

Dependencies were remediated before this deployment: `next` and `eslint-config-next` 16.4.5, `zod` 4.6.7, `drizzle-orm` 0.45.4 with `drizzle-kit` 0.31.11, `vitest` 4.1.12, and an explicit `esbuild` 0.28.2 with `@esbuild-kit/core-utils` pinned to `esbuild` ^0.25.0. `npm audit` reports 0 vulnerabilities across prod, dev and optional trees.

The drizzle major bump wraps PostgreSQL errors in `DrizzleQueryError`, which carries the SQL text as its own message and moves the original error (and SQLSTATE) to `cause`. Four raw `.code === "23505"` checks in `transfers`, `recipients`, `requests` and `verification` therefore missed unique violations; they now use the shared cause-walking `isUniqueViolation()`. This was caught by two full-suite failures — concurrent creation idempotency and the append-only evidence guard — and both now pass; the evidence test reads the whole cause chain instead of drizzle's wrapper message.
