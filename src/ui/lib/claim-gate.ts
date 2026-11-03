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
 * Claim execution stays disabled unless the explicit deployment flag is
 * enabled. The wiring below it (exact SDK `claim(swapId)`, single-attempt
 * discipline, verify-after-claim) is implemented and unit-tested with mocks.
 */
import type { TransferStatus } from "@/domain/transfers";

export const CLAIM_FLAG_NAME = "NEXT_PUBLIC_THENCE_ENABLE_CLAIM";
const CLAIM_FLAG_VALUE = process.env.NEXT_PUBLIC_THENCE_ENABLE_CLAIM;
/** Stop starting a claim when the provider's refund deadline is too close. */
export const CLAIM_TIMELOCK_MARGIN_MS = 60_000;

/**
 * Reads the build-time flag by default. An explicit env object is retained for
 * deterministic tests and never used by the production call sites.
 */
export function isClaimFlagEnabled(env?: Record<string, string | undefined>): boolean {
  return (env ?? { [CLAIM_FLAG_NAME]: CLAIM_FLAG_VALUE })[CLAIM_FLAG_NAME] === "1";
}

const FUNDED_TRANSFER: ReadonlySet<string> = new Set(["SERVER_FUNDED", "CLAIMING"]);
const FUNDED_PROVIDER: ReadonlySet<string> = new Set(["serverfunded", "clientredeeming", "clientredeemed"]);

export interface ClaimEligibilityInput {
  flagEnabled: boolean;
  /** The owner explicitly pressed the one-shot finish control. */
  explicitAuthorization?: boolean;
  /** Session identity must still be valid for this owner-scoped action. */
  sessionValid?: boolean;
  /** Missing/false is fail-closed for real claim callers; omitted preserves older pure callers. */
  timelockSafe?: boolean;
  /** A prior claim was submitted and has not been cleared by verification. */
  claimAlreadySubmitted?: boolean;
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
  if (input.explicitAuthorization === false) reasons.push("Choose Finish delivery to authorize this one delivery attempt.");
  if (input.sessionValid === false) reasons.push("Your session has ended. Sign in again before finishing delivery.");
  if (input.timelockSafe === false) reasons.push("The delivery deadline is too close or unavailable. Check Activity for the latest status \u2014 don\u2019t try again yet.");
  if (input.claimAlreadySubmitted) reasons.push("A delivery attempt has already been submitted. Check Activity for the latest status before trying again.");
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

/**
 * Claim is safe only while a known provider refund deadline remains ahead by
 * the safety margin. A missing deadline fails closed.
 */
export function isClaimWindowOpen(
  evmRefundLocktime: number | null,
  now = Date.now(),
  marginMs = CLAIM_TIMELOCK_MARGIN_MS,
): boolean {
  if (evmRefundLocktime === null || !Number.isSafeInteger(evmRefundLocktime) || evmRefundLocktime <= 0) return false;
  return evmRefundLocktime * 1000 - now > marginMs;
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
