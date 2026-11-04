/**
 * P4 — evidence-gated terminal resolution for expired, unfunded transfers.
 *
 * Problem (incident eddaa6de, 2026-11-02): an authorized payment whose
 * Satora swap expired without funding sat in RECONCILING forever. The
 * planner had no exit, so it occupied the owner's funding-exposure slot
 * indefinitely.
 *
 * This module moves RECONCILING → EXPIRED_UNFUNDED ONLY when ALL of the
 * following hold, re-verified at resolution time:
 *
 * Provider (fresh read, never cached):
 * - same swap id, Lightning→EVM, same amount, destination, chain and token
 *   as the bound transfer, and the same hash lock as the attachment;
 * - terminal status `expired`, with NO evm fund and NO evm claim tx id;
 * - invoice expired (provider AND attach-time copy) at least
 *   EXPIRY_SETTLE_MARGIN_MS ago, so no Lightning payment can still land.
 *
 * Chain (independent of the provider):
 * - the provider-named HTLC is a pinned, known contract, and it emitted NO
 *   event for this hash lock from shortly before the swap was bound until
 *   well after the invoice expired, with the window end finalized.
 *
 * Local records:
 * - no provider observation ever showed movement, no identity mismatch was
 *   ever recorded, no EVM proof is stored, and no attempt still reserves.
 *
 * Nimiq side:
 * - Thence never sees Nimiq Pay's own NIM HTLC. If Thence holds ANY
 *   recorded Nimiq funding evidence for this payment, resolution is refused
 *   (operator review) because Thence cannot prove that NIM was returned.
 *   Otherwise the transfer closes as EXPIRED_UNFUNDED — which states only
 *   that nothing reached the provider or Polygon. It is NEVER presented as a
 *   NIM refund; the owner copy points to Nimiq Pay's own timeout.
 *
 * Concurrency and durability:
 * - Evidence is gathered WITHOUT holding the transfer lock (network I/O).
 * - The commit phase takes the per-transfer advisory lock, re-reads state
 *   and local evidence, checks evidence freshness, then writes the status
 *   change, an audit row (terminal, unique per transfer) and an observation
 *   in ONE transaction. Exposure is derived from status, so capacity is
 *   released exactly when — and only if — that transaction commits.
 * - Repeats and races converge: an already-resolved transfer returns
 *   deduplicated; a lost race hits the terminal-once unique index and is
 *   reported as deduplicated as well.
 *
 * Never initiates payments, claims or refunds; never touches attempts,
 * attachments, proofs or prior observations.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  handoffAttempts,
  reconciliationObservations,
  swapAttachments,
  transferProofs,
  transferTransitions,
  transfers,
} from "@/db/schema";
import { canTransition, type TransferStatus } from "@/domain/transfers";
import { lockTransfer } from "@/lib/handoff";
import { getProviderSwap, resolveRoute, SatoraError, type VerifiedSwapFacts } from "@/lib/satora";
import { TRUSTED_HTLC_CONTRACTS, verifyNoHtlcActivity, type HtlcActivityResult } from "@/lib/settlement";
import { isUniqueViolation, recordTransition } from "@/lib/transitions";

type Db = ReturnType<typeof getDb>;
type Reader = Pick<Db, "select">;

/** Lightning can no longer pay an invoice this long after its expiry. */
export const EXPIRY_SETTLE_MARGIN_MS = 10 * 60_000;
/** Chain scan starts this long before the swap was bound (clock skew margin). */
export const SCAN_LEAD_MS = 5 * 60_000;
/** Chain scan ends this long after invoice expiry (covers the EVM locktime, ~1 h before invoice expiry). */
export const SCAN_TAIL_MS = 60 * 60_000;
/** Evidence gathered before the commit phase must be at most this old. */
export const EVIDENCE_MAX_AGE_MS = 2 * 60_000;

/** HTLC trust list now lives with the chain verifiers (P5); re-exported for P4 callers. */
export { TRUSTED_HTLC_CONTRACTS } from "@/lib/settlement";

export const RESOLVABLE_FROM: readonly TransferStatus[] = ["RECONCILING"];

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

