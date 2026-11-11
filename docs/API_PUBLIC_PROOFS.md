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

The implementation has a source-verification hard-stop: the endpoints must
not publish destination-only rows even if an operator accidentally sets the
publication flag. A row is eligible only after reconciliation independently
verifies the Nimiq HTLC transaction against the configured trusted Nimiq RPC,
binds its payment hash to the server-verified swap attachment, and records the
source marker in the same handoff transition. Missing RPC configuration,
provider disagreement, duplicate attribution, or ambiguous history keeps the
row unpublished.

When disabled, the endpoints return `404 PUBLIC_PROOFS_DISABLED` and do not
open a database connection.

## Feed

```http
GET /api/proofs?limit=20&cursor=<opaque-cursor>
```

`limit` is an integer from 1 to 50. Results are ordered newest verified
settlement first, with a stable `(verifiedAt, proofId)` cursor.

A published item reports both independently verified legs. The destination
contains the exact USDC amount in atomic units, recipient wallet, network,
transaction hash and explorer link. The source contains the exact native NIM
amount in luna (`decimals: 5`), authenticated sender wallet, Nimiq network,
transaction hash and explorer link, plus fee/total-debit fields and trusted
confirmation depth. Each item also carries a `method` block naming how both legs
were checked and qualified finality wording (see below). Payment hashes, invoices,
preimages, HTLC internals,
Satora identifiers, owner/session ids and labels remain redacted.

Example shape (values are illustrative):

```json
{
  "proofId": "…",
  "status": "DELIVERED",
  "source": {
    "asset": "NIM",
    "network": "mainnet",
    "sender": "NQ…",
    "amountLuna": "100000",
    "feeLuna": "100",
    "totalDebitLuna": "100100",
    "decimals": 5,
    "transactionHash": "…",
    "blockNumber": "…",
    "confirmations": 6,
    "explorerTxUrl": "https://nimiq.watch/#…",
    "evidence": "VERIFIED",
    "verification": "VERIFIED"
  },
  "destination": {
    "asset": "USDC",
    "network": "Polygon",
    "recipient": "0x…",
    "verifiedAmountAtomic": "300000",
    "decimals": 6,
    "transactionHash": "0x…",
    "explorerTxUrl": "https://polygonscan.com/tx/0x…"
  },
  "method": {
    "kind": "historical-recovery",
    "sourceRpc": "Nimiq Watch open RPC (rpc.nimiqwatch.com)",
    "destinationRpcs": ["PublicNode (polygon-bor-rpc.publicnode.com)", "dRPC (polygon.drpc.org)"],
    "sourceFinality": "Included in a Nimiq batch whose closing macro block the RPC returned with a Tendermint justification; the aggregate validator signature was not independently verified.",
    "destinationFinality": "At or below Polygon’s finalized block, with the same block hash, on two independent RPC operators."
  }
}
```

`method.kind` is `reconciliation` (checked by the live payment path against
Thence’s configured nodes; `sourceRpc` is `null`, `destinationRpcs` empty) or
`historical-recovery` (A3d.6 operator recovery under the named public-RPC trust
policy). Nimiq finality is always qualified: macro-block inclusion and a present
justification are checked, but the aggregate BLS signature is not independently
verified, so the RPC operator remains the trust boundary for Nimiq finality.

## Detail

```http
GET /api/proofs/:proofId
```

The response is `{ "proof": <feed item> }`. Unknown, malformed, unpublished,
and non-public proof ids all return `404 NOT_FOUND`.

## Publication invariants

A row is publishable only when all of the following hold:

- an independent Nimiq verifier has proven the exact source transaction is a
  successful native-NIM HTLC creation whose derived recipient, actual
  transaction sender and encoded HTLC sender match the authenticated wallet,
  including its exact amount, full 256-bit payment-hash binding, confirmation
  threshold, macro-block inclusion (justification present; aggregate signature
  not independently verified) and unique binding to this transfer, recorded
  either by the live reconciliation marker or by an append-only
  `transfer_source_evidence` VERIFIED row;
- transfer status is `DELIVERED`;
- the route is USDC on Polygon or Arbitrum and the proof chain matches it;
- evidence source is the independently matched ERC20 destination transfer;
- recipient, transaction, token, block, amount, and finality fields are
  complete and internally consistent;
- verified destination amount is at least the requested atomic amount;
- the token matches the server's approved route token; Arbitrum additionally
  requires Circle native USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831`,
  never USDC.e;
- the independently verified NIM source is on mainnet. Testnet source evidence
  is never published alongside a mainnet Polygon or Arbitrum destination;
- the stored finality level meets the applicable settlement policy, or — for
  historical recovery only — the recovery’s dual-RPC `finalized` re-check
  matches the stored proof’s transaction, block, block hash, recipient, token
  and amount exactly (the stored proof row is never rewritten). Arbitrum
  requires `finalized`; Polygon uses the configured/default confirmation
  policy.

Historical Polygon rows are not restricted by creation date, but they are
publishable only when exact independent NIM source evidence has also been
recovered and bound. They remain subject to the gate and current publication
trust configuration.

## Deliberate limitations

The public contract publishes only the verified proof fields needed by an
approved proof UI: source/destination assets, networks, wallet addresses,
amounts, transaction hashes, block/finality metadata and explorer links. It
does not publish recipient labels, owner/session ids, request or idempotency
keys, invoices, Lightning payment hashes, preimages, HTLC internals, Satora
swap ids, credentials or quoted Lightning sats. A host-returned Nimiq
transaction identifier is not source proof and is never sufficient for
publication. Source verification is required for every published row;
destination-only publication remains blocked.

Previously completed Polygon rows do not receive source proof automatically.
The live handoff path can bind a source hash only when the authenticated
handoff report supplies the exact identity and the trusted RPC verifies it.
Historical recovery requires an exact operator-record transaction hash and a
separate controlled verification/import procedure; missing, multiple or
ambiguous records remain unpublished. No historical production coverage is
claimed by this PR.
