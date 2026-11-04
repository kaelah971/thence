# API_SETTLEMENT (B4.4) — Verified Settlement Proofs & Receipts

Backend-only evidence verification for Lightning → EVM transfers.
No payments, claim/refund initiation, signing, or broadcasting exist in this slice; settlement and refund checks are read-only.

## 1. Supported networks and settlement modes

| Network  | Chain id | Mode |
|----------|----------|------|
| USDC Polygon | 137 | EVM HTLC claim → ERC20 Transfer to destination |
| USDC Arbitrum | 42161 | EVM HTLC claim → ERC20 Transfer to destination |
| USDC Ethereum | 1 | EVM HTLC claim → ERC20 Transfer to destination |

Only enabled *and* route-verified configurations are usable: the canonical
token contract and chain id always come from the live route registry
(`resolveRoute`), never from the request, the provider payload, or the client.

## 2. SDK claim/settlement research (verified against installed code)

Sources: `@satora/swap@1.7.2` (`dist/index.d.ts`) and
`@lendasat/lendaswap-sdk-pure` (`dist/generated/api.d.ts`,
`LightningToEvmSwapResponse`).

- Flow: the user pays the BOLT11 hold invoice; the server funds an
  `HTLCErc20` lock (`evm_htlc_address`); the user's client claims via the
  `HTLCCoordinator` (`evm_coordinator_address`, `redeemAndExecute`), which
  sweeps tokens to `target_evm_address`. Claims may be gasless
  (`client_evm_address` is SDK-derived) or self-relayed — either way the
  only on-chain settlement evidence is the claim transaction's receipt.
- `evm_claim_txid` is present on the swap response (`evm_claim_txid?:
  string | null`) and names the user's claim transaction. It is a provider
  **assertion**, reliable as a pointer but never as proof of receipt.
- `evm_fund_txid` names the server's HTLC funding transaction. It proves
  the lock was funded, not that the destination was paid.
- Settlement may legitimately involve **several Transfer logs** in one
  receipt (lock → coordinator → destination legs). All logs in the verified
  receipt with `token == canonical` AND `to == destination` are summed;
  unrelated token movements are ignored, never counted. `from` is
  deliberately not filtered (HTLC/coordinator legs vary by deployment).
- Provider statuses implying claim progress: `clientredeeming`
  (in-flight/mempool claim), `clientredeemed`, `serverredeemed`.
  None of them — nor a successful claim-API response — proves the
  destination wallet received tokens. Only matching ERC20 Transfer events
  in the verified claim receipt constitute destination proof.
- Unproven by provider status alone: actual recipient credit, received
  amount, token contract identity, chain correctness, confirmation depth,
  and reorg safety. All are checked independently below.

## 3. Evidence hierarchy (strongest first)

1. Verified ERC20 `Transfer` events in the provider-named claim receipt:
   emitting contract == canonical token, `to` == immutable destination,
   summed value >= requested atomic amount, receipt `status == success`.
2. Provider claim pointer (`evm_claim_txid` + claim-progress status):
   locates the transaction to verify; proves nothing by itself.
3. Provider funding pointer (`evm_fund_txid`, `serverfunded`): corroborates
   the lock; proves nothing about the destination.
4. Client reports, quote data, tx hashes from any client field, screenshots:
   never evidence. A client-supplied tx hash sent to `verify-settlement`
   is ignored outright.

## 4. ERC20 event interpretation

- Event signature: `Transfer(address,address,address=>indexed from/to)`
  topic `0xddf252ad…b3ef`, `data` = uint256 value (big-endian).
- A log matches iff `topics[0]` is the Transfer topic, `address`
  equals the canonical token (case-insensitive), and the `to` field
  (last 20 bytes of `topics[2]`) equals the transfer destination
  (case-insensitive). Logs with zero/unparseable values are skipped.
- All matching logs in the receipt are summed (`BigInt`, atomic units);
  delivery requires `total >= targetAmountAtomic`. Multi-leg coordinator
  settlements therefore verify; split payments across *different*
  transactions never combine (one claim tx = one proof).

## 5. Provider swap/claim correlation

- The claim transaction is taken **only** from the refreshed provider
  record for the bound swap (`getProviderSwap(bound.satoraSwapId)`).
