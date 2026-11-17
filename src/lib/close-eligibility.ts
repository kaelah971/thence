/**
 * Read-only close eligibility for the owner's recovery screen.
 *
 * The Activity screen must offer "Close expired payment" (P4) or the NIM
 * return check (R2) only when the server's own evidence gates would let the
 * action proceed. This module runs the SAME pure gates those actions run
 * (assessNonChainEvidence / assessLocalForNimReturn + assessProviderEvidence)
 * against a fresh provider read, so the client never decides eligibility.
 *
 * It is a preview, never a substitute: both close actions still re-read the
 * provider, re-check local history, and run their independent chain checks
 * (Polygon HTLC scan; Nimiq return proof) before changing anything. A refusal
 * here keeps the payment open; nothing here writes.
 */
import type { swapAttachments, transfers } from "@/db/schema";
import type { VerifiedSwapFacts } from "@/lib/satora";
import { assessNonChainEvidence, assessProviderEvidence, readLocalEvidence, refusal, type ResolutionRefusal } from "@/lib/expiry-resolution";
import { assessLocalForNimReturn, nimReturnProviderStatuses, nimReturnRefusal, type NimReturnRefusal } from "@/lib/nim-return-resolution";

type Reader = Parameters<typeof readLocalEvidence>[0];

export interface CloseGate<Code extends string> {
  /** True only when every non-chain gate passes; the action re-verifies everything. */
  eligible: boolean;
  /** First refusing gate, or null when eligible. */
  reason: Code | null;
  /** Owner-facing refusal copy (the action's own wording), or null when eligible. */
  message: string | null;
}

export interface CloseEligibility {
  /** P4: close an expired payment with no recorded NIM funding. */
  expiredUnfunded: CloseGate<ResolutionRefusal>;
  /** R2: close an expired payment whose recorded NIM lock must be proven returned. */
  nimReturn: CloseGate<NimReturnRefusal>;
}

const UNAVAILABLE_COPY = "Thence couldn't check whether this payment can be closed right now. It stays open — try again shortly.";
/** Fail-closed preview when local evidence can't be read: nothing is closable. */
export const CLOSE_PREVIEW_UNAVAILABLE: CloseEligibility = {
  expiredUnfunded: { eligible: false, reason: null, message: UNAVAILABLE_COPY },
  nimReturn: { eligible: false, reason: null, message: UNAVAILABLE_COPY },
};

/** Pure: both gates from already-gathered evidence (unit-testable without I/O). */
export function assessCloseEligibility(input: {
  transfer: typeof transfers.$inferSelect;
  attachment: typeof swapAttachments.$inferSelect;
  facts: VerifiedSwapFacts;
  routeMatches: boolean;
  local: Awaited<ReturnType<typeof readLocalEvidence>>;
  now: number;
}): CloseEligibility {
  const p4 = assessNonChainEvidence(input);
  // Same rule as the real close (the preview already holds the fresh provider status).
  const r2 = assessLocalForNimReturn(input.transfer.status, input.local, input.facts.status || "unknown") ?? assessProviderEvidence({ ...input, acceptedStatuses: nimReturnProviderStatuses(input.transfer.status) });
  return {
    expiredUnfunded: p4 === null ? { eligible: true, reason: null, message: null } : { eligible: false, reason: p4, message: refusal(p4).message },
    nimReturn: r2 === null ? { eligible: true, reason: null, message: null } : { eligible: false, reason: r2, message: nimReturnRefusal(r2).message },
  };
}

/** Reads local evidence (read-only) and assesses both close gates. */
export async function readCloseEligibility(
  db: Reader,
  input: { transfer: typeof transfers.$inferSelect; attachment: typeof swapAttachments.$inferSelect; facts: VerifiedSwapFacts; routeMatches: boolean },
): Promise<CloseEligibility> {
  const now = Date.now();
  const local = await readLocalEvidence(db, input.transfer.id, now);
  return assessCloseEligibility({ ...input, local, now });
}
