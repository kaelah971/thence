/**
 * Thence backend — swap binding + safe handoff contract (B4.2).
 *
 * Backend contracts ONLY: no swap is created, no invoice funded, no Nimiq
 * Pay invoked, no claim executed here. The future browser client creates the
 * Satora swap with its own SDK, persists recovery material in IndexedDB
 * (with readback), and only then attaches + requests handoff authorization.
 *
 * Crash-window finding (verified in @satora/swap 1.7.2 source):
 * `createLightningToEvmSwap` POSTs `/swap/lightning/evm` and only afterwards
 * calls `ctx.storeSwap(...)`. A browser crash (or storage failure) between
 * the two leaves a provider-side swap with no client recovery record. The
 * mitigation is contractual and enforced here: attach requires a
 * client-reported persistence acknowledgement, handoff authorization
 * requires it stored, and the eventual frontend must read back durable
 * storage before invoking Nimiq Pay. The ack is reported, not independently
 * proven — documented, never overstated.
 *
 * Safety properties:
 * - One active attempt per transfer (partial unique + advisory serialization).
 * - One bound swap per transfer; one swap authorizes at most one transfer
 *   (global UNIQUE on satora_swap_id).
 * - Attach verifies the swap read-only against independent provider facts;
 *   mismatches block, never warn-and-continue.
 * - Repricing (swap source > quoted source) blocks handoff authorization
 *   until explicit renewed confirmation exists (a later slice).
 * - Unknown outcomes never become FAILED and never auto-authorize anything.
 * - Only the server-side lifecycle may change transfer status, using the
 *   existing domain transitions (QUOTED→SWAP_CREATED→AWAITING_NIM_APPROVAL).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import {
  handoffAttempts,
  paymentRequests,
  recipientDestinations,
  recipients,
  swapAttachments,
  transferProofs,
  transfers,
} from "@/db/schema";
import { getEnv, parseEnabledRoutes } from "@/lib/env";
import { assertPilotIntent, getOwnerAddress } from "@/lib/pilot";
import { canTransition, transition } from "@/domain/transfers";
import { checkDestination } from "@/lib/recipients";
import { getProviderSwap, resolveRoute, SatoraError } from "@/lib/satora";
import type { VerifiedSwapFacts } from "@/lib/satora";

export const ATTEMPT_TOKEN_BYTES = 16;
const INVOICE_RE = /^(lnbc|lnbcrt|lntb|lntbs)/i;

export type HandoffAttemptStatus = "PREPARED" | "SWAP_ATTACHED" | "HANDOFF_AUTHORIZED" | "SUPERSEDED";
const ACTIVE_STATUSES = ["PREPARED", "SWAP_ATTACHED"] as const;

type Db = ReturnType<typeof getDb>;
type TransferRow = typeof transfers.$inferSelect;

export function hashAttemptToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newAttemptToken(): string {
  return randomBytes(ATTEMPT_TOKEN_BYTES).toString("base64url");
}

/** Advisory serialization per transfer (same key family as recipients). */
export async function lockTransfer(tx: { execute: Db["execute"] }, transferId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"transfer:" + transferId}))`);
}

export interface AttemptView {
  id: string;
  transferId: string;
  status: HandoffAttemptStatus;
  quoteRevision: number;
  satoraSwapId: string | null;
  recoveryAcknowledged: boolean;
  expiresAt: string;
  handoffAuthorizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toAttemptView(row: typeof handoffAttempts.$inferSelect): AttemptView {
  return {
    id: row.id,
    transferId: row.transferId,
    status: row.status as HandoffAttemptStatus,
    quoteRevision: row.quoteRevision,
    satoraSwapId: row.satoraSwapId,
    recoveryAcknowledged: row.recoveryAcknowledged,
    expiresAt: row.expiresAt.toISOString(),
    handoffAuthorizedAt: row.handoffAuthorizedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface BoundSwapView {
  satoraSwapId: string;
  sourceSats: string;
  targetAtomic: string;
  paymentHash: string;
  invoiceExpiresAt: string | null;
  providerStatus: string | null;
  verifiedAt: string;
}

/**
 * Pure swap-vs-transfer verification. Every independently checkable fact
 * must match; anything missing or divergent blocks. Unit-testable without
 * network or database.
 */
export function verifySwapMatch(args: {
  asset: string;
  network: string;
  chainId: string;
  tokenAddress: string;
  destination: string;
  targetAmountAtomic: string;
  swap: VerifiedSwapFacts;
}): void {
  const { asset, network, chainId, tokenAddress, destination, targetAmountAtomic, swap } = args;
  // Direction is mandatory: without it the route identity is unverifiable.
  if (swap.direction !== "lightning_to_evm") {
    throw new AuthError(409, "SWAP_MISMATCH", "Provider swap is not a Lightning to EVM swap.");
  }
  if (String(swap.evmChainId) !== chainId) {
    throw new AuthError(409, "SWAP_MISMATCH", "Provider swap chain does not match the transfer route.");
  }
  if (swap.targetTokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
    throw new AuthError(409, "SWAP_MISMATCH", "Provider swap token does not match the transfer route.");
  }
  void asset;
  void network;
  if (swap.targetAddress.toLowerCase() !== destination.trim().toLowerCase()) {
    throw new AuthError(409, "SWAP_MISMATCH", "Provider swap destination does not match the transfer.");
  }
  if (swap.targetAtomic !== targetAmountAtomic) {
    throw new AuthError(409, "SWAP_MISMATCH", "Provider swap output differs from the requested exact amount.");
  }
  if (swap.status !== "" && swap.status !== "pending") {
    throw new AuthError(409, "SWAP_STATE_UNEXPECTED", `Provider swap is not awaiting funding (status: ${swap.status}).`);
  }
  if (!INVOICE_RE.test(swap.bolt11Invoice)) {
    throw new AuthError(409, "SWAP_MISMATCH", "Provider swap invoice is not a valid BOLT11 invoice.");
  }
  if (!swap.invoiceExpiresAt || swap.invoiceExpiresAt.getTime() <= Date.now()) {
    throw new AuthError(409, "INVOICE_EXPIRED", "Provider swap invoice is missing or expired.");
  }
}

/**
 * Prepare a handoff attempt: revalidated snapshot + single active attempt.
 * Idempotent replay returns the existing active attempt (with its token,
 * which is owner-scoped — never a payment capability).
 */
export async function prepareHandoff(
  userId: string,
  transferId: string,
  expectedQuoteRevision: unknown,
): Promise<{ attempt: AttemptView; token: string; deduplicated: boolean }> {
  if (typeof expectedQuoteRevision !== "number" || !Number.isInteger(expectedQuoteRevision) || expectedQuoteRevision < 1) {
    throw new AuthError(400, "BAD_BODY", "expectedQuoteRevision must be a positive integer.");
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const rows = await tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
      .limit(1);
    const transfer = rows[0];
    if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    if (transfer.status !== "QUOTED") {
      throw new AuthError(409, "NOT_PREPARABLE", "Only pre-funding quoted transfers can be prepared.");
    }
    // F8 restricted pilot: prepare is a funded-execution path.
    assertPilotIntent({
      routeId: transfer.routeId,
      targetAmountAtomic: transfer.targetAmountAtomic,
      ownerAddress: await getOwnerAddress(userId),
    });
    if (transfer.quoteRevision !== expectedQuoteRevision) {
      throw new AuthError(409, "VERSION_CONFLICT", "Quote revision changed; re-read the transfer before preparing.");
    }
    if (!transfer.quoteExpiresAt || transfer.quoteExpiresAt.getTime() <= Date.now()) {
      throw new AuthError(409, "QUOTE_STALE", "Quote expired; re-quote before preparing handoff.");
    }
    const env = getEnv();
    if (!parseEnabledRoutes(env.THENCE_ENABLED_ROUTES).includes(transfer.routeId)) {
      throw new AuthError(409, "ROUTE_DISABLED", "Route is no longer enabled.");
    }
    // Request linkage revalidated (snapshot terms themselves are immutable).
    if (transfer.requestId) {
      const req = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, transfer.requestId)).limit(1);
      const linked = req[0];
      if (linked?.cancelledAt) {
        throw new AuthError(409, "REQUEST_CANCELLED", "Linked payment request was cancelled.");
      }
      if (linked?.expiresAt && linked.expiresAt.getTime() <= Date.now()) {
        throw new AuthError(409, "REQUEST_EXPIRED", "Linked payment request has expired.");
      }
    }
    // Live route revalidation: token config may have changed since quoting.
    try {
      await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    } catch (err) {
      if (err instanceof SatoraError) throw new AuthError(err.code === "PROVIDER_UNAVAILABLE" || err.code === "PROVIDER_TIMEOUT" ? 503 : 409, err.code, err.message);
      throw err;
    }
    // Idempotent replay: same active attempt for this transfer + revision.
    const active = await tx
      .select()
      .from(handoffAttempts)
      .where(
        and(
          eq(handoffAttempts.transferId, transfer.id),
          sql`${handoffAttempts.status} IN ('PREPARED', 'SWAP_ATTACHED')`,
          sql`${handoffAttempts.expiresAt} > NOW()`,
        ),
      )
      .orderBy(desc(handoffAttempts.createdAt))
      .limit(1);
    const existing = active[0];
    // NOTE: the raw bearer token is not stored — only its hash. The owner
    // re-fetch below re-issues the same logical attempt handle: callers must
    // treat the handle as opaque. We return no raw token on replay; the
    // original caller persisted it before swap creation (contract).
    if (existing && existing.quoteRevision === expectedQuoteRevision) {
      return { attempt: toAttemptView(existing), token: "", deduplicated: true };
    }
    if (existing) {
      throw new AuthError(409, "ATTEMPT_IN_PROGRESS", "Another handoff attempt is already active for this transfer.");
    }
    // Explicitly retire stale/ambiguous predecessors (auditable, never silent).
    await tx
      .update(handoffAttempts)
      .set({ status: "SUPERSEDED", updatedAt: new Date() })
      .where(
        and(
          eq(handoffAttempts.transferId, transfer.id),
          sql`${handoffAttempts.status} IN ('PREPARED', 'SWAP_ATTACHED')`,
        ),
      );
    const token = newAttemptToken();
    const inserted = await tx
      .insert(handoffAttempts)
      .values({
        transferId: transfer.id,
        attemptTokenHash: hashAttemptToken(token),
        quoteRevision: transfer.quoteRevision,
        status: "PREPARED",
        expiresAt: new Date(Date.now() + env.THENCE_PREPARATION_TTL_SECONDS * 1000),
      })
      .returning();
    const created = inserted[0];
    if (!created) throw new AuthError(500, "PREPARE_FAILED", "Could not prepare handoff.");
    return { attempt: toAttemptView(created), token, deduplicated: false };
  });
}

/**
 * Attach a client-created swap after verifying it read-only against the
 * transfer snapshot, quote terms and live provider facts. Idempotent for the
 * same swap; conflicting swap ids are rejected, never merged.
 */
export async function attachSwap(
  userId: string,
  transferId: string,
  body: unknown,
): Promise<{ attachment: BoundSwapView; transferStatus: string; deduplicated: boolean }> {
  const { attemptToken, expectedQuoteRevision, satoraSwapId, recoveryAcknowledged } =
    (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof attemptToken !== "string" || attemptToken.length === 0) {
    throw new AuthError(400, "BAD_BODY", "attemptToken is required.");
  }
  if (expectedQuoteRevision !== undefined && (typeof expectedQuoteRevision !== "number" || !Number.isInteger(expectedQuoteRevision) || expectedQuoteRevision < 1)) {
    throw new AuthError(400, "BAD_BODY", "expectedQuoteRevision must be a positive integer.");
  }
  if (typeof satoraSwapId !== "string" || satoraSwapId.length === 0 || satoraSwapId.length > 128) {
    throw new AuthError(400, "BAD_BODY", "satoraSwapId is required.");
  }
  if (recoveryAcknowledged !== true) {
    throw new AuthError(400, "RECOVERY_NOT_CONFIRMED", "Client must confirm durable recovery persistence before attaching.");
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const rows = await tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
      .limit(1);
    const transfer = rows[0];
    if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    // Idempotent replay first: the same bound swap returns the stored facts
    // regardless of later state (read-only, never a second handoff).
    const bound = await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    const existingBinding = bound[0];
    if (existingBinding) {
      if (existingBinding.satoraSwapId !== satoraSwapId) {
        throw new AuthError(409, "SWAP_CONFLICT", "This transfer already has a bound swap; it cannot be replaced.");
      }
      return {
        attachment: toBoundView(existingBinding),
        transferStatus: transfer.status,
        deduplicated: true,
      };
    }
    if (transfer.status !== "QUOTED") {
      throw new AuthError(409, "NOT_ATTACHABLE", "Only pre-funding quoted transfers can bind a swap.");
    }
    // F8 restricted pilot: attach binds a live swap (funded-execution path).
    assertPilotIntent({
      routeId: transfer.routeId,
      targetAmountAtomic: transfer.targetAmountAtomic,
      ownerAddress: await getOwnerAddress(userId),
    });
    const attempts = await tx
      .select()
      .from(handoffAttempts)
      .where(
        and(
          eq(handoffAttempts.transferId, transfer.id),
          eq(handoffAttempts.attemptTokenHash, hashAttemptToken(attemptToken)),
        ),
      )
      .limit(1);
    const attempt = attempts[0];
    if (!attempt || attempt.expiresAt.getTime() <= Date.now() || !ACTIVE_STATUSES.includes(attempt.status as (typeof ACTIVE_STATUSES)[number])) {
      throw new AuthError(410, "ATTEMPT_INVALID", "Handoff attempt is unknown, expired, or no longer active.");
    }
    if (expectedQuoteRevision !== undefined && expectedQuoteRevision !== transfer.quoteRevision) {
      throw new AuthError(409, "VERSION_CONFLICT", "Quote revision changed; re-read the transfer before attaching.");
    }
    if (attempt.quoteRevision !== transfer.quoteRevision) {
      throw new AuthError(409, "VERSION_CONFLICT", "Attempt was prepared for a different quote revision; re-prepare first.");
    }
    // (Idempotent replay is handled before the status gate above.)
    // Global swap reuse guard: one swap authorizes at most one transfer.
    const reused = await tx.select({ id: swapAttachments.id }).from(swapAttachments).where(eq(swapAttachments.satoraSwapId, satoraSwapId)).limit(1);
    if (reused.length > 0) {
      throw new AuthError(409, "SWAP_ALREADY_BOUND", "This Satora swap is already bound to another transfer.");
    }
    // Live read-only verification against independent provider facts.
    let facts;
    try {
      const { getProviderSwap } = await import("@/lib/satora");
      facts = await getProviderSwap(satoraSwapId);
    } catch (err) {
      if (err instanceof SatoraError) {
        const status = err.code === "SWAP_NOT_FOUND" ? 404 : err.code === "PROVIDER_TIMEOUT" || err.code === "PROVIDER_UNAVAILABLE" ? 503 : 409;
        throw new AuthError(status, err.code, err.message);
      }
      throw new AuthError(503, "PROVIDER_UNAVAILABLE", "Route provider is temporarily unavailable.");
    }
    // Resolve the canonical token identity for comparison (never trusted from the client).
    let resolved;
    try {
      const { resolveRoute } = await import("@/lib/satora");
      resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    } catch (err) {
      if (err instanceof SatoraError) {
        throw new AuthError(err.code === "PROVIDER_UNAVAILABLE" || err.code === "PROVIDER_TIMEOUT" ? 503 : 409, err.code, err.message);
      }
      throw err;
    }
    if (facts.satoraSwapId !== satoraSwapId) {
      throw new AuthError(409, "SWAP_MISMATCH", "Provider returned a different swap than requested.");
    }
    verifySwapMatch({
      asset: transfer.targetAsset,
      network: transfer.targetNetwork,
      chainId: resolved.chainId,
      tokenAddress: resolved.tokenAddress,
      destination: transfer.destination,
      targetAmountAtomic: transfer.targetAmountAtomic,
      swap: facts,
    });
    const attached = await tx
      .insert(swapAttachments)
      .values({
        transferId: transfer.id,
        attemptId: attempt.id,
        satoraSwapId: facts.satoraSwapId,
        invoiceBolt11: facts.bolt11Invoice,
        paymentHash: facts.paymentHash,
        sourceSats: facts.sourceSats,
        targetAtomic: facts.targetAtomic,
        invoiceExpiresAt: facts.invoiceExpiresAt,
        providerStatus: facts.status,
      })
      .returning();
    const attachment = attached[0];
    if (!attachment) throw new AuthError(500, "ATTACH_FAILED", "Could not bind the swap.");
    await tx
      .update(handoffAttempts)
      .set({ status: "SWAP_ATTACHED", satoraSwapId: facts.satoraSwapId, recoveryAcknowledged: true, updatedAt: new Date() })
      .where(eq(handoffAttempts.id, attempt.id));
    // Mirror the public swap id into the receipt-bound proofs row (upsert).
    await tx
      .insert(transferProofs)
      .values({ transferId: transfer.id, satoraSwapId: facts.satoraSwapId, lightningHash: facts.paymentHash })
      .onConflictDoUpdate({
        target: transferProofs.transferId,
        set: { satoraSwapId: facts.satoraSwapId, lightningHash: facts.paymentHash },
      });
    if (!canTransition("QUOTED", "SWAP_CREATED")) {
      throw new AuthError(500, "LIFECYCLE_FORBIDDEN", "Transfer cannot advance to swap-created.");
    }
    await tx.update(transfers).set({ status: "SWAP_CREATED", updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
    return { attachment: toBoundView(attachment), transferStatus: "SWAP_CREATED", deduplicated: false };
  });
}

function toBoundView(row: typeof swapAttachments.$inferSelect): BoundSwapView {
  return {
    satoraSwapId: row.satoraSwapId,
    sourceSats: row.sourceSats,
    targetAtomic: row.targetAtomic,
    paymentHash: row.paymentHash,
    invoiceExpiresAt: row.invoiceExpiresAt?.toISOString() ?? null,
    providerStatus: row.providerStatus,
    verifiedAt: row.verifiedAt.toISOString(),
  };
}

/**
 * Authorize exactly one handoff for an attached, acknowledged attempt.
 * Revalidates the live swap (still pending, invoice live) and the
 * repricing invariant (swap source must not exceed the quoted source —
 * anything larger needs explicit renewed confirmation in a later slice).
 * Never invokes Nimiq Pay; records the authorization durably.
 */
export async function authorizeHandoff(
  userId: string,
  transferId: string,
  attemptToken: string,
): Promise<{ attemptId: string; invoiceBolt11: string; sourceSats: string; authorizedAt: string }> {
  if (typeof attemptToken !== "string" || attemptToken.length === 0) {
    throw new AuthError(400, "BAD_BODY", "attemptToken is required.");
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const rows = await tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
      .limit(1);
    const transfer = rows[0];
    if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    if (transfer.status !== "SWAP_CREATED") {
      throw new AuthError(409, "NOT_AUTHORIZABLE", "Only swap-bound pre-funding transfers can authorize handoff.");
    }
    // F8 restricted pilot: authorization is the last server gate before host payment.
    assertPilotIntent({
      routeId: transfer.routeId,
      targetAmountAtomic: transfer.targetAmountAtomic,
      ownerAddress: await getOwnerAddress(userId),
    });
    const attempts = await tx
      .select()
      .from(handoffAttempts)
      .where(
        and(
          eq(handoffAttempts.transferId, transfer.id),
          eq(handoffAttempts.attemptTokenHash, hashAttemptToken(attemptToken)),
        ),
      )
      .limit(1);
    const attempt = attempts[0];
    if (!attempt || attempt.status !== "SWAP_ATTACHED" || attempt.expiresAt.getTime() <= Date.now()) {
      throw new AuthError(409, "ATTEMPT_INVALID", "Handoff attempt is unknown, expired, or not attach-confirmed.");
    }
    if (!attempt.recoveryAcknowledged) {
      throw new AuthError(409, "RECOVERY_NOT_CONFIRMED", "Recovery persistence was not acknowledged for this attempt.");
    }
    const bound = await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    const attachment = bound[0];
    if (!attachment || attachment.satoraSwapId !== attempt.satoraSwapId) {
      throw new AuthError(409, "ATTEMPT_INVALID", "No bound swap matches this attempt.");
    }
    // Live revalidation: still pending, invoice still live.
    let facts;
    try {
      const { getProviderSwap } = await import("@/lib/satora");
      facts = await getProviderSwap(attachment.satoraSwapId);
    } catch (err) {
      if (err instanceof SatoraError) {
        const status = err.code === "SWAP_NOT_FOUND" ? 404 : err.code === "PROVIDER_TIMEOUT" || err.code === "PROVIDER_UNAVAILABLE" ? 503 : 409;
        throw new AuthError(status, err.code, err.message);
      }
      throw new AuthError(503, "PROVIDER_UNAVAILABLE", "Route provider is temporarily unavailable.");
    }
    if (facts.status !== "" && facts.status !== "pending") {
      throw new AuthError(409, "SWAP_STATE_UNEXPECTED", `Provider swap is no longer awaiting funding (status: ${facts.status}). Reconcile before retrying.`);
    }
    if (!facts.invoiceExpiresAt || facts.invoiceExpiresAt.getTime() <= Date.now()) {
      throw new AuthError(409, "INVOICE_EXPIRED", "Provider swap invoice is missing or expired.");
    }
    // Repricing guard: never silently approve a larger obligation.
    if (!transfer.quotedSourceSats || BigInt(facts.sourceSats) > BigInt(transfer.quotedSourceSats)) {
      throw new AuthError(409, "REPRICED_NEEDS_CONFIRMATION", "Swap source exceeds the quoted amount; explicit renewed confirmation is required.");
    }
    const authorized = await tx
      .update(handoffAttempts)
      .set({ status: "HANDOFF_AUTHORIZED", handoffAuthorizedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(handoffAttempts.id, attempt.id), eq(handoffAttempts.status, "SWAP_ATTACHED")))
      .returning({ id: handoffAttempts.id });
    if (!authorized[0]) {
      throw new AuthError(409, "ALREADY_AUTHORIZED", "Handoff was already authorized for this attempt.");
    }
    if (!canTransition("SWAP_CREATED", "AWAITING_NIM_APPROVAL")) {
      throw new AuthError(500, "LIFECYCLE_FORBIDDEN", "Transfer cannot advance to approval.");
    }
    await tx.update(transfers).set({ status: "AWAITING_NIM_APPROVAL", updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
    return {
      attemptId: attempt.id,
      invoiceBolt11: facts.bolt11Invoice,
      sourceSats: facts.sourceSats,
      authorizedAt: new Date().toISOString(),
    };
  });
}

/** Read-only resume contract: latest attempt + bound swap summary (no secrets). */
export async function getAttemptStatus(
  userId: string,
  transferId: string,
): Promise<{ attempt: AttemptView | null; swap: BoundSwapView | null; transferStatus: string }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const transfer = rows[0];
  if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  const attempts = await db
    .select()
    .from(handoffAttempts)
    .where(eq(handoffAttempts.transferId, transfer.id))
    .orderBy(desc(handoffAttempts.createdAt))
    .limit(1);
  const attempt = attempts[0] ?? null;
  let swap: BoundSwapView | null = null;
  if (attempt?.satoraSwapId) {
    const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    if (bound[0]) swap = toBoundView(bound[0]);
  }
  return {
    attempt: attempt ? toAttemptView(attempt) : null,
    swap,
    transferStatus: transfer.status,
  };
}

/** Purge helper for tests: remove attempts/attachments of a transfer. Never used by routes. */
export async function __deleteHandoffRecordsForTests(transferId: string): Promise<void> {
  const db = getDb();
  await db.delete(swapAttachments).where(eq(swapAttachments.transferId, transferId));
  await db.delete(handoffAttempts).where(eq(handoffAttempts.transferId, transferId));
}
