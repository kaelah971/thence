/**
 * R2 read model: the on-chain-verified NIM return recorded by an R2 close.
 * Dependency-light on purpose (schema + drizzle only) so the transfer list can
 * read it without importing the resolution's provider/chain modules.
 */
import { and, eq } from "drizzle-orm";
import { transferTransitions } from "@/db/schema";
import type { getDb } from "@/lib/db";

type Reader = Pick<ReturnType<typeof getDb>, "select">;

export const NIM_RETURN_REASON_CODE = "NIM_HTLC_RETURNED_VERIFIED";

export interface RecordedNimReturn {
  refundTxHash: string;
  returnedLuna: string;
  feeLuna: string;
}

/**
 * Only the terminal R2 audit row with `refundProof: VERIFIED_ON_CHAIN` counts.
 * A P4 close, a provider refund or anything else never reads as a NIM return.
 */
export async function recordedReturn(db: Reader, transferId: string): Promise<RecordedNimReturn | null> {
  const rows = await db
    .select({ evidence: transferTransitions.evidence })
    .from(transferTransitions)
    .where(
      and(
        eq(transferTransitions.transferId, transferId),
        eq(transferTransitions.terminal, true),
        eq(transferTransitions.toStatus, "EXPIRED_UNFUNDED"),
        eq(transferTransitions.reasonCode, NIM_RETURN_REASON_CODE),
      ),
    )
    .limit(1);
  const nimiq = (rows[0]?.evidence as { nimiq?: Record<string, unknown> } | undefined)?.nimiq;
  if (!nimiq || nimiq["refundProof"] !== "VERIFIED_ON_CHAIN" || typeof nimiq["refundTxHash"] !== "string") return null;
  return { refundTxHash: nimiq["refundTxHash"], returnedLuna: String(nimiq["returnedLuna"]), feeLuna: String(nimiq["feeLuna"]) };
}
