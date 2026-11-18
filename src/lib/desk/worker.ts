import { getPool } from "@/lib/db";
import { deskConfig } from "./config";
import { checkDeskOrder } from "./service";
import type { DeskOrder } from "./store";

/** Dedicated money-moving worker; never called by the legacy read-only reconciler. */
export async function runDeskBatch() {
  deskConfig();
  const started = Date.now();
  const { rows } = await getPool().query<DeskOrder>("SELECT * FROM desk_orders WHERE state IN ('AWAITING_NIM','VERIFIED','PAYOUT_PREPARED','PAYOUT_SUBMITTED') ORDER BY updated_at ASC LIMIT 10");
  const summary = { checked: 0, delivered: 0, refundDue: 0, errors: 0, ambiguous: 0 };
  for (const order of rows) {
    if (Date.now() - started > 35000) break;
    try {
      const result = await checkDeskOrder(order.owner_id, order.payload.ownerAddress, order.id);
      summary.checked++;
      if (result.code === "MULTIPLE_DEPOSITS") summary.ambiguous++;
      if (result.state === "DELIVERED") summary.delivered++;
      if (result.state === "REFUND_DUE") summary.refundDue++;
    } catch { summary.errors++; }
    finally {
      // Every attempt advances scheduling, including unpaid/ambiguous/error rows.
      // State and signed bytes remain unchanged; an old order cannot starve the queue.
      await getPool().query("UPDATE desk_orders SET updated_at=now() WHERE id=$1", [order.id]);
    }
  }
  return summary;
}
