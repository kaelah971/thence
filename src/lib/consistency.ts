/**
 * P5 — financial-state consistency checker (read-only).
 *
 * Cross-checks one transfer's status against the durable records that must
 * accompany it: the bound swap, the handoff authorization, the settlement
 * proof, and the append-only transition audit trail. Pure core
 * (`checkTransferConsistency`) plus a loader; it never writes or repairs.
 *
 * `requireAudit` asserts complete audit coverage. Every status writer audits
 * since P5, so tests enforce it for transfers they create; rows written by
 * pre-P5 code (no audit trail) are checked without it.
 */
import { asc, eq } from "drizzle-orm";
import { handoffAttempts, swapAttachments, transferProofs, transferTransitions, transfers } from "@/db/schema";
import { canTransition, isTerminal, type TransferStatus } from "@/domain/transfers";
import type { getDb } from "@/lib/db";

type Db = ReturnType<typeof getDb>;

export interface ConsistencySnapshot {
  /** targetAmountAtomic enables the R7 amount checks (absent = not checked). */
  transfer: { id: string; status: string; targetAmountAtomic?: string };
  attachment: { satoraSwapId: string } | null;
  proof: typeof transferProofs.$inferSelect | null;
  attempts: Array<{ status: string }>;
  transitions: Array<typeof transferTransitions.$inferSelect>;
}

export type ConsistencyCode =
  | "DELIVERED_WITHOUT_PROOF"
  | "DELIVERED_BELOW_REQUEST"
  | "SHORT_WITHOUT_PROOF"
  | "SHORT_NOT_BELOW_REQUEST"
  | "PROOF_WITHOUT_DELIVERY"
  | "BOUND_STATUS_WITHOUT_SWAP"
  | "HANDOFF_WITHOUT_AUTHORIZATION"
  | "REFUNDED_WITHOUT_VERIFIED_REFUND"
  | "AUDIT_MISSING"
  | "AUDIT_ILLEGAL_HOP"
  | "AUDIT_CHAIN_BROKEN"
  | "AUDIT_TAIL_MISMATCH"
  | "AUDIT_MULTIPLE_TERMINAL";

export interface ConsistencyViolation {
  code: ConsistencyCode;
  detail: string;
}

/** Statuses that exist only after a swap was bound. */
const BOUND_STATUSES: ReadonlySet<string> = new Set([
  "SWAP_CREATED",
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
  "NEEDS_ATTENTION",
  "REFUNDED",
  "DELIVERED",
  "DELIVERED_SHORT",
  "FAILED",
  "EXPIRED_UNFUNDED",
]);

/** Statuses that exist only after the owner authorized the handoff. */
const AUTHORIZED_STATUSES: ReadonlySet<string> = new Set([...BOUND_STATUSES].filter((s) => s !== "SWAP_CREATED"));

/** Statuses a transfer may hold without any transition (creation states). */
/** Same-state annotation rows (not hops). */
const ANNOTATION_REASONS: ReadonlySet<string> = new Set(["SOURCE_EVIDENCE_RECORDED", "HOST_SWAP_HINT_RECORDED"]);
const INITIAL_STATUSES: ReadonlySet<string> = new Set(["DRAFT", "QUOTED"]);

function proofComplete(proof: ConsistencySnapshot["proof"]): boolean {
  return (
    !!proof &&
    proof.evidenceSource === "evm_erc20_transfer" &&
    proof.chainId !== null &&
    !!proof.evmTxHash &&
    !!proof.tokenContract &&
    !!proof.recipient &&
    !!proof.verifiedAmountAtomic &&
    proof.blockNumber !== null &&
    !!proof.blockHash &&
    !!proof.finalityLevel &&
    !!proof.verifiedAt
  );
}

/**
 * Order audit rows into the chain they describe. Rows are sorted by time;
 * pre-P5 rows of one multi-hop path share a timestamp (column default NOW()
 * is the transaction start), so ties are stitched by from→to linkage.
 */
export function orderTransitions<T extends { fromStatus: string; toStatus: string; createdAt: Date }>(rows: readonly T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out: T[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.createdAt.getTime() === sorted[i]!.createdAt.getTime()) j++;
    const group = sorted.slice(i, j);
    while (group.length > 0) {
      const tail = out.at(-1)?.toStatus;
      const k = tail === undefined ? group.findIndex((r) => !group.some((o) => o !== r && o.toStatus === r.fromStatus)) : group.findIndex((r) => r.fromStatus === tail);
      out.push(...group.splice(k < 0 ? 0 : k, 1));
    }
    i = j;
  }
  return out;
}

