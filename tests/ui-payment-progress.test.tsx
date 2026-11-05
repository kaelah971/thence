// @vitest-environment jsdom
/**
 * Mobile payment UX (2026-11-05 live payment follow-up) — ONE status, ONE
 * timeline, ONE next action, rendered (jsdom + Testing Library).
 *
 * Live evidence: 2c2432af was claimed at 09:31:48Z and reached 256
 * confirmations at 09:38:12Z; the server marked it DELIVERED at 09:38:51Z.
 * At 09:34Z the screen said "Finishing delivery" next to "Action needed —
 * Finish delivery", "On its way", a stale "Payment being checked" notice and a
 * static "Approve the NIM payment" timeline. These tests pin the replacement:
 *
 *   approval → funded → claim needed → claim submitted → finality pending →
 *   Delivered (receipt), plus reload, Activity navigation, visibility changes,
 *   a delayed verifier, no repeat claim, no duplicate payment and no false
 *   Delivered.
 *
 * Fetch is the fixture fake API (tests/ui/fake-api.ts, mirrors the server
 * claim-intent and verify-settlement rules); the browser Satora module is a
 * spy. Nothing here can move money.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, INCIDENT, OWNER_ID, type FakeApi } from "./ui/fake-api";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, string>)}>
      {children}
    </a>
  ),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));
const claimSpy = vi.hoisted(() => ({ claimStoredSwap: vi.fn(), readBackSwap: vi.fn() }));
vi.mock("@/ui/lib/satora-browser", () => claimSpy);
const claimFlag = vi.hoisted(() => ({ on: true }));
vi.mock("@/ui/lib/claim-gate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/claim-gate")>();
  return { ...original, isClaimFlagEnabled: () => claimFlag.on };
});

import { SettlementProgress } from "@/ui/screens/send/SettlementProgress";
import { HandoffStep } from "@/ui/screens/send/SendFlow";
import { Activity } from "@/ui/screens/activity/Activity";
import { ForegroundRefresh, FOREGROUND_REFRESH_SPACING_MS } from "@/ui/components/ForegroundRefresh";
import { resetPaymentTrackersForTests } from "@/ui/lib/payment-tracker";
import { useApiResource } from "@/ui/lib/resource";
import { createMemoryVault, RECOVERY_VAULT_VERSION } from "@/ui/lib/recovery-vault";
import { FINISH_HEADLINE, paymentProgress, VERIFYING_HEADLINE } from "@/ui/lib/payment-progress";
import { pillLabel } from "@/ui/lib/status";

const ID = INCIDENT.transfer.id;
const SWAP = INCIDENT.attachment.satora_swap_id;
const LOCK = INCIDENT.attachment.payment_hash;
const LOCKTIME = INCIDENT.satora.getSwap.evm_refund_locktime;
const APPROVED_AT = INCIDENT.attempt.handoff_authorized_at!;
const FUNDED_SEEN = INCIDENT.observations[0]!.observed_at;
const SUCCESS = { success: true, txHash: `0x${"5c".repeat(32)}`, message: "ok" };

let api: FakeApi;
let hidden = false;

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  hidden = false;
  claimFlag.on = true;
  router.push.mockReset();
  claimSpy.claimStoredSwap.mockReset();
  claimSpy.readBackSwap.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  const vault = createMemoryVault();
  await vault.saveAndVerify({
    version: RECOVERY_VAULT_VERSION,
    transferId: ID,
    satoraSwapId: SWAP,
    paymentHash: LOCK,
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
  claimSpy.readBackSwap.mockResolvedValue({ ok: true, satoraSwapId: SWAP, hasRecoveryMaterial: true, paymentHash: LOCK, evmRefundLocktime: LOCKTIME });
});

afterEach(() => {
  cleanup();
  resetPaymentTrackersForTests();
  api?.restore();
  (globalThis as { __thenceVault?: unknown }).__thenceVault = undefined;
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function setVisible(visible: boolean): Promise<void> {
  hidden = !visible;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function renderSend() {
  return render(
    <SettlementProgress transferId={ID} ownerUserId={OWNER_ID} requestPublicId={null} sessionValid previewMode={false} routeId="usdc-polygon" asset="USDC" saveOffer={null} />,
  );
}

const text = () => document.body.textContent ?? "";
const finishButtons = () => screen.queryAllByRole("button", { name: "Finish delivery" });
const timelines = () => document.querySelectorAll("ol").length;
const delivered = () => /View on Polygon/.test(text());

/** One status headline is on screen, never contradicted by another status card. */
function expectOnlyHeadline(headline: string): void {
  expect(screen.getAllByText(headline)).toHaveLength(1);
  for (const other of ["Payment on its way", "On its way", "Still on its way", "What happens after you approve", "Payment being checked", "Finishing delivery"]) {
    expect(screen.queryByText(other), `stale status "${other}"`).toBeNull();
  }
}

