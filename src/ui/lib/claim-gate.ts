/**
 * F4.3 — client-side claim eligibility gate.
 *
 * A claim may run ONLY when every condition holds:
 * - Explicit claim execution flag (controlled test config)
 * - Transfer is in a funded state (SERVER_FUNDED or CLAIMING)
 * - Provider reports a funded swap (serverfunded / clientredeeming /
 *   clientredeemed — mirrors backend isClaimReady)
 * - Vault binding matches this transfer + owner + bound swap
 * - Client recovery material passes SDK readback
 * - Bound network and destination match the transfer snapshot
 * - No earlier claim attempt is unresolved (unknown outcome)
 * - Not preview mode
 *
 * Claim execution stays DISABLED in this milestone
 * (NEXT_PUBLIC_THENCE_ENABLE_CLAIM is unset): the gate always blocks,
 * so no funded mainnet claim can run. The wiring below it (exact SDK
 * `claim(swapId)`, single-attempt discipline, verify-after-claim) is
 * implemented and unit-tested with mocks.
 */
import type { TransferStatus } from "@/domain/transfers";

export const CLAIM_FLAG_NAME = "NEXT_PUBLIC_THENCE_ENABLE_CLAIM";

/** Reads the controlled test flag. Unset/anything-but-"1" means OFF. */
export function isClaimFlagEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CLAIM_FLAG_NAME] === "1";
}

const FUNDED_TRANSFER: ReadonlySet<string> = new Set(["SERVER_FUNDED", "CLAIMING"]);
const FUNDED_PROVIDER: ReadonlySet<string> = new Set(["serverfunded", "clientredeeming", "clientredeemed"]);

export interface ClaimEligibilityInput {
  flagEnabled: boolean;
  transferStatus: TransferStatus | string;
  providerStatus: string;
  vaultMatched: boolean;
  readbackOk: boolean;
  networkMatch: boolean;
  destinationMatch: boolean;
  earlierClaimUnknown: boolean;
  previewMode: boolean;
}

export interface ClaimDecision {
  allowed: boolean;
  reasons: string[];
}

/** Pure gate: every condition must pass; reasons explain each block. */
export function evaluateClaimEligibility(input: ClaimEligibilityInput): ClaimDecision {
  const reasons: string[] = [];
  if (!input.flagEnabled) reasons.push("Finishing delivery is paused in this preview. Check Activity for the latest status \u2014 don\u2019t try again yet.");
  if (!FUNDED_TRANSFER.has(input.transferStatus)) reasons.push("This payment isn't ready to be finished yet.");
  if (!FUNDED_PROVIDER.has(input.providerStatus)) reasons.push("The swap isn't funded yet, so there's nothing to finish.");
  if (!input.vaultMatched) reasons.push("Recovery information doesn't match. Do not continue.");
  if (!input.readbackOk) reasons.push("Saved swap information couldn't be read back.");
  if (!input.networkMatch) reasons.push("This payment is for a different network.");
  if (!input.destinationMatch) reasons.push("This payment is for a different wallet.");
  if (input.earlierClaimUnknown) reasons.push("A delivery attempt is still being checked. Don't try again yet.");
  if (input.previewMode) reasons.push("Finishing payments is disabled in preview.");
  return { allowed: reasons.length === 0, reasons };
}

export interface ClaimRetryInput {
  earlierClaimUnknown: boolean;
  verifyCompletedSinceClaim: boolean;
  claimReadyNow: boolean;
  knownClaimTxHash: boolean;
}

/**
 * Pure re-claim discipline. After an unknown claim outcome, a second claim
 * is allowed ONLY after a fresh verify-settlement round completed AND the
 * server still reports the swap claimable with no observed claim tx.
 * Never retry blindly.
 */
export function mayRetryClaim(input: ClaimRetryInput): boolean {
  if (!input.earlierClaimUnknown) return true;
  return input.verifyCompletedSinceClaim && input.claimReadyNow && !input.knownClaimTxHash;
}
