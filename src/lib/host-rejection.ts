/**
 * Ada/Rev incident (2026-11-18 01:57Z): two new users pressed Cancel in
 * Nimiq Pay. The host answered PERMISSION_DENIED with no transaction hash
 * and no swap id, but each payment sat in RECONCILING and held the wallet's
 * only payment slot for hours, so neither could try again.
 *
 * The state machine stays as it is: an authorized handoff reported as
 * cancelled still goes to RECONCILING (B4.4). A hold invoice in `pending`
 * does not prove that nothing was paid, so the server keeps watching it, and
 * a late payment can still be recovered. The P4 close then retires it
 * automatically (server-reconciler.ts).
 *
 * What changes is the exposure slot. When the host explicitly reported the
 * user's refusal with no transaction, and nothing on record shows any
 * movement, the payment no longer blocks a new one. The client's report is
 * untrusted, so a false one can only let the same wallet run a second payment
 * in parallel. It can never close, deliver or refund anything.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { reconciliationObservations, transferProofs, transferSourceEvidence, transferTransitions } from "@/db/schema";
import type { getDb } from "@/lib/db";

type Reader = Pick<ReturnType<typeof getDb>, "select">;

/** Audit reason for a host-reported refusal (PERMISSION_DENIED, no hash, no swap id). */
export const HOST_REJECTED_REASON = "CANCEL_HOST_REJECTED_RECONCILE";

/** Provider statuses that say nothing moved (anything else counts as possible movement). */
const QUIESCENT_PROVIDER_STATUSES: ReadonlySet<string> = new Set(["pending", "expired", "unknown", ""]);

export interface HostDiagnostics {
  providerErrorType: string | null;
  normalizedOutcome: "cancelled" | "initiated" | "unknown";
  hasHash: boolean;
  hasSwapId: boolean;
}

/** The host explicitly reported the user's refusal and returned no transaction at all. */
export function isHostRejection(d: HostDiagnostics | undefined): boolean {
  return (
    d !== undefined &&
    d.normalizedOutcome === "cancelled" &&
    d.providerErrorType === "PERMISSION_DENIED" &&
    d.hasHash === false &&
    d.hasSwapId === false
  );
}

/**
 * Of `transferIds`, those that entered RECONCILING through a host refusal and
 * have NO recorded sign of movement: no NIM source hint or evidence, no EVM
 * proof, no provider status beyond pending/expired, no EVM transaction and no
 * identity or route mismatch. Callers must still check the transfer's status.
 */
export async function hostRejectedWithoutMovement(db: Reader, transferIds: readonly string[]): Promise<Set<string>> {
  if (transferIds.length === 0) return new Set();
  const ids = [...new Set(transferIds)];
  const rejected = await db
    .select({ transferId: transferTransitions.transferId })
    .from(transferTransitions)
    .where(and(inArray(transferTransitions.transferId, ids), eq(transferTransitions.reasonCode, HOST_REJECTED_REASON)));
  const candidates = new Set(rejected.map((r) => r.transferId));
  if (candidates.size === 0) return candidates;
  const list = [...candidates];

  const proofs = await db
    .select({ transferId: transferProofs.transferId })
    .from(transferProofs)
    .where(and(inArray(transferProofs.transferId, list), or(isNotNull(transferProofs.nimiqTxHash), isNotNull(transferProofs.evmTxHash))));
  for (const p of proofs) candidates.delete(p.transferId);

  const sources = await db
    .select({ transferId: transferSourceEvidence.transferId })
    .from(transferSourceEvidence)
    .where(inArray(transferSourceEvidence.transferId, list));
  for (const s of sources) candidates.delete(s.transferId);

  const observations = await db
    .select({
      transferId: reconciliationObservations.transferId,
      providerStatus: reconciliationObservations.providerStatus,
      kind: reconciliationObservations.kind,
      evmFundTxid: reconciliationObservations.evmFundTxid,
      evmClaimTxid: reconciliationObservations.evmClaimTxid,
    })
    .from(reconciliationObservations)
    .where(inArray(reconciliationObservations.transferId, list));
  for (const o of observations) {
    const moved =
      // Fail closed: any kind other than a plain read or a failed read (identity
      // or route mismatch, or anything added later) keeps the slot held.
      (o.kind !== "observation" && o.kind !== "provider_error") ||
      Boolean(o.evmFundTxid) ||
      Boolean(o.evmClaimTxid) ||
      (o.kind === "observation" && !QUIESCENT_PROVIDER_STATUSES.has(o.providerStatus ?? ""));
    if (moved) candidates.delete(o.transferId);
  }
  return candidates;
}
