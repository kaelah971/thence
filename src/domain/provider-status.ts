/**
 * ONE classification of Satora's Lightning→EVM swap statuses, shared by the
 * server (reconcile, settlement, claim-intent, server reconciler) and the
 * browser (tracker, recovery copy). Provider statuses are ASSERTIONS: every
 * set here only decides which independent chain check applies next, never
 * an outcome by itself.
 *
 * Satora's own definition (lendaswap OpenAPI `SwapStatus`):
 *   Pending → ClientFunded → ServerFunded → ClientRedeemed → ServerRedeemed
 *   ServerFunded → ClientFundedServerRefunded (EVM HTLC timeout)
 *   `clientredeemedandclientrefunded`: the client REDEEMED the EVM HTLC
 *   (secret revealed, target asset sent) and the client's BTC side was ALSO
 *   refunded because the server did not claim it in time. For the recipient
 *   this is a delivery, never a refund.
 *
 * Field names are not evidence either: Satora has reported its own EVM REFUND
 * transaction in `evm_claim_txid` (incident af9dc922, 2026-11-15, status
 * `clientfundedserverrefunded`). That field is only a pointer to inspect.
 */

/** Provider reports a claim of the EVM HTLC was submitted or landed. Delivery still needs on-chain proof. */
export const CLAIM_ACTIVITY_STATUSES: ReadonlySet<string> = new Set([
  "clientredeeming",
  "clientredeemed",
  "serverredeemed",
  "clientredeemedandclientrefunded",
]);

/** Provider reports the EVM HTLC was redeemed (subset of claim activity). */
export const REDEEMED_STATUSES: ReadonlySet<string> = new Set(["clientredeemed", "serverredeemed", "clientredeemedandclientrefunded"]);

/**
 * Provider reports a refund with NO redeem. REFUNDED still needs an
 * independent SwapRefunded event of the pinned HTLC for the bound swap, and
 * says nothing about the user's NIM, which Nimiq Pay's own HTLC returns.
 */
export const PROVIDER_REFUND_STATUSES: ReadonlySet<string> = new Set([
  "clientrefunded",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
]);
