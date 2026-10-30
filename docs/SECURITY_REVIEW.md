# SECURITY_REVIEW (B5.1) — Money-Path Hardening

Focused review of the B0–B4 backend boundaries. One confirmed
vulnerability was fixed (rate-limit key forgery); everything else was
verified against code, schema, and tests with no change. No new product
features, no live money movement, no funded transactions or claims.

## 1. Trust boundaries

- **Client browser**: untrusted. May forge headers, bodies, and timing;
  may skip steps, replay requests, or report false outcomes. All
  security-relevant facts are re-derived server-side per request.
- **Satora provider API**: semi-trusted assertions (swap status, invoice,
  txids). Never payment proof. Chain facts re-verified independently.
- **Configured EVM RPCs**: trusted transport to public chain state;
  responses still validated (shape, hash agreement, finality policy).
- **Neon PostgreSQL**: trusted store; advisory locks + unique
  constraints are the concurrency backstop.
- **Nimiq wallet (host)**: external signer; integration pending, so no
  host-signed assertion is accepted anywhere yet.

## 2. Threats examined (with evidence, not assumptions)

### T1 — Rate-limit bypass via forged forwarding headers [CONFIRMED, FIXED]
`clientKeyFromHeaders` keyed every limiter on the client-controlled
`x-forwarded-for` first entry. Demonstrated: rotating the header per
request gives each request a fresh counter, so no limit ever triggers —
on all 19 authenticated endpoints including transfer, handoff, quote,
and settlement-verification writes.
Fix: new `rateLimitKeyFor(userId, headers)` keys authenticated callers
by server-derived `session.userId` (`user:{id}`); header keying remains
only for genuinely unauthenticated endpoints (challenge, session verify,
public routes/catalog, token verification). Regression:
`tests/rate-limit.test.ts` — pure key-derivation tests plus a LIVE test
that rotates six forged IPs against a limit of 2 and asserts the single
user counter reaches 6 with enforcement applied.

### T2 — Cross-user transfer/swap access
Verified by construction + tests: every money endpoint filters
`ownerUserId = session.userId` (404 otherwise); swap attachments are
per-transfer UNIQUE and globally UNIQUE on `satora_swap_id`; bonds are
re-validated against provider facts on every read. Existing IDOR tests
(reconcile, resume, verify-settlement, receipt, cross-user attach)
all pass. No change.

### T3 — Swap reuse / wrong-destination attach (theft analysis)
No vulnerability. (a) Second attach of the same swap fails with
`SWAP_ALREADY_BOUND` (global unique). (b) Attaching someone else's swap
to your transfer fails `verifySwapMatch` unless your transfer's
asset/network/amount/destination exactly equal the swap's — and funds
follow the *swap's* `target_evm_address`, never the transfer row, so a
matching attach cannot redirect money. The binding is attribution, not
direction. No change; do not relax either check.

### T4 — Replay of prepare/authorize, stale quotes, skipped recovery ack
Prepare is idempotent per (transfer, revision) with token-hash binding;
authorize requires `SWAP_CREATED` + `SWAP_ATTACHED` + unexpired attempt +
live provider `pending` + repricing re-check, and converges to one
`HANDOFF_AUTHORIZED` (B4.2 tests). Stale quotes are rejected via
`expectedQuoteRevision` + `quoteExpiresAt`; missing recovery ack is 400.
No change.

### T5 — Re-authorization / second funding after unknown outcome
Impossible by state gates: prepare requires `QUOTED`, attach requires
`QUOTED`, authorize requires `SWAP_CREATED`. `OUTCOME_UNKNOWN` /
`RECONCILING` transfers cannot re-enter the handoff path, so no second
funding attempt can be authorized. Cancel reports from `AWAITING` route
to the reconcilable chain (B4.4), never terminal. Late-funding
regression test preserved and passing. No change.

