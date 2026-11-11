# Thence — Swap Binding & Handoff Contract (B4.2, backend only)

This document is the backend/client split for moving a QUOTED transfer to a
Nimiq Pay handoff. The backend never creates swaps, invoices, approvals,
claims or settlements in this slice — it **binds and gates**.

## Verified Satora finding (do not re-litigate without new evidence)

`@satora/swap@1.7.2` `createLightningToEvmSwap` runs, in order:
`POST /swap/lightning/evm` (provider swap now exists) → `storeSwap(...)`
(browser persistence **after**). A crash, closed tab, or storage failure
between the two leaves a provider-side swap with no client recovery record.
Retries only happen on hash-collision, so a lost response is *not*
auto-retried — but a naive client retry would create a *second* swap.

Mitigation (enforced below + required of the future frontend):
the client must persist recovery material in durable browser storage and
**read it back** before invoking Nimiq Pay; the backend binds exactly one
swap per transfer, rejects second swaps, and never auto-creates anything.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/transfers/:id/prepare` | cookie (owner) | `{ expectedQuoteRevision }` → `{ attempt: {id, status: PREPARED, quoteRevision, expiresAt, …}, attemptToken, deduplicated }`. Revalidates status QUOTED, fresh quote, enabled route, active request, live token config. Idempotent replay returns the same active attempt. Expired predecessors are explicitly SUPERSEDED, never silently unlocked |
| GET | `/api/transfers/:id/attempt` | cookie (owner) | Resume contract: latest attempt + bound swap summary (no secrets). 404 when none |
| POST | `/api/transfers/:id/attach` | cookie (owner) | `{ attemptToken, expectedQuoteRevision?, satoraSwapId, recoveryAcknowledged: true }` → verifies the swap read-only, binds it, advances QUOTED → SWAP_CREATED. Idempotent replays return stored facts |
| POST | `/api/transfers/:id/authorize-handoff` | cookie (owner) | `{ attemptToken }` → revalidates live swap (still pending, invoice live) + repricing + ack, records one authorization, advances SWAP_CREATED → AWAITING_NIM_APPROVAL. Does NOT call Nimiq Pay |
| POST | `/api/transfers/:id/handoff-result` | cookie (owner) | `{ outcome: cancelled\|initiated\|unknown, diagnostics?, sourceTxHash? }` → records the bounded host outcome. `sourceTxHash` is only an untrusted Nimiq hint; the server independently verifies it against the authenticated wallet, bound Lightning payment hash, trusted Nimiq RPC, and configured confirmation-finality policy. |

All POSTs: same-origin, 8 KB body cap, DB-backed `transfers-write` throttle.

## Verification rules (attach)

Against the transfer snapshot + live provider facts, all must hold:
direction `lightning_to_evm` (exact) · chain id matches route · token
contract matches provider config (case-insensitive) · destination address
matches exactly · `target_amount` equals the requested atomic amount exactly ·
status `pending` · BOLT11 invoice present and unexpired · swap id equals the
requested one · swap not already bound to any transfer. Anything else is a
409 (`SWAP_MISMATCH` / `SWAP_STATE_UNEXPECTED` / `INVOICE_EXPIRED` /
`SWAP_CONFLICT` / `SWAP_ALREADY_BOUND`), unknown ids 404, provider trouble
502/503 — never FAILED, never auto-anything.

## Authorization rules

Requires: attached + acknowledged attempt, live swap still `pending` with a
live invoice, and `swap.sourceSats <= quoted.sourceSats`. A worse price
returns 409 `REPRICED_NEEDS_CONFIRMATION` (explicit renewed confirmation
belongs to a later slice); the transfer stays SWAP_CREATED. Exactly one
authorization per attempt (conditional update; losers get 409). Unknown
provider outcomes (timeout/down) return 503 and change nothing.

## Handoff boundary (B4.3+)

After authorization the frontend must: read back durable recovery state,
call Nimiq Pay `payLightningInvoice` itself, then report only the bounded
`cancelled`/`initiated`/`unknown` outcome. If the host returns a 32-byte hash,
it may send it as `sourceTxHash`; that identifier is never proof on its own.
The server reads the separate trusted Nimiq proof node independently and
stores source proof only when the exact transaction hash, successful execution,
actual transaction sender, authenticated HTLC sender, derived HTLC recipient,
SHA-256 payment hash, positive NIM amount, native-NIM structure, network and
configured finality checks pass; an unverified host hint never becomes source
evidence or public proof. Then observe provider status.
The backend will attach settlement evidence and receipts in later milestones.
`Delivered` remains impossible without destination evidence; unknown
outcomes must enter reconciliation, never failure.

## What remains unverified without a real host

A genuine browser swap creation (real invoice + real persistence round-trip),
a real Nimiq Pay approval, and any mainnet movement. All provider evidence
here is read-only or fixture-driven; no live swap was ever created.
