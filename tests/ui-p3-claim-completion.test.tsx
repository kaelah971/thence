// @vitest-environment jsdom
/**
 * P3 — reliable payment completion, rendered (jsdom + Testing Library).
 *
 * Replays the REAL 2026-11-02 failure path of 077770a1 (approval 21:12:48Z,
 * Polygon funding observed 21:30:26Z, claim deadline 22:12:42Z, refund
 * 22:16:54Z) through the real Send settlement screen, the real Activity
 * screen, the real P1 tracker and the real useSettlement claim path — and
 * this time the owner can finish delivery before the deadline:
 *
 *   approval → funding → Finish delivery visible (deadline shown) → explicit
 *   owner click → server claim authorization (claim-intent) → browser SDK
 *   claim → claim outcome checked → on-chain delivery verified → DELIVERED
 *   with a receipt, and only then.
 *
 * No network, no wallet, no provider: fetch is the fixture fake API
 * (tests/ui/fake-api.ts, which mirrors src/lib/claim-intent.ts); the browser
 * Satora module is a spy. The claim tx and receipt are SYNTHETIC (Nov 2 never
 * had a claim) and labelled as such. Nothing here can move money.
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

const claimSpy = vi.hoisted(() => ({ claimStoredSwap: vi.fn(), readBackSwap: vi.fn() }));
vi.mock("@/ui/lib/satora-browser", () => claimSpy);
const claimFlag = vi.hoisted(() => ({ on: true }));
vi.mock("@/ui/lib/claim-gate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/claim-gate")>();
  return { ...original, isClaimFlagEnabled: () => claimFlag.on };
});

import { SettlementProgress } from "@/ui/screens/send/SettlementProgress";
import { Activity } from "@/ui/screens/activity/Activity";
import { resetPaymentTrackersForTests } from "@/ui/lib/payment-tracker";
import { createMemoryVault, RECOVERY_VAULT_VERSION } from "@/ui/lib/recovery-vault";
import { UNKNOWN_CLAIM_VERIFY_DELAY_MS } from "@/ui/screens/send/useSettlement";

const ID = INCIDENT.transfer.id;
const SWAP = INCIDENT.attachment.satora_swap_id;
const LOCK = INCIDENT.attachment.payment_hash;
const LOCKTIME = INCIDENT.satora.getSwap.evm_refund_locktime;
const DEADLINE_MS = LOCKTIME * 1000;
const APPROVED_AT = INCIDENT.attempt.handoff_authorized_at!; // 21:12:48Z
const FUNDED_SEEN = INCIDENT.observations[0]!.observed_at; // 21:30:26Z, serverfunded
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
  claimSpy.claimStoredSwap.mockReset();
  claimSpy.readBackSwap.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  await installVault();
  claimSpy.readBackSwap.mockResolvedValue({ ok: true, satoraSwapId: SWAP, hasRecoveryMaterial: true, paymentHash: LOCK, evmRefundLocktime: LOCKTIME });
});

afterEach(() => {
  cleanup();
  resetPaymentTrackersForTests();
  api?.restore();
  (globalThis as { __thenceVault?: unknown }).__thenceVault = undefined;
  vi.useRealTimers();
});

/** The owner's own recovery binding, saved (and read back) before Nimiq Pay was opened. */
async function installVault(over: Partial<{ satoraSwapId: string; destination: string; targetAtomic: string; ownerUserId: string }> = {}) {
  const vault = createMemoryVault();
  await vault.saveAndVerify({
    version: RECOVERY_VAULT_VERSION,
    transferId: ID,
    satoraSwapId: over.satoraSwapId ?? SWAP,
    paymentHash: LOCK,
    sourceSats: INCIDENT.attachment.source_sats,
    targetAtomic: over.targetAtomic ?? INCIDENT.transfer.target_amount_atomic,
    destination: over.destination ?? INCIDENT.transfer.destination,
    routeId: INCIDENT.transfer.route_id,
    quoteRevision: 1,
    ownerUserId: over.ownerUserId ?? OWNER_ID,
    attemptToken: "owner-bound-test-token",
    storedAt: INCIDENT.attempt.created_at,
    verifiedAt: INCIDENT.attempt.created_at,
  });
  (globalThis as { __thenceVault?: unknown }).__thenceVault = vault;
}

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

