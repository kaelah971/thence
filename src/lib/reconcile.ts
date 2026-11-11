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
 *   payment was initiated. Satora's terminal `expired` status is different:
 *   for Lightning swaps the SDK defines it as expired without funding;
 *   owner-close still rechecks identity, contradictory tx ids and prior
 *   funding observations before changing our local status.
 * - Client reports are NOT payment proof. The client may only request
 *   retirement (the server verifies pre-handoff or terminal expired evidence),
 *   initiated, or unknown. It can never report funded/claimed/delivered.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import {
  handoffAttempts,
  paymentRequests,
  reconciliationObservations,
  swapAttachments,
  transferProofs,
  transfers,
  users,
} from "@/db/schema";
import { canTransition, isTerminal, transition } from "@/domain/transfers";
import type { TransferStatus } from "@/domain/transfers";
import { getProviderSwap, resolveRoute, SatoraError } from "@/lib/satora";
import type { VerifiedSwapFacts } from "@/lib/satora";
import { lockTransfer } from "@/lib/handoff";
import { verifyHtlcFunding, verifyHtlcRefund, type HtlcFundingResult, type HtlcRefundResult } from "@/lib/settlement";
import { recordPath, recordTransition } from "@/lib/transitions";
import { claimActionAllowed, claimWindowAt, validateLocktime, type ClaimWindow } from "@/domain/claim-deadline";
import { getEnv } from "@/lib/env";
import {
  isNimiqSourceHashUnattributed,
  verifyNimiqSourceTransaction,
  type VerifiedNimiqSource,
} from "@/lib/nimiq-source";

type Db = ReturnType<typeof getDb>;
type TxLike = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAIN_LINE: TransferStatus[] = [
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
];

const REFUNDED_PROVIDER_STATUSES = new Set([
  "clientrefunded",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
  "clientredeemedandclientrefunded",
]);

const REFUND_NEGATIVE = new Set([
  ...REFUNDED_PROVIDER_STATUSES,
  "clientinvalidfunded",
  "clientfundedtoolate",
  "serverwontfund",
]);