### T6 — Forged paid/claimed/delivered states
`handoffOutcomeSchema` accepts only cancelled/initiated/unknown; funded-
family strings are rejected with `CLIENT_CANNOT_ATTEST` (tested).
`DELIVERED` requires `transition(..., {evidence})` inside settlement
verification only. Provider status alone never delivers (reconcile has
no `DELIVERED` edge). No change.

### T7 — Settlement proof integrity (B4.4 rules re-confirmed)
Claim tx is provider-bound (`getProviderSwap(boundSwap)`); RPC/token/
chain/amount all server-derived (route registry + transfer snapshot);
amounts are `BigInt` atomic sums over matching logs only; finality is
fail-closed per chain; reorg/header mismatch → `INCONCLUSIVE`;
`UNIQUE(chain_id, evm_tx_hash)` + in-transaction clash check blocks
double attribution with 409. Scoping determination (§3): one claim tx
settles exactly one swap HTLC (`hash_lock` + per-swap coordinator), and
one swap binds at most one transfer (DB-enforced), so the UNIQUE cannot
reject legitimate independent settlements; CCTP-bridged and native legs
stay `INCONCLUSIVE` by rule and are an explicit E2E validation gate
(see §6). No change.

### T8 — Unknown-outcome safety
Cancel-while-pending can no longer strand delayed funding (B4.4 fix +
regression test, passing). Expired invoices, provider timeouts, and
duplicate client callbacks all resolve to reconcilable states, never
`FAILED`/`USER_CANCELLED`/re-authorization. No change.

### T9 — Secrets and data minimization
Grep over `src/lib`, money routes: no mnemonic/preimage/private-key/
token material in code, logs, responses, or error paths (only
`SECRET_ENV_KEYS = ["DATABASE_URL"]`, never logged). `transfer_proofs`
columns are public identifiers only; tests assert no secret patterns in
stored rows and API payloads. Anonymous endpoints return public terms
only; sensitive GETs send `Cache-Control: no-store`; errors are generic
codes. No change.

### T10 — Nimiq verification (review only)
`src/lib/nimiq.ts` implements the documented keyguard scheme
(`\x16Nimiq Signed Message:\n` + decimal length + bytes → SHA-256 →
raw Ed25519), RFC 8032 TEST 1 vector for the primitive, strict hex
parsing, IBAN mod-97 per core-rs. B1 tests green. No demonstrated
correctness issue → cryptography untouched per constraint. Host
wallet-signing E2E remains pending (pre-existing condition).

## 3. Residual risks (by severity)

- **Medium — anonymous-endpoint rate limiting still header-keyed**
  (challenge, session verify, public routes/catalog, token verify).
  Unauthenticated callers have no stable server identity to key on.
  Impact is bounded (single-use short-TTL challenges, public data), but
  login/challenge endpoints deserve account- or proof-based throttling
  in B5.2/B6. Not exploitable into money movement.
- **Low — shared-DB flake pressure under 4-worker parallel CI**
  (transient 5xx absorbed by a bounded test-only retry in the
  destinations suite; no prod change). Production traffic patterns
  differ; monitor pool saturation on first deploy.
- **Low — CCTP-bridged routes unverifiable by the ERC20 rule.**
  Explicit E2E gate: do not enable bridged routes until a second-leg
  evidence rule ships with real settlement data.
- **Info — public RPC circa B4.4 decoder check only; production needs
  authenticated `THENCE_EVM_RPCS_JSON` (empty = fail-closed, correct).**

## 4. Client vs server responsibilities

Server owns: identity, ownership scoping, quote/revision binding, swap
verification, authorization gating, outcome recording, settlement proof,
finality, receipts. Client owns: durable recovery material, honest
outcome reporting (treated as hints, never proof), and — in future —
invoking Nimiq Pay and the EVM claim. The client can never advance money
state by assertion.

## 5. B5.2 / B6 gates

Real host-signing E2E (Nimiq Pay) before any mainnet flow; funded-claim
observation to validate coordinator multi-log behavior on mainnet;
account-aware throttling for anonymous auth endpoints; pool sizing from
production traffic; CCTP second-leg evidence rule before enabling
bridged routes.