export type ResolutionRefusal =
  | "NOT_RESOLVABLE"
  | "NOT_BOUND"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_IDENTITY_MISMATCH"
  | "PROVIDER_NOT_EXPIRED"
  | "PROVIDER_REPORTS_EVM_TX"
  | "INVOICE_NOT_SETTLED"
  | "LOCAL_MOVEMENT_RECORDED"
  | "LOCAL_IDENTITY_MISMATCH_RECORDED"
  | "EVM_PROOF_RECORDED"
  | "NIM_FUNDING_RECORDED"
  | "ATTEMPT_STILL_RESERVED"
  | "HTLC_UNTRUSTED"
  | "CHAIN_ACTIVITY_FOUND"
  | "CHAIN_NOT_FINAL"
  | "CHAIN_INCONCLUSIVE"
  | "CHAIN_UNAVAILABLE"
  | "EVIDENCE_STALE";

/** Owner-facing, plain-language refusals (never technical jargon). */
const REFUSAL_COPY: Record<ResolutionRefusal, { status: number; message: string }> = {
  NOT_RESOLVABLE: { status: 409, message: "This payment can't be closed this way. Check its status in Activity." },
  NOT_BOUND: { status: 409, message: "There is no provider swap to check for this payment." },
  PROVIDER_UNAVAILABLE: { status: 503, message: "We couldn't reach the provider to confirm. Try again shortly — the payment stays open." },
  PROVIDER_IDENTITY_MISMATCH: { status: 409, message: "The provider's record doesn't match this payment. It stays open for review." },
  PROVIDER_NOT_EXPIRED: { status: 409, message: "The provider doesn't show this payment as expired. It stays open." },
  PROVIDER_REPORTS_EVM_TX: { status: 409, message: "The provider reports activity for this payment. It stays open — don't resend." },
  INVOICE_NOT_SETTLED: { status: 409, message: "This payment only just expired. Check again in a few minutes." },
  LOCAL_MOVEMENT_RECORDED: { status: 409, message: "We saw activity for this payment earlier, so it can't be closed as unfunded." },
  LOCAL_IDENTITY_MISMATCH_RECORDED: { status: 409, message: "This payment had a mismatch earlier. It stays open for review." },
  EVM_PROOF_RECORDED: { status: 409, message: "A transaction is recorded for this payment, so it can't be closed as unfunded." },
  NIM_FUNDING_RECORDED: { status: 409, message: "A NIM payment is recorded for this payment, and Thence can't confirm it came back. It stays open for review." },
  ATTEMPT_STILL_RESERVED: { status: 409, message: "This payment is still being prepared. Check again shortly." },
  HTLC_UNTRUSTED: { status: 409, message: "We couldn't verify this payment's network record. It stays open for review." },
  CHAIN_ACTIVITY_FOUND: { status: 409, message: "The network shows activity for this payment, so it can't be closed as unfunded." },
  CHAIN_NOT_FINAL: { status: 409, message: "The network check isn't final yet. Check again later." },
  CHAIN_INCONCLUSIVE: { status: 409, message: "We couldn't confirm this on the network. It stays open." },
  CHAIN_UNAVAILABLE: { status: 503, message: "The network check is temporarily unavailable. Try again shortly — the payment stays open." },
  EVIDENCE_STALE: { status: 409, message: "The check took too long. Try again." },
};

export function refusal(code: ResolutionRefusal): AuthError {
  const { status, message } = REFUSAL_COPY[code];
  return new AuthError(status, code, message);
}

/** Non-secret evidence snapshot persisted with the audit row. */
export interface ExpiredUnfundedEvidence {
  version: 1;
  gatheredAt: string;
  provider: {
    satoraSwapId: string;
    status: string;
    invoiceExpiresAt: string | null;
    attachInvoiceExpiresAt: string | null;
    evmFundTxid: null;
    evmClaimTxid: null;
    identityMatch: true;
  };
  chain: {
    chainId: number;
    htlcAddress: string;
    hashLock: string;
    windowStart: string;
    windowEnd: string;
    verdict: "NO_ACTIVITY";
    fromBlock: string | null;
    toBlock: string | null;
    latestBlock: string | null;
  };
  local: {
    movementObservations: 0;
    identityMismatchObservations: 0;
    evmProofRecorded: false;
    activeReservations: 0;
  };
  nimiq: {
    nimiqFundingRecorded: false;
    /** Thence cannot observe Nimiq Pay's HTLC; this closure is NOT a NIM refund proof. */
    refundProof: "NOT_OBSERVABLE_BY_THENCE";
  };
}

