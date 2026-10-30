# Thence — Transfers API (B4.1)

Durable, owner-scoped **transfer intents**: an immutable destination snapshot
bound to a live exact-output quote. This slice stops at QUOTED — no swap,
invoice, approval, settlement or delivery exists here. Only later provider
payment evidence may advance the state machine (B4.2+); there is no
client-controlled status endpoint.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/transfers` | cookie (rate-limited, origin-checked, 8 KB cap) | Create intent from exactly one of `recipientDestinationId`, `requestPublicId`, or `direct:{asset,network,address}` + `routeId`, `targetAmountAtomic`, `idempotencyKey`, optional `recipientName` (direct only). → 201 (new) or 200 `{deduplicated:true}` (replay) |
| GET | `/api/transfers?status=&page=&pageSize=` | cookie | Owner's transfers, newest first. `status` must be a known domain status |
| GET | `/api/transfers/:id` | cookie (owner only) | Full snapshot, quote, freshness, timeline |
| POST | `/api/transfers/:id/requote` | cookie (owner only) | `{ expectedQuoteRevision }` → fresh live quote, revision+1. Only in pre-funding `QUOTED` |

## Transfer shape (abridged)

```json
{
  "transfer": {
    "id": "uuid", "status": "QUOTED", "statusLabel": "Ready to pay",
    "routeId": "usdc-polygon", "asset": "USDC", "network": "Polygon",
    "destination": "0x…", "targetAmountAtomic": "5000000",
    "recipientName": "Daniel",
    "recipientDestinationId": "uuid|null", "requestId": "uuid|null",
    "requestPublicId": "…|null", "idempotencyKey": "…",
    "quote": {
      "provider": "satora", "revision": 2, "exact": true,
      "requestedAtomic": "5000000", "netTargetAmountAtomic": "5000000",
      "sourceSats": "6327", "fees": { "networkFeeSats": 4, "gaslessNetworkFeeSats": 0, "protocolFeeSats": 31, "protocolFeeRate": 0.005, "unit": "sats" },
      "limits": { "minSats": 356, "maxSats": 20000000 },
      "observedAt": "…", "validUntil": "…", "fresh": true
    },
    "createdAt": "…", "updatedAt": "…", "quotedAt": "…", "quoteExpiresAt": "…"
  }
}
```

## Lifecycle implemented in B4.1

- Creation validates the `DRAFT→QUOTED` domain edge, then persists `QUOTED`
  with `quoteRevision: 1`. Rejected inputs never create rows (no DRAFT orphans).
- `requote` requires `status == QUOTED` and `expectedQuoteRevision` equal to
  the stored revision (single conditional `UPDATE … WHERE revision = $expected`
  — concurrent requotes converge to exactly one winner, losers get 409
  `VERSION_CONFLICT`). Revalidation always uses **new live provider terms**.
- Quote expiry is informational (`quote.fresh: false`, `validUntil` passed):
  an expired quote is NOT a failure and stays `QUOTED`; requote refreshes it.
- `NEVER` in B4.1: funding, approval, claiming, delivered, failed-via-unknown,
  or any client-driven status change.

## Idempotency contract

`UNIQUE(owner, idempotencyKey)`. Same key + same canonical request
(route, triple lower-cased, amount, recipient/request refs, name) → same
transfer, `{deduplicated:true}`. Same key + different request → 409
`IDEMPOTENCY_CONFLICT`. Concurrent identical creates converge on one row
(unique violation → re-read → fingerprint compare). Keys are owner-scoped:
no cross-user visibility or collision.

## Snapshot invariance

The transfer stores its own recipient name, route, asset/network/address,
and atomic amount. Renaming/archiving beneficiaries, editing destinations,
cancelling or expiring requests never mutates existing transfers (verified
by tests). Payment-request intents additionally revalidate the live request
on requote (cancelled/expired → 409); deleted requests fall back to the
frozen snapshot terms.

## Money-safety boundary (B4.1)

The backend imports only the read-only quote path (`getQuote`, token/pair
catalogues). It never: creates a Satora swap, generates invoices, holds or
persists mnemonics/preimages/recovery material, calls Nimiq Pay, claims
payouts, marks anything delivered, or infers success from a quote or client
claim. `transfer_proofs` stays empty in this slice.

## B4.2 handoff prerequisites

Client-held Satora SDK creates the swap + persists recovery material in
durable browser storage **before** any Nimiq Pay handoff (persist-before-handoff).
The backend keeps exposing the quoted intent (`sourceSats`, route, destination)
for the client to build from, plus `requestId`/`publicId` linkage for receipts.
Server-side swap observation, funding detection, claiming and delivery evidence
attach in B4.2 — this slice deliberately has no endpoints for them.

## Error codes

`BAD_BODY` · `FIELD_FORBIDDEN` · `UNKNOWN_ROUTE` · `ROUTE_DISABLED` ·
`ROUTE_NOT_QUOTEABLE` · `BAD_AMOUNT` · `SNAPSHOT_MISMATCH` (wrong request amount,
route, address, or archived/blocked source) · `REQUEST_NOT_FOUND`/`REQUEST_CANCELLED`/
`REQUEST_EXPIRED` · `BELOW_MINIMUM`/`ABOVE_MAXIMUM` · `NOT_FOUND` (incl. cross-user) ·
`RECIPIENT_ARCHIVED` · `IDEMPOTENCY_CONFLICT` (409) · `VERSION_CONFLICT` (409) ·
`NOT_REQUOTEABLE` (409, non-QUOTED) · `UNAUTHORIZED`/`ORIGIN_MISMATCH`/
`BODY_TOO_LARGE`/`RATE_LIMITED`.
