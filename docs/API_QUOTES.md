# Thence — Quotes API (B3.1)

Read-only exact-receive quoting for the NIM-funded Lightning route. The user
states what the recipient should receive; Thence obtains a live provider
quote. **Nothing here creates a swap, invoice, approval, transfer or payment.**

## Provider (verified)

- `@satora/swap` **1.7.2** (lendaswap-sdk-pure 2.7.x), default base URL
  `https://api.satora.io/` (overridable via `THENCE_SATORA_BASE_URL`).
- `getQuote({sourceChain: "Lightning", sourceToken: "btc", targetChain,
  targetToken, targetAmount})` — **native exact-output is supported**:
  pinning `targetAmount` (atomic `bigint`) returns `net_target_amount`
  equal to the requested amount (proven live). No fallback solver needed.
- `targetChain` is the EVM CAIP id (`"137"` Polygon, `"42161"` Arbitrum,
  `"1"` Ethereum). EVM token addresses come from the provider's live
  `/tokens` endpoint at quote time — never invented, never hardcoded.
- `QuoteResponse` units: `*_amount`/`source_amount`/`target_amount` are
  atomic-unit strings (u128-safe); `network_fee`, `gasless_network_fee`,
  `protocol_fee`, `min_amount`, `max_amount` are integer **sats**;
  `protocol_fee_rate` is a decimal fraction; `exchange_rate` is EVM token
  per BTC. The response carries **no expiry field**.