export interface ResolutionInputs {
  transfer: typeof transfers.$inferSelect;
  attachment: typeof swapAttachments.$inferSelect;
  facts: VerifiedSwapFacts;
  routeMatches: boolean;
  local: LocalEvidence;
  chain: HtlcActivityResult;
  window: { start: Date; end: Date };
  now: number;
}

export interface LocalEvidence {
  movementObservations: number;
  identityMismatchObservations: number;
  evmProofRecorded: boolean;
  nimiqFundingRecorded: boolean;
  activeReservations: number;
}

/** Chain scan window for a bound swap: [bound − lead, latest invoice expiry + tail]. */
export function scanWindow(attachment: { createdAt: Date; invoiceExpiresAt: Date | null }, facts: { invoiceExpiresAt: Date | null }): { start: Date; end: Date } | null {
  const expiries = [attachment.invoiceExpiresAt, facts.invoiceExpiresAt].filter((d): d is Date => d instanceof Date);
  if (expiries.length === 0) return null;
  const latestExpiry = Math.max(...expiries.map((d) => d.getTime()));
  return { start: new Date(attachment.createdAt.getTime() - SCAN_LEAD_MS), end: new Date(latestExpiry + SCAN_TAIL_MS) };
}

/**
 * Pure provider + local + Nimiq gates (no I/O). Returns the first refusal,
 * or null when everything except the chain verdict is satisfied.
 * Order matters: the most specific, most safety-relevant reason first.
 */
export function assessNonChainEvidence(input: Omit<ResolutionInputs, "chain" | "window">): ResolutionRefusal | null {
  const { transfer, attachment, facts, local, now } = input;
  if (!RESOLVABLE_FROM.includes(transfer.status as TransferStatus)) return "NOT_RESOLVABLE";
  if (local.nimiqFundingRecorded) return "NIM_FUNDING_RECORDED";
  if (local.evmProofRecorded) return "EVM_PROOF_RECORDED";
  if (local.identityMismatchObservations > 0) return "LOCAL_IDENTITY_MISMATCH_RECORDED";
  if (local.movementObservations > 0) return "LOCAL_MOVEMENT_RECORDED";
  if (local.activeReservations > 0) return "ATTEMPT_STILL_RESERVED";
  if (
    facts.satoraSwapId !== attachment.satoraSwapId ||
    facts.direction !== "lightning_to_evm" ||
    facts.paymentHash.toLowerCase() !== attachment.paymentHash.toLowerCase() ||
    facts.targetAtomic !== transfer.targetAmountAtomic ||
    facts.targetAddress.trim().toLowerCase() !== transfer.destination.trim().toLowerCase() ||
    !input.routeMatches
  ) {
    return "PROVIDER_IDENTITY_MISMATCH";
  }
  if (facts.evmFundTxid !== null || facts.evmClaimTxid !== null) return "PROVIDER_REPORTS_EVM_TX";
  if (facts.status !== "expired") return "PROVIDER_NOT_EXPIRED";
  const expiries = [attachment.invoiceExpiresAt, facts.invoiceExpiresAt].filter((d): d is Date => d instanceof Date);
  if (expiries.length === 0 || expiries.some((d) => d.getTime() + EXPIRY_SETTLE_MARGIN_MS > now)) return "INVOICE_NOT_SETTLED";
  const trusted = TRUSTED_HTLC_CONTRACTS[facts.evmChainId] ?? [];
  if (!facts.evmHtlcAddress || !trusted.includes(facts.evmHtlcAddress.toLowerCase())) return "HTLC_UNTRUSTED";
  return null;
}