export type ReconcileDecision =
  | { action: "none"; reason: string }
  | { action: "advance"; path: TransferStatus[]; reason: string }
  | { action: "needs-attention"; path: TransferStatus[]; reason: string }
  /**
   * P4: a terminal exit EXISTS but must never be applied by reconciliation
   * itself. Only the owner-initiated, evidence-gated resolution in
   * src/lib/expiry-resolution.ts may take it, after re-proving provider
   * identity, local history, Nimiq-side records and on-chain HTLC absence.
   */
  | { action: "evidence-gated-close"; path: TransferStatus[]; reason: string };

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
  const walkToRefunded = (): TransferStatus[] | null => {
    if (current === "REFUNDED") return [];
    if (canTransition(current, "REFUNDED")) return ["REFUNDED"];
    if (current === "OUTCOME_UNKNOWN") return ["RECONCILING", "REFUNDED"];
    if (current === "LIGHTNING_HANDOFF") return ["OUTCOME_UNKNOWN", "RECONCILING", "REFUNDED"];
    if (current === "AWAITING_NIM_APPROVAL") return ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "REFUNDED"];
    return null;
  };

  if (providerStatus === "pending" || providerStatus === "clientfundingseen") {
    return { action: "none", reason: "No provider-confirmed milestone yet." };
  }
  if (providerStatus === "expired" && current === "RECONCILING") {
    return {
      action: "evidence-gated-close",
      path: ["EXPIRED_UNFUNDED"],
      reason: "Provider swap expired; closing requires independent no-funding evidence (owner action).",
    };
  }
  if (providerStatus === "expired") {
    // Reconciliation is intentionally read-only with respect to terminal
    // retirement. The owner Close action performs the stricter identity and
    // no-funding proof before releasing this transfer's exposure.
    return { action: "none", reason: "Provider swap expired; no funding milestone to advance." };
  }
  if (REFUNDED_PROVIDER_STATUSES.has(providerStatus)) {
    const path = walkToRefunded();
    if (!path) return { action: "none", reason: "No legal refund path from current state." };
    return { action: "advance", path, reason: `Provider reports terminal refund ${providerStatus}.` };
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
  /** P2: Polygon claim deadline (Satora evm_refund_locktime), ISO; null when unknown. */
  claimDeadlineAt: string | null;
  /** P2: server-side window at read time (unknown/open/closing/unsafe/passed). */
  claimWindow: ClaimWindow;
  /** P2: the latest provider read diverged from the bound swap identity. */
  identityMismatch: boolean;
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
 * P6: identical observations within this window are not re-inserted (the
 * browser driver and the server cron may observe the same provider state
 * seconds apart). Transitions are ALWAYS accompanied by an observation.
 */
export const OBSERVATION_DEDUPE_MS = 60_000;

type BoundAttachment = typeof swapAttachments.$inferSelect;

/**
 * P6: everything learned from the network for one reconciliation, gathered
 * WITHOUT holding the transfer lock and without writing anything.
 */
type GatheredEvidence =
  | { kind: "provider_error"; code: string }
  | { kind: "route_error"; facts: VerifiedSwapFacts }
  | { kind: "route_mismatch"; facts: VerifiedSwapFacts }
  | { kind: "facts"; facts: VerifiedSwapFacts; refund: HtlcRefundResult | null };

async function gatherEvidence(
  transfer: typeof transfers.$inferSelect,
  attachment: BoundAttachment,
): Promise<GatheredEvidence> {
  let facts: VerifiedSwapFacts;
  try {
    facts = await getProviderSwap(attachment.satoraSwapId);
  } catch (err) {
    const code = err instanceof Error && (err as { code?: string }).code ? String((err as { code?: unknown }).code) : "PROVIDER_UNAVAILABLE";
    return { kind: "provider_error", code };
  }
  // Chain/token identity revalidation against canonical config.
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    if (String(resolved.chainId) !== String(facts.evmChainId) || resolved.tokenAddress.toLowerCase() !== facts.targetTokenAddress.toLowerCase()) {
      return { kind: "route_mismatch", facts };
    }
  } catch {
    return { kind: "route_error", facts };
  }
  // Independent refund evidence is read here (chain I/O), never under the lock.
  // P5: the provider's refund pointer is a hint only. The refund must be a
  // SwapRefunded event of the PINNED HTLC for the BOUND hash lock; a missing
  // or wrong pointer falls back to scanning the HTLC's own logs.
  let refund: HtlcRefundResult | null = null;
  const providerStatus = facts.status || "unknown";
  if (REFUNDED_PROVIDER_STATUSES.has(providerStatus) && transfer.status !== "REFUNDED") {
    const locktimeSec = facts.evmRefundLocktime ?? (attachment.evmRefundLocktime ? Math.floor(attachment.evmRefundLocktime.getTime() / 1000) : null);
    // On Arbitrum, re-check the bound fund receipt first. This independently
    // anchors the terms used to derive the v7 SwapKey before a refund event can
    // affect reconciliation; current provider terms alone are not sufficient.
    let funding: HtlcFundingResult | null = null;
    if (facts.evmChainId === 42161) {
      funding = locktimeSec === null
        ? { verdict: "INCONCLUSIVE", reason: "The Arbitrum funding deadline is unavailable.", confirmations: null }
        : await verifyHtlcFunding({
            chainId: facts.evmChainId,
            htlcAddress: facts.evmHtlcAddress,
            hashLock: attachment.paymentHash,
            fundTxHash: facts.evmFundTxid,
            expectedLocktimeSec: locktimeSec,
            expectedTokenAddress: facts.evmHtlcTokenAddress,
            expectedAmountAtomic: facts.evmHtlcAmountAtomic,
            expectedRefundAddress: facts.evmHtlcRefundAddress,
            expectedClaimAddress: facts.evmHtlcClaimAddress,
          });
    }
    refund = funding && funding.verdict !== "VERIFIED"
      ? { verdict: "INCONCLUSIVE", reason: `Arbitrum funding identity is not independently verified: ${funding.reason}`, confirmations: funding.confirmations, refundTxHash: null, source: null }
      : await verifyHtlcRefund({
          chainId: facts.evmChainId,
          htlcAddress: facts.evmHtlcAddress,
          hashLock: attachment.paymentHash,
          providerRefundTxHash: facts.evmClaimTxid,
          earliestRefundAt: locktimeSec !== null ? new Date(locktimeSec * 1000) : attachment.createdAt,
          expectedLocktimeSec: locktimeSec,
          expectedTokenAddress: facts.evmHtlcTokenAddress,
          expectedAmountAtomic: facts.evmHtlcAmountAtomic,
          expectedRefundAddress: facts.evmHtlcRefundAddress,
          expectedClaimAddress: facts.evmHtlcClaimAddress,
        });
  }
  return { kind: "facts", facts, refund };
}

/** Identity of the provider swap vs the bound attachment and transfer terms. */
function identityMatches(transfer: typeof transfers.$inferSelect, attachment: BoundAttachment, facts: VerifiedSwapFacts): boolean {
  // P2: the claim deadline is part of the swap identity once known.
  const storedLocktimeSec = attachment.evmRefundLocktime ? Math.floor(attachment.evmRefundLocktime.getTime() / 1000) : null;
  const locktimeChanged = storedLocktimeSec !== null && facts.evmRefundLocktime !== null && facts.evmRefundLocktime !== storedLocktimeSec;
  return !(
    facts.satoraSwapId !== attachment.satoraSwapId ||
    facts.direction !== "lightning_to_evm" ||
    facts.targetAtomic !== transfer.targetAmountAtomic ||
    facts.targetAddress.toLowerCase() !== transfer.destination.toLowerCase() ||
    facts.paymentHash.toLowerCase() !== attachment.paymentHash.toLowerCase() ||
    locktimeChanged
  );
}

/** Insert an observation unless an identical one was recorded moments ago (P6 dedupe). */
async function recordObservationDeduped(
  db: DbClient,
  transferId: string,
  swapId: string,
  entry: Parameters<typeof recordObservation>[3],
  force: boolean,
): Promise<boolean> {
  if (!force) {
    const latest = await db
      .select()
      .from(reconciliationObservations)
      .where(eq(reconciliationObservations.transferId, transferId))
      .orderBy(desc(reconciliationObservations.observedAt))
      .limit(1);
    const last = latest[0];
    if (
      last &&
      Date.now() - last.observedAt.getTime() < OBSERVATION_DEDUPE_MS &&
      last.providerStatus === entry.providerStatus &&
      last.kind === entry.kind &&
      (last.errorCode ?? null) === (entry.errorCode ?? null) &&
      (last.evmFundTxid ?? null) === (entry.evmFundTxid ?? null) &&
      (last.evmClaimTxid ?? null) === (entry.evmClaimTxid ?? null)
    ) {
      return false;
    }
  }
  await recordObservation(db, transferId, swapId, entry);
  return true;
}