- Client construction is stateless (`Client.builder().build()`, no storage):
  the in-memory key material is never persisted, never used for signing —
  only read-only endpoints are called (`getTokens`, `getSwapPairs`,
  `getQuote`). No swap is ever created or funded from the backend.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/routes/public` | none (rate-limited) | All canonical routes with `enabled`, `supported`, live `quoteable`, reason, token symbol/decimals/address, chain id, sats limits, `lastObservedAt`. `no-store` |
| POST | `/api/quotes` | cookie (rate-limited, origin-checked, 8 KB cap) | `{ routeId, targetAmountAtomic, requestId? }` → 200 typed quote (below) |

## Quote response

```json
{
  "quote": {
    "routeId": "usdc-polygon", "asset": "USDC", "network": "Polygon",
    "targetAmountAtomic": "50000000", "targetAmount": "50",
    "netTargetAmountAtomic": "50000000", "exact": true,
    "sourceAmountSats": "63270", "sourceAmountPreFeeSats": "62920",
    "sourceChain": "Lightning",
    "fees": { "networkFeeSats": 4, "gaslessNetworkFeeSats": 0, "protocolFeeSats": 31, "protocolFeeRate": 0.005, "unit": "sats" },
    "limits": { "minSats": 356, "maxSats": 20000000 },
    "exchangeRate": "…", "exchangeRateNote": "EVM token per BTC, as reported by the provider.",
    "observedAt": "…", "validUntil": "…",
    "validityNote": "Local estimate only (TTL 300s); the provider issues no expiry and B4 revalidates before any handoff.",
    "availability": "available",
    "settlementProven": false,
    "settlementNote": "A quote is not a settlement promise; Delivered requires destination evidence.",
    "warnings": []
  }
}
```

Error codes: `UNKNOWN_ROUTE` · `ROUTE_DISABLED` · `ROUTE_NOT_QUOTEABLE`
(includes reason, e.g. classic USDT absent from the provider list on
Polygon) · `BAD_AMOUNT` (non-atomic/zero) · `BELOW_MINIMUM`/`ABOVE_MAXIMUM`
(sats bounds) · `SNAPSHOT_MISMATCH`/`REQUEST_NOT_ACTIVE`/`REQUEST_NOT_FOUND`
· `PROVIDER_TIMEOUT`/`PROVIDER_UNAVAILABLE` (503) · `INEXACT_QUOTE` (never
silent) · standard `UNAUTHORIZED`/`ORIGIN_MISMATCH`/`BODY_TOO_LARGE`/
`RATE_LIMITED`.

`requestId` (optional): terms are taken from the immutable payment-request
snapshot — pair must match, amount must equal (or be omitted only when… no:
the amount is required and must equal the snapshot), cancelled/expired
requests rejected, unknown ids 404.

## Freshness, caching, honesty rules

- Quotes are never cached server-side; each call is a live provider read
  (15s provider timeout). Token/pair reference data is cached in-memory for
  60s and labelled as such.
- `validUntil` = `observedAt` + `THENCE_QUOTE_TTL_SECONDS` (default 300) is a
  **local** estimate. There is deliberately no provider-expiry claim.
- Every quote writes a `route_observations` diagnostic row (min/max/fee in
  sats, source `satora-quote`) — availability signal only, never a promise.
- A quote never implies settlement, liquidity, or a fixed rate. B4 must
  revalidate executable terms immediately before any Nimiq Pay handoff.
- Observed provider behavior: getQuote can price BELOW its own published
  pair minimum (seen on Lightning→Ethereum). Thence rejects such quotes
  with BELOW_MINIMUM/ABOVE_MAXIMUM rather than presenting un-actionable
  terms; B4 revalidates regardless.

## Route matrix (verified live, read-only, 2026-10-27)

| Route | Asset | Network | Chain | Provider token? | Lightning pair? | Status |
|---|---|---|---|---|---|---|
| `usdc-polygon` | USDC | Polygon | 137 | yes (`0x3c49…`) | yes (min 356) | **live** |
| `usdc-arbitrum` | USDC | Arbitrum | 42161 | yes (`0xaf88…`) | yes (min 356) | **live** |
| `usdc-ethereum` | USDC | Ethereum | 1 | yes (`0xa0b8…`) | yes (min 10000) | **live** |
| `usdt-polygon` | USDT | Polygon | 137 | **no** (only USDT0/USDC) | yes | unavailable-token |
| `usdt-arbitrum` | USDT | Arbitrum | 42161 | **no** (only USDT0/USDC/…) | yes | unavailable-token |
| `usdc-base` | USDC | Base | 8453 | **no** (no Base tokens listed) | no pair | unavailable-token |
| `btc-lightning` | BTC | Lightning | n/a | n/a (Nimiq Pay native) | n/a | host-dependent |

Classic USDT is quoted live where actually offered (Ethereum
`0xdac1…`, verified exact-output). **USDT0 is a distinct token and is
never substituted for USDT** — `resolveRoute` matches symbol *and* chain
against the live catalogue, so `USDT`/Polygon correctly fails while
`USDT0`/Polygon exists. No Base tokens are listed at all, so Base legs
(incl. CCTP) stay unavailable. `GET /api/routes/public` reports per-route
`status` (`live` | `disabled` | `unsupported` | `unavailable-token` |
`unavailable-provider` | `unknown` | `host-dependent`) plus `providerFresh`
(stale-serving fallback is flagged, never silently cached as unsupported).

## Home estimate contract

`src/domain/estimates.ts` (`getSendValueEstimate`) is the typed contract
for the future Send-value-as dropdown. It returns `unavailable` with reason
`no-nim-pricing-source`: the NIM balance lives in Nimiq Pay client-side,
provider quotes are Lightning sats (not NIM debits), and no verified
NIM→Lightning indicative pricing source exists. No endpoint, no UI, no
invented prices — the exact NIM debit is always shown by Nimiq Pay.

## Route reality (verified live, read-only)

- **Proven exact-output**: USDC/Polygon, USDC/Arbitrum, USDT/Ethereum.
- **Unavailable**: classic USDT on Polygon (absent from the provider token
  list — only USDT0/USDC are offered on 137), USDC on Base (no Base tokens
  listed). These correctly return `ROUTE_NOT_QUOTEABLE` with the reason.
- Registry enablement (`THENCE_ENABLED_ROUTES`) gates selection; provider
  presence gates quoteability. The two are reported separately per route.
