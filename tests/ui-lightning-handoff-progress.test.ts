/**
 * Incident 6f44918d (2026-11-13): Nimiq Pay returned a hash, the NIM source
 * was verified on-chain, but the provider never received the Lightning
 * payment. The screen kept saying "Confirming your approval". These tests pin
 * the display-only replacement copy, which never claims a refund, and that the
 * transfer state machine still drives everything else.
 */
import { describe, expect, it } from "vitest";
import { LIGHTNING_DELAY_MS, paymentProgress, type ProgressInput } from "@/ui/lib/payment-progress";
import { handoffInfoFrom } from "@/ui/screens/send/useSettlement";

const HANDOFF = Date.parse("2026-11-13T08:03:52.387Z");
const VERIFIED = Date.parse("2026-11-13T08:04:29.259Z");
const INVOICE_EXPIRES = Date.parse("2026-11-13T09:32:50.000Z");

const incident: ProgressInput = {
  phase: "waiting-approval",
  transferStatus: "LIGHTNING_HANDOFF",
  providerStatus: "pending",
  claimReady: false,
  receiptReady: false,
  handedOff: true,
  sourceVerifiedAtMs: VERIFIED,
  handoffAtMs: HANDOFF,
  invoiceExpiresAtMs: INVOICE_EXPIRES,
  invoiceExpired: false,
};

const text = (v: { headline: string; body: string }) => `${v.headline} ${v.body}`;

describe("Lightning handoff progress after a verified NIM source", () => {
  it("unverified source: keeps the existing approval-pending copy", () => {
    const v = paymentProgress({ ...incident, sourceVerifiedAtMs: null, nowMs: HANDOFF + 10 * 60_000 });
    expect(v.headline).toBe("Confirming your approval");
    expect(v.steps?.[0]).toMatchObject({ label: "Approve in Nimiq Pay", detail: "Confirming your Nimiq Pay payment." });
  });

  it("verified source, within the normal window: approval done, Lightning leg pending", () => {
    const v = paymentProgress({ ...incident, nowMs: VERIFIED + 10_000 });
    expect(v.headline).toBe("Approved — sending the Lightning payment");
    expect(v.tone).toBe("neutral");
    expect(v.action).toBe("wait");
    expect(v.steps?.[0]).toMatchObject({ label: "Approved in Nimiq Pay", detail: "NIM locked — waiting for the Lightning payment." });
  });

  it("the exact incident at five minutes: delayed, names the invoice deadline, never 'Confirming your approval'", () => {
    const v = paymentProgress({ ...incident, nowMs: HANDOFF + 5 * 60_000 });
    expect(v.headline).toBe("Delivery delayed — waiting for the Lightning payment");
    expect(v.tone).toBe("warn");
    expect(v.action).toBe("wait");
    expect(v.body).toMatch(/your NIM is locked/);
    expect(v.body).toMatch(/If it arrives before .+, delivery continues\./);
    expect(v.body).toMatch(/Don't pay again/);
    expect(text(v)).not.toMatch(/Confirming your approval/);
  });

  it("switches to delayed exactly at the threshold, measured from the handoff", () => {
    expect(paymentProgress({ ...incident, nowMs: HANDOFF + LIGHTNING_DELAY_MS - 1 }).headline).toBe("Approved — sending the Lightning payment");
    expect(paymentProgress({ ...incident, nowMs: HANDOFF + LIGHTNING_DELAY_MS }).headline).toBe("Delivery delayed — waiting for the Lightning payment");
  });

  it("invoice expired (server verdict or clock): not delivered, refund only as a future possibility, never as done", () => {
    for (const v of [
      paymentProgress({ ...incident, invoiceExpired: true, nowMs: HANDOFF + 60_000 }),
      paymentProgress({ ...incident, nowMs: INVOICE_EXPIRES }),
    ]) {
      expect(v.headline).toBe("Not delivered — the Lightning payment never arrived");
      expect(v.action).toBe("check");
      expect(v.body).toMatch(/Thence hasn't seen a refund yet/);
      expect(v.body).toMatch(/Nimiq Pay can return it/);
      expect(text(v)).not.toMatch(/\brefunded\b|has been returned|was returned/i);
    }
  });

  it("late provider payment: the server status takes over and the usual copy follows", () => {
    const late = { ...incident, nowMs: HANDOFF + 20 * 60_000 };
    expect(paymentProgress({ ...late, transferStatus: "CLIENT_FUNDED", providerStatus: "clientfunded", phase: "finishing" }).headline).toBe("Payment received — preparing delivery");
    const funded = paymentProgress({ ...late, transferStatus: "SERVER_FUNDED", providerStatus: "serverfunded", phase: "finishing", claimReady: true });
    expect(funded.action).toBe("finish");
  });

  it("maps the server reconciliation view into display facts, failing closed on bad dates", () => {
    expect(
      handoffInfoFrom({
        latest: { sourceVerifiedAt: "2026-11-13T08:04:29.259Z", handoffAt: "2026-11-13T08:03:52.387Z", invoiceExpired: false } as never,
        swap: { invoiceExpiresAt: "2026-11-13T09:32:50.000Z" } as never,
      }),
    ).toEqual({ sourceVerifiedAtMs: VERIFIED, handoffAtMs: HANDOFF, invoiceExpiresAtMs: INVOICE_EXPIRES, invoiceExpired: false });
    expect(handoffInfoFrom({ latest: { sourceVerifiedAt: "garbage", invoiceExpired: true } as never, swap: null })).toEqual({
      sourceVerifiedAtMs: null,
      handoffAtMs: null,
      invoiceExpiresAtMs: null,
      invoiceExpired: true,
    });
  });
});
