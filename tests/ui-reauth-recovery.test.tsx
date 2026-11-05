// @vitest-environment jsdom
/**
 * iOS login-cookie loss (2026-11-05 diagnostic): the browser keeps IndexedDB
 * and localStorage but loses every cookie, the page is recreated, and the
 * owner signs in again with the SAME wallet (same user id, new session).
 *
 * Pins, with simulated payments only (fake API, mocked Satora SDK, memory
 * recovery vault; nothing can move money):
 * - while signed out, Finish delivery reveals nothing and asks the server for nothing;
 * - after re-authentication the original payment resumes from the SAME vault
 *   binding and SDK readback: one claim intent, one SDK claim, no new
 *   transfer, swap or Nimiq Pay approval;
 * - a different wallet on the device, a missing vault binding, missing SDK
 *   recovery material or a passed deadline each fail safe.
 *
 * Server-side counterparts (new session, stale session, other wallet) are in
 * tests/p3-claim-intent.test.ts, "re-authentication after login-cookie loss".
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

const sdk = vi.hoisted(() => ({ claimStoredSwap: vi.fn(), readBackSwap: vi.fn() }));
vi.mock("@/ui/lib/satora-browser", () => sdk);
vi.mock("@/ui/lib/claim-gate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/claim-gate")>();
  return { ...original, isClaimFlagEnabled: () => true };
});

import { SettlementProgress } from "@/ui/screens/send/SettlementProgress";
import { resetPaymentTrackersForTests } from "@/ui/lib/payment-tracker";
import { createMemoryVault, RECOVERY_VAULT_VERSION } from "@/ui/lib/recovery-vault";

const ID = INCIDENT.transfer.id;
const SWAP = INCIDENT.attachment.satora_swap_id;
const LOCK = INCIDENT.attachment.payment_hash;
const LOCKTIME = INCIDENT.satora.getSwap.evm_refund_locktime;
const DEADLINE_MS = LOCKTIME * 1000;
const FUNDED_SEEN = INCIDENT.observations[0]!.observed_at;
const OTHER_WALLET_USER = "00000000-0000-4000-8000-0000000000aa";

let api: FakeApi;

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

/** The binding written before Nimiq Pay approval; survives the cookie loss (IndexedDB kept). */
async function installVault(present = true) {
  const vault = createMemoryVault();
  if (present) {
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
  }
  (globalThis as { __thenceVault?: unknown }).__thenceVault = vault;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  sdk.claimStoredSwap.mockReset();
  sdk.readBackSwap.mockReset();
  window.localStorage.clear();
  await installVault();
  sdk.readBackSwap.mockResolvedValue({ ok: true, satoraSwapId: SWAP, hasRecoveryMaterial: true, paymentHash: LOCK, evmRefundLocktime: LOCKTIME });
  sdk.claimStoredSwap.mockResolvedValue({ success: true, txHash: `0x${"5c".repeat(32)}`, message: "ok" });
  vi.setSystemTime(new Date(FUNDED_SEEN));
  api = installFakeApi({ [ID]: { status: "SERVER_FUNDED", providerStatus: "serverfunded", observedAt: FUNDED_SEEN } });
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

const text = () => document.body.textContent ?? "";
const finishButtons = () => screen.queryAllByRole("button", { name: "Finish delivery" });
const creates = () => api.calls.filter((c) => c.method === "POST" && /\/api\/transfers$|\/prepare$|\/attach$|\/authorize-handoff$/.test(c.path));

/** Page recreated after the reload: a fresh mount with whatever session the app now has. */
async function mount(opts: { ownerUserId?: string; sessionValid: boolean }) {
  cleanup();
  resetPaymentTrackersForTests();
  render(
    <SettlementProgress
      transferId={ID}
      ownerUserId={opts.ownerUserId ?? OWNER_ID}
      requestPublicId={null}
      sessionValid={opts.sessionValid}
      previewMode={false}
      routeId="usdc-polygon"
      asset="USDC"
      saveOffer={null}
    />,
  );
  await advance(3_000);
}

async function clickFinish(): Promise<void> {
  const button = finishButtons()[0];
  if (button) fireEvent.click(button);
  await advance(0);
  await advance(0);
}

describe("iOS login-cookie loss → page recreated → sign in again", () => {
  it("signed out: Finish delivery reveals nothing and does not ask the server to authorize", async () => {
    await mount({ sessionValid: false });
    await clickFinish();
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
    if (finishButtons().length > 0) expect(text()).toMatch(/session has ended|Sign in again/i);
  });

  it("same wallet signs in again: the original payment resumes from the same vault binding — one claim, nothing re-created or re-approved", async () => {
    await mount({ sessionValid: false });
    await clickFinish();
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();

    // Re-authenticated: same wallet ⇒ same user id, new session.
    await mount({ sessionValid: true });
    expect(screen.getAllByText("Action required — Finish delivery").length).toBeGreaterThan(0);
    expect(finishButtons()).toHaveLength(1);
    await clickFinish();
    expect(api.count("POST", "/claim-intent")).toBe(1);
    expect(sdk.claimStoredSwap).toHaveBeenCalledTimes(1);
    expect(sdk.claimStoredSwap).toHaveBeenCalledWith(SWAP);
    expect(creates()).toEqual([]);
    expect(api.state[ID]!.status).toBe("CLAIMING");

    // Another reload after the claim: no second attempt is offered.
    await mount({ sessionValid: true });
    expect(finishButtons()).toHaveLength(0);
    await advance(5 * 60_000);
    expect(sdk.claimStoredSwap).toHaveBeenCalledTimes(1);
  });

  it("a different wallet signed in on this device: the binding is foreign, nothing is revealed", async () => {
    await mount({ ownerUserId: OTHER_WALLET_USER, sessionValid: true });
    await clickFinish();
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
  });

  it("recovery binding missing after the reload (thence-recovery cleared): blocked before authorization", async () => {
    await installVault(false);
    await mount({ sessionValid: true });
    await clickFinish();
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
    if (finishButtons().length > 0) expect(text()).toMatch(/doesn't match|Do not continue/);
  });

  it("SDK recovery material missing after the reload (lendaswap-v3 cleared): blocked before authorization", async () => {
    sdk.readBackSwap.mockResolvedValue({ ok: false, satoraSwapId: SWAP, hasRecoveryMaterial: false, paymentHash: null, evmRefundLocktime: null, reason: "Saved swap was not found." });
    await mount({ sessionValid: true });
    await clickFinish();
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
  });

  it("deadline passed while signed out: after signing in again there is no Finish delivery and no claim", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS + 60_000));
    await mount({ sessionValid: true });
    expect(finishButtons()).toHaveLength(0);
    await clickFinish();
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();
    expect(api.count("POST", "/claim-intent")).toBe(0);
  });

  it("inside the 5-minute unsafe window after signing in again: no Finish delivery", async () => {
    vi.setSystemTime(new Date(DEADLINE_MS - 4 * 60_000));
    await mount({ sessionValid: true });
    expect(finishButtons()).toHaveLength(0);
    expect(sdk.claimStoredSwap).not.toHaveBeenCalled();
  });
});
