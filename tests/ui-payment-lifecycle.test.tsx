// @vitest-environment jsdom
/**
 * Phase 1 — rendered (jsdom + React Testing Library) payment lifecycle for
 * the real Send settlement screen (SettlementProgress + useSettlement) and the
 * real Activity screen, driven by a fixture-backed fake API built from the
 * redacted 2026-11-02 incident evidence (tests/ui/fake-api.ts).
 *
 * No database, no network, no provider, no wallet: global fetch is the fake;
 * the browser Satora claim module is a spy that must never be called.
 *
 * P4, P2 and P1 have converted every former `it.fails` marker in this file
 * into an ordinary test (named "P1: …", "P2: …", "P4: …").
 *
 * P1 tracking is ONE shared driver per (owner, transfer)
 * (src/ui/lib/payment-tracker.ts); the claim module is a spy, and the claim
 * flag is OFF unless a test explicitly opens every gate to prove that even
 * then nothing claims without a click, and never twice.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, INCIDENT, OWNER_ID, STALE, type FakeApi } from "./ui/fake-api";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, string>)}>
      {children}
    </a>
  ),
}));

const claimSpy = vi.hoisted(() => ({ claimStoredSwap: vi.fn(), readBackSwap: vi.fn() }));
vi.mock("@/ui/lib/satora-browser", () => claimSpy);
const claimFlag = vi.hoisted(() => ({ on: false }));
vi.mock("@/ui/lib/claim-gate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/claim-gate")>();
  return { ...original, isClaimFlagEnabled: () => claimFlag.on };
});

import { SettlementProgress } from "@/ui/screens/send/SettlementProgress";
import { Activity } from "@/ui/screens/activity/Activity";
import { activePaymentTrackerCount, resetPaymentTrackersForTests } from "@/ui/lib/payment-tracker";
import { reportHandoffResult } from "@/ui/lib/handoff-client";
import { createMemoryVault, RECOVERY_VAULT_VERSION } from "@/ui/lib/recovery-vault";
import { REFUNDED_BODY } from "@/ui/lib/settlement-client";

const DEADLINE_MS = INCIDENT.satora.getSwap.evm_refund_locktime * 1000;
const FIRST_OBSERVED = INCIDENT.observations[0]!.observed_at; // 21:30:26Z, serverfunded
/** Anything that tells the owner when the claim window closes. */
const DEADLINE_COPY = /deadline|time left|minutes? left|before \d{1,2}:\d{2}|expires? (at|in)|\b\d{1,2}:\d{2}\b.*(left|remaining)/i;

let api: FakeApi;
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
let hidden = false;

beforeAll(() => {
  // jsdom has no <dialog> modal support; the Activity sheet needs it.
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  hidden = false;
  claimFlag.on = false;
  (globalThis as { __thenceVault?: unknown }).__thenceVault = undefined;
  claimSpy.claimStoredSwap.mockReset();
  claimSpy.readBackSwap.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  resetPaymentTrackersForTests();
  api?.restore();
  vi.useRealTimers();
});

