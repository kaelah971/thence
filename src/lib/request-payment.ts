/**
 * Payment requests: at most one payment per request.
 *
 * A request has no stored "paid" state (terms stay immutable, B2.2); whether
 * it is taken is DERIVED from the transfers linked to it. Before this guard a
 * shared link could be paid again after delivery, or by two payers at once,
 * while the Send screen promised it "counts as paid once delivery is
 * confirmed".
 *
 * A request is taken when another linked transfer is
 * - delivered (DELIVERED / DELIVERED_SHORT), or
 * - authorized for payment and not yet resolved (from AWAITING_NIM_APPROVAL
 *   through NEEDS_ATTENTION): its NIM may already be committed.
 * Unauthorized drafts (QUOTED, SWAP_CREATED) and closed non-deliveries
 * (cancelled, expired, refunded, failed) never block another payer.
 *
 * Checked at transfer creation (fast refusal, after idempotent replay) and
 * again at authorize-handoff under a per-request advisory lock — the last
 * gate before Nimiq Pay commits NIM — so two concurrent payers converge.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { AuthError } from "@/lib/auth";
import type { getDb } from "@/lib/db";
import { transfers } from "@/db/schema";
import type { TransferStatus } from "@/domain/transfers";

export const REQUEST_PAID_STATUSES: readonly TransferStatus[] = ["DELIVERED", "DELIVERED_SHORT"];
export const REQUEST_IN_FLIGHT_STATUSES: readonly TransferStatus[] = [
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
  "NEEDS_ATTENTION",
];

type Db = ReturnType<typeof getDb>;

/** Serialize payments of one request inside the caller's transaction. */
export async function lockRequestPayment(tx: Pick<Db, "execute">, requestId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`request-payment:${requestId}`}))`);
}

/** Refuse when another transfer already paid, or is paying, this request. */
export async function assertRequestPayable(
  db: Pick<Db, "select">,
  requestId: string,
  exceptTransferId: string | null,
): Promise<void> {
  const others = await db
    .select({ status: transfers.status })
    .from(transfers)
    .where(
      and(
        eq(transfers.requestId, requestId),
        inArray(transfers.status, [...REQUEST_PAID_STATUSES, ...REQUEST_IN_FLIGHT_STATUSES]),
        exceptTransferId ? ne(transfers.id, exceptTransferId) : sql`TRUE`,
      ),
    )
    .limit(5);
  if (others.some((r) => (REQUEST_PAID_STATUSES as readonly string[]).includes(r.status))) {
    throw new AuthError(409, "REQUEST_ALREADY_PAID", "This payment request was already paid.");
  }
  if (others.length > 0) {
    throw new AuthError(409, "REQUEST_PAYMENT_IN_PROGRESS", "A payment for this request is already in progress.");
  }
}