export interface ReconcileActor {
  /** "owner" = session request; "system" = server cron (no session). */
  kind: "owner" | "system";
  /** Owner scope for session requests; null for the system reconciler. */
  ownerUserId: string | null;
}

/**
 * P6: the ONE reconciliation core, shared by the owner route (P1 browser
 * driver) and the server cron. Phase A gathers network evidence with no lock
 * and no writes; phase B commits under the per-transfer advisory lock,
 * re-reading state, re-running identity checks against the fresh
 * attachment, and planning from the CURRENT status — so concurrent callers
 * converge (the second sees an empty path) and never double-transition.
 * Never claims, refunds, pays, creates swaps, or applies P4's owner close.
 */
export async function reconcileCore(transferId: string, actor: ReconcileActor): Promise<ReconciliationSummary> {
  const db = getDb();
  const scope = actor.ownerUserId
    ? and(eq(transfers.id, transferId), eq(transfers.ownerUserId, actor.ownerUserId))
    : eq(transfers.id, transferId);

  // ---- Phase A: read + network, no lock ----
  const rows = await db.select().from(transfers).where(scope).limit(1);
  const initial = rows[0];
  if (!initial) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, initial.id)).limit(1);
  const initialAttachment = bound[0];
  // Observation requires something to observe; advancement is decided
  // purely by the state machine afterwards (terminal states no-op).
  if (!initialAttachment) throw new AuthError(409, "NOT_RECONCILABLE", "No bound swap to observe.");
  const evidence = await gatherEvidence(initial, initialAttachment);

  // ---- Phase B: short commit under the per-transfer lock ----
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const fresh = await tx.select().from(transfers).where(scope).limit(1);
    const transfer = fresh[0];
    if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    const boundNow = await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    const attachment = boundNow[0];
    if (!attachment || attachment.satoraSwapId !== initialAttachment.satoraSwapId) {
      throw new AuthError(409, "NOT_RECONCILABLE", "The bound swap changed during reconciliation.");
    }
    const current = transfer.status as TransferStatus;

    if (evidence.kind === "provider_error") {
      await recordObservationDeduped(tx, transfer.id, attachment.satoraSwapId, { providerStatus: "unknown", kind: "provider_error", errorCode: evidence.code }, false);
      const summary = await buildSummary(tx, transfer.id);
      if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
      return { ...summary, lastError: evidence.code, advanced: false, advancedPath: [] };
    }
    const facts = evidence.facts;
    // Identity revalidation on every read: never trust a drifting swap. The
    // mismatch observation must be DURABLE (it gates claim readiness and P4
    // closure), so the committed summary is returned; the route answers 409.
    if (!identityMatches(transfer, attachment, facts) || evidence.kind === "route_mismatch") {
      await recordObservationDeduped(tx, transfer.id, attachment.satoraSwapId, { providerStatus: facts.status || "unknown", kind: "identity_mismatch", errorCode: "SWAP_MISMATCH" }, false);
      return await mismatchSummary(tx, transfer.id);
    }
    if (evidence.kind === "route_error") {
      await recordObservationDeduped(tx, transfer.id, attachment.satoraSwapId, { providerStatus: facts.status || "unknown", kind: "provider_error", errorCode: "PROVIDER_UNAVAILABLE" }, false);
      const summary = await buildSummary(tx, transfer.id, { providerInvoiceExpiresAt: facts.invoiceExpiresAt });
      if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
      return { ...summary, lastError: "PROVIDER_UNAVAILABLE", advanced: false, advancedPath: [] };
    }

    // P2 backfill: rows bound before P2 lack the deadline. Persisted only
    // here, AFTER the full identity + route verification above, and only
    // when plausible relative to the original bind time.
    const storedLocktimeSec = attachment.evmRefundLocktime ? Math.floor(attachment.evmRefundLocktime.getTime() / 1000) : null;
    if (storedLocktimeSec === null && facts.evmRefundLocktime !== null) {
      const validated = validateLocktime(facts.evmRefundLocktime, attachment.createdAt.getTime(), attachment.invoiceExpiresAt);
      if (validated instanceof Date) {
        await tx.update(swapAttachments).set({ evmRefundLocktime: validated }).where(eq(swapAttachments.id, attachment.id));
      }
    }

    const providerStatus = facts.status || "unknown";
    if (REFUNDED_PROVIDER_STATUSES.has(providerStatus) && current !== "REFUNDED") {
      const verdict = evidence.refund?.verdict ?? "INCONCLUSIVE";
      if (verdict !== "VERIFIED") {
        const errorCode = `REFUND_${verdict}`;
        await recordObservationDeduped(
          tx,
          transfer.id,
          attachment.satoraSwapId,
          { providerStatus, kind: "provider_error", errorCode, evmFundTxid: facts.evmFundTxid ?? null, evmClaimTxid: facts.evmClaimTxid ?? null },
          false,
        );
        const summary = await buildSummary(tx, transfer.id, { providerInvoiceExpiresAt: facts.invoiceExpiresAt });
        if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
        return { ...summary, lastError: errorCode, advanced: false, advancedPath: [] };
      }
    }

    // Planned from the CURRENT (locked) status: a concurrent reconciliation
    // that already advanced makes this path empty — no double transition.
    const decision = planReconciliation(current, providerStatus);
    const advanced: TransferStatus[] = [];
    if (decision.action === "advance" || decision.action === "needs-attention") {
      let state = current;
      for (const next of decision.path) {
        state = transition(state, next);
        advanced.push(next);
      }
      const final = advanced[advanced.length - 1];
      if (final) {
        await tx.update(transfers).set({ status: final, updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
        // P4 audit: same transaction as the status write.
        await recordPath(
          tx,
          {
            transferId: transfer.id,
            actor: "reconciler",
            actorUserId: actor.ownerUserId,
            reasonCode: `PROVIDER_${providerStatus.toUpperCase()}`,
            evidence: {
              providerStatus,
              decision: decision.action,
              trigger: actor.kind === "system" ? "server-cron" : "owner-session",
              evmFundTxid: facts.evmFundTxid ?? null,
              evmClaimTxid: facts.evmClaimTxid ?? null,
              refundVerified: REFUNDED_PROVIDER_STATUSES.has(providerStatus) ? true : null,
              ...(REFUNDED_PROVIDER_STATUSES.has(providerStatus) && evidence.refund
                ? {
                    // EVM-side only: the provider's lock went back to the
                    // provider. Nimiq Pay's NIM side is not observable by Thence.
                    refundScope: facts.evmChainId === 137 ? "polygon_htlc" : "arbitrum_htlc",
                    refundTxHash: evidence.refund.refundTxHash,
                    refundEvidenceSource: evidence.refund.source,
                    refundConfirmations: evidence.refund.confirmations,
                    nimiqSideRefund: "not_observable",
                  }
                : {}),
            },
          },
          current,
          advanced,
        );
      }
    }
    await recordObservationDeduped(
      tx,
      transfer.id,
      attachment.satoraSwapId,
      { providerStatus, kind: "observation", evmFundTxid: facts.evmFundTxid ?? null, evmClaimTxid: facts.evmClaimTxid ?? null },
      advanced.length > 0,
    );
    // Read inside the same transaction: the status advance and observation
    // above are uncommitted until return.
    const summary = await buildSummary(tx, transfer.id, { providerInvoiceExpiresAt: facts.invoiceExpiresAt });
    if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    return { ...summary, advanced: advanced.length > 0, advancedPath: advanced };
  });
}

