# FRONTEND_HANDOFF (B6) — Mini App Integration Target

Backend is a stable integration target. No frontend code here; no funded
transactions were ever executed. All tables below describe the existing,
tested backend — `E2E_PENDING` where a real host/wallet is required.

## 1. Base rules (apply to every screen)

- **Auth:** `POST /api/session/challenge` → sign with Nimiq wallet →
  `POST /api/session/verify` sets HttpOnly session cookie. All
  authenticated calls send the cookie; all POSTs must pass same-origin /
  allow-list CSRF checks. No token storage in JS.
- **Money rules:** the frontend NEVER attests payment. It reports only
  `cancelled | initiated | unknown`. It never retries `createSwap` or
  `payLightningInvoice` when the outcome is uncertain — surface
  "Checking payment — do not resend" and poll read-only endpoints.
- **Amounts:** exact atomic-unit strings everywhere. Never equate NIM
  balance with Lightning sats. No fiat conversion exists — do not invent one.
- **Rate limits:** authenticated calls are user-keyed (shared IPs are
  safe); anonymous calls are layered per challenge/token/global.

## 2. Endpoint inventory (all VERIFIED by integration tests)

| # | Method + path | Auth | Input → Response (shape) | Errors | Idempotent | Cache |
|---|---|---|---|---|---|---|
| 1 | POST `/api/session/challenge` | no | `{address?}` → `{challenge, expiresAt}` | 400/429 | new nonce each call | — |
| 2 | POST `/api/session/verify` | no | `{challenge, publicKey, signature}` → `{user:{id,nimiqAddress}}` + cookie | 400/401/409/429 | single-use challenge | — |
| 3 | POST `/api/session/logout` | yes | — → `{ok}` | 401 | yes | — |
| 4 | GET `/api/me` | yes | — → `{user}` | 401 | yes | no-store |
| 5 | GET `/api/health` | no | — → `{status, service, version, env, enabledRoutes, db, uptimeSec, latencyMs}` | never 500s config | yes | dynamic |
| 6 | CRUD `/api/recipients` (+`/[id]`) | yes | `{displayName}` → recipient; PATCH/DELETE | 400/404/409 | create dedupes by name+owner | no-store reads |
| 7 | POST/GET `/api/recipients/[id]/destinations` | yes | `{asset, network, address, label?}` → destination `{id, isDefault, verification}` | 400/404/409 | no (distinct rows) | no-store |
| 8 | PATCH/DELETE `.../destinations/[destId]` | yes | `{isDefault?, label?…}` → destination | 400/404/409/500→retry | concurrent-safe, converges | — |
| 9 | POST `.../verify-start`, POST `/api/verify/[token]`, GET `/api/verify/[token]` | mixed | EVM personal_sign proof → `{verified:true}` + badge | 400/404/409/410 | proof write-once | no-store |
| 10 | POST/GET `/api/requests`, PATCH `/api/requests/[publicId]`, GET `/api/requests/[publicId]` | mixed | request terms `{publicId, amount, asset, network, expiresAt}`; cancel only | 400/404/409 | cancel idempotent | no-store; public GET returns terms only |
| 11 | GET `/api/routes/public` | no | — → live route availability | 429/503 | yes | no-store |
| 12 | POST `/api/quotes` | yes | `{routeId, targetAmountAtomic}` → exact-receive quote `{netTarget, fees, expiresAt}` | 400/409/503 | yes (read-only) | — |
| 13 | POST `/api/transfers` | yes | `{routeId, targetAmountAtomic, idempotencyKey, direct?}` → `{transfer, deduplicated}` (201/200) | 400/409/503 | **yes — reuse idempotencyKey** | — |
| 14 | GET `/api/transfers`, GET `/api/transfers/[id]` | yes | list/detail with `status`, `statusLabel` | 401/404 | yes | no-store detail |
| 15 | POST `.../[id]/requote` | yes | `{}` → fresh quote, revision+1 | 400/409 | no (new revision) | — |
| 16 | POST `.../[id]/prepare` | yes | `{expectedQuoteRevision}` → `{attempt, attemptToken}` (token once) | 400/409/410 | replay returns same attempt | — |
| 17 | POST `.../[id]/attach` | yes | `{attemptToken, expectedQuoteRevision, satoraSwapId, recoveryAcknowledged:true}` → bound swap | 400/404/409/410 | same swap replays | — |
| 18 | POST `.../[id]/authorize-handoff` | yes | `{attemptToken}` → authorized | 400/409/410 | second call 409, no side effect | — |
| 19 | GET `.../[id]/attempt` | yes | — → attempt + transfer status (resume) | 401/404 | yes | no-store |
| 20 | POST `.../[id]/handoff-result` | yes | `{outcome: cancelled\|initiated\|unknown}` → `{handoff:{status, deduplicated}}` | 400/409/503 | dedup flags | — |
| 21 | POST `.../[id]/reconcile` | yes | `{}` → `{reconciliation:{status, providerStatus, claimReady, ambiguous, …}}` | 404/409/503 | yes | — |
| 22 | GET `.../[id]/reconciliation` | yes | — → resume view (transfer+attempt+swap+latest) | 401/404 | yes | no-store |
| 23 | POST `.../[id]/verify-settlement` | yes | `{}` (client tx hashes **ignored**) → `{settlement:{verdict, proof…}}` | 404/409/422/503 | yes (converges) | — |
| 24 | GET `.../[id]/receipt` | yes | — → immutable receipt, or 409 `RECEIPT_NOT_READY` | 404/409 | immutable | no-store |

