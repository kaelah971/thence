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
/** Polygon claim deadline (Satora evm_refund_locktime): 30 min BEFORE the invoice expiry. */
const CLAIM_DEADLINE = Date.parse("2026-11-13T09:02:50.000Z");
const MIN = 60_000;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
  claimDeadlineMs: CLAIM_DEADLINE,
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

  it("the exact incident at five minutes: delayed, bounded by the claim deadline (not the invoice), never 'Confirming your approval'", () => {
    const v = paymentProgress({ ...incident, nowMs: HANDOFF + 5 * MIN });
    expect(v.headline).toBe("Delivery delayed — waiting for the Lightning payment");
    expect(v.tone).toBe("warn");
    expect(v.action).toBe("wait");
    expect(v.body).toMatch(/your NIM is locked/);
    // Latest Finish delivery = claim deadline − 5 min unsafe window (08:57:50Z), never the 09:32:50Z invoice expiry.
    expect(v.body).toContain(`only if it arrives in time to finish before ${hhmm(CLAIM_DEADLINE - 5 * MIN)}`);
    expect(v.body).not.toContain(hhmm(INVOICE_EXPIRES));
    expect(v.body).not.toMatch(/delivery continues/);
    expect(v.body).toMatch(/Don't pay again/);
    expect(text(v)).not.toMatch(/Confirming your approval/);
  });

  describe("30-minute gap: claim deadline 09:02:50Z passed while the invoice is live until 09:32:50Z", () => {
    for (const [label, nowMs] of [
      ["inside the 5-min unsafe window (08:59Z)", CLAIM_DEADLINE - 4 * MIN],
      ["just after the claim deadline (09:03Z)", CLAIM_DEADLINE + 10_000],
      ["mid-gap (09:17Z)", CLAIM_DEADLINE + 15 * MIN],
      ["one second before invoice expiry", INVOICE_EXPIRES - 1_000],
    ] as const) {
      it(`${label}: not deliverable even though the invoice is active`, () => {
        const v = paymentProgress({ ...incident, nowMs });
        expect(v.headline).toBe("Not delivered — the delivery deadline has passed");
        expect(v.action).toBe("check");
        expect(v.body).toContain(`delivery deadline (${hhmm(CLAIM_DEADLINE)}) has passed`);
        expect(v.body).toMatch(/can no longer be delivered, even if the Lightning payment still arrives/);
        expect(v.body).toMatch(/Thence hasn't seen a refund yet/);
        expect(text(v)).not.toMatch(/delivery continues|can still be delivered|\brefunded\b/i);
      });
    }

    it("the invoice-expired message takes over at invoice expiry", () => {
      expect(paymentProgress({ ...incident, nowMs: INVOICE_EXPIRES }).headline).toBe("Not delivered — the payment window has closed");
      expect(paymentProgress({ ...incident, providerStatus: "expired", nowMs: INVOICE_EXPIRES }).headline).toBe("Not delivered — the Lightning payment never arrived");
    });

    it("deadline passed with an unknown provider state: no claim about what the provider received", () => {
      const v = paymentProgress({ ...incident, providerStatus: "unknown", nowMs: CLAIM_DEADLINE + 15 * MIN });
      expect(v.headline).toBe("Not delivered — the delivery deadline has passed");
      expect(v.body).toMatch(/can't confirm the provider's latest status/);
      expect(text(v)).not.toMatch(/hasn't received|had not received|never/);
    });
  });

  it("unknown claim deadline: never promises delivery", () => {
    const v = paymentProgress({ ...incident, claimDeadlineMs: null, nowMs: HANDOFF + 5 * MIN });
    expect(v.headline).toBe("Delivery delayed — waiting for the Lightning payment");
    expect(v.body).toMatch(/can't confirm the delivery deadline yet/);
    expect(v.body).not.toMatch(/can still be delivered|delivery continues/);
  });

  it("switches to delayed exactly at the threshold, measured from the handoff", () => {
    expect(paymentProgress({ ...incident, nowMs: HANDOFF + LIGHTNING_DELAY_MS - 1 }).headline).toBe("Approved — sending the Lightning payment");
    expect(paymentProgress({ ...incident, nowMs: HANDOFF + LIGHTNING_DELAY_MS }).headline).toBe("Delivery delayed — waiting for the Lightning payment");
  });

  it("invoice expired: only the provider's own `expired` verdict says the Lightning payment never arrived", () => {
    const confirmed = paymentProgress({ ...incident, providerStatus: "expired", nowMs: INVOICE_EXPIRES });
    expect(confirmed.headline).toBe("Not delivered — the Lightning payment never arrived");
    expect(confirmed.body).toMatch(/The provider reports the swap expired without receiving the Lightning payment/);

    // Invoice expiry alone with the last provider read still `pending`: not categorical.
    const pending = paymentProgress({ ...incident, providerStatus: "pending", nowMs: INVOICE_EXPIRES });
    expect(pending.headline).toBe("Not delivered — the payment window has closed");
    expect(pending.body).toMatch(/As of Thence's last check, the provider had not received the Lightning payment/);
    expect(text(pending)).not.toMatch(/never (arrived|received)/);

    // Unknown or unrecognized provider state: non-conclusive.
    for (const providerStatus of ["unknown", null, "somethingnew"]) {
      const v = paymentProgress({ ...incident, providerStatus, invoiceExpired: true, nowMs: HANDOFF + 60_000 });
      expect(v.headline).toBe("Not delivered — the payment window has closed");
      expect(v.body).toMatch(/can't confirm the provider's latest status/);
      expect(text(v)).not.toMatch(/never (arrived|received)|hadn't received|had not received/);
    }
  });

  it("invoice expired (server verdict or clock): not delivered, refund only as a future possibility, never as done", () => {
    for (const v of [
      paymentProgress({ ...incident, invoiceExpired: true, nowMs: HANDOFF + 60_000 }),
      paymentProgress({ ...incident, nowMs: INVOICE_EXPIRES }),
    ]) {
      expect(v.headline).toMatch(/^Not delivered — /);
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
    ).toEqual({ sourceVerifiedAtMs: VERIFIED, handoffAtMs: HANDOFF, invoiceExpiresAtMs: INVOICE_EXPIRES, invoiceExpired: false, handoffStalled: false });
    expect(handoffInfoFrom({ latest: { sourceVerifiedAt: "garbage", invoiceExpired: true } as never, swap: null })).toEqual({
      sourceVerifiedAtMs: null,
      handoffAtMs: null,
      invoiceExpiresAtMs: null,
      invoiceExpired: true,
      handoffStalled: false,
    });
    // R3: only an explicit server `stalled: true` sets the flag.
    expect(handoffInfoFrom({ latest: { handoffStall: { stalled: true, stalledSince: null, anchorAt: null } } as never, swap: null }).handoffStalled).toBe(true);
    expect(handoffInfoFrom({ latest: { handoffStall: { stalled: "yes" } } as never, swap: null }).handoffStalled).toBe(false);
  });
});
