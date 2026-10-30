/**
 * Thence backend — payment requests ("Request to Pay", B2.2).
 *
 * A request is a validated, immutable snapshot of payment terms owned by its
 * creator. The public link resolves WITHOUT authentication and WITHOUT
 * touching any recipient book — deleting, archiving or editing a saved
 * beneficiary can never mutate existing request terms.
 *
 * Invariants:
 * - Amounts are exact atomic-unit strings (money.ts); never floats. Input is
 *   a human decimal string converted server-side with per-asset precision.
 * - Public IDs are 128-bit cryptographic random, URL-safe, non-sequential.
 * - Terms are immutable after creation: PATCH accepts only {action:"cancel"}.
 * - Cancellation is terminal and idempotent; no "paid" status exists here —
 *   fulfillment attaches in later transfer milestones.
 * - Creating a request initiates nothing: no payment, no swap, no quote.
 * - `route.quoteable` reports current registry state honestly; a supported
 *   (structurally valid) route is NOT a liquidity promise (B3 quotes live).
 */
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { paymentRequests } from "@/db/schema";
import { getEnv, parseEnabledRoutes } from "@/lib/env";
import { atomicToDecimal, decimalToAtomic, parseAtomicAmount } from "@/domain/money";
import { buildRouteRegistry, getRoute, isSupportedPair, routeIdForPair } from "@/domain/routes";
import { checkDestination, displayNameSchema, readJsonBody, rejectForbiddenKeys } from "@/lib/recipients";

/** Canonical smallest-unit precision per supported asset. */
const ASSET_DECIMALS: Record<string, number> = { USDT: 6, USDC: 6, BTC: 8 };

export const requestCreateSchema = z.object({
  recipientName: displayNameSchema,
  asset: z.string().trim().min(1),
  network: z.string().trim().min(1),
  address: z.string().trim().min(1, "Destination is required.").max(256),
  /** Human decimal amount, e.g. "50.00" — converted server-side to atomic units. */
  amount: z.string().trim().min(1, "Amount is required.").max(40),
  memo: z.string().trim().max(280).nullable().optional(),
  /** Lifetime in seconds. Defaults to THENCE_REQUEST_DEFAULT_TTL_SECONDS. */
  expiresInSeconds: z.number().int().positive().optional(),
});

export type RequestCreateInput = z.infer<typeof requestCreateSchema>;

export type RequestStatus = "active" | "expired" | "cancelled";

