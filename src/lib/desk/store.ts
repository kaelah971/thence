import type { PoolClient } from "pg";
import { getPool } from "@/lib/db";
import type { DeskSourceFacts } from "@/lib/nimiq-source";
import { DeskError, type DeskState } from "./policy";
import { syncMirror } from "./ledger";

export interface DeskPayload {
  ownerAddress: string; recipient: `0x${string}`; nimAddress: string;
  nimLuna: string; feeLuna: string; baseLuna: string; memo: string;
  rateE18: string; rateObservedAt: string; feeBps: number;
  authorizedAt?: number; fundingDeadline?: number; code?: string;
  refundHash?: string; reportedHash?: string; transferId?: string; source?: DeskSourceFacts;
}
export interface DeskOrder {
  id: string; owner_id: string; state: DeskState; amount_atomic: string;
  payout_wallet: `0x${string}`; expires_at: Date; created_at: Date; updated_at: Date;
  deposit_hash: string | null; payout_hash: `0x${string}` | null;
  payout_nonce: string | null; signed_payout: `0x${string}` | null;
  payload: DeskPayload;
}
/** One global desk lock serializes quote capacity and signer nonces across all workers. */
export async function deskTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(191818, 137)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function loadDeskOrder(c: PoolClient, id: string, ownerId?: string): Promise<DeskOrder> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DeskError("NOT_FOUND", "Payment not found.", 404);
  const { rows } = await c.query<DeskOrder>("SELECT * FROM desk_orders WHERE id=$1" + (ownerId ? " AND owner_id=$2" : ""), ownerId ? [id, ownerId] : [id]);
  if (!rows[0]) throw new DeskError("NOT_FOUND", "Payment not found.", 404);
  return rows[0];
}
export async function transition(c: PoolClient, order: DeskOrder, state: DeskState, code: string, evidence?: Record<string, unknown>): Promise<DeskOrder> {
  const { rows } = await c.query<DeskOrder>("UPDATE desk_orders SET state=$2, payload=$3, updated_at=now() WHERE id=$1 RETURNING *", [order.id, state, JSON.stringify({ ...order.payload, code })]);
  await c.query("INSERT INTO desk_events(order_id,state,code) VALUES($1,$2,$3)", [order.id, state, code]);
  await syncMirror(c, rows[0]!, evidence);
  return rows[0]!;
}
export function publicDeskOrder(o: DeskOrder) {
  return { id: o.id, state: o.state, amountAtomic: o.amount_atomic, recipient: o.payload.recipient,
    nimAddress: o.payload.nimAddress, nimLuna: o.payload.nimLuna, feeLuna: o.payload.feeLuna,
    baseLuna: o.payload.baseLuna, feeBps: o.payload.feeBps, memo: o.payload.memo,
    expiresAt: o.expires_at.toISOString(), fundingDeadline: o.payload.fundingDeadline ?? null,
    depositHash: o.deposit_hash, reportedHash: o.payload.reportedHash ?? null, payoutHash: o.payout_hash, refundHash: o.payload.refundHash ?? null,
    code: o.payload.code ?? null, createdAt: o.created_at.toISOString() };
}
export type PublicDeskOrder = ReturnType<typeof publicDeskOrder>;
