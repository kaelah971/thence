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
 * Convention (no fixes in this milestone):
 * - `it(...)` characterizes today's behavior and passes.
 * - `it.fails(...)` states REQUIRED behavior that is expected to fail until
 *   the named plan step (P1/P2/P4) lands; a fix flips it and forces removal
 *   of the marker in the fixing change.
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

import { SettlementProgress } from "@/ui/screens/send/SettlementProgress";
import { Activity } from "@/ui/screens/activity/Activity";

const DEADLINE_MS = INCIDENT.satora.getSwap.evm_refund_locktime * 1000;
const FIRST_OBSERVED = INCIDENT.observations[0]!.observed_at; // 21:30:26Z, serverfunded
/** Anything that tells the owner when the claim window closes. */
const DEADLINE_COPY = /deadline|time left|minutes? left|before \d{1,2}:\d{2}|expires? (at|in)|\b\d{1,2}:\d{2}\b.*(left|remaining)/i;

let api: FakeApi;
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
  api?.restore();
  vi.useRealTimers();
});

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
  it("after approval the funded swap reads as 'on its way' with a manual-only action and no deadline; nothing claims on its own", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.handoff_authorized_at!));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: INCIDENT.attempt.handoff_authorized_at! } });
    renderSend();
    await advance(0);
    expect(screen.getAllByText("Payment on its way").length).toBeGreaterThan(0);

    // Provider funds the Polygon HTLC (real: block 96632367, 21:13:27Z).
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(3_000);
    expect(screen.getAllByText("Payment on its way").length).toBeGreaterThan(0);
    // Customer copy implies Thence is completing delivery by itself…
    expect(screen.getAllByText(/Thence is moving it to their wallet now/).length).toBeGreaterThan(0);
    // …but completion actually needs an explicit owner click.
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    // No deadline anywhere, although the refund locktime is fixed and near.
    expect(document.body.textContent ?? "").not.toMatch(DEADLINE_COPY);

    // Ten minutes of tracking: the UI never claims on its own.
    await advance(10 * 60_000);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.calls.some((c) => /claim|cancel|handoff-result|prepare|attach|authorize/.test(c.path))).toBe(false);
  });

  it("while funded, polling never backs off: the round counter is stuck at 0 (every 3 s, indefinitely)", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    const start = api.count("POST", "/reconcile");
    await advance(60_000);
    expect(api.count("POST", "/reconcile") - start).toBeGreaterThanOrEqual(19);
  });

  it.fails("REQUIRED (P1): tracking follows the bounded backoff (≤ 8 provider refreshes per minute)", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    const start = api.count("POST", "/reconcile");
    await advance(60_000);
    expect(api.count("POST", "/reconcile") - start).toBeLessThanOrEqual(8);
  });

  it("backgrounding the app for more than 12 s stops tracking permanently, even after returning", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    hidden = true; // user switches to Nimiq Pay / locks the phone
    await advance(3_000 + 13_000);
    const beforeReturn = api.count("POST", "/reconcile");
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(5 * 60_000);
    expect(api.count("POST", "/reconcile")).toBe(beforeReturn);
  });

  it.fails("REQUIRED (P1): tracking resumes when the app becomes visible again", async () => {
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

  it.fails("REQUIRED (P2): while claim-ready, the owner sees that action is needed before a deadline", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(3_000);
    expect(document.body.textContent ?? "").toMatch(DEADLINE_COPY);
  });

  it("after the deadline passes unclaimed, the provider refunds and the screen ends at 'Payment refunded'", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 5 * 60_000));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    renderSend();
    await advance(0);
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    // Real: refund tx 0x57c4…851b mined 22:16:54Z; Thence observed it at 12:32Z the next day.
    api.set(INCIDENT.transfer.id, { status: "REFUNDED", providerStatus: "clientfundedserverrefunded", observedAt: INCIDENT.observations[1]!.observed_at });
    await advance(10 * 60_000);
    expect(screen.getAllByText("Payment refunded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("The provider refunded this payment. No delivery was confirmed.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    // Polling stops at the terminal state.
    const settled = api.count("POST", "/reconcile");
    await advance(60_000);
    expect(api.count("POST", "/reconcile")).toBe(settled);
  });

  it("if mounted while still AWAITING_NIM_APPROVAL, the screen reads once and never polls again", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.created_at));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "AWAITING_NIM_APPROVAL", providerStatus: "pending", observedAt: INCIDENT.attempt.created_at } });
    renderSend();
    await advance(0);
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(0);
    const reads = api.count("GET", "/reconciliation");
    // Approval and funding happen; the mounted screen does not notice.
    api.set(INCIDENT.transfer.id, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED });
    await advance(30 * 60_000);
    expect(api.count("GET", "/reconciliation")).toBe(reads);
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(0);
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
  it("funded 077770a1 during its window: one-time manual finish offered, no deadline shown, nothing automatic", async () => {
    vi.setSystemTime(new Date(FIRST_OBSERVED));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FIRST_OBSERVED } });
    await openActivityDetail(/They/);
    await advance(3_000);
    expect(screen.getByText("Ready to finish delivery")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish delivery" })).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(DEADLINE_COPY);
    await advance(5 * 60_000);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("refunded 077770a1: closed with 'Payment refunded — no delivery'; no check or finish actions", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [INCIDENT.transfer.id]: { status: "REFUNDED", providerStatus: "clientfundedserverrefunded", observedAt: INCIDENT.observations[1]!.observed_at } });
    await openActivityDetail(/They/);
    expect(screen.getAllByText("Payment refunded — no delivery").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish delivery" })).toBeNull();
  });

  it("stale eddaa6de: evidence says 'EXPIRED — SAFE TO CLOSE' while the payment says 'do not resend' and offers no way to close", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [STALE.transfer.id]: { status: "RECONCILING", providerStatus: "expired", observedAt: STALE.observations[2]!.observed_at } });
    await openActivityDetail(/Someone new/);
    expect(screen.getAllByText(/Checking your payment — do not resend/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await advance(0);
    expect(api.state[STALE.transfer.id]!.status).toBe("RECONCILING");

    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await advance(0);
    expect(screen.getByText("Funding evidence: EXPIRED — SAFE TO CLOSE")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel unpaid payment" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Resume payment|Continue to approval/ })).toBeNull();
    expect(api.calls.some((c) => c.path.endsWith("/handoff-result"))).toBe(false);
  });

  it.fails("REQUIRED (P4): an evidence-proven expired-unfunded RECONCILING payment can be safely closed", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [STALE.transfer.id]: { status: "RECONCILING", providerStatus: "expired", observedAt: STALE.observations[2]!.observed_at } });
    await openActivityDetail(/Someone new/);
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await advance(0);
    expect(screen.getByRole("button", { name: "Cancel unpaid payment" })).toBeTruthy();
  });
});
