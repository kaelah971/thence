/**
 * R3 — stalled Lightning handoff detection (pure), operator-alert dedupe,
 * owner-facing stalled copy and the pre-approval risk disclosure.
 * Timings mirror the 2026-11-13 read-only production comparison: successful
 * NIM locks reached the provider in 23–34 s; incident 6f44918d never did.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  assessHandoffStall,
  emitHandoffStallAlert,
  HANDOFF_STALL_MS,
  setStallAlertSinkForTests,
  stallAnchor,
  STALL_EVIDENCE_FRESH_MS,
  type StallObservation,
} from "@/lib/handoff-stall";
import { LIGHTNING_DELAY_MS, paymentProgress, type ProgressInput } from "@/ui/lib/payment-progress";
import { NIM_LOCK_ESTIMATE_HOURS, PRE_APPROVAL_RISK_BODY, PRE_APPROVAL_RISK_TITLE, STALLED_HEADLINE } from "@/ui/lib/handoff-risk";

const T0 = Date.parse("2026-11-13T08:03:52.000Z"); // incident 6f44918d handoff report
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms);
let seq = 0;
const obs = (ms: number, providerStatus = "pending", kind = "observation"): StallObservation => ({ id: `o${seq++}`, providerStatus, kind, observedAt: at(ms) });
const base = { status: "LIGHTNING_HANDOFF", sourceVerifiedAt: at(37_000), handoffAt: at(0) };

afterEach(() => setStallAlertSinkForTests(null));

describe("assessHandoffStall", () => {
  it("normal funding within 60 s: never stalled (the transfer has left LIGHTNING_HANDOFF)", () => {
    const r = assessHandoffStall({ ...base, status: "SERVER_FUNDED", observations: [obs(1_000), obs(34_000, "serverfunded")], now: T0 + 6 * MIN });
    expect(r).toMatchObject({ stalled: false, reason: "NOT_IN_HANDOFF", alertDue: false });
  });

  it("still in handoff but provider funded in the window: not stalled", () => {
    const r = assessHandoffStall({ ...base, observations: [obs(1_000), obs(30_000, "clientfunded"), obs(6 * MIN)], now: T0 + 6 * MIN });
    expect(r).toMatchObject({ stalled: false, reason: "PROVIDER_NOT_PENDING" });
  });

  it("requires independently VERIFIED source funding", () => {
    const r = assessHandoffStall({ ...base, sourceVerifiedAt: null, observations: [obs(6 * MIN)], now: T0 + 6 * MIN });
    expect(r).toMatchObject({ stalled: false, reason: "SOURCE_NOT_VERIFIED" });
  });

  it("anchors on the earlier server handoff time only when it precedes verification", () => {
    expect(stallAnchor(at(37_000), at(0))?.getTime()).toBe(T0);
    expect(stallAnchor(at(37_000), at(60_000))?.getTime()).toBe(T0 + 37_000);
    expect(stallAnchor(null, at(0))).toBeNull();
  });

  it("before five minutes: TOO_EARLY even with pending reads (the 2-minute delayed copy is #72's, client-side)", () => {
    const r = assessHandoffStall({ ...base, observations: [obs(1_000), obs(2 * MIN), obs(4 * MIN)], now: T0 + HANDOFF_STALL_MS - 1 });
    expect(r).toMatchObject({ stalled: false, reason: "TOO_EARLY" });
  });

  it("stalled after five minutes with a fresh pending read past the threshold; alert due on that first read only", () => {
    const first = obs(HANDOFF_STALL_MS + 10_000);
    const r = assessHandoffStall({ ...base, observations: [obs(1_000), obs(2 * MIN), first], now: T0 + HANDOFF_STALL_MS + 20_000 });
    expect(r).toEqual({ stalled: true, reason: "STALLED", anchorAt: at(0).toISOString(), stalledSince: first.observedAt.toISOString(), alertDue: true });
    const later = assessHandoffStall({ ...base, observations: [obs(1_000), first, obs(8 * MIN)], now: T0 + 8 * MIN + 1_000 });
    expect(later).toMatchObject({ stalled: true, stalledSince: first.observedAt.toISOString(), alertDue: false });
  });

  it("a stale provider read never proves a stall", () => {
    const beforeThreshold = assessHandoffStall({ ...base, observations: [obs(1_000), obs(2 * MIN)], now: T0 + 10 * MIN });
    expect(beforeThreshold).toMatchObject({ stalled: false, reason: "PROVIDER_EVIDENCE_STALE" });
    const tooOld = assessHandoffStall({ ...base, observations: [obs(6 * MIN)], now: T0 + 6 * MIN + STALL_EVIDENCE_FRESH_MS + 1 });
    expect(tooOld).toMatchObject({ stalled: false, reason: "PROVIDER_EVIDENCE_STALE" });
    expect(assessHandoffStall({ ...base, observations: [], now: T0 + 10 * MIN })).toMatchObject({ reason: "NO_PROVIDER_EVIDENCE" });
  });

  it("provider errors and identity mismatches are not stall evidence", () => {
    for (const kind of ["provider_error", "identity_mismatch"]) {
      const r = assessHandoffStall({ ...base, observations: [obs(6 * MIN), obs(7 * MIN, "unknown", kind)], now: T0 + 7 * MIN + 1 });
      expect(r).toMatchObject({ stalled: false, reason: "PROVIDER_ERROR" });
    }
  });

  it("provider expired / any non-pending latest status is not a stall (expiry copy is #72's)", () => {
    for (const status of ["expired", "unknown", "clientfunded"]) {
      expect(assessHandoffStall({ ...base, observations: [obs(6 * MIN, status)], now: T0 + 6 * MIN + 1 })).toMatchObject({ stalled: false, reason: "PROVIDER_NOT_PENDING" });
    }
  });

  it("incident 6f44918d shape: pending for an hour → stalled since the first read past five minutes", () => {
    const reads = Array.from({ length: 30 }, (_, i) => obs(i * 2 * MIN + 15_000));
    const r = assessHandoffStall({ ...base, observations: reads, now: T0 + 58 * MIN + 30_000 });
    expect(r.stalled).toBe(true);
    expect(r.stalledSince).toBe(at(6 * MIN + 15_000).toISOString());
    expect(r.alertDue).toBe(false);
  });
});

describe("emitHandoffStallAlert", () => {
  const stalled = assessHandoffStall({ ...base, observations: [obs(6 * MIN)], now: T0 + 6 * MIN + 1 });

  it("emits exactly one non-secret line per transfer", () => {
    const lines: string[] = [];
    setStallAlertSinkForTests((l) => lines.push(l));
    expect(emitHandoffStallAlert({ transferId: "6f44918d-0000-4000-8000-000000000000", satoraSwapId: "572c5c65-0ca7-4930-b805-9bdda8c0120b", stall: stalled, now: T0 + 6 * MIN })).toBe(true);
    expect(emitHandoffStallAlert({ transferId: "6f44918d-0000-4000-8000-000000000000", satoraSwapId: "572c5c65-0ca7-4930-b805-9bdda8c0120b", stall: stalled })).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("thence-alert ")).toBe(true);
    const payload = JSON.parse(lines[0]!.slice("thence-alert ".length)) as Record<string, unknown>;
    expect(payload).toMatchObject({ alert: "LIGHTNING_HANDOFF_STALLED", swap: "572c5c65", minutesSinceHandoff: 6, providerStatus: "pending" });
    expect(lines[0]).not.toContain("0ca7-4930");
  });

  it("never alerts when not stalled or when the alert is not due", () => {
    const lines: string[] = [];
    setStallAlertSinkForTests((l) => lines.push(l));
    expect(emitHandoffStallAlert({ transferId: "a", satoraSwapId: null, stall: { ...stalled, alertDue: false } })).toBe(false);
    expect(emitHandoffStallAlert({ transferId: "b", satoraSwapId: null, stall: { ...stalled, stalled: false } })).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("owner-facing stalled copy (payment progress)", () => {
  const input = (over: Partial<ProgressInput>): ProgressInput => ({
    phase: "waiting-funding",
    transferStatus: "LIGHTNING_HANDOFF",
    providerStatus: "pending",
    claimReady: false,
    receiptReady: false,
    sourceVerifiedAtMs: T0 + 37_000,
    handoffAtMs: T0,
    invoiceExpiresAtMs: T0 + 89 * MIN,
    claimDeadlineMs: T0 + 59 * MIN,
    nowMs: T0 + 6 * MIN,
    ...over,
  } as ProgressInput);

  it("server stall supersedes the 2-minute delayed copy, keeps waiting, never claims a refund", () => {
    const v = paymentProgress(input({ handoffStalled: true }));
    expect(v.headline).toBe(STALLED_HEADLINE);
    expect(v.action).toBe("wait");
    expect(v.body).toContain("Don't pay again");
    expect(v.body).toContain("hasn't seen a refund");
    expect(v.body).toMatch(/estimate/);
    expect(v.body).not.toMatch(/refunded|has been returned|was returned/i);
  });

  it("without the server verdict the existing #72 delayed copy is unchanged", () => {
    expect(paymentProgress(input({ nowMs: T0 + LIGHTNING_DELAY_MS + 1 })).headline).toBe("Delivery delayed — waiting for the Lightning payment");
    expect(paymentProgress(input({ nowMs: T0 + 30_000 })).headline).toBe("Approved — sending the Lightning payment");
  });

  it("expiry and passed-deadline copy still win over a stale stall flag", () => {
    expect(paymentProgress(input({ handoffStalled: true, invoiceExpired: true, providerStatus: "expired" })).headline).toBe("Not delivered — the Lightning payment never arrived");
    expect(paymentProgress(input({ handoffStalled: true, nowMs: T0 + 60 * MIN })).headline).toBe("Not delivered — the delivery deadline has passed");
  });

  it("a stall flag with a non-pending provider read is ignored", () => {
    expect(paymentProgress(input({ handoffStalled: true, providerStatus: "unknown" })).headline).not.toBe(STALLED_HEADLINE);
  });

  it("Polygon regression: funded and delivered transfers are unaffected by a stall flag", () => {
    expect(paymentProgress(input({ handoffStalled: true, transferStatus: "SERVER_FUNDED", providerStatus: "serverfunded", claimReady: true })).headline).not.toBe(STALLED_HEADLINE);
    expect(paymentProgress(input({ handoffStalled: true, transferStatus: "DELIVERED", phase: "delivered", providerStatus: "serverredeemed" })).headline).not.toBe(STALLED_HEADLINE);
  });
});

describe("pre-approval risk disclosure", () => {
  it("states the lock risk, labels the duration as an estimate, and promises nothing", () => {
    expect(NIM_LOCK_ESTIMATE_HOURS).toBe(59);
    expect(PRE_APPROVAL_RISK_TITLE).toMatch(/NIM can stay locked/);
    expect(PRE_APPROVAL_RISK_BODY).toMatch(/about 2½ days \(an estimate from recent payments\)/);
    expect(PRE_APPROVAL_RISK_BODY).toMatch(/Nimiq Pay sets the exact timeout/);
    expect(PRE_APPROVAL_RISK_BODY).toMatch(/Thence can't release it sooner/);
    expect(PRE_APPROVAL_RISK_BODY).not.toMatch(/guarantee|always refund|instant refund/i);
  });
});