Transfer `statusLabel` map (display verbatim): Ready to pay
(DRAFT/QUOTED/SWAP_CREATED) · Quote expired · Approve in Nimiq Pay ·
Payment cancelled · Payment approved · **Checking payment — do not
resend** (OUTCOME_UNKNOWN/RECONCILING) · Converting · Sending ·
Needs attention · Delivered.

## 3. Mocked E2E walkthrough (contract exists for every step)

A–H app-side: 1→5 login/profile, 6→8 recipients/destinations,
12 quote, 13 create (idempotent), 16 prepare. I–J **browser-only and
unbuilt**: create the Lightning→EVM swap with `@satora/swap` in the Mini
App, persist SDK state to IndexedDB, **read it back before proceeding**.
K attach (server re-verifies swap identity/terms), L authorize (single,
pre-funding). M **browser-only**: `payLightningInvoice` only after
explicit user approval showing native debit terms. N outcome report
(never success). O reconcile same bound swap (idempotent). P
**browser-only**: SDK claim with client-owned material when the server
is funded. Q verify-settlement (server-derived claim tx). R receipt
only after `DELIVERED` (pre-delivery → 409).

## 4. Responsibility boundaries

- **Nimiq Pay client:** host connection, balances, challenge signing,
  `payLightningInvoice` behind deliberate approval with native terms.
- **Satora browser client:** swap creation, secret custody, IndexedDB
  persistence + readback, same swap identity across resume,
  claim/recovery execution. Secrets never touch the backend.
- **Backend:** identity, metadata, quotes, swap verification, one-shot
  authorization, observations, ambiguity resolution, chain proof,
  receipts.

## 5. Recovery gates (frontend display rules)

| Case | Show | Retry safe? | Call | Manual? | 2nd payment? |
|---|---|---|---|---|---|
| Quote expired pre-prepare | "Quote expired — refresh" | yes | requote → prepare | no | n/a (nothing paid) |
| IndexedDB persist fails | "Not saved — do not pay" | yes (new swap) | — (do NOT attach) | no | n/a |
| Crash between createSwap/storeSwap | "Check for an existing swap before creating" | only after recovery lookup | attach existing swap id | yes if unrecoverable | **forbidden** until resolved |
| Attach times out | "Checking…" then resume | yes (idempotent) | GET attempt → attach | no | forbidden until bound-or-not known |
| Authorize response lost | "Checking…" | yes (409 = already authorized) | GET attempt → proceed | no | forbidden (single authorization) |
| User rejects Nimiq approval | "Payment cancelled" | yes, fresh flow | report `cancelled` if pre-submit | no | allowed (nothing moved) |
| Unknown Pay outcome | "Checking payment — do not resend" | only read-only calls | report `unknown` → reconcile | no | **forbidden** |
| Funding after cancel | "Checking payment…" | only read-only calls | reconcile (recoverable by design) | no | **forbidden** |
| Claim submit timeout | "Checking…" | re-query, never re-claim blindly | verify-settlement | yes if stuck | n/a (no new swap) |
| Claimed but no chain proof | "Checking…" (INCONCLUSIVE) | re-verify later | verify-settlement | yes if persistent | n/a |

## 6. Product mapping + route honesty

- HOME: NIM balance (host only), destination currency, indicative estimate (quote endpoint, labelled estimate), recent activity (`GET /transfers`).
- SEND: recipient pick/create → destination → exact amount → quote → review → native approval → progress/recovery screens per §5.
- RECIPIENTS: CRUD + verification badges + Pay Again (prefill Send).
- ACTIVITY: transfer list, `statusLabel` timeline, reconcile/verify actions, receipt view.
- REQUEST TO PAY: share `publicId` link; public terms immutable; expiry/cancel states; prefill Send.
- Routes (provider-verified, never substituted): USDC Polygon/Arbitrum/Ethereum live; USDT Ethereum quoted-where-offered; classic USDT on Polygon/Arbitrum **unavailable** (only USDT0 listed — a different token, never substituted); USDC Base unavailable; BTC Lightning host-dependent. Quoteable ≠ settled.

## 7. Configuration gates (all classified in docs/OPERATIONS.md)

Fail-closed without: trusted EVM RPCs, finality config, verified token
contracts, valid app origin, DATABASE_URL, production cookies
(`Secure` auto in production). Outstanding externals: Nimiq host
(HOST_INTEGRATION_PENDING), edge/WAF (deployment-pending policy in
OPERATIONS.md §3), pool validation under prod traffic, trusted RPC
infra, real-wallet signing tests, browser persistence tests, one funded
NIM→recipient E2E (E2E_PENDING).

## 8. F1 slice proposal (first frontend increment)

1. App shell + brand + auth flow (challenge/verify, session, /me) against the live backend.
2. Recipients CRUD + destinations + verification badges (no money).
3. Routes catalog + exact-receive quotes (read-only, estimate-labelled).
4. Send flow through transfer create → prepare → attach (mock swap id in dev) with resume rendering; stop before authorization UX.
5. Then: Nimiq Pay host binding, then authorization/claim UX per §5 gates.

## 9. Integration blockers (exact)

1. Nimiq Pay Mini App host binding (sign + `payLightningInvoice`) — without it, no funded test is possible.
2. IndexedDB SDK persistence + readback proof in the browser bundle.
3. Edge/WAF rate-limit policy enforcement (app keys are forgeable by design).
4. One funded NIM→recipient E2E to validate claim observation + receipt against mainnet.
5. Production Neon pool + trusted RPC validation under real traffic.
