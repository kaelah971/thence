/**
 * Thence backend — read-only provider reconciliation + ambiguous-outcome
 * handling (B4.3).
 *
 * This module NEVER initiates payment, claims, or refunds. It reads the
 * provider's view of an already-bound swap (via the B4.2 read-only adapter),
 * persists safe observations, and advances the transfer along EXISTING
 * domain edges only — never inventing settlement.
 *
 * Trust model (verified against @satora/swap 1.7.2):
 * - Provider status progression for Lightning→EVM is:
 *   pending → clientfunded → serverfunded → clientredeemed → serverredeemed
 *   (plus refund/expired branches). Protocol order guarantees intermediates:
 *   a later milestone implies the earlier ones happened.
 * - `status`, invoice state and tx ids are provider ASSERTIONS. On-chain
 *   txids are independently verifiable chain evidence (B4.4's job, not
 *   asserted here). An expired invoice alone proves nothing about whether
 *   payment was initiated.
 * - Client reports are NOT payment proof. The client may only report
 *   cancelled-before-submit (verified against a pending provider state),
 *   initiated, or unknown. It can never report funded/claimed/delivered.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import {
  handoffAttempts,
  paymentRequests,
  reconciliationObservations,
  swapAttachments,
  transfers,
} from "@/db/schema";
import { canTransition, isTerminal, transition } from "@/domain/transfers";
import type { TransferStatus } from "@/domain/transfers";
import { getProviderSwap, resolveRoute } from "@/lib/satora";
import type { VerifiedSwapFacts } from "@/lib/satora";
import { lockTransfer } from "@/lib/handoff";

type Db = ReturnType<typeof getDb>;

const MAIN_LINE: TransferStatus[] = [
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
];

const REFUND_NEGATIVE = new Set([
  "clientrefunded",
  "clientinvalidfunded",
  "clientfundedtoolate",
  "serverwontfund",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
  "clientredeemedandclientrefunded",
]);

export type ReconcileDecision =
  | { action: "none"; reason: string }
  | { action: "advance"; path: TransferStatus[]; reason: string }
  | { action: "needs-attention"; path: TransferStatus[]; reason: string };

/**
 * Pure status-mapping: provider milestone → legal internal path.
 * Monotonic by construction (never regresses on stale observations);
 * unknown provider states produce no transition.
 */