async function openActivityDetail(): Promise<void> {
  render(<Activity />);
  await advance(0);
  await advance(0);
  const row = screen.getAllByRole("button").find((b) => /They/.test(b.textContent ?? ""));
  expect(row, "activity row").toBeTruthy();
  fireEvent.click(row!);
  await advance(0);
}

const text = () => document.body.textContent ?? "";
const finishButtons = () => screen.queryAllByRole("button", { name: "Finish delivery" });
/** Order of the requests that matter, for asserting what preceded the claim. */
const posts = () => api.calls.filter((c) => c.method === "POST").map((c) => c.path.split("/").pop());

function fundedServer(): void {
  api.set(ID, { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN });
}

describe("P3: the Nov 2 failure path now completes — explicit Finish delivery, verified delivery", () => {
  it("approval → funding → Finish delivery before the deadline → claim checked → USDC verified → DELIVERED only with proof", async () => {
    vi.setSystemTime(new Date(APPROVED_AT));
    api = installFakeApi({ [ID]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: APPROVED_AT } });
    renderSend();
    await advance(0);
    // Back from Nimiq Pay (host webview hidden while approving, then visible).
    await setVisible(false);
    await advance(60_000);
    await setVisible(true);
    await advance(0);
    expect(finishButtons()).toHaveLength(0);

    // Satora funds the Polygon HTLC; the original browser learns it from the tracker.
    vi.setSystemTime(new Date(FUNDED_SEEN));
    fundedServer();
    await advance(15_000);
    expect(screen.getAllByText("Action needed — Finish delivery").length).toBeGreaterThan(0);
    expect(text()).toContain(`Finish delivery before ${clock(DEADLINE_MS)}`);
    expect(finishButtons()).toHaveLength(1);
    // Funding alone is never delivery.
    expect(text()).not.toMatch(/\bDelivered\b/);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();

    claimSpy.claimStoredSwap.mockResolvedValue({ success: true, txHash: `0x${"5c".repeat(32)}`, message: "ok" });
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledWith(SWAP);
    // The server authorized THIS attempt immediately before the SDK claim.
    expect(posts()).toContain("claim-intent");
    expect(api.state[ID]!.status).toBe("CLAIMING");
    // Claim outcome is checked, not trusted: "confirming", no second button, not Delivered.
    expect(screen.getAllByText("Delivery submitted — confirming it arrived").length).toBeGreaterThan(0);
    expect(finishButtons()).toHaveLength(0);
    expect(text()).not.toMatch(/They received the exact amount/);

    // The provider reports the claim; the chain does not show the USDC yet.
    api.set(ID, { providerStatus: "clientredeemed" });
    api.settlementVerdict = "INSUFFICIENT_CONFIRMATIONS";
    await advance(60_000);
    expect(api.state[ID]!.status).toBe("CLAIMING");
    expect(text()).not.toMatch(/They received the exact amount/);
    expect(api.count("POST", "/verify-settlement")).toBeGreaterThan(0);

    // Independent on-chain verification succeeds → DELIVERED with a receipt.
    api.settlementVerdict = "VERIFIED";
    await advance(60_000);
    expect(api.state[ID]!.status).toBe("DELIVERED");
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    expect(screen.getByText("Receipt")).toBeTruthy();
    expect(screen.getByRole("link", { name: /View on Polygon/ })).toBeTruthy();
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    // Well before the real deadline.
    expect(Date.now()).toBeLessThan(DEADLINE_MS - 5 * 60_000);
  });

  it("Activity: funding that lands while the detail is open surfaces Finish delivery there, and finishing works from Activity", async () => {
    vi.setSystemTime(new Date(APPROVED_AT));
    api = installFakeApi({ [ID]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: APPROVED_AT } });
    await openActivityDetail();
    expect(finishButtons()).toHaveLength(0);
    vi.setSystemTime(new Date(FUNDED_SEEN));
    fundedServer();
    await advance(15_000);
    expect(finishButtons()).toHaveLength(1);
    expect(text()).toContain(`Finish delivery before ${clock(DEADLINE_MS)}`);
    claimSpy.claimStoredSwap.mockResolvedValue({ success: true, txHash: `0x${"5c".repeat(32)}`, message: "ok" });
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(finishButtons()).toHaveLength(0);
  });

  it("the Activity list says the owner must act ('Finish delivery needed'), never 'On its way'", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    render(<Activity />);
    await advance(0);
    await advance(0);
    expect(screen.getAllByText("Finish delivery needed").length).toBeGreaterThan(0);
    expect(screen.queryByText("On its way")).toBeNull();
  });
});

