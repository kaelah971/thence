# A3d.2 — Real NIM HTLC proof pilot and finality review

**Status: BLOCKED — exact authorized source evidence unavailable.**

This milestone is read-only. No production database, payment, swap, claim,
refund, environment, DNS, systemd, or public-proof setting was changed.

## 1. Historical evidence result

The authorized repository/operator material was searched for an exact Nimiq
source transaction, authenticated Nimiq sender, and bound Lightning payment
hash. The available pilot postmortem and judge evidence intentionally redact
wallet addresses, transaction hashes, block numbers, and absolute timestamps.
Fixtures contain synthetic values only.

Therefore no genuine historical source case could be selected. No positive
mainnet HTLC verification was attempted, and no hash was inferred from an
amount, timestamp, explorer result, destination transfer, or transfer label.

Required identifiers for a later pilot case:

- exact 64-hex Nimiq transaction hash from an authorized receipt/operator record;
- canonical authenticated Nimiq sender address;
- exact bound Lightning payment hash from the server-verified swap attachment;
- optional exact NIM amount in luna, only when supplied by the same trusted
  record;
- evidence provenance and authorization scope.

## 2. Finality review

Official Nimiq documentation states:

- microblocks contain user transactions;
- checkpoint macroblocks finalize the preceding batch;
- macroblocks require two-thirds validator consensus via Tendermint;
- six head-distance confirmations do not independently establish macroblock
  finality.

Sources:

- https://nimiq.dev/protocol/consensus/block-format
- https://nimiq.dev/rpc
- https://nimiq.dev/rpc/open-servers
- https://github.com/nimiq/core-rs-albatross/blob/albatross/primitives/src/policy.rs

The verifier now requires both configured confirmations and the next justified
macroblock. It checks the macroblock number, network, `type: "macro"`, and a
non-empty serialized Tendermint justification. The verified evidence records
`finalizedByMacroBlock` internally. Public-proof eligibility also requires that
internal marker.

A six-confirmation-only policy is not approved.

## 3. RPC decision

`https://rpc.nimiqwatch.com` was tested only as a bounded research source. It
returned compatible `MainAlbatross` transaction and macroblock responses, and
the updated verifier correctly rejected an ordinary live transaction as
`WRONG_ASSET` after exercising the macroblock query.

It is not a production recommendation. Nimiq's official open-server guidance
says public servers are for testing/development, have no uptime/SLA guarantee,
may throttle, and should not be used for critical applications.

Recommended production order:

1. A dedicated authenticated managed Nimiq history RPC with full historical
   lookup, macroblock/justification support, TLS/authentication, rate limits,
   retention, monitoring, and an explicit SLA. Pricing must be obtained from
   the selected vendor; no provider was approved here.
2. An operator-controlled full Nimiq node on a separate appropriately sized
   VPS. This requires separate compute, persistent disk, bandwidth, backups,
   upgrades, monitoring, and operator time. It must not be installed on Hermes
   during this milestone.
3. NimiqWatch only as a non-production research/cross-check source.

`rpc.nimiq.com` remained DNS-unavailable during validation.

## 4. Read-only recovery manifest

A later operator-only tool should accept a manifest containing only explicitly
supplied cases:

```text
manifestVersion
transferId (internal)
sourceTxHash (exact)
ownerNimiqAddress (authenticated record)
lightningPaymentHash (verified attachment)
expectedAmountLuna (optional, exact trusted record only)
sourceRecordReference / authorization
approvedRpcProfile
approvedMinConfirmations
```

The validation report should record redacted case identifiers and one of:

`VERIFIED`, `NO_EXACT_HASH`, `AMBIGUOUS_HASH`, `DUPLICATE_HASH`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_MALFORMED`, `INSUFFICIENT_FINALITY`,
`WRONG_ASSET`, `WRONG_SENDER`, `PAYMENT_HASH_MISMATCH`, or another verifier
failure code.

A successful report must include internally: exact hash match, successful
execution, mainnet identity, native NIM HTLC structure, sender/refund-sender
binding, payment-hash binding, derived HTLC recipient, value/fee, confirmation
threshold, justified macroblock, and unique attribution. It must not write
payment state or publish a proof.

## 5. Future Nimiq Pay readiness

The existing handoff forwards a strict 64-hex `payLightningInvoice().hash` as
an untrusted `sourceTxHash` hint. The server independently verifies it against
the authenticated address and bound payment hash. The SDK result may represent
native NIM or Polygon USDT; the verifier's native-NIM HTLC checks remain
mandatory.

Remaining uncertainty is real-host semantic confirmation: a live Nimiq Pay host
must demonstrate that its returned `hash` is the submitted NIM transaction
hash for a native-NIM case. No host payment was invoked here.

## 6. Code and verification

Changed on dedicated branch `feat/a3d2-nimiq-finality`:

- require justified Albatross macroblock finality in `src/lib/nimiq-source.ts`;
- record the finalizing macroblock in internal source evidence;
- require that evidence at public-proof serialization/query boundaries;
- add focused regression tests and documentation.

No migration, configuration, production access, or deployment was performed.

A3d.2 remains blocked until exact authorized identifiers and an approved
production-grade RPC/finality policy are supplied.
