/**
 * Treasury desk → transfer ledger mirror.
 *
 * The desk keeps `desk_orders` as its source of truth for money. Activity,
 * receipts and the global proof feed all read `transfers`, so every desk order
 * also writes one transfer row here and keeps its status in step. Nothing in
 * this module can move funds: it only records what the desk already did.
 *
 * Status names are desk-specific on purpose. Mapping a desk payment onto swap
 * states would render "Converting" or "Action needed — finish delivery" for a
 * payment that is simply waiting for NIM.
 */
import type { PoolClient } from "pg";
import { isTerminal, type TransferStatus } from "@/domain/transfers";
import type { DeskState } from "./policy";
import type { DeskOrder } from "./store";
import { POLYGON_USDC } from "./policy";

const DESK_STATUS: Record<DeskState, TransferStatus> = {
  QUOTED: "QUOTED",
  AWAITING_NIM: "DESK_AWAITING_NIM",
  VERIFIED: "DESK_PAYING_OUT",
  PAYOUT_PREPARED: "DESK_PAYING_OUT",
  PAYOUT_SUBMITTED: "DESK_PAYING_OUT",
  DELIVERED: "DELIVERED",
  REFUND_DUE: "DESK_REFUND_DUE",
  REFUNDED: "REFUNDED",
  EXPIRED: "QUOTE_EXPIRED",
};

/**
 * Records the transfer row for a freshly quoted desk order.
 * Idempotent per order: `desk:<order id>` is unique per owner, so a retried
 * quote can never create a second history row.
 */
export async function mirrorQuote(c: PoolClient, order: DeskOrder): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO transfers (
       owner_user_id, route_id, target_asset, target_network, destination,
       target_amount_atomic, quote_provider, quote_revision, quoted_at,
       quoted_net_target_atomic, quoted_fees_json, quote_expires_at, status, idempotency_key
     ) VALUES ($1, 'usdc-polygon', 'USDC', 'Polygon', $2, $3, 'desk', 1, now(), $3, $4, $5, $6, $7)
     ON CONFLICT (owner_user_id, idempotency_key) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      order.owner_id,
      order.payload.recipient,
      order.amount_atomic,
      JSON.stringify({
        unit: "NIM",
        nimLuna: order.payload.nimLuna,
        baseLuna: order.payload.baseLuna,
        feeLuna: order.payload.feeLuna,
        feeBps: order.payload.feeBps,
        memo: order.payload.memo,
      }),
      order.expires_at,
      DESK_STATUS.QUOTED,
      `desk:${order.id}`,
    ],
  );
  return rows[0]!.id;
}

/**
 * Mirrors one desk state change into its transfer row and the audit trail.
 * Silently does nothing for orders created before the mirror existed.
 */
export async function syncMirror(c: PoolClient, order: DeskOrder, extra?: Record<string, unknown>): Promise<void> {
  const transferId = order.payload.transferId;
  if (!transferId) return;
  const next = DESK_STATUS[order.state];
  const { rows } = await c.query<{ status: TransferStatus }>("SELECT status FROM transfers WHERE id = $1", [transferId]);
  const from = rows[0]?.status;
  if (!from || from === next) return;
  await c.query("UPDATE transfers SET status = $2, updated_at = clock_timestamp() WHERE id = $1", [transferId, next]);
  await c.query(
    `INSERT INTO transfer_transitions (transfer_id, from_status, to_status, actor, reason_code, evidence, terminal)
     VALUES ($1, $2, $3, 'reconciler', $4, $5, $6)`,
    [transferId, from, next, `DESK_${order.state}`, JSON.stringify({ deskOrderId: order.id, code: order.payload.code ?? null, ...extra }), isTerminal(next)],
  );
}

/**
 * Publishes the global proof for a finalized desk delivery.
 *
 * The public feed only trusts a transition carrying the same Nimiq source
 * facts the swap path records (`nimiqSource*`), plus a proof row with the
 * finalized Polygon receipt. Both are written here in the delivery
 * transaction, so a proof exists only if the delivery committed.
 */
export async function publishDeskProof(
  c: PoolClient,
  order: DeskOrder,
  payout: { blockNumber: number; blockHash: string; logIndexes: number[] },
): Promise<Record<string, unknown>> {
  const transferId = order.payload.transferId;
  const source = order.payload.source;
  const deposit = order.deposit_hash;
  const payoutHash = order.payout_hash;
  if (!transferId || !source || !deposit || !payoutHash) return {};
  const evidence = {
    source: {
      transactionHash: deposit,
      sender: source.sender,
      amountLuna: source.amountLuna,
      feeLuna: source.feeLuna,
      totalDebitLuna: source.totalDebitLuna,
      blockNumber: source.blockNumber,
      confirmations: source.confirmations,
      macroBlockNumber: source.finalizedByMacroBlock,
      network: source.network,
      verifiedAt: source.verifiedAt,
      rpcHost: source.rpcHost,
    },
  };
  await c.query(
    `INSERT INTO transfer_source_evidence
       (transfer_id, nimiq_tx_hash, verdict, evidence, verifier_version, rpc_source, finality_policy, operator_ref)
     VALUES ($1, $2, 'VERIFIED', $3, 'desk-worker-1', $4, 'nimiq-macro-finality', $5)
     ON CONFLICT DO NOTHING`,
    [transferId, deposit, JSON.stringify(evidence), source.rpcHost, `desk:${order.id}`.slice(0, 128)],
  );
  await c.query(
    `INSERT INTO transfer_proofs
       (transfer_id, nimiq_tx_hash, evm_tx_hash, evidence_source, chain_id, token_contract, recipient,
        verified_amount_atomic, block_number, block_hash, log_indexes, finality_level, verified_at)
     VALUES ($1, $2, $3, 'evm_erc20_transfer', 137, $4, $5, $6, $7, $8, $9, 'finalized', now())
     ON CONFLICT (transfer_id) DO NOTHING`,
    [
      transferId, deposit, payoutHash, POLYGON_USDC, order.payload.recipient.toLowerCase(),
      order.amount_atomic, payout.blockNumber, payout.blockHash, JSON.stringify(payout.logIndexes),
    ],
  );
  return {
    nimiqSourceVerification: "VERIFIED",
    nimiqSourceTxHash: deposit,
    nimiqSourceSenderAddress: source.sender,
    nimiqSourceAmountLuna: source.amountLuna,
    nimiqSourceFeeLuna: source.feeLuna,
    nimiqSourceTotalDebitLuna: source.totalDebitLuna,
    nimiqSourceBlockNumber: source.blockNumber,
    nimiqSourceConfirmations: source.confirmations,
    nimiqSourceFinalizedByMacroBlock: source.finalizedByMacroBlock,
    nimiqSourceNetwork: source.network,
    nimiqSourceVerifiedAt: source.verifiedAt,
    nimiqSourceRpcHost: source.rpcHost,
  };
}