describe("P3: interruptions keep claim eligibility and never double-claim", () => {
  it("backgrounded during funding: on return the action is there at once", async () => {
    vi.setSystemTime(new Date(APPROVED_AT));
    api = installFakeApi({ [ID]: { status: "LIGHTNING_HANDOFF", providerStatus: "pending", observedAt: APPROVED_AT } });
    renderSend();
    await advance(0);
    await setVisible(false);
    vi.setSystemTime(new Date(FUNDED_SEEN));
    fundedServer();
    await advance(10 * 60_000);
    expect(finishButtons()).toHaveLength(0); // hidden: no polling
    await setVisible(true);
    await advance(3_000);
    expect(finishButtons()).toHaveLength(1);
  });

  it("reload before finishing keeps eligibility (vault binding untouched); reload after a submitted claim offers no second attempt", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    const first = renderSend();
    await advance(3_000);
    expect(finishButtons()).toHaveLength(1);
    first.unmount();
    resetPaymentTrackersForTests();
    renderSend();
    await advance(3_000);
    expect(finishButtons()).toHaveLength(1);

    claimSpy.claimStoredSwap.mockResolvedValue({ success: true, txHash: null, message: "submitted" });
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    cleanup();
    resetPaymentTrackersForTests();
    renderSend();
    await advance(3_000);
    expect(finishButtons()).toHaveLength(0);
    expect(screen.getAllByText("Delivery submitted — confirming it arrived").length).toBeGreaterThan(0);
    await advance(5 * 60_000);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
  });

  it("Send and Activity mounted together, both clicked at once: exactly one claim", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    claimSpy.claimStoredSwap.mockImplementation(() => new Promise((r) => setTimeout(() => r({ success: true, txHash: null, message: "" }), 2_000)));
    renderSend();
    await openActivityDetail();
    await advance(3_000);
    const buttons = finishButtons();
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    await advance(3_000);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(api.count("POST", "/claim-intent")).toBe(1);
  });

  it("another tab or device already holds the claim lease: refused with a clear reason, no claim here", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    api.claimLeaseUntil[ID] = Date.now() + 3 * 60_000;
    renderSend();
    await advance(3_000);
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(text()).toContain("A delivery attempt was just authorized for this payment");
  });

  it("unknown claim outcome: no blind retry; after verification and the server lease, one explicit retry is allowed", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    renderSend();
    await advance(3_000);
    claimSpy.claimStoredSwap.mockRejectedValueOnce(new Error("Network lost."));
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(finishButtons()).toHaveLength(0);
    expect(text()).toMatch(/do not resend/i);
    // Verification round runs; the provider still shows serverfunded with no claim.
    api.settlementVerdict = "PENDING";
    await advance(UNKNOWN_CLAIM_VERIFY_DELAY_MS + 15_000);
    expect(api.count("POST", "/verify-settlement")).toBeGreaterThan(0);
    // The button may return, but the server lease still refuses inside 3 min.
    const early = finishButtons()[0];
    if (early) {
      fireEvent.click(early);
      await advance(0);
      await advance(0);
      expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(1);
    }
    await advance(3 * 60_000);
    claimSpy.claimStoredSwap.mockResolvedValueOnce({ success: true, txHash: `0x${"5c".repeat(32)}`, message: "ok" });
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).toHaveBeenCalledTimes(2);
  });
});

