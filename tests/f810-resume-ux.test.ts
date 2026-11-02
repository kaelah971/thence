/**
 * F8.10 — durable resume + recipient UX regression tests (pure, no DOM).
 *
 * 1. Resume CTA gating: only unpaid pre-approval states offer a resume path
 *    (same transfer, same idempotency key, same attempt). Funded, checking,
 *    attention and terminal states must never show it — recovery for those
 *    runs through reconcile/receipt, never a resume that could fork a
 *    second funded attempt.
 * 2. Expired-swap binding discard: only a server-verified expired invoice
 *    proves the bound swap is dead. Every other attach failure keeps the
 *    binding so a bound or merely unverified swap is never silently
 *    replaced.
 * 3. Recipient inline validation: a structurally valid Polygon address
 *    passes (enabling Continue), anything else explains itself.
 */
import { describe, expect, it } from "vitest";
import type { TransferStatus } from "@/domain/transfers";
import { canShowCancelUnpaid, resumeLabelFor } from "@/ui/lib/status";
import { shouldDiscardBindingOnAttachFailure } from "@/ui/lib/recovery-vault";
import { destinationAddressIssue } from "@/ui/lib/assets";

describe("resume CTA gating (F8.10)", () => {
  it("offers resume only for unpaid pre-approval states", () => {
    expect(resumeLabelFor("QUOTED")).toBe("Resume payment");
    expect(resumeLabelFor("SWAP_CREATED")).toBe("Resume payment");
    expect(resumeLabelFor("AWAITING_NIM_APPROVAL")).toBe("Continue to approval");
  });

  it("never offers resume for funded, checking, attention or terminal states", () => {
    const never: TransferStatus[] = [
      "DRAFT",
      "LIGHTNING_HANDOFF",
      "CLIENT_FUNDED",
      "SERVER_FUNDED",
      "CLAIMING",
      "OUTCOME_UNKNOWN",
      "RECONCILING",
      "NEEDS_ATTENTION",
      "FAILED",
      "DELIVERED",
      "QUOTE_EXPIRED",
      "USER_CANCELLED",
    ];
    for (const status of never) {
      expect(resumeLabelFor(status)).toBeNull();
    }
  });
});

describe("cancel-unpaid gating", () => {
  it("never offers cancellation for an unresolved or funded lifecycle", () => {
    for (const status of ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "NEEDS_ATTENTION"] as TransferStatus[]) {
      expect(canShowCancelUnpaid(status, true), status).toBe(false);
    }
  });

  it("keeps reversible pre-funding cancellation and verified expiry separate", () => {
    expect(canShowCancelUnpaid("QUOTED", false)).toBe(true);
    expect(canShowCancelUnpaid("SWAP_CREATED", false)).toBe(true);
    expect(canShowCancelUnpaid("AWAITING_NIM_APPROVAL", true)).toBe(true);
    expect(canShowCancelUnpaid("AWAITING_NIM_APPROVAL", false)).toBe(false);
  });
});

describe("expired-swap binding discard (F8.10)", () => {
  it("drops the binding only on server-verified invoice expiry", () => {
    expect(shouldDiscardBindingOnAttachFailure("INVOICE_EXPIRED")).toBe(true);
  });

  it("keeps the binding for every other attach outcome", () => {
    for (const code of [null, "", "SWAP_MISMATCH", "SWAP_CONFLICT", "SWAP_ALREADY_BOUND", "SWAP_NOT_FOUND", "VERSION_CONFLICT", "ATTEMPT_INVALID", "NOT_ATTACHABLE", "PROVIDER_TIMEOUT", "TIMEOUT", "invoice_expired"]) {
      expect(shouldDiscardBindingOnAttachFailure(code)).toBe(false);
    }
  });
});

describe("recipient inline validation (F8.10)", () => {
  it("accepts a structurally valid Polygon address", () => {
    expect(destinationAddressIssue("Polygon", "0x0000000000000000000000000000000000000001")).toBeNull();
    expect(destinationAddressIssue("Polygon", "  0x0000000000000000000000000000000000000001  ")).toBeNull();
  });

  it("explains invalid, empty and wrong-network entries", () => {
    expect(destinationAddressIssue("Polygon", "")).toBe("Enter the address they gave you.");
    expect(destinationAddressIssue("Polygon", "0x123")).toMatch(/42 characters/);
    expect(destinationAddressIssue("Polygon", "NQ07 0000 0000 0000 0000 0000 0000 0000 0000")).toMatch(/Nimiq address/);
  });
});
