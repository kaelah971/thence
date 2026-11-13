/**
 * R4 — durable record of the Fastspot swap id Nimiq Pay returned for a
 * transfer, so a stalled NIM → Lightning payment can be traced to its swap.
 *
 * Storage: a same-state, non-terminal `transfer_transitions` audit row with
 * reason HOST_SWAP_HINT_RECORDED. Same-state annotation rows are not hops, so
 * they never change transfer state, the handoff time or the consistency chain
 * (see consistency.ts). No schema change.
 *
 * Trust: an untrusted host hint. Nothing here verifies funding or the source,
 * and nothing reads it to make a payment decision. The first value recorded
 * for a transfer is the one operators see; a later DIFFERENT value is kept as
 * a flagged conflict and never replaces it. Rows are capped per transfer.
 * The full id is operator-only: it is not part of any client response.
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { transferTransitions } from "@/db/schema";
import { isTerminal, type TransferStatus } from "@/domain/transfers";
import { normalizeHostSwapId } from "@/domain/host-swap-id";
import { recordTransition } from "@/lib/transitions";
import type { getDb } from "@/lib/db";

export const HOST_SWAP_HINT_REASON = "HOST_SWAP_HINT_RECORDED";
/** At most this many hint rows per transfer (first value plus conflicts). */
export const HOST_SWAP_HINT_MAX_ROWS = 3;

type Db = ReturnType<typeof getDb>;
type TxLike = Pick<Db, "select" | "insert">;

export type HostSwapHintWrite = "recorded" | "duplicate" | "conflict_recorded" | "skipped";

/**
 * Record the hint inside the caller's transaction, under its transfer lock.
 * The caller has already scoped the transfer to its authenticated owner.
 */
export async function recordHostSwapHint(
  tx: TxLike,
  input: { transferId: string; status: TransferStatus; actorUserId: string; hostSwapId: string; sourceTxHashHint: string | null },
): Promise<HostSwapHintWrite> {
  const hostSwapId = normalizeHostSwapId(input.hostSwapId);
  // Terminal transfers take no further rows (terminal hops are unique per transfer).
  if (!hostSwapId || isTerminal(input.status)) return "skipped";
  const existing = await tx
    .select({ evidence: transferTransitions.evidence })
    .from(transferTransitions)
    .where(and(eq(transferTransitions.transferId, input.transferId), eq(transferTransitions.reasonCode, HOST_SWAP_HINT_REASON)))
    .orderBy(asc(transferTransitions.createdAt));
  const ids = existing.map((r) => (r.evidence as Record<string, unknown> | null)?.["hostSwapId"]);
  if (ids.includes(hostSwapId)) return "duplicate";
  if (existing.length >= HOST_SWAP_HINT_MAX_ROWS) return "skipped";
  const otherTransfers = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transferTransitions)
    .where(
      and(
        eq(transferTransitions.reasonCode, HOST_SWAP_HINT_REASON),
        ne(transferTransitions.transferId, input.transferId),
        sql`${transferTransitions.evidence}->>'hostSwapId' = ${hostSwapId}`,
      ),
    );
  const conflict = existing.length > 0;
  await recordTransition(tx, {
    transferId: input.transferId,
    from: input.status,
    to: input.status,
    actor: "owner",
    actorUserId: input.actorUserId,
    reasonCode: HOST_SWAP_HINT_REASON,
    evidence: {
      hostSwapId,
      hostSwapIdTrust: "untrusted_host_hint",
      sourceTxHashHint: input.sourceTxHashHint,
      conflictsWithFirst: conflict,
      reportedOnOtherTransfer: Number(otherTransfers[0]?.n ?? 0) > 0,
    },
  });
  return conflict ? "conflict_recorded" : "recorded";
}

export interface HostSwapHint {
  hostSwapId: string;
  recordedAt: string;
  conflictingIds: string[];
  reportedOnOtherTransfer: boolean;
}

/** Operator diagnostics only. Never returned to clients. */
export async function readHostSwapHint(db: Pick<Db, "select">, transferId: string): Promise<HostSwapHint | null> {
  const rows = await db
    .select({ evidence: transferTransitions.evidence, createdAt: transferTransitions.createdAt })
    .from(transferTransitions)
    .where(and(eq(transferTransitions.transferId, transferId), eq(transferTransitions.reasonCode, HOST_SWAP_HINT_REASON)))
    .orderBy(asc(transferTransitions.createdAt));
  const parsed = rows
    .map((r) => ({ e: (r.evidence ?? {}) as Record<string, unknown>, at: r.createdAt }))
    .map((r) => ({ id: normalizeHostSwapId(r.e["hostSwapId"]), other: r.e["reportedOnOtherTransfer"] === true, at: r.at }))
    .filter((r): r is { id: string; other: boolean; at: Date } => r.id !== null);
  const first = parsed[0];
  if (!first) return null;
  return {
    hostSwapId: first.id,
    recordedAt: first.at.toISOString(),
    conflictingIds: parsed.slice(1).map((r) => r.id),
    reportedOnOtherTransfer: parsed.some((r) => r.other),
  };
}