describe("P3: every safety gate blocks before anything is revealed", () => {
  async function fundedAndClick(): Promise<void> {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    renderSend();
    await advance(3_000);
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
  }

  it("recovery material for a different swap: blocked, no server authorization, no claim", async () => {
    await installVault({ satoraSwapId: "another-swap" });
    await fundedAndClick();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
    expect(text()).toContain("Recovery information doesn't match. Do not continue.");
  });

  it("recovery material for a different destination or amount: blocked", async () => {
    await installVault({ destination: "0x0000000000000000000000000000000000000bad" });
    await fundedAndClick();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(text()).toContain("This payment is for a different wallet.");
  });

  it("SDK readback with a different payment hash or deadline: blocked", async () => {
    claimSpy.readBackSwap.mockResolvedValue({ ok: true, satoraSwapId: SWAP, hasRecoveryMaterial: true, paymentHash: `0x${"ab".repeat(32)}`, evmRefundLocktime: LOCKTIME });
    await fundedAndClick();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
  });

  it("recovery material missing in this browser (another device): blocked with the reason", async () => {
    claimSpy.readBackSwap.mockResolvedValue({ ok: false, satoraSwapId: SWAP, hasRecoveryMaterial: false, paymentHash: null, evmRefundLocktime: null, reason: "Saved swap was not found." });
    await fundedAndClick();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(text()).toMatch(/couldn't be read back|deadline is too close or unavailable/);
  });

  it("the server's fresh check refuses (provider unavailable / on-chain lock invalid): its reason is shown, no claim", async () => {
    vi.setSystemTime(new Date(FUNDED_SEEN));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    api.claimIntentOutcome = { kind: "refused", status: 503, error: "PROVIDER_UNAVAILABLE", message: "The provider can't be checked right now, so delivery can't be confirmed safe yet. Try again shortly." };
    renderSend();
    await advance(3_000);
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(text()).toContain("The provider can't be checked right now");
    api.claimIntentOutcome = { kind: "refused", status: 409, error: "FUNDING_INVALID", message: "On-chain HTLC deadline differs from the bound claim deadline. Do not continue." };
    fireEvent.click(finishButtons()[0]!);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(text()).toContain("On-chain HTLC deadline differs");
  });

  it("five-minute unsafe window: no action rendered, and the server refuses even if a stale screen clicks", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 4 * 60_000));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    renderSend();
    await advance(3_000);
    expect(finishButtons()).toHaveLength(0);
    expect(text()).toContain("Too close to the delivery deadline");
    // A screen rendered earlier, clicked inside the window: the server refuses.
    cleanup();
    resetPaymentTrackersForTests();
    vi.setSystemTime(new Date(DEADLINE_MS - 6 * 60_000));
    renderSend();
    await advance(1_000);
    const stale = finishButtons()[0]!;
    vi.setSystemTime(new Date(DEADLINE_MS - 4 * 60_000 - 30_000));
    fireEvent.click(stale);
    await advance(0);
    await advance(0);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("claim flag off (paused build): no claim, and the pause is stated", async () => {
    claimFlag.on = false;
    await fundedAndClick();
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
    expect(text()).toMatch(/paused in this preview/);
  });
});

describe("P3: terminal outcomes never offer a claim", () => {
  it("refunded (077770a1's real end state): no action, Polygon-only refund copy", async () => {
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    api = installFakeApi({ [ID]: { status: "REFUNDED", providerStatus: "clientfundedserverrefunded", observedAt: INCIDENT.observations[1]!.observed_at } });
    renderSend();
    await advance(3_000);
    expect(finishButtons()).toHaveLength(0);
    expect(screen.getAllByText("Not delivered — Polygon lock refunded").length).toBeGreaterThan(0);
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });

  it("deadline passed while still SERVER_FUNDED: no action, 'deadline has passed', no claim", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS + 60_000));
    api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
    renderSend();
    await advance(3_000);
    expect(finishButtons()).toHaveLength(0);
    expect(text()).toContain("The delivery deadline has passed");
    expect(claimSpy.claimStoredSwap).not.toHaveBeenCalled();
  });
});