- Guards before any chain read: bound swap exists; `evm_claim_txid`
  present; provider status in claim progress; `facts.evmChainId` equals
  the resolved route chain id; receipt chain id is in the supported set
  with a configured trusted RPC.
- Double-attribution guard: partial unique index
  `transfer_proofs_claim_uidx (chain_id, evm_tx_hash) WHERE evm_tx_hash
  IS NOT NULL` plus an in-transaction clash check — one on-chain event
  funds at most one Thence transfer.

## 6. Finality policy (fail-closed, configurable)

Configured via `THENCE_SETTLEMENT_FINALITY_JSON`
(`{chainId: {mode, confirmations}}`); unset chains use defaults:

| Chain | Default policy | Rationale |
|-------|---------------|-----------|
| Ethereum (1) | `finalized` block must cover the receipt | Only L1-finalized ancestry counts. Confirmation counts are not finality. |
| Arbitrum (42161) | `finalized` block must cover the receipt | Nitro's `finalized` tag reflects L1-finalized batches. Sequencer confirmations are soft and never sufficient. An arbitrary number of L2 blocks is NOT equated to Ethereum finality. |
| Polygon (137) | 256 confirmations (~9 min at 2s/block) | Bor has no trustworthy `finalized` tag; checkpoints land ~every 30 min. Documented as evidence of inclusion, NOT finality. |

Verdict ladder: `PENDING` (unmined) → confirmed+matched →
`INSUFFICIENT_CONFIRMATIONS` (stay nonterminal, retryable) →
`finalized`/`confirmations-N` → `VERIFIED`. If the RPC cannot provide the
required evidence (no `finalized` tag, unreadable header, outage), the
result is `INCONCLUSIVE`/`UNAVAILABLE` — finality is never claimed.

## 7. Receipt contract

`GET /api/transfers/:id/receipt` (owner-only, `no-store`).

- Pre-delivery: `409 { error: "RECEIPT_NOT_READY", status }`.
- Post-delivery (immutable): `transferId, recipientName, asset, network,
  destination, requestedAmountAtomic, verifiedAmountAtomic, provider,
  satoraSwapId, settlementTxHash, chainId, blockNumber, blockHash,
  logIndexes, finalityLevel, verifiedAt, explorerTxUrl,
  quotedSourceSatsEstimate, actualFundingProven: false`.
- The quoted sats figure is labelled an **estimate**: B4.4 never proves
  the actual debited amount, only the verified destination output.

## 8. Refund reconciliation

A provider refund status is not sufficient to release exposure. For the Polygon
Lightning → EVM path, owner-authorized reconciliation additionally requires the
provider-named transaction receipt to be successful and to emit
`SwapRefunded(bytes32 indexed preimageHash, bytes32 indexed key)` from the exact
bound HTLC with the exact bound hash lock. The receipt block hash is rechecked
for reorgs and the Polygon finality policy is applied. Only verified evidence
may advance `SERVER_FUNDED` (or another legal pre-delivery state) to durable
`REFUNDED`; provider observations never spoof Activity or release capacity.
The transition is locked and idempotent, so one refunded transfer releases only
its own exposure slot while unresolved `RECONCILING` transfers remain active.

P5 hardening (`verifyHtlcRefund` in `src/lib/settlement.ts`):

- The provider-named HTLC must be on the pinned trust list
  (`TRUSTED_HTLC_CONTRACTS`, shared with P4). Any other contract is `INVALID`
  before any chain read.
- Satora's refund pointer (empirically reported in `evm_claim_txid`) is a hint
  only. When it is missing, or its receipt holds no matching `SwapRefunded`,
  Thence scans the pinned HTLC's own logs for this hash lock (from the EVM
  refund locktime minus 5 min, bounded to 40 000 blocks). Exactly one refund
  transaction must be found, and it is verified like the pointer (receipt,
  event, reorg check, finality). Several candidates, none, or an RPC failure or
  timeout never yield `VERIFIED`.
- The `REFUNDED` audit row records `refundTxHash`, `refundEvidenceSource`
  (`provider_pointer` | `htlc_log_scan`), `refundScope: "polygon_htlc"` and
  `nimiqSideRefund: "not_observable"`.
