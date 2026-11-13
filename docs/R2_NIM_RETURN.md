# R2 — closing a failed Lightning handoff after a verified NIM return

Incident `6f44918d` (2026-11-13). Nimiq Pay locked 7,244.09383 NIM in a native HTLC and returned a hash. The NIM source was verified on-chain, but the provider never received the Lightning payment. The transfer sits in `LIGHTNING_HANDOFF` and keeps the owner's single funding-exposure slot. P4 `closeExpiredUnfunded` refuses it: it accepts only `RECONCILING`, and it refuses on `NIM_FUNDING_RECORDED`. **That behaviour is unchanged.**

R2 adds a sibling owner action, `POST /api/transfers/:id/close-nim-returned` (`src/lib/nim-return-resolution.ts`). It closes as `EXPIRED_UNFUNDED` only on positive on-chain proof that the NIM came back.

## Security invariants

| # | Invariant | Where |
|---|---|---|
| 1 | The original HTLC creation re-verifies exactly as R1 source evidence does: native creation, hash lock = bound payment hash, owner-authenticated sender (EarlyResolve owner signature for vault-funded sources), exact recorded amount, macro-final. | `verifyNimiqHtlcReturn` → `verifyNimiqSourceTransaction` |
| 2 | The spend is successful and covered by a justified Albatross macro block, with at least the configured confirmations. | `macroFinality` (shared with R1) |
| 3 | The destination equals the authenticated owner. That is the HTLC's encoded refund address, which R1 already binds to the session wallet; the login wallet must also match. | `WRONG_DESTINATION`, `NIM_SOURCE_AMBIGUOUS` |
| 4 | `value + fee` of the single spend equals the full locked amount. | `AMOUNT_MISMATCH` |
| 5 | The complete history is read from two endpoints (`getTransactionsByAddress` and `getTransactionHashesByAddress`, named params). Both must agree, both must stay below the page bound, and history must be exactly {funding, one outgoing}. The HTLC balance must also be 0. | `HISTORY_INCOMPLETE`, `HISTORY_MISMATCH`, `UNEXPECTED_SPEND`, `STILL_LOCKED` |
| 6 | Malformed, unavailable, truncated or disagreeing RPC data is a refusal; there is never a partial pass. | `PROVIDER_*`, `NIM_RETURN_UNAVAILABLE` |
| 7 | A RegularTransfer (preimage) spend is `REDEEMED`. A TimeoutResolve needs the owner's signature and a block at or after the HTLC timeout. An EarlyResolve needs both the HTLC recipient's and the owner's signatures. | `REDEEMED`, `INVALID_PROOF`, `BEFORE_TIMEOUT` |
| 8 | Provider gates are identical to P4 (`assessProviderEvidence`): fresh identity, terminal `expired`, no EVM fund or claim transaction, every invoice copy expired by at least 10 minutes, pinned HTLC. | shared code |
| 9 | Polygon: a finalized no-activity scan for the hash lock over P4's window. | `verifyNoHtlcActivity` |
| 10 | State: only the existing edges `LIGHTNING_HANDOFF → OUTCOME_UNKNOWN → RECONCILING → EXPIRED_UNFUNDED` (or a suffix of that path). Every hop is audited in one transaction under the per-transfer lock. Local, source and provider gates re-run under the lock; evidence older than 2 minutes is refused. A terminal-once unique index makes repeats and races converge. | Phase B |
| 11 | The source hash is attributed to no other transfer. | `sourceAttributedElsewhere` |
| 12 | Nothing is signed, broadcast, claimed or refunded. Attempts, attachments and proofs are untouched. | — |

**Not changed:** the transition table, P4 gates, exposure rules, schema (no migration), R1 source verification semantics (only the macro-finality code was extracted into a shared helper).

## Owner-facing refund status

| State | Activity shows |
|---|---|
| `LIGHTNING_HANDOFF` / `OUTCOME_UNKNOWN` with provider `expired` (and, for `RECONCILING`, after P4 refused with `NIM_FUNDING_RECORDED`) | **"Not delivered — waiting for your NIM to come back"** and the button **"Check whether my NIM came back"**. The copy says Thence closes only after verifying the full return on the Nimiq blockchain. |
| Check refused | The server's plain-language reason. For example, NIM still locked: "Your NIM is still locked in Nimiq Pay's swap. Thence can close this only after it is returned to you." The payment stays open. |
| Closed by R2 (`nimReturn` present) | **"Not delivered — your NIM came back"**: "Nothing was delivered: the provider never received the Lightning payment. 7244.09283 NIM came back to your wallet (the network fee of … NIM was paid from the locked amount), and Thence verified the return on the Nimiq blockchain (transaction abcd1234…ef5678)." |
| Closed by P4, or any other `EXPIRED_UNFUNDED` | Unchanged P4 copy, which never claims a refund. |

`nimReturn` is set by the server only from the terminal R2 audit row with `refundProof: VERIFIED_ON_CHAIN`. It is never inferred from invoice expiry, provider status or balances.

## Read-only procedure for incident 6f44918d (after 2026-11-15 19:02:50Z)

Nothing below writes anywhere.

1. **Nimiq**, using the same verifier the close action runs:
   ```
   npx tsx scripts/check-nim-return.ts \
     --tx 7b619a2b2e02c8d432720f6d2fd9023f9155f498a1a4930dd19518805c890df1 \
     --owner "NQ19 9FXV 42G1 HJ35 PPBX 52ES BXVK V6NK BN4Y" \
     --hash-lock d3d7213a08bdc478c8c542d98b619f3bd9dbeec40a2f6c673d91ae41890a035c \
     --amount 724409383 --rpc https://rpc.nimiqwatch.com
   ```
   - Exit 0 with `VERIFIED_RETURN`: the refund transaction, the amounts and the final macro block are printed.
   - Exit 2 with a code: not proven. `STILL_LOCKED` is expected before the timeout or until Nimiq Pay refunds; it was observed 2026-11-13 09:46Z.
2. **Satora**: `getSwap` should show `status = expired`, with no `evm_fund_txid` or `evm_claim_txid`.
3. **Production DB**, read-only (`BEGIN READ ONLY`): the transfer is still `LIGHTNING_HANDOFF`, no terminal transition exists, and the `transfer_proofs` NIM hash equals the funding hash.
4. **Only after R2 is reviewed, merged and deployed (owner approval):** the tester (or the owner, on the tester's request) taps "Check whether my NIM came back" in Activity. The server re-runs every gate itself.
5. If step 1 still says `STILL_LOCKED` well after the timeout, nothing is closed. Escalate to Nimiq Pay with the support packet.