export function checkTransferConsistency(s: ConsistencySnapshot, opts: { requireAudit?: boolean } = {}): ConsistencyViolation[] {
  const v: ConsistencyViolation[] = [];
  const status = s.transfer.status;

  if (status === "DELIVERED" && !proofComplete(s.proof)) {
    v.push({ code: "DELIVERED_WITHOUT_PROOF", detail: "DELIVERED requires a complete on-chain ERC20 settlement proof." });
  }
  if (status === "DELIVERED_SHORT" && !proofComplete(s.proof)) {
    v.push({ code: "SHORT_WITHOUT_PROOF", detail: "DELIVERED_SHORT requires a complete on-chain ERC20 settlement proof." });
  }
  const target = s.transfer.targetAmountAtomic;
  const measured = s.proof?.verifiedAmountAtomic;
  if (target && measured && /^[0-9]+$/.test(target) && /^[0-9]+$/.test(measured) && proofComplete(s.proof)) {
    if (status === "DELIVERED" && BigInt(measured) < BigInt(target)) {
      v.push({ code: "DELIVERED_BELOW_REQUEST", detail: "DELIVERED proof is below the requested amount." });
    }
    if (status === "DELIVERED_SHORT" && (BigInt(measured) <= 0n || BigInt(measured) >= BigInt(target))) {
      v.push({ code: "SHORT_NOT_BELOW_REQUEST", detail: "DELIVERED_SHORT proof must be positive and below the requested amount." });
    }
  }
  if (status !== "DELIVERED" && status !== "DELIVERED_SHORT" && s.proof && (s.proof.evidenceSource === "evm_erc20_transfer" || s.proof.verifiedAt)) {
    v.push({ code: "PROOF_WITHOUT_DELIVERY", detail: `A verified settlement proof exists but status is ${status}.` });
  }
  if (BOUND_STATUSES.has(status) && !s.attachment) {
    v.push({ code: "BOUND_STATUS_WITHOUT_SWAP", detail: `${status} requires a bound swap.` });
  }
  if (AUTHORIZED_STATUSES.has(status) && !s.attempts.some((a) => a.status === "HANDOFF_AUTHORIZED")) {
    v.push({ code: "HANDOFF_WITHOUT_AUTHORIZATION", detail: `${status} requires a HANDOFF_AUTHORIZED attempt.` });
  }

  // Same-state, non-terminal source-evidence rows annotate a status; they are
  // not hops (handoff late evidence, R1 reconcile re-check, R4 host swap hint).
  const chain = orderTransitions(
    s.transitions.filter((t) => !(t.fromStatus === t.toStatus && !t.terminal && ANNOTATION_REASONS.has(t.reasonCode))),
  );
  if (status === "REFUNDED" && (chain.length > 0 || opts.requireAudit)) {
    const into = chain.find((t) => t.toStatus === "REFUNDED");
    const ev = (into?.evidence ?? {}) as Record<string, unknown>;
    if (!into || ev["refundVerified"] !== true) {
      v.push({ code: "REFUNDED_WITHOUT_VERIFIED_REFUND", detail: "REFUNDED requires an audited, independently verified EVM HTLC refund." });
    }
  }
  if (chain.length === 0) {
    if (opts.requireAudit && !INITIAL_STATUSES.has(status)) {
      v.push({ code: "AUDIT_MISSING", detail: `${status} has no transition audit trail.` });
    }
    return v;
  }
  for (const [i, t] of chain.entries()) {
    if (!canTransition(t.fromStatus as TransferStatus, t.toStatus as TransferStatus)) {
      v.push({ code: "AUDIT_ILLEGAL_HOP", detail: `Audited hop ${t.fromStatus} -> ${t.toStatus} is not a legal transition.` });
    }
    const prev = chain[i - 1];
    if (prev && prev.toStatus !== t.fromStatus) {
      v.push({ code: "AUDIT_CHAIN_BROKEN", detail: `Audit gap: ${prev.toStatus} is followed by a hop from ${t.fromStatus}.` });
    }
  }
  const first = chain[0]!;
  if (opts.requireAudit && !INITIAL_STATUSES.has(first.fromStatus)) {
    v.push({ code: "AUDIT_CHAIN_BROKEN", detail: `Audit trail starts at ${first.fromStatus}, not a creation status.` });
  }
  const last = chain.at(-1)!;
  if (last.toStatus !== status) {
    v.push({ code: "AUDIT_TAIL_MISMATCH", detail: `Latest audited status ${last.toStatus} differs from current status ${status}.` });
  }
  const terminal = chain.filter((t) => isTerminal(t.toStatus as TransferStatus));
  if (terminal.length > 1) {
    v.push({ code: "AUDIT_MULTIPLE_TERMINAL", detail: `${terminal.length} terminal transitions recorded.` });
  }
  return v;
}

/** Load the snapshot for one transfer (read-only). */
export async function readConsistencySnapshot(db: Pick<Db, "select">, transferId: string): Promise<ConsistencySnapshot | null> {
  const t = (await db.select({ id: transfers.id, status: transfers.status, targetAmountAtomic: transfers.targetAmountAtomic }).from(transfers).where(eq(transfers.id, transferId)).limit(1))[0];
  if (!t) return null;
  const [attachment, proof, attempts, transitions] = await Promise.all([
    db.select({ satoraSwapId: swapAttachments.satoraSwapId }).from(swapAttachments).where(eq(swapAttachments.transferId, transferId)).limit(1),
    db.select().from(transferProofs).where(eq(transferProofs.transferId, transferId)).limit(1),
    db.select({ status: handoffAttempts.status }).from(handoffAttempts).where(eq(handoffAttempts.transferId, transferId)),
    db.select().from(transferTransitions).where(eq(transferTransitions.transferId, transferId)).orderBy(asc(transferTransitions.createdAt)),
  ]);
  return { transfer: t, attachment: attachment[0] ?? null, proof: proof[0] ?? null, attempts, transitions };
}