describe("payment progress model — one message per state", () => {
  const base = { phase: "on-its-way", transferStatus: "SERVER_FUNDED", providerStatus: "serverfunded", claimReady: true, receiptReady: false };

  it("funded and claimable: the owner's tap is the action, never 'on its way'", () => {
    const v = paymentProgress(base);
    expect(v.headline).toBe(FINISH_HEADLINE);
    expect(v.action).toBe("finish");
    expect(v.steps?.map((s) => s.state)).toEqual(["done", "current", "upcoming", "upcoming"]);
  });

  it("claim submitted here: verifying, no second tap — even while the provider still says funded", () => {
    const v = paymentProgress({ ...base, transferStatus: "CLAIMING", phase: "finishing", claimPending: true });
    expect(v.headline).toBe(VERIFYING_HEADLINE);
    expect(v.action).toBe("verifying");
    expect(v.steps?.map((s) => s.state)).toEqual(["done", "done", "current", "upcoming"]);
  });

  it("finality pending (the 10:34 state): says it is waiting for confirmations, not 'almost there'", () => {
    const v = paymentProgress({ ...base, transferStatus: "CLAIMING", phase: "finishing", providerStatus: "serverredeemed", claimReady: false, verifyVerdict: "INSUFFICIENT_CONFIRMATIONS" });
    expect(v.headline).toBe(VERIFYING_HEADLINE);
    expect(v.body).toMatch(/Waiting for confirmations/);
    expect(v.action).toBe("verifying");
  });

  it("claim landed on another device (no local record): verifying, not Finish delivery", () => {
    expect(paymentProgress({ ...base, transferStatus: "CLAIMING", phase: "finishing", providerStatus: "clientredeemed", claimReady: false }).action).toBe("verifying");
  });

  it("server re-allows ONE retry after an unknown outcome: Finish delivery again (gates still decide the button)", () => {
    expect(paymentProgress({ ...base, transferStatus: "CLAIMING", phase: "finishing", claimReady: true, claimPending: false }).action).toBe("finish");
  });

  it("Delivered only for DELIVERED; never from approval, funding, claim or a verdict alone", () => {
    for (const transferStatus of ["LIGHTNING_HANDOFF", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"]) {
      const v = paymentProgress({ ...base, transferStatus, phase: "finishing", verifyVerdict: "VERIFIED" });
      expect(v.headline).not.toBe("Delivered");
      expect(v.steps?.at(-1)?.state).not.toBe("done");
    }
    expect(paymentProgress({ ...base, transferStatus: "DELIVERED", phase: "delivered", receiptReady: true }).action).toBe("receipt");
  });

  it("chain evidence contradicting the payment is attention, never 'verifying'", () => {
    expect(paymentProgress({ ...base, transferStatus: "CLAIMING", phase: "finishing", claimPending: true, verifyVerdict: "INVALID" }).headline).toBe("Payment needs attention");
  });

  it("list pills: funded-before-claim and claimed states never say 'On its way'", () => {
    expect(pillLabel("CLIENT_FUNDED")).toBe("Preparing delivery");
    expect(pillLabel("SERVER_FUNDED")).toBe("Finish delivery needed");
    expect(pillLabel("CLAIMING")).toBe("Verifying delivery");
  });
});

describe("Send: approval → funded → claim needed → claim submitted → finality pending → Delivered", () => {
  it("one headline and one timeline at every step; exactly one claim; Delivered only after the verifier confirms finality", async () => {
    vi.setSystemTime(new Date(APPROVED_AT));
    api = installFakeApi({ [ID]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: APPROVED_AT } });
    renderSend();
    await advance(0);
    expectOnlyHeadline("Confirming your approval");
    expect(timelines()).toBe(1);
    expect(finishButtons()).toHaveLength(0);

    // Lightning arrived at the provider: still nothing to tap, but the owner is told the tap is coming.
    api.set(ID, { status: "CLIENT_FUNDED", providerStatus: "clientfunded", observedAt: APPROVED_AT });
    await advance(5_000);
    expectOnlyHeadline("Payment received — preparing delivery");
    expect(text()).toMatch(/tap Finish delivery in a moment/);
    expect(finishButtons()).toHaveLength(0);

    // Funded on Polygon: action required, real deadline countdown, ONE button.
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api.set(ID, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN });
    await advance(15_000);
    expectOnlyHeadline(FINISH_HEADLINE);
    expect(text()).toMatch(/Finish delivery before \d{1,2}:\d{2}.* — \d+ min left/);
    expect(text()).toMatch(/Only this device can do it/);
    expect(finishButtons()).toHaveLength(1);
    expect(timelines()).toBe(1);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled(); // never on its own

    // Owner taps once; the claim is submitted.
    claimSpy.claimStoredSwap.mockResolvedValue(SUCCESS);
    api.settlementVerdict = "PENDING";
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expectOnlyHeadline(VERIFYING_HEADLINE);
    expect(finishButtons()).toHaveLength(0);
    expect(screen.queryByText(FINISH_HEADLINE)).toBeNull();

    // Mined but below 256 confirmations for several minutes (the 10:34 state).
    api.set(ID, { status: "CLAIMING", providerStatus: "serverredeemed", observedAt: FUNDED_SEEN });
    api.settlementVerdict = "INSUFFICIENT_CONFIRMATIONS";
    await advance(60_000);
    expectOnlyHeadline(VERIFYING_HEADLINE);
    expect(text()).toMatch(/Waiting for confirmations/);
    await advance(5 * 60_000);
    expect(delivered()).toBe(false); // no false Delivered while finality is pending
    expect(finishButtons()).toHaveLength(0); // no repeat claim offered
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(api.count("POST", "/verify-settlement")).toBeGreaterThan(2); // the verifier keeps being asked

    // Finality reached: the verifier confirms → DELIVERED → receipt.
    api.settlementVerdict = "VERIFIED";
    await advance(35_000);
    await advance(0);
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    expect(delivered()).toBe(true);
    expect(timelines()).toBe(0); // the receipt replaces the progress timeline
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    // No new payment, swap or approval was ever requested.
    expect(api.calls.filter((c) => c.method === "POST" && /\/(prepare|attach|authorize-handoff)$|^\/api\/transfers$/.test(c.path))).toHaveLength(0);
  });

  it("reload while finality is pending: rebuilt from the server, still verifying, no second claim offered", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    const first = renderSend();
    await advance(3_000);
    claimSpy.claimStoredSwap.mockResolvedValue(SUCCESS);
    api.settlementVerdict = "INSUFFICIENT_CONFIRMATIONS";
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    api.set(ID, { status: "CLAIMING", providerStatus: "serverredeemed", observedAt: FUNDED_SEEN });
    first.unmount();
    resetPaymentTrackersForTests();

    renderSend(); // fresh mount = reload: nothing restored from React state
    await advance(3_000);
    expectOnlyHeadline(VERIFYING_HEADLINE);
    expect(finishButtons()).toHaveLength(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
  });

  it("hidden page stops polling; returning to the foreground refreshes at once and shows Delivered", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "CLAIMING", providerStatus: "serverredeemed", observedAt: FUNDED_SEEN } });
    api.settlementVerdict = "INSUFFICIENT_CONFIRMATIONS";
    renderSend();
    await advance(3_000);
    expectOnlyHeadline(VERIFYING_HEADLINE);
    await setVisible(false); // owner switches to their wallet app
    const reads = api.count("GET", "/reconciliation");
    api.settlementVerdict = "VERIFIED";
    await advance(5 * 60_000);
    expect(api.count("GET", "/reconciliation")).toBe(reads); // no background polling
    expect(delivered()).toBe(false);
    await setVisible(true);
    await advance(3_000);
    await advance(0);
    expect(delivered()).toBe(true);
  });

  it("delayed verifier (Polygon RPC unavailable) never shows Delivered or a new Finish delivery; recovers when it answers", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "CLAIMING", providerStatus: "serverredeemed", observedAt: FUNDED_SEEN } });
    api.settlementVerdict = "UNAVAILABLE";
    renderSend();
    await advance(60_000);
    expectOnlyHeadline(VERIFYING_HEADLINE);
    expect(text()).toMatch(/couldn't be checked just now/);
    expect(delivered()).toBe(false);
    expect(finishButtons()).toHaveLength(0);
    api.settlementVerdict = "VERIFIED";
    await advance(35_000);
    await advance(0);
    expect(delivered()).toBe(true);
  });

  it("double tap: one claim attempt only", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    renderSend();
    await advance(3_000);
    let release: (v: typeof SUCCESS) => void = () => undefined;
    claimSpy.claimStoredSwap.mockReturnValue(new Promise((r) => (release = r)));
    const button = finishButtons()[0]!;
    fireEvent.click(button);
    fireEvent.click(button);
    await advance(0);
    await advance(0);
    release(SUCCESS);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(api.count("POST", "/claim-intent")).toBe(1);
  });
});