export function chainRefusal(chain: HtlcActivityResult): ResolutionRefusal | null {
  switch (chain.verdict) {
    case "NO_ACTIVITY":
      return null;
    case "ACTIVITY_FOUND":
      return "CHAIN_ACTIVITY_FOUND";
    case "INSUFFICIENT_CONFIRMATIONS":
      return "CHAIN_NOT_FINAL";
    case "UNAVAILABLE":
      return "CHAIN_UNAVAILABLE";
    case "INCONCLUSIVE":
      return "CHAIN_INCONCLUSIVE";
  }
}

/** Read every local fact the gates depend on (used in BOTH phases). */
async function readLocalEvidence(db: Reader, transferId: string, now: number): Promise<LocalEvidence> {
  const observations = await db
    .select({ providerStatus: reconciliationObservations.providerStatus, kind: reconciliationObservations.kind })
    .from(reconciliationObservations)
    .where(eq(reconciliationObservations.transferId, transferId));
  const movementObservations = observations.filter((o) => (MOVEMENT_STATUSES as readonly string[]).includes(o.providerStatus)).length;
  const identityMismatchObservations = observations.filter((o) => o.kind === "identity_mismatch").length;
  const proofs = await db
    .select({ nimiqTxHash: transferProofs.nimiqTxHash, evmTxHash: transferProofs.evmTxHash })
    .from(transferProofs)
    .where(eq(transferProofs.transferId, transferId));
  const reservations = await db
    .select({ id: handoffAttempts.id })
    .from(handoffAttempts)
    .where(
      and(
        eq(handoffAttempts.transferId, transferId),
        inArray(handoffAttempts.status, ["PREPARED", "SWAP_ATTACHED"]),
        gt(handoffAttempts.expiresAt, new Date(now)),
      ),
    );
  return {
    movementObservations,
    identityMismatchObservations,
    evmProofRecorded: proofs.some((p) => typeof p.evmTxHash === "string" && p.evmTxHash.length > 0),
    nimiqFundingRecorded: proofs.some((p) => typeof p.nimiqTxHash === "string" && p.nimiqTxHash.length > 0),
    activeReservations: reservations.length,
  };
}

export interface ResolutionResult {
  transferId: string;
  status: TransferStatus;
  deduplicated: boolean;
}

/**
 * Owner-initiated, evidence-gated close of an expired, unfunded payment.
 * Throws AuthError with a plain-language refusal on any doubt.
 */
