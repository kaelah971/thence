# Thence — Recipients & Destinations API (B2.1)

Backend contract for the future frontend. All endpoints require B1 wallet
authentication (HttpOnly session cookie). Identity always comes from the
verified session; cross-user ids resolve to `404` (no existence oracle).

Error shape everywhere: `{ "error": "<CODE>", "message": "<human text>" }`.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/recipients?q=&archived=&page=&pageSize=` | cookie | List own recipients (default: excludes archived; `archived=true` includes them; `q` matches display name; `pageSize` max 100) |
| POST | `/api/recipients` | cookie | Create `{ displayName }` → 201 |
| GET | `/api/recipients/:id` | cookie | Detail incl. `destinations[]`, `transferCount`, `lastPaidAt` |
| PATCH | `/api/recipients/:id` | cookie | `{ displayName? }`, `{ archived: true }` archive, `{ archived: false }` unarchive. Archived recipients are frozen except unarchive (409 otherwise) |
| GET | `/api/recipients/:id/destinations` | cookie | List destinations (default first) |
| POST | `/api/recipients/:id/destinations` | cookie | Add `{ asset, network, address, label?, isDefault? }` → 201. First destination auto-becomes default; `isDefault: true` switches atomically |
| PATCH | `/api/recipients/:id/destinations/:destId` | cookie | Edit fields and/or `{ isDefault: true }`. Unsetting the only default promotes the most recent sibling |
| DELETE | `/api/recipients/:id/destinations/:destId` | cookie | Remove. Deleting the default promotes the most recent sibling. Transfer history is preserved (transfers reference recipients, never destinations) |

State-changing writes additionally enforce same-origin (403 on forged
`Origin`/`Referer`), a JSON body cap (413 past 8 KB), and a DB-backed
per-client write rate limit (429 + `Retry-After`).

## Shapes

Recipient summary:

```json
{
  "id": "uuid",
  "displayName": "Daniel",
  "archivedAt": null,
  "createdAt": "…",
  "updatedAt": "…",
  "defaultDestination": {
    "id": "uuid", "asset": "USDC", "network": "Base",
    "address": "0x…", "label": "Base savings",
    "verification": { "status": "added-by-you" }
  },
  "destinationCount": 2,
  "transferCount": 1,
  "lastPaidAt": "…"
}
```

Destination: summary fields plus `"isDefault": true` and `"createdAt"`.
`verification.status` is `"added-by-you"` unless a completed recipient
verification backs the destination (`"verified-by-recipient"` + `verifiedAt`).
Clients cannot set verification — `verification*`/`verified*`/`owner_*`
fields are rejected with 400.

## Network guard

- Pair must exist in the canonical registry (`USDT/Polygon`,
  `USDT/Arbitrum`, `USDC/Arbitrum`, `USDC/Ethereum`, `USDC/Base`,
  `BTC/Lightning`) or the call fails `UNSUPPORTED_ROUTE`.
- EVM networks require `0x` + 40 hex; mixed-case must satisfy EIP-55
  (`INVALID_ADDRESS` otherwise). Validity is never proof of ownership.
- `BTC/Lightning` with a BOLT11 invoice → `BOLT11_NOT_REUSABLE`
  (invoices are single-use and expire). Any other reusable Lightning
  endpoint → `LIGHTNING_DESTINATION_PENDING` until a real
  validation/resolution contract exists. No token contracts or wallet
  addresses are hardcoded anywhere.

## Frontend notes (for later milestones)

- **Recent recipients**: list defaults to `updatedAt` desc; combine with
  `lastPaidAt`/`transferCount` for recency.
- **Pay Again**: use `defaultDestination` (asset/network/address/amount
  flow comes with the Send milestone).
- **Send picker**: `GET /api/recipients/:id` gives the selectable
  settlement preference (`destinations[]`, default first).
