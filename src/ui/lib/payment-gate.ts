/**
 * F4.2 — strict payment gate. Real payment invocation is OFF unless the
 * explicit deployment flag is enabled at build time.
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
 * No test, preview, or dev fixture may bypass this. The deployment flag is
 * read through a direct `process.env.NEXT_PUBLIC_*` reference so Next.js
 * actually inlines its build-time production value; injected env objects stay
 * available for unit tests.
 */

export const PAYMENT_FLAG_NAME = "NEXT_PUBLIC_THENCE_ENABLE_PAYMENT";
const PAYMENT_FLAG_VALUE = process.env.NEXT_PUBLIC_THENCE_ENABLE_PAYMENT;

/**
 * Reads the build-time flag by default. An explicit env object is retained for
 * deterministic tests and never used by the production call sites.
 */
export function isPaymentFlagEnabled(env?: Record<string, string | undefined>): boolean {
  return (env ?? { [PAYMENT_FLAG_NAME]: PAYMENT_FLAG_VALUE })[PAYMENT_FLAG_NAME] === "1";
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
  if (!input.flagEnabled) reasons.push("Payments are paused in this preview. No native payment call was made.");
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
