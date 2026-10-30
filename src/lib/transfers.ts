/**
 * Thence backend — transfer intents with live quote binding (B4.1).
 *
 * A transfer intent is a DURABLE, owner-scoped plan: an immutable
 * destination snapshot (route, asset/network/address, exact atomic amount,
 * recipient name) bound to a real, exact-output provider quote. Creating or
 * requoting a transfer NEVER creates a swap, invoice, approval, payment or
 * settlement — this slice stops at QUOTED. Only later milestone evidence
 * may advance the state machine (see src/domain/transfers.ts).
 *
 * Lifecycle (server-side only; no client status API exists):
 * - Creation validates DRAFT→QUOTED via the domain policy, then persists
 *   with status QUOTED and quote revision 1.
 * - Requote is allowed only in pre-funding QUOTED state, always against a
 *   fresh live quote, guarded by optimistic concurrency (expected revision).
 * - Quote expiry never becomes failure: expired quotes stay QUOTED and may
 *   be refreshed with live terms.
 *
 * Idempotency: (owner, idempotencyKey) is unique at the DB level. Same key +
 * same canonical request returns the same record; same key + different
 * request is a 409 conflict. Concurrent identical creates converge on one
 * row via insert-or-compare (unique violation → re-read → compare).
 */
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { paymentRequests, recipientDestinations, recipients, transfers } from "@/db/schema";

import { isAtomicAmount, parseAtomicAmount } from "@/domain/money";
import {
  TRANSFER_STATUSES,
  USER_FACING_LABEL,
  canTransition,
  type TransferStatus,
} from "@/domain/transfers";
import { pairForRouteId } from "@/domain/routes";
import { checkDestination, displayNameSchema, readJsonBody, rejectForbiddenKeys } from "@/lib/recipients";
import { createQuote } from "@/lib/quotes";

export const MAX_BODY_BYTES = 8_192;

const FORBIDDEN_TRANSFER_FIELDS = new Set([
  "status",
  "ownerUserId",
  "owner_user_id",
  "recipientId",
  "recipient_id",
  "requestId",
  "request_id",
  "verification",
  "verified",
  "isVerified",
  "verificationId",
  "verification_id",
  "proofs",
  "swapId",
  "swap_id",
  "delivered",
  "quoteRevision",
  "quote_revision",
  "quotedAt",
  "quoted_at",
  "quoteExpiresAt",
  "quote_expires_at",
]);

export function rejectTransferForbiddenFields(body: unknown): void {
  rejectForbiddenKeys(body);
  if (typeof body !== "object" || body === null) return;
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_TRANSFER_FIELDS.has(key)) {
      throw new AuthError(400, "FIELD_FORBIDDEN", `Field "${key}" cannot be set by clients.`);
    }
  }
}

const directDestinationSchema = z.object({
  asset: z.string().trim().min(1).max(16),
  network: z.string().trim().min(1).max(32),
  address: z.string().trim().min(1).max(256),
});

export const transferCreateSchema = z
  .object({
    routeId: z.string().min(1).max(32),
    targetAmountAtomic: z.string().min(1).max(78),
    idempotencyKey: z.string().min(8).max(128),
    recipientName: displayNameSchema.optional(),
    recipientDestinationId: z.string().uuid().optional(),
    requestPublicId: z.string().min(1).max(64).optional(),
    direct: directDestinationSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const sources = [v.recipientDestinationId !== undefined, v.requestPublicId !== undefined, v.direct !== undefined];
    if (sources.filter(Boolean).length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Exactly one of recipientDestinationId, requestPublicId or direct is required." });
    }
  });

export type TransferCreateInput = z.infer<typeof transferCreateSchema>;

export interface QuoteSnapshot {
  provider: string;
  revision: number;
  /** Exact-output verified when the quote was bound. */
  exact: true;
  requestedAtomic: string;
  netTargetAmountAtomic: string;
  sourceSats: string;
  fees: { networkFeeSats: number; gaslessNetworkFeeSats: number; protocolFeeSats: number; protocolFeeRate: number; unit: string };
  limits: { minSats: number; maxSats: number };
  observedAt: string;
  validUntil: string;
  fresh: boolean;
}