export function planReconciliation(
  current: TransferStatus,
  providerStatus: string,
): ReconcileDecision {
  const walkMainLineFrom = (start: TransferStatus, target: TransferStatus): TransferStatus[] | null => {
    // Recoverability (B4.4 §9): funding/claim evidence observed while the
    // transfer sits in RECONCILING advances via its direct legal edges —
    // otherwise delayed funding is silently stranded.
    if (start === "RECONCILING") {
      return canTransition("RECONCILING", target) ? [target] : null;
    }
    const from = MAIN_LINE.indexOf(start);
    const to = MAIN_LINE.indexOf(target);
    if (from < 0 || to < 0 || to <= from) return to === from ? [] : null;
    const path: TransferStatus[] = [];
    for (let i = from + 1; i <= to; i++) {
      const prev = i === from + 1 ? start : (MAIN_LINE[i - 1] as TransferStatus);
      const next = MAIN_LINE[i] as TransferStatus;
      if (!canTransition(prev, next)) return null;
      path.push(next);
    }
    return path;
  };
  const walkMainLine = (target: TransferStatus): TransferStatus[] | null => {
    if (current === "OUTCOME_UNKNOWN") {
      if (!canTransition("OUTCOME_UNKNOWN", "RECONCILING")) return null;
      const rest = walkMainLineFrom("RECONCILING", target);
      return rest === null ? null : (["RECONCILING", ...rest] as TransferStatus[]);
    }
    return walkMainLineFrom(current, target);
  };
  const walkToNeedsAttention = (): TransferStatus[] | null => {
    if (current === "NEEDS_ATTENTION") return [];
    // Direct edge where the domain allows it (CLIENT_FUNDED, SERVER_FUNDED,
    // CLAIMING all reach NEEDS_ATTENTION in one step).
    if (canTransition(current, "NEEDS_ATTENTION")) return ["NEEDS_ATTENTION"];
    if (current === "RECONCILING") return ["NEEDS_ATTENTION"];
    if (current === "OUTCOME_UNKNOWN") return ["RECONCILING", "NEEDS_ATTENTION"];
    if (current === "LIGHTNING_HANDOFF") return ["OUTCOME_UNKNOWN", "RECONCILING", "NEEDS_ATTENTION"];
    if (current === "AWAITING_NIM_APPROVAL") return ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "NEEDS_ATTENTION"];
    return null;
  };

  if (providerStatus === "pending" || providerStatus === "clientfundingseen") {
    return { action: "none", reason: "No provider-confirmed milestone yet." };
  }
  if (providerStatus === "expired") {
    return { action: "none", reason: "Expiry alone establishes nothing about payment." };
  }
  if (REFUND_NEGATIVE.has(providerStatus)) {
    const path = walkToNeedsAttention();
    if (!path) return { action: "none", reason: "No legal attention path from current state." };
    return { action: "needs-attention", path, reason: `Provider reports ${providerStatus}.` };
  }
  if (providerStatus === "clientfunded") {
    const path = walkMainLine("CLIENT_FUNDED");
    if (path === null) return { action: "none", reason: "No legal forward path from current state." };
    return path.length === 0
      ? { action: "none", reason: "Already at or beyond funded." }
      : { action: "advance", path, reason: "Provider-confirmed client funding." };
  }
  if (providerStatus === "serverfunded") {
    const path = walkMainLine("SERVER_FUNDED");
    if (path === null) return { action: "none", reason: "No legal forward path from current state." };
    return path.length === 0
      ? { action: "none", reason: "Already at or beyond server-funded." }
      : { action: "advance", path, reason: "Provider-confirmed server funding." };
  }
  if (["clientredeeming", "clientredeemed", "serverredeemed"].includes(providerStatus)) {
    const path = walkMainLine("CLAIMING");
    if (path === null) return { action: "none", reason: "No legal forward path from current state." };
    return path.length === 0
      ? { action: "none", reason: "Already at or beyond claiming." }
      : { action: "advance", path, reason: "Provider-observed claim activity; destination proof still required." };
  }
  return { action: "none", reason: `Unknown provider status "${providerStatus}"; recorded without transition.` };
}

/** Claim-ready is evidence-backed and actionable — never a settlement claim. */
export function isClaimReady(transferStatus: TransferStatus, providerStatus: string): boolean {
  const funded = providerStatus === "serverfunded" || providerStatus === "clientredeeming" || providerStatus === "clientredeemed";
  return funded && (transferStatus === "SERVER_FUNDED" || transferStatus === "CLAIMING");
}

export interface ReconciliationBase {
  transferId: string;
  status: TransferStatus;
  statusLabel: string;
  providerStatus: string;
  observedAt: string;
  claimReady: boolean;
  ambiguous: boolean;
  ambiguityReasons: string[];
  invoiceExpired: boolean;
  unknownProviderState: boolean;
  lastError: string | null;
}

export interface ReconciliationSummary extends ReconciliationBase {
  advanced: boolean;
  advancedPath: TransferStatus[];
}

type DbClient = Pick<Db, "select" | "insert">;

async function recordObservation(
  db: DbClient,
  transferId: string,
  swapId: string,
  entry: {
    providerStatus: string;
    kind: "observation" | "provider_error" | "identity_mismatch";
    errorCode?: string;
    evmFundTxid?: string | null;
    evmClaimTxid?: string | null;
  },
): Promise<void> {
  await db.insert(reconciliationObservations).values({
    transferId,
    satoraSwapId: swapId,
    providerStatus: entry.providerStatus,
    kind: entry.kind,
    errorCode: entry.errorCode ?? null,
    evmFundTxid: entry.evmFundTxid ?? null,
    evmClaimTxid: entry.evmClaimTxid ?? null,
  });
}

