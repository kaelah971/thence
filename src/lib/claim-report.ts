/**
 * f1ca0926 — durable, owner-reported evidence of what a browser claim attempt
 * ACTUALLY sent (UserOperation accepted / nothing sent / no answer).
 *
 * Storage: a same-state, non-terminal `transfer_transitions` annotation row
 * with reason CLAIM_ATTEMPT_REPORTED (no schema change; consistency.ts treats
 * it as an annotation, not a hop). Rows are capped per transfer.
 *
 * Trust: an untrusted client report. Nothing reads it to make a payment
 * decision: delivery is still decided only by the provider and the chain
 * (settlement verifier, reconciler). It exists so operators can see the exact
 * failing step: during f1ca0926 the browser held the only copy of the error
 * and the server log showed nothing after "authorized".
 *
 * Accepted fields are codes, booleans and public hashes; free text is
 * bounded and stripped of hex runs (calldata, signatures, preimages).
 */
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { transferTransitions, transfers } from "@/db/schema";
import { isTerminal, type TransferStatus } from "@/domain/transfers";
import { lockTransfer } from "@/lib/handoff";
import { recordTransition } from "@/lib/transitions";

export const CLAIM_REPORT_REASON = "CLAIM_ATTEMPT_REPORTED";
export const CLAIM_REPORT_MAX_ROWS = 12;
/** Statuses in which a browser claim attempt can happen. */
const REPORTABLE: ReadonlySet<string> = new Set(["SERVER_FUNDED", "CLAIMING", "OUTCOME_UNKNOWN", "NEEDS_ATTENTION"]);

const HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const claimReportSchema = z
  .object({
    submission: z.enum(["submitted", "not-submitted", "unknown"]),
    code: z.string().regex(/^[A-Z0-9_]{2,40}$/),
    disclosedToInfrastructure: z.boolean(),
    userOpHash: HASH.nullable(),
    txHash: HASH.nullable(),
    errorText: z.string().max(400).nullable(),
  })
  .strict();
export type ClaimReportInput = z.infer<typeof claimReportSchema>;

/** Server-side repeat of the client's redaction: no hex runs, bounded length. */
export function redactClaimText(text: string | null): string | null {
  if (text === null) return null;
  const out = text.replace(/0x[0-9a-fA-F]{16,}/g, "0x…").replace(/[0-9a-fA-F]{40,}/g, "…").replace(/\s+/g, " ").trim().slice(0, 160);
  return out.length > 0 ? out : null;
}

export type ClaimReportWrite = "recorded" | "skipped";

export async function recordClaimReport(userId: string, transferId: string, input: ClaimReportInput): Promise<ClaimReportWrite> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const t = (await tx.select({ status: transfers.status }).from(transfers).where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId))).limit(1))[0];
    if (!t) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    const status = t.status as TransferStatus;
    if (isTerminal(status) || !REPORTABLE.has(status)) return "skipped";
    const existing = await tx
      .select({ n: count() })
      .from(transferTransitions)
      .where(and(eq(transferTransitions.transferId, transferId), eq(transferTransitions.reasonCode, CLAIM_REPORT_REASON)));
    if (Number(existing[0]?.n ?? 0) >= CLAIM_REPORT_MAX_ROWS) return "skipped";
    await recordTransition(tx, {
      transferId,
      from: status,
      to: status,
      actor: "owner",
      actorUserId: userId,
      reasonCode: CLAIM_REPORT_REASON,
      evidence: {
        trust: "untrusted_client_report",
        submission: input.submission,
        code: input.code,
        disclosedToInfrastructure: input.disclosedToInfrastructure,
        userOpHash: input.userOpHash,
        txHash: input.txHash,
        errorText: redactClaimText(input.errorText),
      },
    });
    return "recorded";
  });
}
