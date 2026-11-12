// @vitest-environment jsdom
/**
 * Incident 19cc312c (2026-11-12): Nimiq Pay refused with INVALID_TRANSACTION
 * "Insufficient NIM balance" BEFORE asking the owner to approve. The server
 * correctly kept the payment open (RECONCILING); the UI only showed a generic
 * "outcome unknown". These tests pin the UX-only fix:
 * - the server outcome stays the conservative `unknown`;
 * - only pre-confirmation reasons get specific copy (never "pay again");
 * - genuine TRANSACTION_OUTCOME_UNKNOWN keeps the generic checking screen;
 * - provider evidence of movement always outranks the client's explanation;
 * - the reason survives in the local handoff record (reopening Activity).
 */
import { afterEach, describe, expect, it } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { payAuthorizedInvoice, type LightningCapableProvider, type PaymentDiagnostics } from "@/ui/lib/nimiq-pay";
import { mapHostResultToServerOutcome } from "@/ui/lib/handoff-client";
import { isPreConfirmationRefusal, preConfirmationRefusalCopy } from "@/ui/lib/pre-confirmation-refusal";
import { paymentProgress } from "@/ui/lib/payment-progress";
import { loadHandoffRecord, saveHandoffRecord } from "@/ui/screens/send/useHandoff";

const INVOICE = "lnbc14060n1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq";

async function hostRefuses(type: string, message: string): Promise<{ outcome: string; diag: PaymentDiagnostics }> {
  const provider: LightningCapableProvider = {
    payLightningInvoice: (async () => {
      throw NimiqProviderError.from({ code: -32602, message, type }) ?? new Error(message);
    }) as LightningCapableProvider["payLightningInvoice"],
  };
  let diag: PaymentDiagnostics | null = null;
  const result = await payAuthorizedInvoice(provider, INVOICE, { onDiagnostics: (d) => { diag = d; } });
  return { outcome: mapHostResultToServerOutcome(result), diag: diag! };
}

afterEach(() => window.localStorage.clear());