/**
 * One bounded read-only refresh of the bound swap. Records the observation,
 * advances along legal edges only, never fails unknown outcomes.
 */
export async function reconcileTransfer(userId: string, transferId: string): Promise<ReconciliationSummary> {
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
    const bound = await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    const attachment = bound[0];
    // Observation requires something to observe; advancement is decided
    // purely by the state machine afterwards (terminal states no-op).
    if (!attachment) throw new AuthError(409, "NOT_RECONCILABLE", "No bound swap to observe.");
    const current = transfer.status as TransferStatus;

    let facts: VerifiedSwapFacts;
    try {
      const { getProviderSwap } = await import("@/lib/satora");
      facts = await getProviderSwap(attachment.satoraSwapId);
    } catch (err) {
      const code = err instanceof Error && (err as { code?: string }).code ? String((err as { code?: unknown }).code) : "PROVIDER_UNAVAILABLE";
      await recordObservation(tx, transfer.id, attachment.satoraSwapId, { providerStatus: "unknown", kind: "provider_error", errorCode: code });
      const summary = await buildSummary(tx, transfer.id);
      if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
      return { ...summary, lastError: code, advanced: false, advancedPath: [] };
    }
    // Identity revalidation on every read: never trust a drifting swap.
    const expected = {
      asset: transfer.targetAsset,
      network: transfer.targetNetwork,
      destination: transfer.destination,
      targetAmountAtomic: transfer.targetAmountAtomic,
    };
    if (
      facts.targetAtomic !== expected.targetAmountAtomic ||
      facts.targetAddress.toLowerCase() !== expected.destination.toLowerCase()
    ) {
      await recordObservation(tx, transfer.id, attachment.satoraSwapId, { providerStatus: facts.status || "unknown", kind: "identity_mismatch", errorCode: "SWAP_MISMATCH" });
      throw new AuthError(409, "SWAP_MISMATCH", "Provider swap no longer matches the bound transfer terms.");
    }
    // Chain/token identity revalidation against canonical config.
    try {
      const { resolveRoute } = await import("@/lib/satora");
      const resolved = await resolveRoute(expected.asset, expected.network);
      if (String(resolved.chainId) !== String(facts.evmChainId) || resolved.tokenAddress.toLowerCase() !== facts.targetTokenAddress.toLowerCase()) {
        await recordObservation(tx, transfer.id, attachment.satoraSwapId, { providerStatus: facts.status || "unknown", kind: "identity_mismatch", errorCode: "SWAP_MISMATCH" });
        throw new AuthError(409, "SWAP_MISMATCH", "Provider swap token identity does not match the route registry.");
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      await recordObservation(tx, transfer.id, attachment.satoraSwapId, { providerStatus: facts.status || "unknown", kind: "provider_error", errorCode: "PROVIDER_UNAVAILABLE" });
      const summary = await buildSummary(tx, transfer.id, { providerInvoiceExpiresAt: facts.invoiceExpiresAt });
      if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
      return { ...summary, lastError: "PROVIDER_UNAVAILABLE", advanced: false, advancedPath: [] };
    }

    const decision = planReconciliation(current, facts.status || "unknown");
    let advanced: TransferStatus[] = [];
    if (decision.action === "advance" || decision.action === "needs-attention") {
      let state = current;
      for (const next of decision.path) {
        state = transition(state, next);
        advanced.push(next);
      }
      const final = advanced[advanced.length - 1];
      if (final) {
        await tx.update(transfers).set({ status: final, updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
      }
    }
    await recordObservation(tx, transfer.id, attachment.satoraSwapId, {
      providerStatus: facts.status || "unknown",
      kind: "observation",
      evmFundTxid: facts.evmFundTxid ?? null,
      evmClaimTxid: facts.evmClaimTxid ?? null,
    });
    // Read inside the same transaction: the status advance and observation
    // above are uncommitted until return, so an outer-DB read would see
    // stale state (the TS2345-class bug: Db transaction vs database).
    const summary = await buildSummary(tx, transfer.id, {
      providerInvoiceExpiresAt: facts.invoiceExpiresAt,
    });
    if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    return { ...summary, advanced: advanced.length > 0, advancedPath: advanced };
  });
}

async function buildSummary(
  db: DbClient,
  transferId: string,
  opts?: { providerInvoiceExpiresAt?: Date | null },
): Promise<ReconciliationBase | null> {
  const { USER_FACING_LABEL } = await import("@/domain/transfers");
  const rows = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  const transfer = rows[0];
  if (!transfer) return null;
  const obs = await db
    .select()
    .from(reconciliationObservations)
    .where(eq(reconciliationObservations.transferId, transferId))
    .orderBy(desc(reconciliationObservations.observedAt))
    .limit(1);
  const latest = obs[0];
  const providerStatus = latest?.providerStatus ?? "unknown";
  // Expiry is ambiguous evidence: prefer the live provider view when present
  // (the bound row is a cached copy from attach time), else the stored row.
  const providerExpiry = opts?.providerInvoiceExpiresAt;
  const dbLive = await invoiceIsLive(db, transferId);
  const invoiceLive = providerExpiry instanceof Date ? providerExpiry.getTime() > Date.now() : dbLive;
  const unknownProviderState = !latest || (!!latest && !RECOGNIZED_STATUSES.has(latest.providerStatus) && latest.kind === "observation" && latest.providerStatus !== "unknown");
  const ambiguityReasons: string[] = [];
  if (invoiceLive === false) ambiguityReasons.push("Invoice expired; expiry alone does not establish whether payment was initiated.");
  if (unknownProviderState) ambiguityReasons.push("Provider reported an unrecognized state.");
  if (latest?.kind === "provider_error") ambiguityReasons.push(`Last provider read failed (${latest.errorCode ?? "unknown error"}).`);
  if (latest?.kind === "identity_mismatch") ambiguityReasons.push("Provider swap identity diverged from bound terms.");
  return {
    transferId: transfer.id,
    status: transfer.status as TransferStatus,
    statusLabel: USER_FACING_LABEL[transfer.status as TransferStatus] ?? transfer.status,
    providerStatus,
    observedAt: latest?.observedAt.toISOString() ?? transfer.updatedAt.toISOString(),
    claimReady: isClaimReady(transfer.status as TransferStatus, providerStatus),
    ambiguous: ambiguityReasons.length > 0,
    ambiguityReasons,
    invoiceExpired: invoiceLive === false,
    unknownProviderState,
    lastError: latest?.kind === "provider_error" ? (latest.errorCode ?? "PROVIDER_ERROR") : null,
  };
}

const RECOGNIZED_STATUSES = new Set([
  "pending",
  "clientfundingseen",
  "clientfunded",
  "serverfunded",
  "clientredeeming",
  "clientredeemed",
  "serverredeemed",
  "expired",
  "clientrefunded",
  "clientinvalidfunded",
  "clientfundedtoolate",
  "serverwontfund",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
  "clientredeemedandclientrefunded",
]);

async function invoiceIsLive(db: DbClient, transferId: string): Promise<boolean | null> {
  const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transferId)).limit(1);
  const attachment = bound[0];
  if (!attachment?.invoiceExpiresAt) return null;
  return attachment.invoiceExpiresAt.getTime() > Date.now();
}