/**
 * One bounded read-only refresh of the bound swap for its owner (session).
 * Records the observation, advances along legal edges only, never fails
 * unknown outcomes.
 */
export async function reconcileTransfer(userId: string, transferId: string): Promise<ReconciliationSummary> {
  return reconcileCore(transferId, { kind: "owner", ownerUserId: userId });
}

/** Committed summary after a recorded identity mismatch (no transition). */
async function mismatchSummary(db: DbClient, transferId: string): Promise<ReconciliationSummary> {
  const summary = await buildSummary(db, transferId);
  if (!summary) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  return { ...summary, lastError: "SWAP_MISMATCH", advanced: false, advancedPath: [] };
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
  const boundRows = await db.select({ evmRefundLocktime: swapAttachments.evmRefundLocktime }).from(swapAttachments).where(eq(swapAttachments.transferId, transferId)).limit(1);
  const claimDeadline = boundRows[0]?.evmRefundLocktime ?? null;
  const claimWindow = claimWindowAt(claimDeadline ? claimDeadline.getTime() : null, Date.now());
  const identityMismatch = latest?.kind === "identity_mismatch";
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
    claimReady: claimReadyNow({ transferStatus: transfer.status as TransferStatus, providerStatus, latestKind: latest?.kind ?? null, claimWindow }),
    ambiguous: ambiguityReasons.length > 0,
    ambiguityReasons,
    invoiceExpired: invoiceLive === false,
    unknownProviderState,
    lastError: latest?.kind === "provider_error" ? (latest.errorCode ?? "PROVIDER_ERROR") : null,
    claimDeadlineAt: claimDeadline ? claimDeadline.toISOString() : null,
    claimWindow,
    identityMismatch,
  };
}

/**
 * P2: claim-ready right now. Funded (isClaimReady) AND the latest provider
 * read is a clean observation (never after an identity mismatch or a failed
 * read) AND the deadline window still allows a claim. An UNKNOWN deadline
 * stays claim-ready server-side for recovery visibility, but every client
 * claim action requires a known, open window (fail closed).
 */
export function claimReadyNow(input: {
  transferStatus: TransferStatus;
  providerStatus: string;
  latestKind: string | null;
  claimWindow: ClaimWindow;
}): boolean {
  if (!isClaimReady(input.transferStatus, input.providerStatus)) return false;
  if (input.latestKind !== "observation") return false;
  return input.claimWindow === "unknown" || claimActionAllowed(input.claimWindow);
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
    /** P2: Polygon claim deadline (Satora evm_refund_locktime), ISO; null when unknown. */
    claimDeadline: string | null;
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
          claimDeadline: attachment.evmRefundLocktime?.toISOString() ?? null,
          providerStatus: latest.providerStatus,
          verifiedAt: attachment.verifiedAt.toISOString(),
        }
      : null,
    latest,
  };
}