async function setVisible(visible: boolean): Promise<void> {
  hidden = !visible;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const ownerWrites = () => api.calls.filter((c) => c.method === "POST" && /\/(claim|close-expired|prepare|attach|authorize-handoff)$|^\/api\/transfers$/.test(c.path));

/** Advance fake time and let React and pending promises settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderSend(transferId = INCIDENT.transfer.id) {
  return render(
    <SettlementProgress
      transferId={transferId}
      ownerUserId={OWNER_ID}
      requestPublicId={null}
      sessionValid
      previewMode={false}
      routeId="usdc-polygon"
      asset="USDC"
      saveOffer={null}
    />,
  );
}

describe("Send settlement screen — Nov 2 incident: approval → funded swap → no claim → deadline → refund", () => {
  it("P2: after approval the funded swap is 'Action needed — Finish delivery' with the real deadline and time left; nothing claims on its own", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.handoff_authorized_at!));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: INCIDENT.attempt.handoff_authorized_at! } });
    renderSend();
    await advance(0);
    expect(screen.getAllByText("Payment on its way").length).toBeGreaterThan(0);

    // Provider funds the Polygon HTLC (real: block 96632367, 21:13:27Z).
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(3_000);
    // No reassuring "Thence is moving it" while the owner must act.
    expect(screen.queryByText(/Thence is moving it to their wallet now/)).toBeNull();
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
    const text = () => document.body.textContent ?? "";
    // Real deadline 22:12:42Z (evm_refund_locktime, fixed at swap creation 21:12:44Z):
    // right after approval only 59 min remain, not a fresh hour from funding.
    expect(text()).toContain(`Finish delivery before ${clock(DEADLINE_MS)} — 59 min left`);
    expect(text()).toMatch(DEADLINE_COPY);
    // Deadline is the Polygon one, explicitly not Nimiq Pay's NIM timer, and not the invoice expiry.
    expect(text()).toContain("separate from Nimiq Pay's own timer for returning NIM");
    expect(text()).not.toContain(clock(Date.parse(INCIDENT.attachment.invoice_expires_at!)));
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();

    // Ten minutes of tracking: the countdown advances; the UI never claims on its own.
    await advance(10 * 60_000);
    expect(text()).toContain("49 min left");
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.calls.some((c) => /claim|cancel|handoff-result|prepare|attach|authorize/.test(c.path))).toBe(false);
  });

  // P1 (was it.fails): tracking follows the bounded backoff (≤ 8 provider refreshes per minute).
  it("P1: tracking follows the bounded backoff (≤ 8 provider refreshes per minute)", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    const start = api.count("POST", "/reconcile");
    await advance(60_000);
    expect(api.count("POST", "/reconcile") - start).toBeLessThanOrEqual(8);
  });

  it("P1: backoff resets to fast polling when the payment makes progress, and stays within the write budget long-term", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(10 * 60_000);
    // Pre-funding cap 15 s → at most ~4/min after the initial ramp (budget: 60 writes/min shared).
    const settled = api.count("POST", "/reconcile");
    await advance(60_000);
    expect(api.count("POST", "/reconcile") - settled).toBeLessThanOrEqual(5);
    // Funding lands: the next refresh sees it and the cadence resets to fast.
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(15_000);
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
    // Progress resets the cadence: the next read follows 3 s later (provider
    // refreshes stay ≥ 5 s apart to protect the shared write budget).
    const afterProgress = api.count("GET", "/reconciliation");
    await advance(3_000);
    expect(api.count("GET", "/reconciliation")).toBe(afterProgress + 1);
  });

  // P1 (was it.fails): tracking resumes when the app becomes visible again.
  it("P1: tracking resumes when the app becomes visible again", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    hidden = true;
    await advance(3_000 + 13_000);
    const beforeReturn = api.count("POST", "/reconcile");
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(30_000);
    expect(api.count("POST", "/reconcile")).toBeGreaterThan(beforeReturn);
  });

  // P2 (was it.fails): while claim-ready, the owner sees that action is needed before a deadline.
  it("P2: while claim-ready, the owner sees that action is needed before a deadline", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(3_000);
    expect(document.body.textContent ?? "").toMatch(DEADLINE_COPY);
  });

  it("after the deadline passes unclaimed, the provider refunds and the screen ends at 'Not delivered — Polygon lock refunded'", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 20 * 60_000));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    // Real: refund tx 0x57c4…851b mined 22:16:54Z; Thence observed it at 12:32Z the next day.
    api.set(INCIDENT.transfer.id, { status: "REFUNDED", providerStatus: "clientfundedserverrefunded", observedAt: INCIDENT.observations[1]!.observed_at });
    await advance(10 * 60_000);
    expect(screen.getAllByText("Not delivered — Polygon lock refunded").length).toBeGreaterThan(0);
    // P5: the Polygon refund is never presented as the NIM coming back.
    expect(screen.getAllByText(REFUNDED_BODY).length).toBeGreaterThan(0);
    expect(document.body.textContent ?? "").not.toMatch(/your NIM (was|has been) (refunded|returned)/i);
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    // Polling stops at the terminal state.
    const settled = api.count("POST", "/reconcile");
    await advance(60_000);
    expect(api.count("POST", "/reconcile")).toBe(settled);
  });

  it("P2: deadline expiry — closing warning, then no action inside the unsafe window, then 'deadline has passed'", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 20 * 60_000));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    const { container } = renderSend();
    await advance(0);
    const windowState = () => container.querySelector("[data-claim-window]")?.getAttribute("data-claim-window");
    expect(windowState()).toBe("open");
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();

    await advance(8 * 60_000); // 12 min left
    expect(windowState()).toBe("closing");
    expect(document.body.textContent).toContain("12 min left");
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();

    await advance(8 * 60_000); // 4 min left: unsafe — preimage must not be revealed now
    expect(windowState()).toBe("unsafe");
    expect(screen.getByText("Too close to the delivery deadline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    // Still framed as the owner's payment needing attention, never "on its way".
    expect(screen.queryByText(/Thence is moving it/)).toBeNull();

    await advance(5 * 60_000); // past the deadline, provider has not refunded yet
    expect(windowState()).toBe("passed");
    expect(screen.getByText("The delivery deadline has passed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("P2: returning to the foreground re-evaluates the deadline immediately (no stale time or stale action)", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 30 * 60_000));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    const { container } = renderSend();
    await advance(0);
    expect(document.body.textContent).toContain("30 min left");
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    // Backgrounded (e.g. switched to Nimiq Pay). Jump the wall clock without
    // running timers, as a suspended mobile webview does.
    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    vi.setSystemTime(new Date(DEADLINE_MS - 3 * 60_000));
    // Foreground again: the very first render must already reflect real time.
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelector("[data-claim-window]")?.getAttribute("data-claim-window")).toBe("unsafe");
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    expect(document.body.textContent).not.toContain("30 min left");
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("P2: an identity-mismatched swap never shows a claim action", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED, identityMismatch: true } });
    renderSend();
    await advance(3_000);
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    expect(screen.queryByText("Action needed — Finish delivery")).toBeNull();
  });

  it("P1: mounted while AWAITING_NIM_APPROVAL, tracking continues through approval and funding", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.created_at));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "AWAITING_NIM_APPROVAL", providerStatus: "pending", observedAt: INCIDENT.attempt.created_at } });
    renderSend();
    await advance(0);
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(0);
    // Owner approves in Nimiq Pay; provider funds Polygon 39 s later (real timeline).
    api.set(INCIDENT.transfer.id, { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: INCIDENT.attempt.handoff_authorized_at! });
    await advance(15_000);
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(15_000);
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(ownerWrites()).toEqual([]);
  });

  it("P1 ACCEPTANCE: approval → funding → 5 min in the background → foreground shows the claimable status and Finish delivery at once", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.handoff_authorized_at!));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "AWAITING_NIM_APPROVAL", providerStatus: "pending", observedAt: INCIDENT.attempt.created_at } });
    renderSend();
    await advance(0);
    // The owner leaves Thence for the Nimiq Pay approval sheet.
    await setVisible(false);
    // Meanwhile: approval recorded and the provider funds the HTLC (21:13:27Z).
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: "2026-11-02T21:13:27.000Z" });
    const beforeBackground = api.calls.length;
    await advance(5 * 60_000);
    // Hidden: no provider traffic burned while away (budget preserved)…
    expect(api.calls.length).toBe(beforeBackground);
    // …and on return the very next refresh happens immediately.
    await setVisible(true);
    await advance(0);
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    // 21:12:48 + 5 min = 21:17:48 → deadline 22:12:42 is 54 min away.
    expect(document.body.textContent).toContain(`Finish delivery before ${clock(DEADLINE_MS)} — 54 min left`);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(ownerWrites()).toEqual([]);
  });

  it("P1: if the foreground return lands inside the unsafe window, the status is shown but Finish delivery is not", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 20 * 60_000));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    await setVisible(false);
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(17 * 60_000); // 3 min before the deadline
    await setVisible(true);
    await advance(0);
    expect(screen.getByText("Too close to the delivery deadline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
  });

  it("P1: returning from the Nimiq Pay host wakes tracking immediately (no waiting for backoff)", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.handoff_authorized_at!));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "AWAITING_NIM_APPROVAL", providerStatus: "pending", observedAt: INCIDENT.attempt.created_at } });
    renderSend();
    await advance(2 * 60_000); // backoff has grown to the 15 s pre-funding cap
    api.set(INCIDENT.transfer.id, { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: INCIDENT.attempt.handoff_authorized_at! });
    const before = api.count("GET", "/reconciliation");
    await act(async () => {
      await reportHandoffResult(INCIDENT.transfer.id, "initiated");
    });
    await advance(2_000);
    expect(api.count("GET", "/reconciliation")).toBeGreaterThan(before);
    expect(screen.queryByText("Waiting for approval")).toBeNull();
  });

  it("P1: a reload rebuilds tracking from the persisted transfer — no new swap, invoice or payment", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    const first = renderSend();
    await advance(0);
    expect(activePaymentTrackerCount()).toBe(1);
    first.unmount(); // page unload
    expect(activePaymentTrackerCount()).toBe(0);
    const before = api.calls.length;
    await advance(60_000);
    expect(api.calls.length).toBe(before); // nothing keeps running after unload
    renderSend(); // reload: same transfer id from the persisted pointer / URL
    await advance(0);
    expect(activePaymentTrackerCount()).toBe(1);
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
    expect(ownerWrites()).toEqual([]);
    expect(api.calls.every((c) => c.path.startsWith(`/api/transfers/${INCIDENT.transfer.id}`))).toBe(true);
  });

  it("P1: duplicate tracking is prevented — Send and Activity share one driver, one request at a time", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    api.latencyMs = 400;
    renderSend();
    renderSend(); // e.g. StrictMode double mount / a second view of the same payment
    await advance(0);
    expect(activePaymentTrackerCount()).toBe(1);
    // Burst of wake-ups (focus, pageshow, online, visibility) coalesces.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
    });
    await advance(60_000);
    expect(api.maxInFlight).toBe(1);
    expect(api.count("POST", "/reconcile")).toBeLessThanOrEqual(9);
  });

  it("P1: unmounting cancels the in-flight request (no work after leaving)", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    api.latencyMs = 5_000;
    const view = renderSend();
    await advance(1_000); // first request still in flight
    view.unmount();
    await advance(10_000);
    expect(api.aborted).toBeGreaterThanOrEqual(1);
    expect(activePaymentTrackerCount()).toBe(0);
  });

  it("P1: rate limiting backs off hard instead of exhausting the shared budget", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "OUTCOME_UNKNOWN", providerStatus: "pending", observedAt: FIRST_OBSERVED } });
    api.rateLimitReconcile = true;
    renderSend();
    await advance(0);
    await advance(3 * 60_000);
    // 60 s floor after a 429: ~1 refresh per minute instead of 20.
    expect(api.count("POST", "/reconcile")).toBeLessThanOrEqual(4);
    expect(document.body.textContent).toContain("Too many tries at once");
    // The last good server status is still shown (never a guessed outcome).
    expect(screen.getAllByText("Checking your payment").length).toBeGreaterThan(0);
  });

  it("P1: an unknown outcome keeps tracking (bounded) and surfaces funding as soon as it is seen", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.handoff_authorized_at!));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "OUTCOME_UNKNOWN", providerStatus: "pending", observedAt: INCIDENT.attempt.handoff_authorized_at! } });
    renderSend();
    await advance(0);
    expect(screen.getAllByText("Checking your payment").length).toBeGreaterThan(0);
    await advance(5 * 60_000);
    expect(api.count("POST", "/reconcile")).toBeLessThanOrEqual(26);
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(15_000);
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
  });

  it("P1: terminal outcomes stop tracking — refunded and expired-unfunded", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({
      [INCIDENT.transfer.id]: { status: "REFUNDED", providerStatus: "clientfundedserverrefunded", observedAt: INCIDENT.observations[1]!.observed_at },
      [STALE.transfer.id]: { status: "EXPIRED_UNFUNDED", providerStatus: "expired", observedAt: "2026-11-03T12:59:00.000Z" },
    });
    renderSend(INCIDENT.transfer.id);
    renderSend(STALE.transfer.id);
    await advance(0);
    expect(screen.getAllByText("Not delivered — Polygon lock refunded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Payment expired — not delivered").length).toBeGreaterThan(0);
    const settled = api.calls.length;
    await advance(10 * 60_000);
    expect(api.calls.length).toBe(settled);
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
  });

  it("P1: a deadline that becomes known (backfill) or changes is reflected without remounting", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED, claimDeadlineMs: null } });
    renderSend();
    await advance(0);
    expect(screen.getByText(/we can't confirm the delivery deadline yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    // Server backfills the authentic locktime on its next reconciliation.
    api.set(INCIDENT.transfer.id, { claimDeadlineMs: DEADLINE_MS });
    await advance(15_000);
    expect(document.body.textContent).toContain(`Finish delivery before ${clock(DEADLINE_MS)}`);
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    // A server-side change that moves the deadline into the unsafe window removes the action.
    api.set(INCIDENT.transfer.id, { claimDeadlineMs: Date.now() + 2 * 60_000 });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(2_000);
    expect(screen.getByText("Too close to the delivery deadline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
  });

  it("P1: with every claim gate open, tracking never claims unattended, and a double click claims exactly once", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    claimFlag.on = true;
    const vault = createMemoryVault();
    await vault.saveAndVerify({
      version: RECOVERY_VAULT_VERSION,
      transferId: INCIDENT.transfer.id,
      satoraSwapId: INCIDENT.attachment.satora_swap_id,
      paymentHash: INCIDENT.attachment.payment_hash,
      sourceSats: INCIDENT.attachment.source_sats,
      targetAtomic: INCIDENT.transfer.target_amount_atomic,
      destination: INCIDENT.transfer.destination,
      routeId: INCIDENT.transfer.route_id,
      quoteRevision: 1,
      ownerUserId: OWNER_ID,
      attemptToken: "owner-bound-test-token",
      storedAt: INCIDENT.attempt.created_at,
      verifiedAt: INCIDENT.attempt.created_at,
    });
    (globalThis as { __thenceVault?: unknown }).__thenceVault = vault;
    claimSpy.readBackSwap.mockResolvedValue({
      ok: true,
      satoraSwapId: INCIDENT.attachment.satora_swap_id,
      hasRecoveryMaterial: true,
      paymentHash: INCIDENT.attachment.payment_hash,
      evmRefundLocktime: INCIDENT.satora.getSwap.evm_refund_locktime,
    });
    claimSpy.claimStoredSwap.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true, txHash: null, message: "" }), 2_000)),
    );
    renderSend();
    // 30 min of tracking, foreground/background cycles, wake-ups: no claim.
    await advance(10 * 60_000);
    await setVisible(false);
    await advance(5 * 60_000);
    await setVisible(true);
    await advance(10 * 60_000);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    // Explicit owner action, double-clicked.
    const button = screen.getByRole("button", { name: "Finish delivery" });
    fireEvent.click(button);
    fireEvent.click(button);
    await advance(3_000);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    // Server still reports serverfunded; a later click is refused (already submitted).
    await advance(30_000);
    const again = screen.queryByRole("button", { name: "Finish delivery" });
    if (again) fireEvent.click(again);
    await advance(3_000);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
  });
});

async function openActivityDetail(rowName: RegExp): Promise<void> {
  render(<Activity />);
  await advance(0);
  await advance(0);
  const row = screen.getAllByRole("button").find((b) => rowName.test(b.textContent ?? ""));
  expect(row, "activity row").toBeTruthy();
  fireEvent.click(row!);
  await advance(0);
}

describe("Activity — the two real incident payments", () => {
  it("P2: funded 077770a1 in Activity: 'Action needed — Finish delivery' with time left; nothing automatic", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    await openActivityDetail(/They/);
    await advance(3_000);
    expect(screen.getByText("Action needed — Finish delivery")).toBeTruthy();
    expect(document.body.textContent).toContain(`Finish delivery before ${clock(DEADLINE_MS)} — 42 min left`);
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    await advance(5 * 60_000);
    expect(document.body.textContent).toContain("37 min left");
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("P2: funded 077770a1 in Activity inside the unsafe window: no finish action", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 2 * 60_000));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    await openActivityDetail(/They/);
    await advance(3_000);
    expect(screen.getByText("Too close to the delivery deadline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
  });

  it("refunded 077770a1: closed with 'Not delivered — Polygon lock refunded'; no check or finish actions", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "REFUNDED", providerStatus: "clientfundedserverrefunded", observedAt: INCIDENT.observations[1]!.observed_at } });
    await openActivityDetail(/They/);
    expect(screen.getAllByText("Not delivered — Polygon lock refunded").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
  });

  it("stale eddaa6de: before evidence is checked it stays 'checking — do not resend' with no close action", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [STALE.transfer.id]: { status: "RECONCILING", providerStatus: "expired", observedAt: STALE.observations[2]!.observed_at } });
    await openActivityDetail(/Someone new/);
    expect(screen.getAllByText(/Checking your payment — do not resend/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Close expired payment" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await advance(0);
    expect(api.state[STALE.transfer.id]!.status).toBe("RECONCILING");
    expect(screen.queryByRole("button", { name: /Resume payment|Continue to approval|Cancel unpaid payment/ })).toBeNull();
    expect(api.calls.some((c) => c.path.endsWith("/handoff-result") || c.path.endsWith("/close-expired"))).toBe(false);
  });

  // P4 (was it.fails "…can be safely closed"). The action is named "Close
  // expired payment", not "Cancel unpaid payment": this payment was approved,
  // so "cancel" would misdescribe what happened.
  it("P4: an evidence-proven expired-unfunded RECONCILING payment can be safely closed, with honest copy", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [STALE.transfer.id]: { status: "RECONCILING", providerStatus: "expired", observedAt: STALE.observations[2]!.observed_at } });
    await openActivityDetail(/Someone new/);
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await advance(0);
    expect(screen.getByText("Funding evidence: EXPIRED — SAFE TO CLOSE")).toBeTruthy();
    // No contradiction any more: the "do not resend" banner gives way to one clear explanation.
    expect(screen.getByText("This payment expired before any money moved")).toBeTruthy();
    expect(screen.queryByText(/Checking your payment — do not resend/)).toBeNull();
    const closeButton = screen.getByRole("button", { name: "Close expired payment" });
    expect(screen.queryByRole("button", { name: "Cancel unpaid payment" })).toBeNull();

    fireEvent.click(closeButton);
    await advance(0);
    expect(api.count("POST", "/close-expired")).toBe(1);
    expect(api.state[STALE.transfer.id]!.status).toBe("EXPIRED_UNFUNDED");
    expect(screen.getAllByText("Payment expired — not delivered").length).toBeGreaterThan(0);
    expect(screen.getByText(/Closed\. Nothing reached their network/)).toBeTruthy();
    // Never a NIM refund claim; points to Nimiq Pay's own timeout instead.
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Nimiq Pay releases it back to you when its own timeout ends/);
    expect(text).not.toMatch(/NIM (was|has been) refunded|refund(ed)? your NIM/i);
    expect(screen.queryByRole("button", { name: "Close expired payment" })).toBeNull();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("P4: a server refusal keeps the payment open and shows the plain-language reason", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [STALE.transfer.id]: { status: "RECONCILING", providerStatus: "expired", observedAt: STALE.observations[2]!.observed_at } });
    api.closeOutcome = {
      kind: "refused",
      status: 409,
      error: "NIM_FUNDING_RECORDED",
      message: "A NIM payment is recorded for this payment, and Thence can't confirm it came back. It stays open for review.",
    };
    await openActivityDetail(/Someone new/);
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Close expired payment" }));
    await advance(0);
    expect(screen.getByText(/Thence can't confirm it came back\. It stays open for review\./)).toBeTruthy();
    expect(api.state[STALE.transfer.id]!.status).toBe("RECONCILING");
    expect(screen.queryByText("Payment expired — not delivered")).toBeNull();
  });

  it("P4: an already-closed EXPIRED_UNFUNDED payment shows the closed state and no actions", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [STALE.transfer.id]: { status: "EXPIRED_UNFUNDED", providerStatus: "expired", observedAt: "2026-11-03T12:59:00.000Z" } });
    await openActivityDetail(/Someone new/);
    expect(screen.getAllByText("Payment expired — not delivered").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Expired — not delivered").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Check for updates|Close expired payment|Cancel unpaid payment|Finish delivery/ })).toBeNull();
  });
});