describe("Activity reflects the verified state without a stale snapshot", () => {
  it("finality pending in Activity: verifying, no Finish delivery; Delivered appears in the list without reopening", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "CLAIMING", providerStatus: "serverredeemed", observedAt: FUNDED_SEEN } });
    api.settlementVerdict = "INSUFFICIENT_CONFIRMATIONS";
    render(<Activity />);
    await advance(0);
    await advance(0);
    expect(screen.getAllByText("Verifying delivery").length).toBeGreaterThan(0);
    const row = screen.getAllByRole("button").find((b) => /They/.test(b.textContent ?? ""));
    fireEvent.click(row!);
    await advance(3_000);
    expect(screen.getAllByText(VERIFYING_HEADLINE).length).toBe(1);
    expect(finishButtons()).toHaveLength(0);
    expect(screen.queryByText("Still on its way")).toBeNull();

    const listGets = () => api.calls.filter((c) => c.method === "GET" && /^\/api\/transfers(\?|$)/.test(c.path)).length;
    const listReads = listGets();
    api.settlementVerdict = "VERIFIED";
    await advance(35_000);
    await advance(0);
    // The tracker saw CLAIMING → DELIVERED and re-read the mounted list (no reopen, no reload).
    expect(listGets()).toBeGreaterThan(listReads);
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    expect(screen.queryByText("Verifying delivery")).toBeNull();
  });
});