/**
 * Fresh provider evidence without reconciliation side effects. This is an
 * operator/read-only diagnostic: it never records an observation, advances a
 * transfer, or returns invoices, hashes, swap ids, addresses, or tokens.
 */
export async function readBoundProviderEvidence(
  userId: string,
  transferId: string,
): Promise<{
  transferId: string;
  transferStatus: string;
  providerStatus: string;
  invoiceExpired: boolean;
  invoiceExpiresAt: string | null;
  sourceSats: string;
  targetAtomic: string;
  identityMatch: boolean;
  hasEvmFundingTx: boolean;
  hasEvmClaimTx: boolean;
  observedAt: string;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const transfer = rows[0];
  if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
  const attachment = bound[0];
  if (!attachment) throw new AuthError(409, "NOT_RECONCILABLE", "No bound swap to inspect.");

  let facts: VerifiedSwapFacts;
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

  let identityMatch =
    facts.satoraSwapId === attachment.satoraSwapId &&
    facts.direction === "lightning_to_evm" &&
    facts.targetAtomic === transfer.targetAmountAtomic &&
    facts.targetAddress.toLowerCase() === transfer.destination.toLowerCase();
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    identityMatch =
      identityMatch &&
      String(resolved.chainId) === String(facts.evmChainId) &&
      resolved.tokenAddress.toLowerCase() === facts.targetTokenAddress.toLowerCase();
  } catch {
    identityMatch = false;
  }
  const invoiceExpiresAt = facts.invoiceExpiresAt?.toISOString() ?? null;
  return {
    transferId,
    transferStatus: transfer.status,
    providerStatus: facts.status || "unknown",
    invoiceExpired: !facts.invoiceExpiresAt || facts.invoiceExpiresAt.getTime() <= Date.now(),
    invoiceExpiresAt,
    sourceSats: facts.sourceSats,
    targetAtomic: facts.targetAtomic,
    identityMatch,
    hasEvmFundingTx: facts.evmFundTxid !== null,
    hasEvmClaimTx: facts.evmClaimTxid !== null,
    observedAt: new Date().toISOString(),
  };
}

const MOVEMENT_STATUSES = [
  "clientfundingseen",
  "clientfunded",
  "serverfunded",
  "clientredeeming",
  "clientredeemed",
  "serverredeemed",
  "clientrefunded",
  "clientinvalidfunded",
  "clientfundedtoolate",
  "serverwontfund",
  "clientfundedserverrefunded",
  "clientrefundedserverfunded",
  "clientrefundedserverrefunded",
  "clientredeemedandclientrefunded",
] as const;

/**
 * Satora 1.7.2 defines `expired` as a terminal Lightning swap outcome:
 * "expired without funding — nothing was locked." This helper is deliberately
 * narrower than that protocol statement because it is used to retire a local
 * owner-visible transfer. Any identity mismatch, transaction assertion or
 * prior movement observation fails closed. Pure (no I/O): the provider read
 * happens before the lock, the movement history is read under it (P5).
 */
function isExpiredUnfunded(
  transfer: typeof transfers.$inferSelect,
  attachment: typeof swapAttachments.$inferSelect,
  facts: VerifiedSwapFacts,
  routeMatches: boolean,
): boolean {
  return (
    routeMatches &&
    facts.satoraSwapId === attachment.satoraSwapId &&
    facts.status === "expired" &&
    facts.direction === "lightning_to_evm" &&
    facts.evmFundTxid === null &&
    facts.evmClaimTxid === null &&
    facts.targetAtomic === transfer.targetAmountAtomic &&
    facts.targetAddress.trim().toLowerCase() === transfer.destination.trim().toLowerCase() &&
    !(facts.invoiceExpiresAt !== null && facts.invoiceExpiresAt.getTime() > Date.now())
  );
}

async function hasPriorMovement(db: DbClient, transferId: string): Promise<boolean> {
  const priorMovement = await db
    .select({ id: reconciliationObservations.id })
    .from(reconciliationObservations)
    .where(and(eq(reconciliationObservations.transferId, transferId), inArray(reconciliationObservations.providerStatus, [...MOVEMENT_STATUSES])))
    .limit(1);
  return priorMovement.length > 0;
}

const SOURCE_TX_HASH_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

function normalizeSourceTxHash(value: string | undefined): string | null {
  if (!value || !SOURCE_TX_HASH_RE.test(value)) return null;
  return value.replace(/^0x/i, "").toLowerCase();
}

type SourceEvidenceRead = {
  transactionHash: string;
  evidence: VerifiedNimiqSource | null;
  failureCode: string | null;
};

/**
 * Read-only source evidence for a host-returned hash. The host hash is a
 * hint only; the trusted Nimiq node and the bound Satora payment hash decide
 * whether it becomes evidence. Failure never blocks the ordinary handoff
 * outcome or advances payment state.
 */