- `REFUNDED` is the **Polygon side only**: the provider's USDC lock went back
  to the provider. It is never a NIM refund. Thence cannot observe Nimiq Pay's
  NIM HTLC, so customer copy says "Not delivered — Polygon lock refunded" and
  points to Nimiq Pay for the NIM side (`REFUNDED_BODY`).

## 8a. Transition audit and consistency (P5)

Every writer of `transfers.status` now records a `transfer_transitions` row in
the same database transaction: attach (`SWAP_ATTACHED`), authorize
(`HANDOFF_AUTHORIZED`), handoff-outcome reports (`CLIENT_REPORTED_*`,
`CANCELLED_*`, `CANCEL_UNPROVEN_RECONCILE`), reconciliation (`PROVIDER_*`),
P4 closure and settlement (`SETTLEMENT_VERIFIED`). Rows use
`clock_timestamp()`, so the hops of one multi-step path are strictly ordered.
If the audit insert fails, the status change rolls back with it.

`src/lib/consistency.ts` is a read-only checker. It verifies that `DELIVERED`
has a complete proof, that a proof implies `DELIVERED`, that bound or
authorized statuses have their swap or authorization, that `REFUNDED` has a
verified-refund audit row, and that the audit chain is legal, contiguous,
ends at the current status, and has at most one terminal row. The P5 tests
enforce it strictly. Pre-P5 rows have no audit trail and are checked without
`requireAudit`.

## 9. State machine

`DELIVERED` is reachable only from `CLAIMING` or `SERVER_FUNDED` via
`transition(from, "DELIVERED", { evidence: { destinationTxHash,
amountVerified: true } })`, inside the verification transaction under the
transfer advisory lock (compare-and-set: re-reads status, aborts on
anything unexpected, idempotent on already-`DELIVERED`). It is
inaccessible through client callbacks (forged outcomes rejected with
`CLIENT_CANNOT_ATTEST`), provider status alone (reconcile never emits
`DELIVERED`), invoice claims, reconciliation shortcuts, and generic
status updates. Concurrent verifications converge on the single stored
proof. A stale/unavailable RPC never regresses a verified delivery.
Pre-finality conflicts and reorg evidence stay nonterminal
(`INCONCLUSIVE`) and require reconciliation.

## 10. RPC configuration and unavailable behavior

- `THENCE_EVM_RPCS_JSON`: `{chainId: httpsUrl}`. Empty/missing chain =
  chain verification unavailable (`INCONCLUSIVE`, never public RPCs,
  never client-supplied URLs/contracts/networks).
- All chain reads bounded (`CHAIN_READ_TIMEOUT_MS = 15s`); outages map to
  `503 CHAIN_UNAVAILABLE` (provider outages to `503` provider codes).
  Prior verified observations are never overwritten by failures:
  non-`VERIFIED` verdicts persist nothing.

## 11. Reorganization and ambiguity handling

- Reorg guard: the block hash at the receipt height is re-read; a
  mismatch (or unreadable header) yields `INCONCLUSIVE`.
- Ambiguous states: no claim txid yet, claim status without chain proof,
  unsupported chain, missing RPC, unparseable amounts, header/finality
  evidence unavailable — all `INCONCLUSIVE`, all nonterminal, all
  reconcilable. A reverted receipt or a receipt with no (or insufficient)
  matching Transfer output is `INVALID` (422).

## 12. Known limitations

- CCTP-bridged swaps (`bridge_target_chain` set) settle onward on another
  chain; this slice verifies only the first-leg EVM receipt and reports
  bridged routes as outside the proven path when encountered.
- Native (non-ERC20) settlement legs are not matched by the ERC20 rule.
- Polygon confirmations are inclusion evidence, not finality (see §6).
- `clientredeeming` (mempool claim) is intentionally `PENDING`, never proof.
- Proofs attest destination output only — never the funding source,
  Lightning payment, or fee breakdown.

## 13. Future frontend and wallet integration

The eventual client will call `verify-settlement` after its claim
confirms, poll through `PENDING`/`INSUFFICIENT_CONFIRMATIONS`, and render
`GET receipt`. No frontend, claim invocation, or wallet code exists in
this slice; the receipt endpoint already returns everything the UI needs.