describe("foreground refresh", () => {
  function Probe({ onLoad }: { onLoad: () => void }) {
    const r = useApiResource("probe", async () => {
      onLoad();
      return { ok: true as const, status: 200, data: 1 };
    });
    return <span>{r.status}</span>;
  }

  it("re-reads mounted data when the app returns to the foreground, coalescing bursts", async () => {
    const onLoad = vi.fn();
    render(
      <>
        <ForegroundRefresh />
        <Probe onLoad={onLoad} />
      </>,
    );
    await advance(0);
    expect(onLoad).toHaveBeenCalledTimes(1);
    await advance(FOREGROUND_REFRESH_SPACING_MS + 1);
    await setVisible(false);
    await setVisible(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(0);
    expect(onLoad).toHaveBeenCalledTimes(2); // visibility + focus burst = one refresh
    await setVisible(true);
    await advance(0);
    expect(onLoad).toHaveBeenCalledTimes(2); // within the spacing window
  });
});

describe("approval sheet structure", () => {
  const prepared = { phase: "ready" as const, transferId: ID, sourceSats: "380", invoiceBolt11: "lnbc1test", statusLabel: "Approve in Nimiq Pay" };
  function sheet(handoffPhase: "ready" | "checking", onDone = vi.fn(), onBack = vi.fn()) {
    const handoff = {
      state: handoffPhase === "ready" ? { phase: "ready" as const, transferId: ID } : { phase: "checking" as const, transferId: ID, message: "Payment being checked. Do not resend." },
      invoke: vi.fn(),
      resume: vi.fn(),
      reset: vi.fn(),
    } as unknown as Parameters<typeof HandoffStep>[0]["handoff"];
    render(
      <HandoffStep
        payeeName="Okx"
        amount="0.30"
        assetLabel="USDC"
        routeId="usdc-polygon"
        asset="USDC"
        requestPublicId={null}
        saveOffer={null}
        preparation={prepared}
        handoff={handoff}
        ownerUserId={OWNER_ID}
        sessionValid
        previewMode={false}
        onRetry={vi.fn()}
        onBack={onBack}
        onRequote={vi.fn()}
        onAcceptReprice={vi.fn()}
        onDone={onDone}
      />,
    );
    return { onDone, onBack };
  }

  it("before approval: one Confirm action, back to review allowed, no progress timeline", async () => {
    vi.setSystemTime(new Date(INCIDENT.attempt.created_at));
    api = installFakeApi({ [ID]: { status: "AWAITING_NIM_APPROVAL", providerStatus: "pending", observedAt: INCIDENT.attempt.created_at } });
    sheet("ready");
    await advance(0);
    expect(screen.getByRole("button", { name: "Confirm in Nimiq Pay" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to review" })).toBeTruthy();
    expect(screen.queryByText("What happens after you approve")).toBeNull();
    expect(timelines()).toBe(0);
  });

  it("after approval: no duplicate timeline, no stale 'being checked', no Back to review; Finish delivery is the footer action; Done goes to Activity", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    const { onDone } = sheet("checking");
    await advance(3_000);
    expect(screen.queryByText("What happens after you approve")).toBeNull();
    expect(screen.queryByText("Payment being checked")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm in Nimiq Pay" })).toBeNull();
    expect(timelines()).toBe(1);
    expectOnlyHeadline(FINISH_HEADLINE);
    expect(finishButtons()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/app/activity");
    // Done never implies delivery: no receipt/proof, and the payment still needs the owner's tap.
    expect(delivered()).toBe(false);
    expect(document.querySelector("[data-progress-action]")?.getAttribute("data-progress-action")).toBe("finish");
  });
});

describe("a payment waiting for Finish delivery keeps its action", () => {
  it("survives backgrounding, leaving the screen (Send → Activity) and a reload; nothing claims on its own", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    const send = renderSend();
    await advance(3_000);
    expectOnlyHeadline(FINISH_HEADLINE);
    expect(finishButtons()).toHaveLength(1);

    // Backgrounded for 10 minutes (another app, locked phone).
    await setVisible(false);
    await advance(10 * 60_000);
    await setVisible(true);
    await advance(3_000);
    expectOnlyHeadline(FINISH_HEADLINE);
    expect(finishButtons()).toHaveLength(1);
    expect(text()).toMatch(/Finish delivery before .* min left/);

    // Navigate away (Done → Activity): the same action is offered there.
    send.unmount();
    resetPaymentTrackersForTests();
    const activity = render(<Activity />);
    await advance(0);
    await advance(0);
    const row = screen.getAllByRole("button").find((b) => /They/.test(b.textContent ?? ""));
    fireEvent.click(row!);
    await advance(3_000);
    expect(screen.getAllByText(FINISH_HEADLINE)).toHaveLength(1);
    expect(finishButtons()).toHaveLength(1);

    // Reload: rebuilt from the server, still waiting for the owner's tap.
    activity.unmount();
    resetPaymentTrackersForTests();
    renderSend();
    await advance(3_000);
    expectOnlyHeadline(FINISH_HEADLINE);
    expect(finishButtons()).toHaveLength(1);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
  });

  it("Delivered is never shown without the server's on-chain proof, whatever the provider or the chain verdict says", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    // Provider already reports the claim settled and the verifier says VERIFIED,
    // but the server has NOT written DELIVERED (no proof row yet).
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverredeemed", observedAt: FUNDED_SEEN } });
    api.settlementVerdict = "INSUFFICIENT_CONFIRMATIONS";
    renderSend();
    await advance(60_000);
    expect(delivered()).toBe(false);
    expect(screen.queryAllByText("Delivered").filter((el) => el.closest("[role=status]"))).toHaveLength(0);
    // The receipt endpoint is only asked once the server status is DELIVERED.
    expect(api.count("GET", "/receipt")).toBe(0);
  });
});

describe("approval sheet right after Nimiq Pay returns (server not caught up yet)", () => {
  it("never shows an empty sheet: says it is confirming the approval, not 'Approve in Nimiq Pay'", async () => {
    vi.setSystemTime(new Date(APPROVED_AT));
    api = installFakeApi({ [ID]: { status: "AWAITING_NIM_APPROVAL", providerStatus: "pending", observedAt: APPROVED_AT } });
    const handoff = {
      state: { phase: "checking" as const, transferId: ID, message: "Payment being checked. Do not resend." },
      invoke: vi.fn(),
      resume: vi.fn(),
      reset: vi.fn(),
    } as unknown as Parameters<typeof HandoffStep>[0]["handoff"];
    render(
      <HandoffStep
        payeeName="They"
        amount="0.3"
        assetLabel="USDC"
        routeId="usdc-polygon"
        asset="USDC"
        requestPublicId={null}
        saveOffer={null}
        preparation={{ phase: "ready", transferId: ID, sourceSats: "380", invoiceBolt11: "lnbc1test", statusLabel: "x" }}
        handoff={handoff}
        ownerUserId={OWNER_ID}
        sessionValid
        previewMode={false}
        onRetry={vi.fn()}
        onBack={vi.fn()}
        onRequote={vi.fn()}
        onAcceptReprice={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    // Before the first server read lands: a visible checking state, not a blank sheet.
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    await advance(3_000);
    expectOnlyHeadline("Confirming your approval");
    expect(screen.queryByText("Approve in Nimiq Pay", { selector: "p" })).toBeTruthy(); // timeline step label only
    expect(text()).toMatch(/To their wallet on Polygon/);
  });
});