async function gatherNimiqSourceEvidence(
  userId: string,
  transferId: string,
  sourceTxHash: string | undefined,
): Promise<SourceEvidenceRead | null> {
  const transactionHash = normalizeSourceTxHash(sourceTxHash);
  if (!transactionHash) return null;
  try {
    const db = getDb();
    const transferRows = await db
      .select({ ownerUserId: transfers.ownerUserId })
      .from(transfers)
      .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
      .limit(1);
    if (!transferRows[0]) return { transactionHash, evidence: null, failureCode: "NOT_FOUND" };
    const ownerRows = await db.select({ nimiqAddress: users.nimiqAddress }).from(users).where(eq(users.id, userId)).limit(1);
    const ownerAddress = ownerRows[0]?.nimiqAddress;
    const attachment = (await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transferId)).limit(1))[0];
    if (!ownerAddress || !attachment) return { transactionHash, evidence: null, failureCode: "SOURCE_BINDING_UNAVAILABLE" };

    const env = getEnv();
    // The payment hash is taken from the server-verified attachment, never
    // from the host's swapId/hash result or a fresh provider response. This
    // keeps the source-to-transfer binding stable across provider drift.
    const verified = await verifyNimiqSourceTransaction({
      txHash: transactionHash,
      ownerAddress,
      lightningPaymentHash: attachment.paymentHash,
      config: {
        url: env.THENCE_NIMIQ_PROOF_RPC_URL,
        network: env.THENCE_NIMIQ_NETWORK,
        minConfirmations: env.THENCE_NIMIQ_PROOF_MIN_CONFIRMATIONS,
      },
    });
    return verified.ok
      ? { transactionHash, evidence: verified.evidence, failureCode: null }
      : { transactionHash, evidence: null, failureCode: verified.code };
  } catch {
    // Source proof is additive observability. An invalid/missing proof config
    // must not turn a successful native handoff report into a payment error.
    return { transactionHash, evidence: null, failureCode: "SOURCE_VERIFICATION_UNAVAILABLE" };
  }
}

function sourceAuditEvidence(source: SourceEvidenceRead | null): Record<string, unknown> {
  if (!source) return {};
  if (!source.evidence) {
    return {
      nimiqSourceVerification: "UNVERIFIED",
      nimiqSourceTxHash: source.transactionHash,
      nimiqSourceFailure: source.failureCode,
    };
  }
  return {
    nimiqSourceVerification: "VERIFIED",
    nimiqSourceTxHash: source.evidence.transactionHash,
    nimiqSourceSenderAddress: source.evidence.senderAddress,
    nimiqSourceOwnerAddress: source.evidence.ownerAddress,
    nimiqSourceSenderBinding: source.evidence.senderBinding,
    nimiqSourceAmountLuna: source.evidence.amountLuna,
    nimiqSourceFeeLuna: source.evidence.feeLuna,
    nimiqSourceTotalDebitLuna: source.evidence.totalDebitLuna,
    nimiqSourceBlockNumber: source.evidence.blockNumber,
    nimiqSourceConfirmations: source.evidence.confirmations,
    nimiqSourceFinalizedByMacroBlock: source.evidence.finalizedByMacroBlock,
    nimiqSourceNetwork: source.evidence.network,
    nimiqSourceVerifiedAt: source.evidence.verifiedAt,
  };
}

/** Store only the host hash as a conservative hint; it is never source proof. */
async function persistNimiqSourceHint(tx: TxLike, transferId: string, sourceTxHash: string): Promise<boolean> {
  const existing = await tx
    .select({ nimiqTxHash: transferProofs.nimiqTxHash })
    .from(transferProofs)
    .where(eq(transferProofs.transferId, transferId))
    .limit(1);
  const rawCurrent = existing[0]?.nimiqTxHash?.trim() ?? null;
  const current = rawCurrent ? normalizeSourceTxHash(rawCurrent) : null;
  if (rawCurrent !== null && current !== sourceTxHash) return false;
  await tx
    .insert(transferProofs)
    .values({ transferId, nimiqTxHash: sourceTxHash })
    .onConflictDoUpdate({ target: transferProofs.transferId, set: { nimiqTxHash: sourceTxHash } });
  return true;
}

async function bindVerifiedNimiqSource(tx: TxLike, transferId: string, evidence: VerifiedNimiqSource): Promise<boolean> {
  // Advisory locking closes the check-then-write race because the schema must
  // remain unchanged for this additive proof path.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`nimiq-source:${evidence.transactionHash}`}))`);
  const owners = await tx
    .select({ transferId: transferProofs.transferId, nimiqTxHash: transferProofs.nimiqTxHash })
    .from(transferProofs)
    .where(isNotNull(transferProofs.nimiqTxHash));
  if (
    !isNimiqSourceHashUnattributed(
      evidence.transactionHash,
      transferId,
      owners.map((row) => ({ transferId: row.transferId, transactionHash: row.nimiqTxHash })),
    )
  ) {
    return false;
  }
  return persistNimiqSourceHint(tx, transferId, evidence.transactionHash);
}

/** P5: cancellation evidence is gathered with no lock held and no writes. */
type CancelEvidence = {
  /** Transfer status the evidence was gathered for (commit requires it unchanged). */
  forStatus: TransferStatus;
  swapId: string;
  gatheredAt: number;
  read: { kind: "facts"; facts: VerifiedSwapFacts; routeMatches: boolean } | { kind: "error"; code: string };
};

/** Evidence older than this at commit time is refused (the client re-reads and retries). */
export const CANCEL_EVIDENCE_MAX_AGE_MS = 2 * 60_000;