describe("Nimiq Pay pre-confirmation refusals (UX only)", () => {
  it("the 19cc312c refusal keeps the conservative server outcome and is recognised for honest copy", async () => {
    const { outcome, diag } = await hostRefuses("INVALID_TRANSACTION", "Insufficient NIM balance");
    expect(outcome).toBe("unknown"); // never "cancelled": a client error proves nothing about the invoice
    expect(diag.providerReason).toBe("INSUFFICIENT_NIM_BALANCE");
    expect(isPreConfirmationRefusal(diag.providerReason)).toBe(true);

    const copy = preConfirmationRefusalCopy("INSUFFICIENT_NIM_BALANCE", "2026-11-12T18:55:09.000Z");
    expect(copy.title).toBe("Nimiq Pay: not enough NIM");
    expect(copy.body).toMatch(/NIM balance was too low and stopped before asking you to approve/);
    expect(copy.body).toMatch(/Thence can't confirm that on its own/);
    expect(copy.body).toMatch(/Don't start another payment for it/);
    expect(copy.body).toMatch(/close it in Activity/);
    expect(copy.body).not.toMatch(/try again|pay again now|nothing was (sent|paid)|refund/i);
  });

  it("only reasons thrown before Nimiq Pay's approval prompt qualify", async () => {
    for (const reason of ["INSUFFICIENT_NIM_BALANCE", "INSUFFICIENT_USDT_BALANCE", "SWAP_LIMIT_EXCEEDED", "SWAP_QUOTE_EXPIRED", "INVOICE_EXPIRED"]) {
      expect(isPreConfirmationRefusal(reason)).toBe(true);
      expect(preConfirmationRefusalCopy(reason as never).body).toMatch(/stopped before asking you to approve/);
    }
    for (const reason of ["SEND_REJECTED", "OUTCOME_UNKNOWN", "SUBMITTED_RECORD_NOT_SAVED", "DUPLICATE_IN_FLIGHT", "UNRECOGNIZED", null, undefined, "__proto__"]) {
      expect(isPreConfirmationRefusal(reason)).toBe(false);
    }
    // A genuine unknown outcome from the host is never treated as a refusal.
    const unknown = await hostRefuses("TRANSACTION_OUTCOME_UNKNOWN", "Transaction outcome unknown");
    expect(unknown.outcome).toBe("unknown");
    expect(isPreConfirmationRefusal(unknown.diag.providerReason)).toBe(false);
  });

  it("progress shows the refusal only while checking with no provider movement; evidence always wins", () => {
    const refusal = preConfirmationRefusalCopy("INSUFFICIENT_NIM_BALANCE", null);
    const base = { phase: "checking", claimReady: false, receiptReady: false };
    for (const transferStatus of ["RECONCILING", "OUTCOME_UNKNOWN", "LIGHTNING_HANDOFF"]) {
      for (const providerStatus of [null, "pending", "expired"]) {
        const v = paymentProgress({ ...base, transferStatus, providerStatus, refusal });
        expect(v).toMatchObject({ headline: "Nimiq Pay: not enough NIM", tone: "warn", action: "check" });
      }
    }
    // Provider reports funding while the server is still RECONCILING: never the refusal copy.
    expect(paymentProgress({ ...base, transferStatus: "RECONCILING", providerStatus: "clientfunded", refusal }).headline).not.toBe(refusal.title);
    // Server has moved on: the normal funded/delivered views take over.
    expect(paymentProgress({ ...base, transferStatus: "SERVER_FUNDED", providerStatus: "serverfunded", claimReady: true, refusal }).headline).not.toBe(refusal.title);
    expect(paymentProgress({ ...base, phase: "delivered", transferStatus: "DELIVERED", providerStatus: "serverredeemed", receiptReady: true, refusal }).headline).toBe("Delivered");
    // No refusal recorded (genuine unknown): the existing conservative copy is unchanged.
    expect(paymentProgress({ ...base, transferStatus: "RECONCILING", providerStatus: "pending" })).toMatchObject({
      headline: "Checking your payment",
      body: "We can't confirm the outcome yet. Don't start another payment.",
    });
  });

  it("the reason persists in the local handoff record, owner-scoped, and malformed values are dropped", () => {
    const base = { transferId: "19cc312c-9b6a-4147-80f6-079f058b8926", ownerUserId: "owner-1", invoice: INVOICE, invokedAt: "2026-11-12T17:25:22.000Z", outcomeReported: true, reportedOutcome: "unknown" as const, sourceTxHash: null };
    saveHandoffRecord({ ...base, refusal: { reason: "INSUFFICIENT_NIM_BALANCE", invoiceExpiresAt: "2026-11-12T18:55:09.000Z" } });
    expect(loadHandoffRecord(base.transferId, "owner-1")).toMatchObject({
      reportedOutcome: "unknown",
      refusal: { reason: "INSUFFICIENT_NIM_BALANCE", invoiceExpiresAt: "2026-11-12T18:55:09.000Z" },
    });
    expect(loadHandoffRecord(base.transferId, "someone-else")).toBeNull();

    window.localStorage.setItem(`thence.f4.2.handoff.v1:${base.transferId}`, JSON.stringify({ ...base, refusal: { reason: "SEND_REJECTED", invoiceExpiresAt: "x" } }));
    expect(loadHandoffRecord(base.transferId, "owner-1")?.refusal).toBeNull();
    window.localStorage.setItem(`thence.f4.2.handoff.v1:${base.transferId}`, JSON.stringify({ ...base, refusal: { reason: "INSUFFICIENT_NIM_BALANCE", invoiceExpiresAt: "not-a-date" } }));
    expect(loadHandoffRecord(base.transferId, "owner-1")?.refusal).toEqual({ reason: "INSUFFICIENT_NIM_BALANCE", invoiceExpiresAt: null });
    // Records written before this change (no refusal field) still load unchanged.
    window.localStorage.setItem(`thence.f4.2.handoff.v1:${base.transferId}`, JSON.stringify(base));
    expect(loadHandoffRecord(base.transferId, "owner-1")).toMatchObject({ reportedOutcome: "unknown", refusal: null });
  });
});