export interface TransferView {
  id: string;
  status: TransferStatus;
  statusLabel: string;
  routeId: string;
  recipientName: string | null;
  asset: string;
  network: string;
  destination: string;
  targetAmountAtomic: string;
  recipientDestinationId: string | null;
  requestId: string | null;
  requestPublicId: string | null;
  idempotencyKey: string | null;
  quote: QuoteSnapshot | null;
  createdAt: string;
  updatedAt: string;
  quotedAt: string | null;
  quoteExpiresAt: string | null;
}

type Db = ReturnType<typeof getDb>;
type TransferRow = typeof transfers.$inferSelect;

function quoteSnapshotOf(row: TransferRow): QuoteSnapshot | null {
  if (!row.quotedAt || !row.quotedNetTargetAtomic || !row.quotedSourceSats) return null;
  return {
    provider: row.quoteProvider ?? "satora",
    revision: row.quoteRevision,
    exact: true as const,
    requestedAtomic: row.targetAmountAtomic,
    netTargetAmountAtomic: row.quotedNetTargetAtomic,
    sourceSats: row.quotedSourceSats,
    fees: (row.quotedFeesJson ?? {}) as QuoteSnapshot["fees"],
    limits: (row.quotedLimitsJson ?? { minSats: 0, maxSats: 0 }) as QuoteSnapshot["limits"],
    observedAt: row.quotedAt.toISOString(),
    validUntil: row.quoteExpiresAt?.toISOString() ?? row.quotedAt.toISOString(),
    fresh: row.quoteExpiresAt ? row.quoteExpiresAt.getTime() > Date.now() : false,
  };
}

async function toView(db: Db, row: TransferRow): Promise<TransferView> {
  let requestPublicId: string | null = null;
  if (row.requestId) {
    const req = await db.select({ publicId: paymentRequests.publicId }).from(paymentRequests).where(eq(paymentRequests.id, row.requestId)).limit(1);
    requestPublicId = req[0]?.publicId ?? null;
  }
  return {
    id: row.id,
    status: row.status as TransferStatus,
    statusLabel: USER_FACING_LABEL[row.status as TransferStatus] ?? row.status,
    routeId: row.routeId,
    recipientName: row.recipientName,
    asset: row.targetAsset,
    network: row.targetNetwork,
    destination: row.destination,
    targetAmountAtomic: row.targetAmountAtomic,
    recipientDestinationId: row.recipientDestinationId,
    requestId: row.requestId,
    requestPublicId,
    idempotencyKey: row.idempotencyKey,
    quote: quoteSnapshotOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    quotedAt: row.quotedAt?.toISOString() ?? null,
    quoteExpiresAt: row.quoteExpiresAt?.toISOString() ?? null,
  };
}

/** Canonical fingerprint for idempotency comparison (case-normalized). */
export function fingerprintTransfer(input: {
  routeId: string;
  asset: string;
  network: string;
  address: string;
  targetAmountAtomic: string;
  recipientId: string | null;
  recipientDestinationId: string | null;
  requestId: string | null;
  recipientName: string | null;
}): string {
  return JSON.stringify({
    routeId: input.routeId,
    asset: input.asset,
    network: input.network,
    address: input.address.trim().toLowerCase(),
    targetAmountAtomic: input.targetAmountAtomic,
    recipientId: input.recipientId,
    recipientDestinationId: input.recipientDestinationId,
    requestId: input.requestId,
    recipientName: input.recipientName,
  });
}

interface ResolvedIntent {
  routeId: string;
  asset: string;
  network: string;
  address: string;
  targetAmountAtomic: string;
  recipientName: string | null;
  recipientId: string | null;
  recipientDestinationId: string | null;
  requestId: string | null;
  requestPublicId: string | null;
}

/**
 * Resolve exactly one initiation path server-side. Nothing is trusted from
 * the client except validated references and the exact amount (which must
 * match immutable snapshots where they exist).
 */