async function gatherCancelEvidence(
  transfer: typeof transfers.$inferSelect,
  attachment: typeof swapAttachments.$inferSelect,
): Promise<CancelEvidence> {
  const base = { forStatus: transfer.status as TransferStatus, swapId: attachment.satoraSwapId };
  let facts: VerifiedSwapFacts;
  try {
    facts = await getProviderSwap(attachment.satoraSwapId);
  } catch (err) {
    const code = err instanceof Error && (err as { code?: string }).code ? String((err as { code?: unknown }).code) : "PROVIDER_UNAVAILABLE";
    return { ...base, gatheredAt: Date.now(), read: { kind: "error", code } };
  }
  let routeMatches = false;
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    routeMatches = String(resolved.chainId) === String(facts.evmChainId) && resolved.tokenAddress.toLowerCase() === facts.targetTokenAddress.toLowerCase();
  } catch {
    routeMatches = false;
  }
  return { ...base, gatheredAt: Date.now(), read: { kind: "facts", facts, routeMatches } };
}

const handoffDiagnosticsSchema = z
  .object({
    providerErrorType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
    providerErrorCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
    durationMs: z.number().int().min(0).max(180_000),
    normalizedOutcome: z.enum(["cancelled", "initiated", "unknown"]),
    hasHash: z.boolean(),
    hasSwapId: z.boolean(),
  })
  .strict();

export const handoffOutcomeSchema = z
  .object({
    outcome: z.enum(["cancelled", "initiated", "unknown"]),
    // Client diagnostics are observability only. They never participate in
    // transition decisions or prove funding/settlement.
    diagnostics: handoffDiagnosticsSchema.optional(),
    /** Host-returned Nimiq hash; server treats it as an untrusted hint. */
    sourceTxHash: z.string().regex(SOURCE_TX_HASH_RE, "sourceTxHash must be a 32-byte hex hash.").optional(),
  })
  .strict()
  .refine((value) => value.diagnostics === undefined || value.diagnostics.normalizedOutcome === value.outcome, {
    path: ["diagnostics", "normalizedOutcome"],
    message: "Diagnostics outcome must match the reported outcome.",
  })
  .refine((value) => value.outcome !== "cancelled" || value.sourceTxHash === undefined, {
    path: ["sourceTxHash"],
    message: "A cancelled handoff cannot include a source transaction hint.",
  });

