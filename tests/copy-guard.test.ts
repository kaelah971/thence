/**
 * Slice 0 C4 — customer-facing pause language.
 * Locks natural banking wording and the approval-vs-finishing distinction.
 * Never asserts on secrets; only on user-visible reason strings.
 */
import { describe, expect, it } from "vitest";
import { evaluatePaymentGate, type PaymentGateInput } from "@/ui/lib/payment-gate";
import { evaluateClaimEligibility, type ClaimEligibilityInput } from "@/ui/lib/claim-gate";

const BANNED = [/switched off/i, /switched on/i, /in this build/i];

const paymentOpen: PaymentGateInput = {
  flagEnabled: true,
  hostSupported: true,
  hostNetwork: "mainnet",
  allowedHostNetworks: ["mainnet"],
  sessionValid: true,
  transferAuthorized: true,
  vaultMatched: true,
  invoiceLive: true,
  explicitAction: true,
  previewMode: false,
};

const claimOpen: ClaimEligibilityInput = {
  flagEnabled: true,
  transferStatus: "SERVER_FUNDED",
  providerStatus: "serverfunded",
  vaultMatched: true,
  readbackOk: true,
  networkMatch: true,
  destinationMatch: true,
  earlierClaimUnknown: false,
  previewMode: false,
};

describe("pause language (Slice 0 C4)", () => {
  it("never exposes feature-flag internals in payment gate reasons", () => {
    const decision = evaluatePaymentGate({ ...paymentOpen, flagEnabled: false });
    expect(decision.allowed).toBe(false);
    for (const reason of decision.reasons) {
      for (const pattern of BANNED) expect(reason).not.toMatch(pattern);
    }
    expect(decision.reasons.join(" ")).toMatch(/paused in this preview/i);
  });

  it("never exposes feature-flag internals in claim gate reasons", () => {
    const decision = evaluateClaimEligibility({ ...claimOpen, flagEnabled: false });
    expect(decision.allowed).toBe(false);
    for (const reason of decision.reasons) {
      for (const pattern of BANNED) expect(reason).not.toMatch(pattern);
    }
    expect(decision.reasons.join(" ")).toMatch(/paused in this preview/i);
  });

  it("distinguishes approval (nothing sent) from finishing (status unknown)", () => {
    const payment = evaluatePaymentGate({ ...paymentOpen, flagEnabled: false });
    // Pre-invocation: safe to say nothing was sent.
    expect(payment.reasons.join(" ")).toMatch(/nothing was sent/i);
    const claim = evaluateClaimEligibility({ ...claimOpen, flagEnabled: false });
    // Post-approval: must NOT claim nothing moved — point at Activity instead.
    expect(claim.reasons.join(" ")).not.toMatch(/nothing (was sent|moved|can move|can be debited)/i);
    expect(claim.reasons.join(" ")).toMatch(/activity/i);
  });
});
