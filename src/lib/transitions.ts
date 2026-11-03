/**
 * P4 — transfer transition audit trail.
 *
 * Append-only rows in `transfer_transitions`, written in the SAME database
 * transaction as the status update they describe, so an audit row exists if
 * and only if the transition committed. Evidence snapshots are non-secret:
 * provider status strings, public tx hashes, chain scan windows and verdicts.
 */
import { transferTransitions } from "@/db/schema";
import { isTerminal, type TransferStatus } from "@/domain/transfers";
import type { getDb } from "@/lib/db";

type Db = ReturnType<typeof getDb>;
type Writer = Pick<Db, "insert">;

export type TransitionActor = "owner" | "reconciler" | "operator";

export interface TransitionRecord {
  transferId: string;
  from: TransferStatus;
  to: TransferStatus;
  actor: TransitionActor;
  actorUserId: string | null;
  reasonCode: string;
  evidence: Record<string, unknown>;
}

/** Record one hop. Terminal hops are unique per transfer (DB-enforced). */
export async function recordTransition(db: Writer, record: TransitionRecord): Promise<void> {
  await db.insert(transferTransitions).values({
    transferId: record.transferId,
    fromStatus: record.from,
    toStatus: record.to,
    actor: record.actor,
    actorUserId: record.actorUserId,
    reasonCode: record.reasonCode.slice(0, 64),
    evidence: record.evidence,
    terminal: isTerminal(record.to),
  });
}

/** Record every hop of a multi-step path with shared evidence. */
export async function recordPath(
  db: Writer,
  base: Omit<TransitionRecord, "from" | "to">,
  start: TransferStatus,
  path: readonly TransferStatus[],
): Promise<void> {
  let from = start;
  for (const to of path) {
    await recordTransition(db, { ...base, from, to });
    from = to;
  }
}

/** Postgres unique-violation detector (no message text inspected). */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