export async function closeExpiredUnfunded(userId: string, transferId: string): Promise<ResolutionResult> {
  const db = getDb();

  // ---- Phase A: gather evidence (no lock held during network I/O) ----
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const transfer = rows[0];
  if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  if (transfer.status === "EXPIRED_UNFUNDED") return { transferId, status: "EXPIRED_UNFUNDED", deduplicated: true };
  if (!RESOLVABLE_FROM.includes(transfer.status as TransferStatus)) throw refusal("NOT_RESOLVABLE");
  const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
  const attachment = bound[0];
  if (!attachment) throw refusal("NOT_BOUND");

  const gatheredAt = Date.now();
  const localA = await readLocalEvidence(db, transfer.id, gatheredAt);
  let facts: VerifiedSwapFacts;
  try {
    facts = await getProviderSwap(attachment.satoraSwapId);
  } catch (err) {
    if (err instanceof SatoraError && err.code === "SWAP_NOT_FOUND") throw refusal("PROVIDER_IDENTITY_MISMATCH");
    throw refusal("PROVIDER_UNAVAILABLE");
  }
  let routeMatches = false;
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    routeMatches =
      String(resolved.chainId) === String(facts.evmChainId) &&
      resolved.tokenAddress.toLowerCase() === facts.targetTokenAddress.toLowerCase();
  } catch {
    throw refusal("PROVIDER_UNAVAILABLE");
  }
  const nonChain = assessNonChainEvidence({ transfer, attachment, facts, routeMatches, local: localA, now: gatheredAt });
  if (nonChain) throw refusal(nonChain);
  const window = scanWindow(attachment, facts);
  if (!window) throw refusal("INVOICE_NOT_SETTLED");
  const chain = await verifyNoHtlcActivity({
    chainId: facts.evmChainId,
    htlcAddress: facts.evmHtlcAddress,
    hashLock: attachment.paymentHash,
    windowStart: window.start,
    windowEnd: window.end,
  });
  const chainBlock = chainRefusal(chain);
  if (chainBlock) throw refusal(chainBlock);

  const evidence: ExpiredUnfundedEvidence = {
    version: 1,
    gatheredAt: new Date(gatheredAt).toISOString(),
    provider: {
      satoraSwapId: facts.satoraSwapId,
      status: facts.status,
      invoiceExpiresAt: facts.invoiceExpiresAt?.toISOString() ?? null,
      attachInvoiceExpiresAt: attachment.invoiceExpiresAt?.toISOString() ?? null,
      evmFundTxid: null,
      evmClaimTxid: null,
      identityMatch: true,
    },
    chain: {
      chainId: facts.evmChainId,
      htlcAddress: (facts.evmHtlcAddress ?? "").toLowerCase(),
      hashLock: attachment.paymentHash.toLowerCase(),
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      verdict: "NO_ACTIVITY",
      fromBlock: chain.fromBlock,
      toBlock: chain.toBlock,
      latestBlock: chain.latestBlock,
    },
    local: { movementObservations: 0, identityMismatchObservations: 0, evmProofRecorded: false, activeReservations: 0 },
    nimiq: { nimiqFundingRecorded: false, refundProof: "NOT_OBSERVABLE_BY_THENCE" },
  };

  // ---- Phase B: commit under the per-transfer lock, re-verifying locally ----
  try {
    return await db.transaction(async (tx) => {
      await lockTransfer(tx, transfer.id);
      const fresh = await tx
        .select()
        .from(transfers)
        .where(and(eq(transfers.id, transfer.id), eq(transfers.ownerUserId, userId)))
        .limit(1);
      const current = fresh[0];
      if (!current) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
      if (current.status === "EXPIRED_UNFUNDED") return { transferId, status: "EXPIRED_UNFUNDED" as const, deduplicated: true };
      if (current.status !== transfer.status || !canTransition(current.status as TransferStatus, "EXPIRED_UNFUNDED")) {
        throw refusal("NOT_RESOLVABLE");
      }
      const now = Date.now();
      if (now - gatheredAt > EVIDENCE_MAX_AGE_MS) throw refusal("EVIDENCE_STALE");
      // A reconcile that committed between the phases may have recorded
      // movement or a mismatch: the local gates are re-run under the lock.
      const localB = await readLocalEvidence(tx, transfer.id, now);
      const again = assessNonChainEvidence({ transfer: current, attachment, facts, routeMatches, local: localB, now });
      if (again) throw refusal(again);

      await tx.update(transfers).set({ status: "EXPIRED_UNFUNDED", updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
      await recordTransition(tx, {
        transferId: transfer.id,
        from: current.status as TransferStatus,
        to: "EXPIRED_UNFUNDED",
        actor: "owner",
        actorUserId: userId,
        reasonCode: "EXPIRED_UNFUNDED_VERIFIED",
        evidence: evidence as unknown as Record<string, unknown>,
      });
      await tx.insert(reconciliationObservations).values({
        transferId: transfer.id,
        satoraSwapId: attachment.satoraSwapId,
        providerStatus: facts.status,
        kind: "observation",
        errorCode: null,
        evmFundTxid: null,
        evmClaimTxid: null,
      });
      return { transferId, status: "EXPIRED_UNFUNDED" as const, deduplicated: false };
    });
  } catch (err) {
    // A concurrent resolver committed the terminal audit row first: the
    // transfer is resolved exactly once; report this call as a duplicate.
    if (isUniqueViolation(err)) {
      const settled = await db.select({ status: transfers.status }).from(transfers).where(eq(transfers.id, transfer.id)).limit(1);
      if (settled[0]?.status === "EXPIRED_UNFUNDED") return { transferId, status: "EXPIRED_UNFUNDED", deduplicated: true };
    }
    throw err;
  }
}

/** Audit rows for a transfer (owner-scoped read for diagnostics/tests). */
export async function listTransitions(transferId: string): Promise<Array<typeof transferTransitions.$inferSelect>> {
  return getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, transferId)).orderBy(transferTransitions.createdAt);
}