export interface ResumeView {
  transfer: {
    id: string;
    status: TransferStatus;
    statusLabel: string;
    routeId: string;
    asset: string;
    network: string;
    destination: string;
    targetAmountAtomic: string;
  };
  attempt: { id: string; status: string; quoteRevision: number; handoffAuthorizedAt: string | null; expiresAt: string } | null;
  swap: {
    satoraSwapId: string;
    sourceSats: string;
    targetAtomic: string;
    paymentHash: string;
    invoiceBolt11: string;
    invoiceExpiresAt: string | null;
    providerStatus: string;
    verifiedAt: string;
  } | null;
  latest: ReconciliationBase;
}

/**
 * Reload/resume contract: same transfer, same attempt, same bound invoice.
 * Never creates anything; never authorizes anything.
 */
export async function getReconciliation(userId: string, transferId: string): Promise<ResumeView> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const transfer = rows[0];
  if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  const { getAttemptStatus } = await import("@/lib/handoff");
  const attemptView = await getAttemptStatus(userId, transferId);
  const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
  const attachment = bound[0] ?? null;
  const latest = await buildSummary(db, transfer.id);
  if (!latest) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  const { USER_FACING_LABEL } = await import("@/domain/transfers");
  return {
    transfer: {
      id: transfer.id,
      status: transfer.status as TransferStatus,
      statusLabel: USER_FACING_LABEL[transfer.status as TransferStatus] ?? transfer.status,
      routeId: transfer.routeId,
      asset: transfer.targetAsset,
      network: transfer.targetNetwork,
      destination: transfer.destination,
      targetAmountAtomic: transfer.targetAmountAtomic,
    },
    attempt: attemptView.attempt
      ? {
          id: attemptView.attempt.id,
          status: attemptView.attempt.status,
          quoteRevision: attemptView.attempt.quoteRevision,
          handoffAuthorizedAt: attemptView.attempt.handoffAuthorizedAt,
          expiresAt: attemptView.attempt.expiresAt,
        }
      : null,
    swap: attachment
      ? {
          satoraSwapId: attachment.satoraSwapId,
          sourceSats: attachment.sourceSats,
          targetAtomic: attachment.targetAtomic,
          paymentHash: attachment.paymentHash,
          invoiceBolt11: attachment.invoiceBolt11,
          invoiceExpiresAt: attachment.invoiceExpiresAt?.toISOString() ?? null,
          providerStatus: latest.providerStatus,
          verifiedAt: attachment.verifiedAt.toISOString(),
        }
      : null,
    latest,
  };
}