async function resolveIntent(userId: string, input: TransferCreateInput): Promise<ResolvedIntent> {
  const db = getDb();
  const pair = pairForRouteId(input.routeId);
  if (!pair) throw new AuthError(400, "UNKNOWN_ROUTE", `Route ${input.routeId} is not a known Thence route.`);
  if (!isAtomicAmount(input.targetAmountAtomic) || parseAtomicAmount(input.targetAmountAtomic) === 0n) {
    throw new AuthError(400, "BAD_AMOUNT", "targetAmountAtomic must be a positive atomic integer string.");
  }

  if (input.recipientDestinationId !== undefined) {
    const rows = await db
      .select({
        destId: recipientDestinations.id,
        address: recipientDestinations.address,
        asset: recipientDestinations.asset,
        network: recipientDestinations.network,
        recipientId: recipients.id,
        recipientName: recipients.displayName,
        archivedAt: recipients.archivedAt,
      })
      .from(recipientDestinations)
      .innerJoin(recipients, eq(recipients.id, recipientDestinations.recipientId))
      .where(and(eq(recipientDestinations.id, input.recipientDestinationId), eq(recipients.ownerUserId, userId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw new AuthError(404, "NOT_FOUND", "Saved destination not found.");
    if (target.archivedAt) throw new AuthError(409, "RECIPIENT_ARCHIVED", "Recipient is archived.");
    if (target.asset !== pair.asset || target.network !== pair.network) {
      throw new AuthError(400, "SNAPSHOT_MISMATCH", "Saved destination does not match this route.");
    }
    const guard = checkDestination(target.network, target.asset, target.address);
    if (!guard.ok) throw new AuthError(400, guard.code, guard.message);
    return {
      routeId: input.routeId,
      asset: target.asset,
      network: target.network,
      address: target.address,
      targetAmountAtomic: input.targetAmountAtomic,
      recipientName: target.recipientName,
      recipientId: target.recipientId,
      recipientDestinationId: target.destId,
      requestId: null,
      requestPublicId: null,
    };
  }

  if (input.requestPublicId !== undefined) {
    const rows = await db.select().from(paymentRequests).where(eq(paymentRequests.publicId, input.requestPublicId)).limit(1);
    const req = rows[0];
    if (!req) throw new AuthError(404, "REQUEST_NOT_FOUND", "Payment request not found.");
    if (req.cancelledAt) throw new AuthError(409, "REQUEST_CANCELLED", "Payment request was cancelled.");
    if (req.expiresAt && req.expiresAt.getTime() <= Date.now()) {
      throw new AuthError(409, "REQUEST_EXPIRED", "Payment request has expired.");
    }
    if (req.asset !== pair.asset || req.network !== pair.network) {
      throw new AuthError(400, "SNAPSHOT_MISMATCH", "Payment request terms do not match this route.");
    }
    if (input.targetAmountAtomic !== req.amountAtomic) {
      throw new AuthError(400, "SNAPSHOT_MISMATCH", "Amount must equal the payment request amount.");
    }
    return {
      routeId: input.routeId,
      asset: req.asset,
      network: req.network,
      address: req.destination,
      targetAmountAtomic: req.amountAtomic,
      recipientName: req.recipientName,
      recipientId: null,
      recipientDestinationId: null,
      requestId: req.id,
      requestPublicId: req.publicId,
    };
  }

  const direct = input.direct as { asset: string; network: string; address: string };
  if (direct.asset !== pair.asset || direct.network !== pair.network) {
    throw new AuthError(400, "SNAPSHOT_MISMATCH", "Direct destination does not match this route.");
  }
  const guard = checkDestination(direct.network, direct.asset, direct.address);
  if (!guard.ok) throw new AuthError(400, guard.code, guard.message);
  return {
    routeId: input.routeId,
    asset: direct.asset,
    network: direct.network,
    address: direct.address.trim(),
    targetAmountAtomic: input.targetAmountAtomic,
    recipientName: input.recipientName ?? null,
    recipientId: null,
    recipientDestinationId: null,
    requestId: null,
    requestPublicId: null,
  };
}

export async function createTransfer(
  userId: string,
  body: unknown,
): Promise<{ transfer: TransferView; deduplicated: boolean }> {
  rejectTransferForbiddenFields(body);
  const parsed = transferCreateSchema.safeParse(body);
  if (!parsed.success) throw new AuthError(400, "BAD_BODY", parsed.error.issues[0]?.message ?? "Invalid transfer request.");
  const db = getDb();
  const intent = await resolveIntent(userId, parsed.data);
  const fingerprint = fingerprintTransfer({
    routeId: intent.routeId,
    asset: intent.asset,
    network: intent.network,
    address: intent.address,
    targetAmountAtomic: intent.targetAmountAtomic,
    recipientId: intent.recipientId,
    recipientDestinationId: intent.recipientDestinationId,
    requestId: intent.requestId,
    recipientName: intent.recipientName,
  });

  // Idempotent fast path: same owner + key + same canonical request.
  const prior = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.ownerUserId, userId), eq(transfers.idempotencyKey, parsed.data.idempotencyKey)))
    .limit(1);
  if (prior[0]) {
    const same =
      fingerprintTransfer({
        routeId: prior[0].routeId,
        asset: prior[0].targetAsset,
        network: prior[0].targetNetwork,
        address: prior[0].destination,
        targetAmountAtomic: prior[0].targetAmountAtomic,
        recipientId: prior[0].recipientId,
        recipientDestinationId: prior[0].recipientDestinationId,
        requestId: prior[0].requestId,
        recipientName: prior[0].recipientName,
      }) === fingerprint;
    if (!same) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different transfer.");
    return { transfer: await toView(db, prior[0]), deduplicated: true };
  }

  if (!canTransition("DRAFT", "QUOTED")) {
    throw new AuthError(500, "LIFECYCLE_FORBIDDEN", "Transfer preparation is not permitted.");
  }
  // Live exact-output quote on server-controlled parameters (no second engine).
  const quote = await createQuote({
    routeId: intent.routeId,
    targetAmountAtomic: intent.targetAmountAtomic,
    ...(intent.requestPublicId ? { requestId: intent.requestPublicId } : {}),
  });

  try {
    const inserted = await db
      .insert(transfers)
      .values({
        ownerUserId: userId,
        recipientId: intent.recipientId,
        recipientDestinationId: intent.recipientDestinationId,
        requestId: intent.requestId,
        routeId: intent.routeId,
        targetAsset: intent.asset,
        targetNetwork: intent.network,
        destination: intent.address,
        targetAmountAtomic: intent.targetAmountAtomic,
        recipientName: intent.recipientName,
        status: "QUOTED",
        idempotencyKey: parsed.data.idempotencyKey,
        quoteProvider: "satora",
        quoteRevision: 1,
        quotedAt: new Date(quote.observedAt),
        quotedNetTargetAtomic: quote.netTargetAmountAtomic,
        quotedSourceSats: quote.sourceAmountSats,
        quotedFeesJson: quote.fees,
        quotedLimitsJson: quote.limits,
        quoteExpiresAt: new Date(quote.validUntil),
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new AuthError(500, "TRANSFER_FAILED", "Could not create transfer.");
    return { transfer: await toView(db, row), deduplicated: false };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      // Concurrent identical create won the race: compare and converge.
      const existing = await db
        .select()
        .from(transfers)
        .where(and(eq(transfers.ownerUserId, userId), eq(transfers.idempotencyKey, parsed.data.idempotencyKey)))
        .limit(1);
      const row = existing[0];
      if (!row) throw new AuthError(500, "TRANSFER_FAILED", "Could not create transfer.");
      const same =
        fingerprintTransfer({
          routeId: row.routeId,
          asset: row.targetAsset,
          network: row.targetNetwork,
          address: row.destination,
          targetAmountAtomic: row.targetAmountAtomic,
          recipientId: row.recipientId,
          recipientDestinationId: row.recipientDestinationId,
          requestId: row.requestId,
          recipientName: row.recipientName,
        }) === fingerprint;
      if (!same) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different transfer.");
      return { transfer: await toView(db, row), deduplicated: true };
    }
    throw err instanceof AuthError ? err : new AuthError(500, "TRANSFER_FAILED", "Could not create transfer.");
  }
}

export interface ListTransfersOptions {
  status?: TransferStatus | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function listTransfers(
  userId: string,
  options: ListTransfersOptions = {},
): Promise<{ transfers: TransferView[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
  if (options.status !== undefined && !(TRANSFER_STATUSES as readonly string[]).includes(options.status)) {
    throw new AuthError(400, "BAD_BODY", "Unknown transfer status.");
  }
  const db = getDb();
  const where = options.status
    ? and(eq(transfers.ownerUserId, userId), eq(transfers.status, options.status))
    : eq(transfers.ownerUserId, userId);
  const totalRows = await db.select({ n: count() }).from(transfers).where(where);
  const rows = await db.select().from(transfers).where(where).orderBy(desc(transfers.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  const items: TransferView[] = [];
  for (const row of rows) items.push(await toView(db, row));
  return { transfers: items, total: totalRows[0]?.n ?? 0, page, pageSize };
}

export async function getTransferDetail(userId: string, transferId: string): Promise<TransferView | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const row = rows[0];
  return row ? toView(db, row) : null;
}

/**
 * Refresh a pre-funding quote with new live provider terms. Optimistic
 * concurrency: the write applies only when the stored revision still
 * matches `expectedQuoteRevision`.
 */
export async function requoteTransfer(
  userId: string,
  transferId: string,
  expectedQuoteRevision: number,
): Promise<TransferView> {
  if (!Number.isInteger(expectedQuoteRevision) || expectedQuoteRevision < 1) {
    throw new AuthError(400, "BAD_BODY", "expectedQuoteRevision must be a positive integer.");
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const current = rows[0];
  if (!current) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  if (current.status !== "QUOTED") {
    throw new AuthError(409, "NOT_REQUOTEABLE", "Only pre-funding quoted transfers can be re-quoted.");
  }
  // Resolve the live request public id for snapshot revalidation, if linked.
  let requestPublicId: string | undefined;
  if (current.requestId) {
    const req = await db.select().from(paymentRequests).where(eq(paymentRequests.id, current.requestId)).limit(1);
    const linked = req[0];
    if (!linked) {
      // Request record deleted: terms stay frozen in the transfer snapshot.
      requestPublicId = undefined;
    } else {
      if (linked.cancelledAt) throw new AuthError(409, "REQUEST_CANCELLED", "Payment request was cancelled.");
      if (linked.expiresAt && linked.expiresAt.getTime() <= Date.now()) {
        throw new AuthError(409, "REQUEST_EXPIRED", "Payment request has expired.");
      }
      requestPublicId = linked.publicId;
    }
  }
  const quote = await createQuote({
    routeId: current.routeId,
    targetAmountAtomic: current.targetAmountAtomic,
    ...(requestPublicId ? { requestId: requestPublicId } : {}),
  });
  const updated = await db
    .update(transfers)
    .set({
      quoteProvider: "satora",
      quoteRevision: current.quoteRevision + 1,
      quotedAt: new Date(quote.observedAt),
      quotedNetTargetAtomic: quote.netTargetAmountAtomic,
      quotedSourceSats: quote.sourceAmountSats,
      quotedFeesJson: quote.fees,
      quotedLimitsJson: quote.limits,
      quoteExpiresAt: new Date(quote.validUntil),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transfers.id, current.id),
        eq(transfers.ownerUserId, userId),
        eq(transfers.quoteRevision, expectedQuoteRevision),
        eq(transfers.status, "QUOTED"),
      ),
    )
    .returning();
  const next = updated[0];
  if (!next) {
    const reread = await db
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, current.id), eq(transfers.ownerUserId, userId)))
      .limit(1);
    if (!reread[0]) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    if (reread[0].quoteRevision !== expectedQuoteRevision) {
      throw new AuthError(409, "VERSION_CONFLICT", "Quote was refreshed by another call; re-read before retrying.");
    }
    throw new AuthError(409, "NOT_REQUOTEABLE", "Only pre-funding quoted transfers can be re-quoted.");
  }
  return toView(db, next);
}

export { readJsonBody };
