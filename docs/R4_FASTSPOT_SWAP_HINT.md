# R4 — preserve the Fastspot swap id returned by Nimiq Pay

R3 detects a stalled NIM → Lightning payment. R4 makes the next one traceable to its actual Fastspot swap. It does not prevent the failure: the prevention belongs in Nimiq Pay and Fastspot (see "Upstream" below).

## Why

`payLightningInvoice` resolves with `{ hash, swapId }`. The `swapId` is the wallet's Fastspot swap (`paymentRef`). Until R4, Thence kept the hash and discarded the swap id. That left incident `6f44918d` untraceable at Fastspot. The upstream code shows the relevant gap: `nimiq-pay-app` `src/stores/transactions.ts` sends `provideFundingProof` once, does not await it, and only logs a rejection (`src/lib/swap-telemetry.ts`). Nothing in that code path retries it.

## What changes

| Piece | Where | Behaviour |
|---|---|---|
| Validation | `src/domain/host-swap-id.ts` | Conservative charset and length (`^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`). Fastspot does not document the format. The id is never rewritten. |
| Client capture | `useHandoff.ts`, `handoff-client.ts` | Kept only alongside a valid host hash. Saved in the local handoff record before the report, so an interrupted report re-sends it on resume. A malformed id is dropped and never fails the report. It is never sent with a cancellation. |
| Server record | `src/lib/host-swap-hint.ts`, called from `reportHandoffOutcome` | Owner-scoped, under the per-transfer lock. Stored as a same-state, non-terminal `HOST_SWAP_HINT_RECORDED` audit row (no schema change, not a hop; `consistency.ts` treats it like `SOURCE_EVIDENCE_RECORDED`). The first id wins. A different later id is a flagged conflict. An id seen on another transfer is flagged. There are at most 3 rows per transfer. |
| Exposure | — | Not in any client response, receipt, proof or analytics. The R3 alert carries only an 8-character `hostSwap` prefix. The full id is shown only by the operator script. |
| Operator diagnostics | `scripts/fastspot-diag.ts`, `src/lib/fastspot-diag.ts` | Reads the hint with `BEGIN READ ONLY … ROLLBACK`. `--lookup` makes one `GET /swap/{id}` and nothing else. The module has no PATCH/POST/DELETE path. It is off unless `THENCE_FASTSPOT_DIAG_BASE_URL` and `THENCE_FASTSPOT_DIAG_API_KEY` are set to a key Thence is authorized to use. Thence ships none. Nimiq Pay's embedded key is Nimiq's. The output is an allowlisted snapshot (swap and contract statuses, `hasPreimage` as a boolean, expiry). The preimage is never printed. |

## Trust

The id is an untrusted host hint. It never verifies the NIM source, never proves funding or settlement, never changes transfer state and is never read by a payment decision. A Fastspot lookup is a diagnostic snapshot only. The Nimiq chain remains the only source verification.

## Not changed

Payment execution, authorization, amounts and route limits (no cap), the one-unresolved-payment rule, source verification, deadlines, P4/R2 closes and the emergency switch. Thence sends no funding proof, invoice payment, refund or claim to Fastspot.

## Upstream (the actual prevention)

- **Nimiq Pay:** send the funding proof only after the broadcast is accepted. Await it, and retry with backoff until Fastspot acknowledges it or the swap expires. Surface a definite failure to the Mini App.
- **Fastspot:** detect confirmed NIM HTLC funding on-chain without depending on the proof. Document whether repeated proof PATCHes are idempotent. Offer an early cooperative refund once Lightning has definitively failed.

## Tests

- `tests/r4-host-swap-id.test.ts` (pure) covers:
  - validation;
  - the report body (valid, malformed, missing and unpaired ids);
  - interrupted-record persistence, including another owner and a tampered record;
  - the server schema;
  - GET-only lookup (not configured, bad id, one GET, no body, preimage withheld, HTTP error, timeout, junk);
  - the alert prefix.
- `tests/r1-auto-proof-publication.test.ts` (live test database) covers:
  - malformed, unpaired and cancelled reports refused;
  - a valid id recorded once;
  - a duplicate replay ignored;
  - a mismatched id kept as a conflict with the first retained;
  - the row cap;
  - a foreign owner refused (404);
  - the same id on another transfer flagged;
  - not exposed in the reconciliation view;
  - an R3 alert with the prefix only;
  - state and source verification unchanged, consistency clean and a late payment still advancing.
