/**
 * F4.2 — strict payment gate. Real payment invocation is OFF by default in
 * every build and stays OFF in this milestone.
 *
 * To allow a native invocation ALL of the following must hold:
 * 1. Explicit controlled-test flag: NEXT_PUBLIC_THENCE_ENABLE_PAYMENT === "1"
 * 2. Verified host Lightning capability (function present)
 * 3. Correct host network/environment (allow-listed; undefined host network blocks)
 * 4. Valid authenticated session
 * 5. Authoritative handoff authorization (transfer AWAITING_NIM_APPROVAL)
 * 6. Matching persisted recovery data (vault binding for this transfer+owner)
 * 7. Unexpired invoice (invoiceExpiresAt in the future)
 * 8. Explicit user action (button press — never auto-invoke, never preview)
 *
 * No test, preview, or dev fixture may bypass this. The flag is unset, so
 * `evaluatePaymentGate` always blocks and `payAuthorizedInvoice` is never
 * reached in this milestone.
 */

export const PAYMENT_FLAG_NAME = "NEXT_PUBLIC_THENCE_ENABLE_PAYMENT";

/** Reads the controlled-test flag. Unset/anything-but-"1" means OFF. */
export function isPaymentFlagEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PAYMENT_FLAG_NAME] === "1";
}

export interface PaymentGateInput {
  flagEnabled: boolean;
  hostSupported: boolean;
  hostNetwork: string | null | undefined;
  allowedHostNetworks: readonly string[];
  sessionValid: boolean;
  transferAuthorized: boolean;
  vaultMatched: boolean;
  invoiceLive: boolean;
  explicitAction: boolean;
  previewMode: boolean;
}

export interface PaymentGateDecision {
  allowed: boolean;
  reasons: string[];
}

/** Pure gate: every condition must pass; reasons explain each block. */
export function evaluatePaymentGate(input: PaymentGateInput): PaymentGateDecision {
  const reasons: string[] = [];
  if (!input.flagEnabled) reasons.push("Payments are paused in this preview. Nothing was sent.");
  if (!input.hostSupported) reasons.push("This version of Nimiq Pay can't pay Lightning invoices.");
  if (!input.hostNetwork || !input.allowedHostNetworks.includes(input.hostNetwork)) {
    reasons.push("Nimiq Pay is on the wrong network for this payment.");
  }
  if (!input.sessionValid) reasons.push("Your session has ended. Sign in again.");
  if (!input.transferAuthorized) reasons.push("This payment isn't authorized yet.");
  if (!input.vaultMatched) reasons.push("Recovery information doesn't match. Do not pay.");
  if (!input.invoiceLive) reasons.push("The invoice is missing or expired.");
  if (!input.explicitAction) reasons.push("Confirm explicitly to continue.");
  if (input.previewMode) reasons.push("Payments are disabled in preview.");
  return { allowed: reasons.length === 0, reasons };
}
