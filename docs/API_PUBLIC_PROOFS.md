# Public proof-of-payments API (A3c.1)

This is a **read-only** publication surface. It does not create transfers,
claim, refund, reconcile, or otherwise move funds.

## Publication gate

The server keeps both endpoints dark unless the operator explicitly sets:

```dotenv
THENCE_PUBLIC_PROOFS_ENABLED=1
```

The default is `0`. The flag must remain off until disclosure and
historical-publication policies are approved. It is intentionally server-only
and is not a `NEXT_PUBLIC_*` value. Anonymous reads are bounded by
`THENCE_PUBLIC_PROOFS_READ_RATE_PER_MINUTE` and the shared anonymous ceiling.

When disabled, the endpoints return `404 PUBLIC_PROOFS_DISABLED` and do not
open a database connection.

## Feed

```http
GET /api/proofs?limit=20&cursor=<opaque-cursor>
```

`limit` is an integer from 1 to 50. Results are ordered newest verified
settlement first, with a stable `(verifiedAt, proofId)` cursor.

Sanitized example:

```json
{
  "proofs": [
    {
      "proofId": "11111111-1111-4111-8111-111111111111",
      "status": "DELIVERED",
      "destination": {
        "asset": "USDC",
        "network": "Polygon",
        "chainId": 137,
        "tokenContract": "0x1111111111111111111111111111111111111111",
        "recipient": "0x2222222222222222222222222222222222222222",
        "requestedAmountAtomic": "300000",
        "verifiedAmountAtomic": "300000",
        "decimals": 6,
        "transactionHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "blockNumber": "123456",
        "blockHash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "finalityLevel": "confirmations-256",
        "verifiedAt": "2026-11-10T12:10:00.000Z",
        "explorerTxUrl": "https://polygonscan.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "verification": {
        "destination": "VERIFIED",
        "source": "NOT_VERIFIED",
        "overall": "DESTINATION_ONLY"
      },
      "source": {
        "asset": "NIM",
        "evidence": "NOT_RECORDED",
        "verification": "NOT_VERIFIED",
        "note": "The Nimiq Pay debit is not independently verified by this public proof; no NIM amount, wallet, or transaction is published."
      }
    }
  ],
  "pagination": {
    "limit": 20,
    "nextCursor": null,
    "hasMore": false
  }
}
```

## Detail

```http
GET /api/proofs/:proofId
```

The response is `{ "proof": <feed item> }`. Unknown, malformed, unpublished,
and non-public proof ids all return `404 NOT_FOUND`.

## Publication invariants

A row is publishable only when all of the following hold:

- transfer status is `DELIVERED`;
- the route is USDC on Polygon or Arbitrum and the proof chain matches it;
- evidence source is the independently matched ERC20 destination transfer;
- recipient, transaction, token, block, amount, and finality fields are
  complete and internally consistent;
- verified destination amount is at least the requested atomic amount;
- the token matches the server's approved route token; Arbitrum additionally
  requires Circle native USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831`,
  never USDC.e;
- the stored finality level meets the applicable settlement policy. Arbitrum
  requires `finalized`; Polygon uses the configured/default confirmation
  policy.

Historical verified Polygon rows are not restricted by creation date. They
remain subject to the gate and the current publication trust configuration.

## Deliberate limitations

The public contract does not publish recipient labels, owner/session ids,
request or idempotency keys, invoices, payment hashes, preimages, Satora swap
ids, credentials, quoted Lightning sats, or NIM amounts/wallets/transactions.
A proof therefore establishes **verified destination settlement**, not an
independently verified full NIM-to-USDC debit path. An optional stored NIM
transaction identifier is classified as `IDENTIFIER_UNVERIFIED` and is never
returned.
