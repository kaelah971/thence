# Thence — Payment Requests API (B2.2)

“Request to Pay”: a recipient specifies what they want to receive; the payer
opens a shareable link without needing to know the recipient beforehand.
Backend only — no QR interface in this slice (the frontend renders QR from `url`).

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/requests` | cookie | Create `{ recipientName, asset, network, address, amount, memo?, expiresInSeconds? }` → 201. Initiates nothing: no payment, no swap, no quote |
| GET | `/api/requests?status=&page=&pageSize=` | cookie | Owner's requests only. `status`: `active` (default listing shows all unless filtered: `active`/`expired`/`cancelled`/`all`) |
| GET | `/api/requests/:publicId` | **none (public)** | Public payment terms only. `Cache-Control: no-store`. Bounded per-client read rate limit (429 + `Retry-After`) |
| PATCH | `/api/requests/:publicId` | cookie (creator only) | Only `{ "action": "cancel" }`. Anything else → 400 `IMMUTABLE`; other users → 404 |

State-changing endpoints enforce same-origin (403 on forged `Origin`/`Referer`),
an 8 KB JSON body cap (413), and a DB-backed per-client write throttle
(429 + `Retry-After`).

## Contracts

Create (owner view returned):

```json
{
  "request": {
    "id": "uuid",
    "publicId": "22-char-url-safe-id",
    "recipientName": "Daniel",
    "amount": "50",
    "amountAtomic": "50000000",
    "asset": "USDC",
    "network": "Base",
    "destination": "0x…",
    "memo": "Dinner",
    "expiresAt": "…",
    "cancelledAt": null,
    "createdAt": "…",
    "status": "active",
    "route": { "id": "usdc-base", "supported": true, "quoteable": false },
    "url": "/r/<publicId>"
  }
}
```

Public view: same minus `id`, `createdAt`, `cancelledAt` internals — exactly
`publicId, recipientName, amount, amountAtomic, asset, network, destination,
memo, expiresAt, status, route, url`. Never `creatorUserId`, session data,
recipient-book ids, or history.

`url` is relative (`/r/<publicId>`) unless `THENCE_APP_ORIGIN` configures a
trusted absolute origin (never the request `Host` header). `route.quoteable`
reflects the current registry honestly — a supported route is NOT a liquidity
promise; B3 performs live availability and quote checks.

## Request lifecycle

`active` → (`expired` when `expiresAt` passes) or (`cancelled` by creator).
Cancelled wins over expired. Terms are immutable: any non-cancel PATCH is
rejected; to change terms, create a new request. Cancellation is idempotent
(repeat returns the same state). There is deliberately **no `paid` status** —
fulfillment attaches in later transfer milestones, never from a client claim.

The request is a self-contained snapshot: no recipient-book foreign key.
Recipient edits, archives, or deletions never mutate request terms.

## Error codes

`BAD_BODY` · `BAD_AMOUNT` (zero/negative/over-precision/malformed) ·
`BAD_EXPIRY` (lifetime exceeds maximum) · `UNSUPPORTED_ROUTE` ·
`INVALID_ADDRESS` · `BOLT11_NOT_REUSABLE` · `LIGHTNING_DESTINATION_PENDING` ·
`FIELD_FORBIDDEN` (owner/verification forgery) · `IMMUTABLE` ·
`NOT_FOUND` (incl. cross-user) · `UNAUTHORIZED` (401, owner endpoints) ·
`ORIGIN_MISMATCH` (403) · `BODY_TOO_LARGE` (413) · `RATE_LIMITED` (429).

## Frontend integration expectations (deferred slices)

- Share: copy `url` or render it as QR client-side; absolute form appears
  automatically when `THENCE_APP_ORIGIN` is configured.
- Open: `GET /api/requests/:publicId` (no login) → prefill Send with the
  exact terms; never treat `active` as quoted/liquid — B3 checks live.
- After funding intent: offer “Save this recipient” (writes the recipient
  book via B2.1; NOT part of this backend slice).
- Expired/cancelled links must render as unpayable with their stored terms.