export const handoffOutcomeSchema = z.object({
  outcome: z.enum(["cancelled", "initiated", "unknown"]),
});

/**
 * Minimal client handoff-outcome report. Client claims are NEVER payment
 * proof: "cancelled" requires a provider state showing nothing funded,
 * "initiated"/"unknown" walk the existing unknown-outcome chain, and
 * funded/claimed/delivered/refunded reports are rejected outright.
 */
export async function reportHandoffOutcome(
  userId: string,
  transferId: string,
  body: unknown,
): Promise<{ transferId: string; status: TransferStatus; deduplicated: boolean }> {
  const parsed = handoffOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    const raw = (body as Record<string, unknown> | null)?.["outcome"];
    if (typeof raw === "string" && ["funded", "claimed", "delivered", "refunded", "paid", "success"].includes(raw.toLowerCase())) {
      throw new AuthError(400, "CLIENT_CANNOT_ATTEST", "Clients cannot report payment success; only provider evidence advances a transfer.");
    }
    throw new AuthError(400, "BAD_BODY", parsed.error.issues[0]?.message ?? "Invalid outcome.");
  }
  const outcome = parsed.data.outcome;
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
    const current = transfer.status as TransferStatus;
    const applyPath = async (path: TransferStatus[]): Promise<TransferStatus> => {
      let state = current;
      for (const next of path) {
        state = transition(state, next);
      }
      await tx.update(transfers).set({ status: state, updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
      return state;
    };
    if (outcome === "initiated") {
      if (current !== "AWAITING_NIM_APPROVAL") {
        if (current === "LIGHTNING_HANDOFF") return { transferId, status: current, deduplicated: true };
        throw new AuthError(409, "NOT_REPORTABLE", "Handoff initiation can only be reported while awaiting approval.");
      }
      const next = await applyPath(["LIGHTNING_HANDOFF"]);
      return { transferId, status: next, deduplicated: false };
    }
    if (outcome === "unknown") {
      if (current === "OUTCOME_UNKNOWN" || current === "RECONCILING") {
        return { transferId, status: current, deduplicated: true };
      }
      const start: TransferStatus[] =
        current === "AWAITING_NIM_APPROVAL"
          ? ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]
          : current === "LIGHTNING_HANDOFF"
            ? ["OUTCOME_UNKNOWN", "RECONCILING"]
            : [];
      if (start.length === 0) throw new AuthError(409, "NOT_REPORTABLE", "Unknown outcomes can only be reported for unresolved handoffs.");
      const next = await applyPath(start);
      return { transferId, status: next, deduplicated: false };
    }
    // outcome === "cancelled": only when NOTHING has moved, verified live.
    // Allowed from QUOTED (quoted but not yet bound) and SWAP_CREATED
    // (bound but not yet authorized). From AWAITING the invoice is payable
    // at any moment, so the report is routed to the reconcilable
    // unknown-outcome chain instead of terminal cancellation (B4.4).
    if (current !== "AWAITING_NIM_APPROVAL" && current !== "SWAP_CREATED" && current !== "QUOTED") {
      throw new AuthError(409, "NOT_CANCELLABLE", "Only a pre-handoff transfer can be reported cancelled.");
    }
    const bound = await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    const attachment = bound[0];
    if (!attachment) {
      // Nothing was ever bound: no provider swap can have moved funds for
      // this transfer, so cancellation is trivially safe.
      const next = await applyPath(["USER_CANCELLED"]);
      return { transferId, status: next, deduplicated: false };
    }
    // B4.4 cancellation safety: a hold invoice in provider state `pending`
    // proves nothing about whether the user already submitted payment — the
    // funding event may simply not be observed yet. Once the handoff is
    // authorized (AWAITING) the invoice is payable at any moment, so a
    // client cancel report must keep the transfer reconcilable instead of
    // entering terminal USER_CANCELLED, where delayed funding would be
    // unrecoverable. Truly unbound / never-authorized transfers (QUOTED, or
    // SWAP_CREATED below the authorization gate) keep terminal cancellation.
    if (current === "AWAITING_NIM_APPROVAL") {
      const next = await applyPath(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]);
      return { transferId, status: next, deduplicated: false };
    }
    let facts;
    try {
      const { getProviderSwap } = await import("@/lib/satora");
      facts = await getProviderSwap(attachment.satoraSwapId);
    } catch (err) {
      const code = err instanceof Error && (err as { code?: string }).code ? String((err as { code?: unknown }).code) : "PROVIDER_UNAVAILABLE";
      throw new AuthError(503, code, "Route provider is temporarily unavailable; cancellation cannot be verified.");
    }
    // Independent provider facts win over any local theory: observed or
    // possible movement (funding seen/funded/redeeming/redeemed, late or
    // ambiguous reads) never resolves to terminal cancellation. Quiescent
    // states (pending, or expired past any funding window) may proceed to
    // the invoice + authorization checks below.
    if (facts.status !== "pending" && facts.status !== "expired") {
      throw new AuthError(409, "NOT_CANCELLABLE", "Provider shows activity for this swap; cancellation is not safe — reconcile instead.");
    }
    if (!facts.invoiceExpiresAt || facts.invoiceExpiresAt.getTime() <= Date.now()) {
      // Causal no-funding proof for the ambiguous-invoice case only: Nimiq
      // Pay approval (and hence any invoice payment) requires a
      // HANDOFF_AUTHORIZED attempt, whose invoice the client only ever
      // shows at approval. When no such attempt ever existed for this
      // transfer, funding is impossible regardless of invoice ambiguity —
      // safe to retire with history preserved, no new payment.
      const authorized = await tx
        .select({ id: handoffAttempts.id })
        .from(handoffAttempts)
        .where(and(eq(handoffAttempts.transferId, transfer.id), eq(handoffAttempts.status, "HANDOFF_AUTHORIZED")))
        .limit(1);
      if (authorized.length === 0) {
        const next = await applyPath(["USER_CANCELLED"]);
        return { transferId, status: next, deduplicated: false };
      }
      throw new AuthError(409, "NOT_CANCELLABLE", "Invoice state is ambiguous; cancellation is not safe — reconcile instead.");
    }
    const next = await applyPath(["USER_CANCELLED"]);
    return { transferId, status: next, deduplicated: false };
  });
}