/** Derive the safe public status. Cancelled wins over expired. */
export function requestStatus(row: { cancelledAt: Date | null; expiresAt: Date | null }): RequestStatus {
  if (row.cancelledAt) return "cancelled";
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

/** Generate a 128-bit URL-safe public id (22 chars, non-sequential). */
export function newPublicId(): string {
  return randomBytes(16).toString("base64url");
}

const EXTRA_FORBIDDEN_KEYS = new Set(["creatorUserId", "creator_user_id", "publicId", "public_id"]);

export function rejectRequestForbiddenKeys(body: unknown): void {
  rejectForbiddenKeys(body);
  if (typeof body !== "object" || body === null) return;
  for (const key of Object.keys(body)) {
    if (EXTRA_FORBIDDEN_KEYS.has(key)) {
      throw new AuthError(400, "FIELD_FORBIDDEN", `Field "${key}" cannot be set by clients.`);
    }
  }
}

export interface RouteInfo {
  id: string;
  supported: true;
  /** Current registry quoteability — NOT a liquidity promise (B3 quotes live). */
  quoteable: boolean;
}

export function routeInfoFor(asset: string, network: string): RouteInfo {
  const env = getEnv();
  const registry = buildRouteRegistry({
    enabledRouteIds: parseEnabledRoutes(env.THENCE_ENABLED_ROUTES),
    verifiedTokens: env.THENCE_ROUTE_TOKENS_JSON,
  });
  const id = routeIdForPair(asset, network) ?? `${asset.toLowerCase()}-${network.toLowerCase()}`;
  const route = getRoute(registry, id);
  return { id, supported: true, quoteable: route?.quoteable ?? false };
}

/** Share URL using the trusted configured origin; never the Host header. */
export function shareUrl(publicId: string): string {
  const origin = getEnv().THENCE_APP_ORIGIN.trim().replace(/\/+$/, "");
  const path = `/r/${publicId}`;
  return origin === "" ? path : `${origin}${path}`;
}

export interface PublicRequestView {
  publicId: string;
  recipientName: string;
  amount: string;
  amountAtomic: string;
  asset: string;
  network: string;
  destination: string;
  memo: string | null;
  expiresAt: string | null;
  status: RequestStatus;
  route: RouteInfo;
  url: string;
}

export interface OwnerRequestView extends Omit<PublicRequestView, "url"> {
  id: string;
  createdAt: string;
  cancelledAt: string | null;
  url: string;
}

type Db = ReturnType<typeof getDb>;
type RequestRow = typeof paymentRequests.$inferSelect;

function toPublicView(row: RequestRow): PublicRequestView {
  return {
    publicId: row.publicId,
    recipientName: row.recipientName,
    amount: atomicToDecimal(row.amountAtomic, ASSET_DECIMALS[row.asset] ?? 6),
    amountAtomic: row.amountAtomic,
    asset: row.asset,
    network: row.network,
    destination: row.destination,
    memo: row.memo,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    status: requestStatus(row),
    route: routeInfoFor(row.asset, row.network),
    url: shareUrl(row.publicId),
  };
}

function toOwnerView(row: RequestRow): OwnerRequestView {
  return {
    ...toPublicView(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

/** Validate + convert a human decimal amount to exact atomic units. */
export function amountToAtomic(asset: string, amount: string): string {
  const decimals = ASSET_DECIMALS[asset];
  if (decimals === undefined) throw new AuthError(400, "UNSUPPORTED_ROUTE", `Asset ${asset} is not supported.`);
  let atomic: string;
  try {
    atomic = decimalToAtomic(amount, decimals);
  } catch {
    throw new AuthError(400, "BAD_AMOUNT", "Amount must be a positive decimal within asset precision.");
  }
  if (parseAtomicAmount(atomic) === 0n) {
    throw new AuthError(400, "BAD_AMOUNT", "Amount must be greater than zero.");
  }
  return atomic;
}

export async function createRequest(userId: string, body: unknown): Promise<OwnerRequestView> {
  rejectRequestForbiddenKeys(body);
  const parsed = requestCreateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AuthError(400, "BAD_BODY", parsed.error.issues[0]?.message ?? "Invalid request.");
  }
  const input = parsed.data;
  if (!isSupportedPair(input.asset, input.network)) {
    throw new AuthError(400, "UNSUPPORTED_ROUTE", `Asset/network pair ${input.asset} on ${input.network} is not supported.`);
  }
  // EVM-only this slice; Lightning is rejected with honest pending codes.
  const guard = checkDestination(input.network, input.asset, input.address);
  if (!guard.ok) throw new AuthError(400, guard.code, guard.message);
  const amountAtomic = amountToAtomic(input.asset, input.amount);

  const env = getEnv();
  const ttl = input.expiresInSeconds ?? env.THENCE_REQUEST_DEFAULT_TTL_SECONDS;
  if (ttl > env.THENCE_REQUEST_MAX_TTL_SECONDS) {
    throw new AuthError(400, "BAD_EXPIRY", "Requested lifetime exceeds the maximum.");
  }
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const db = getDb();
  // Collision retry (128-bit ids: retry is near-theoretical, but cheap).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const inserted = await db
        .insert(paymentRequests)
        .values({
          creatorUserId: userId,
          publicId: newPublicId(),
          recipientName: input.recipientName,
          asset: input.asset,
          network: input.network,
          destination: input.address.trim(),
          amountAtomic,
          memo: input.memo?.trim() ? input.memo.trim() : null,
          expiresAt,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new AuthError(500, "REQUEST_FAILED", "Could not create request.");
      return toOwnerView(row);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      const code = (err as { code?: string }).code;
      if (code === "23505" && attempt < 4) continue; // public_id collision: retry
      throw new AuthError(500, "REQUEST_FAILED", "Could not create request.");
    }
  }
  throw new AuthError(500, "REQUEST_FAILED", "Could not create request.");
}

export async function getPublicRequest(publicId: string): Promise<PublicRequestView | null> {
  if (typeof publicId !== "string" || publicId.length === 0 || publicId.length > 64) return null;
  const rows = await getDb().select().from(paymentRequests).where(eq(paymentRequests.publicId, publicId)).limit(1);
  const row = rows[0];
  return row ? toPublicView(row) : null;
}

export interface ListRequestsOptions {
  status?: RequestStatus | "all";
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function listRequests(
  userId: string,
  options: ListRequestsOptions = {},
): Promise<{ requests: OwnerRequestView[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
  const db = getDb();
  const now = new Date();
  // SQL mirrors requestStatus() exactly: cancelled wins, else expiry decides.
  const wanted = options.status ?? "all";
  const statusCondition =
    wanted === "cancelled"
      ? isNotNull(paymentRequests.cancelledAt)
      : wanted === "expired"
        ? and(isNull(paymentRequests.cancelledAt), lte(paymentRequests.expiresAt, now))
        : wanted === "active"
          ? and(
              isNull(paymentRequests.cancelledAt),
              or(isNull(paymentRequests.expiresAt), gt(paymentRequests.expiresAt, now)),
            )
          : undefined;
  const where = statusCondition
    ? and(eq(paymentRequests.creatorUserId, userId), statusCondition)
    : eq(paymentRequests.creatorUserId, userId);
  const totalRows = await db.select({ n: count() }).from(paymentRequests).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(paymentRequests)
    .where(where)
    .orderBy(desc(paymentRequests.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { requests: rows.map(toOwnerView), total, page, pageSize };
}

export async function cancelRequest(userId: string, publicId: string): Promise<OwnerRequestView | null> {
  const db: Db = getDb();
  const rows = await db
    .select()
    .from(paymentRequests)
    .where(and(eq(paymentRequests.publicId, publicId), eq(paymentRequests.creatorUserId, userId)))
    .limit(1);
  const current = rows[0];
  if (!current) return null;
  if (current.cancelledAt) return toOwnerView(current); // idempotent
  const updated = await db
    .update(paymentRequests)
    .set({ cancelledAt: new Date() })
    .where(eq(paymentRequests.id, current.id))
    .returning();
  const next = updated[0];
  if (!next) return toOwnerView(current);
  return toOwnerView(next);
}

export { readJsonBody };