/**
 * Minimal client handoff-outcome report. Client claims are NEVER payment
 * proof: "cancelled" requires server-verified pre-handoff or terminal expired
 * evidence, "initiated"/"unknown" walk the existing unknown-outcome chain,
 * and funded/claimed/delivered/refunded reports are rejected outright.
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
  const sourceHintHash = normalizeSourceTxHash(parsed.data.sourceTxHash);
  // Source verification is best-effort and read-only. It can never make the
  // handoff report fail or advance payment state by itself.
  const sourceRead = sourceHintHash ? await gatherNimiqSourceEvidence(userId, transferId, sourceHintHash) : null;
  const db = getDb();
  const ownerScope = and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId));

  // ---- P5 phase A: provider evidence for cancellation, no lock, no writes ----
  // Only cancelling a bound, pre-handoff transfer needs the network;
  // initiated/unknown reports are pure state-machine steps.
  let gathered: CancelEvidence | null = null;
  if (outcome === "cancelled") {
    const pre = (await db.select().from(transfers).where(ownerScope).limit(1))[0];
    if (!pre) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    if (pre.status === "AWAITING_NIM_APPROVAL" || pre.status === "SWAP_CREATED") {
      const preBound = (await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, pre.id)).limit(1))[0];
      if (preBound) gathered = await gatherCancelEvidence(pre, preBound);
    }
  }

  // ---- phase B: short commit under the per-transfer lock ----
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const rows = await tx.select().from(transfers).where(ownerScope).limit(1);
    const transfer = rows[0];
    if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    let sourceForAudit: SourceEvidenceRead | null = null;
    const acceptSourceEvidence = async (): Promise<void> => {
      sourceForAudit = sourceRead;
      if (!sourceHintHash) return;
      if (sourceRead?.evidence) {
        const bound = await bindVerifiedNimiqSource(tx, transfer.id, sourceRead.evidence);
        if (!bound) {
          sourceForAudit = { ...sourceRead, evidence: null, failureCode: "DUPLICATE_SOURCE_TRANSACTION" };
        }
      } else {
        await persistNimiqSourceHint(tx, transfer.id, sourceHintHash);
      }
    };
    const current = transfer.status as TransferStatus;
    const recordLateSourceEvidence = async (): Promise<void> => {
      if (!sourceForAudit) return;
      await recordTransition(tx, {
        transferId: transfer.id,
        from: current,
        to: current,
        actor: "owner",
        actorUserId: userId,
        reasonCode: "SOURCE_EVIDENCE_RECORDED",
        evidence: { clientOutcome: outcome, ...sourceAuditEvidence(sourceForAudit) },
      });
    };
    // P5: every status change is audited in this same transaction.
    const applyPath = async (path: TransferStatus[], reasonCode: string, evidence: Record<string, unknown> = {}): Promise<TransferStatus> => {
      let state = current;
      for (const next of path) {
        state = transition(state, next);
      }
      await tx.update(transfers).set({ status: state, updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
      await recordPath(
        tx,
        {
          transferId: transfer.id,
          actor: "owner",
          actorUserId: userId,
          reasonCode,
          evidence: { clientOutcome: outcome, ...evidence, ...sourceAuditEvidence(sourceForAudit) },
        },
        current,
        path,
      );
      return state;
    };
    if (outcome === "initiated") {
      if (current !== "AWAITING_NIM_APPROVAL") {
        if (current === "LIGHTNING_HANDOFF") {
          await acceptSourceEvidence();
          await recordLateSourceEvidence();
          return { transferId, status: current, deduplicated: true };
        }
        throw new AuthError(409, "NOT_REPORTABLE", "Handoff initiation can only be reported while awaiting approval.");
      }
      await acceptSourceEvidence();
      const next = await applyPath(["LIGHTNING_HANDOFF"], "CLIENT_REPORTED_INITIATED");
      return { transferId, status: next, deduplicated: false };
    }
    if (outcome === "unknown") {
      if (current === "OUTCOME_UNKNOWN" || current === "RECONCILING") {
        await acceptSourceEvidence();
        await recordLateSourceEvidence();
        return { transferId, status: current, deduplicated: true };
      }
      const start: TransferStatus[] =
        current === "AWAITING_NIM_APPROVAL"
          ? ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]
          : current === "LIGHTNING_HANDOFF"
            ? ["OUTCOME_UNKNOWN", "RECONCILING"]
            : [];
      if (start.length === 0) throw new AuthError(409, "NOT_REPORTABLE", "Unknown outcomes can only be reported for unresolved handoffs.");
      await acceptSourceEvidence();
      const next = await applyPath(start, "CLIENT_REPORTED_UNKNOWN");
      return { transferId, status: next, deduplicated: false };
    }
    // outcome === "cancelled": only when NOTHING has moved, verified live.
    // QUOTED is trivially safe; SWAP_CREATED is checked against the provider
    // and authorization history below. AWAITING may close only through the
    // fresh Satora `expired` proof below; otherwise it is routed to the
    // reconcilable unknown-outcome chain (B4.4).
    if (current !== "AWAITING_NIM_APPROVAL" && current !== "SWAP_CREATED" && current !== "QUOTED") {
      throw new AuthError(409, "NOT_CANCELLABLE", "Only a pre-handoff transfer can be reported cancelled.");
    }
    const bound = await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    const attachment = bound[0];
    if (!attachment) {
      // Nothing was ever bound: no provider swap can have moved funds for
      // this transfer, so cancellation is trivially safe.
      const next = await applyPath(["USER_CANCELLED"], "CANCELLED_UNBOUND");
      return { transferId, status: next, deduplicated: false };
    }
    // P5: the evidence must describe THIS state and THIS swap, and be fresh.
    // A concurrent attach/authorize/report between the phases means the
    // evidence answers a different question: refuse; the client re-reads.
    if (
      !gathered ||
      gathered.forStatus !== current ||
      gathered.swapId !== attachment.satoraSwapId ||
      Date.now() - gathered.gatheredAt > CANCEL_EVIDENCE_MAX_AGE_MS
    ) {
      throw new AuthError(409, "VERSION_CONFLICT", "The payment changed while it was being checked; re-read it before cancelling.");
    }
    const read = gathered.read;
    // B4.4 cancellation safety: a hold invoice in provider state `pending`
    // proves nothing about whether the user already submitted payment — the
    // funding event may simply not be observed yet. Once the handoff is
    // authorized (AWAITING), only a fresh, identity-matched Satora `expired`
    // result can close it. All other reads keep the transfer reconcilable
    // instead of entering terminal USER_CANCELLED, where delayed funding
    // would be unrecoverable.
    if (current === "AWAITING_NIM_APPROVAL") {
      if (read.kind === "facts" && isExpiredUnfunded(transfer, attachment, read.facts, read.routeMatches) && !(await hasPriorMovement(tx, transfer.id))) {
        await recordObservation(tx, transfer.id, attachment.satoraSwapId, {
          providerStatus: read.facts.status,
          kind: "observation",
          evmFundTxid: null,
          evmClaimTxid: null,
        });
        const next = await applyPath(["USER_CANCELLED"], "CANCELLED_PROVIDER_EXPIRED", { providerStatus: read.facts.status });
        return { transferId, status: next, deduplicated: false };
      }
      const next = await applyPath(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"], "CANCEL_UNPROVEN_RECONCILE", {
        providerStatus: read.kind === "facts" ? read.facts.status || "unknown" : "unknown",
        providerError: read.kind === "error" ? read.code : null,
      });
      return { transferId, status: next, deduplicated: false };
    }
    if (read.kind === "error") {
      throw new AuthError(503, read.code, "Route provider is temporarily unavailable; cancellation cannot be verified.");
    }
    const facts = read.facts;
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
        const next = await applyPath(["USER_CANCELLED"], "CANCELLED_NEVER_AUTHORIZED", { providerStatus: facts.status });
        return { transferId, status: next, deduplicated: false };
      }
      throw new AuthError(409, "NOT_CANCELLABLE", "Invoice state is ambiguous; cancellation is not safe — reconcile instead.");
    }
    const next = await applyPath(["USER_CANCELLED"], "CANCELLED_PROVIDER_PENDING", { providerStatus: facts.status });
    return { transferId, status: next, deduplicated: false };
  });
}
