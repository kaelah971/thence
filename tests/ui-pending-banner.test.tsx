// @vitest-environment jsdom
/**
 * Phone smoke test (2026-11-04), follow-up: the saved recovery pointer for
 * the Nov 2 RECONCILING payment (eddaa6de) offered "Continue an interrupted
 * payment", which then dead-ended in "Checking payment — do not resend".
 *
 * Rendered against the REAL Send screen with a fake API (no database,
 * network, provider or wallet):
 * - a non-resumable RECONCILING payment shows its real state and
 *   "View in Activity", never Continue; its pointer is kept; nothing is
 *   created; tapping through never reaches the handoff;
 * - a genuinely resumable payment (AWAITING_NIM_APPROVAL) still offers
 *   "Continue to approval";
 * - a funded, claimable payment is sent to Activity, where the existing
 *   deadline-gated "Finish delivery" lives (proved in
 *   tests/ui-payment-lifecycle.test.tsx, P2);
 * - a DISABLED pilot says new payments are paused while Activity stays
 *   reachable.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/app/send",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, string>)}>
      {children}
    </a>
  ),
}));
const OWNER = "owner-nov2";
vi.mock("@/ui/lib/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/session")>();
  return {
    ...original,
    useSession: () => ({
      status: "valid",
      me: { user: { id: OWNER, nimiqAddress: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000", createdAt: "2026-11-01T00:00:00.000Z" }, profile: { displayName: "Owner", onboardingCompletedAt: "2026-11-01T00:00:00.000Z" } },
    }),
  };
});

import { loadPending, pendingBannerAction, savePending } from "@/ui/lib/prepare-flow";
import { PendingPaymentBanner } from "@/ui/screens/send/PendingPaymentBanner";
import { SendFlow } from "@/ui/screens/send/SendFlow";

const OLD_ID = "eddaa6de-6f02-4b9d-a926-276a1b4a93b4";
const DEST = "0x0000000000000000000000000000000000000001";

type Call = { method: string; path: string };
let calls: Call[] = [];

function installApi(transferStatus: string, statusLabel: string, payments: "available" | "paused"): void {
  calls = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === `/api/transfers/${OLD_ID}`) {
      return json(200, {
        transfer: { id: OLD_ID, status: transferStatus, statusLabel, destination: DEST, targetAmountAtomic: "300000", routeId: "usdc-polygon", quote: { revision: 1 } },
      });
    }
    if (method === "GET" && url.pathname === "/api/pilot/status") return json(200, { payments });
    return json(404, { error: "NOT_FOUND" });
  }) as typeof fetch);
}

function seedPointer(): void {
  savePending({ transferId: OLD_ID, idempotencyKey: "k-nov2-eddaa6de-0001", attemptToken: null, ownerUserId: OWNER, routeId: "usdc-polygon", targetAmountAtomic: "300000" });
}

async function renderSend(): Promise<void> {
  await act(async () => {
    render(<SendFlow />);
  });
  // Let the read-only status loads settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Send: saved pointer for the Nov 2 RECONCILING payment (eddaa6de)", () => {
  it("shows its real state and 'View in Activity' — no Continue, pointer kept, nothing created", async () => {
    seedPointer();
    installApi("RECONCILING", "Checking your payment — do not resend", "paused");
    await renderSend();

    expect(screen.getByText("Checking your payment — do not resend")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: /View in Activity/ });
    expect(links.every((l) => l.getAttribute("href") === "/app/activity")).toBe(true);
    expect(screen.queryByRole("button", { name: /Continue payment|Resume payment|Continue to approval/ })).toBeNull();
    expect(screen.queryByText("Continue an interrupted payment")).toBeNull();
    // Never reaches the dead-end handoff refusal.
    expect(screen.queryByText("Checking payment — do not resend")).toBeNull();

    // Recovery note preserved; only reads were made.
    expect(loadPending(OWNER, OLD_ID)?.transferId).toBe(OLD_ID);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("pilot DISABLED: new payments are paused, existing payments stay reachable in Activity", async () => {
    installApi("RECONCILING", "Checking your payment — do not resend", "paused");
    await renderSend();
    expect(screen.getByText("New payments are paused")).toBeTruthy();
    expect(screen.getByText(/Your existing payments are still in Activity/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View in Activity/ }).getAttribute("href")).toBe("/app/activity");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("pilot available: no paused notice", async () => {
    installApi("RECONCILING", "Checking your payment — do not resend", "available");
    await renderSend();
    expect(screen.queryByText("New payments are paused")).toBeNull();
  });

  it("a genuinely resumable payment (awaiting approval) still offers Continue to approval", async () => {
    seedPointer();
    installApi("AWAITING_NIM_APPROVAL", "Approve in Nimiq Pay", "available");
    await renderSend();
    expect(screen.getByText("Continue an interrupted payment")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue to approval/ })).toBeTruthy();
    expect(loadPending(OWNER, OLD_ID)?.transferId).toBe(OLD_ID);
  });

  it("a finished payment's stale pointer is cleared and no banner shows", async () => {
    seedPointer();
    installApi("DELIVERED", "Delivered", "available");
    await renderSend();
    expect(loadPending(OWNER, OLD_ID)).toBeNull();
    expect(screen.queryByText("Continue an interrupted payment")).toBeNull();
    expect(screen.queryByRole("link", { name: /View in Activity/ })).toBeNull();
  });
});

describe("banner action from authoritative status", () => {
  it("offers Continue only for unpaid pre-approval states", () => {
    for (const s of ["QUOTED", "SWAP_CREATED", "AWAITING_NIM_APPROVAL"]) expect(pendingBannerAction(s), s).toBe("continue");
  });

  it("sends in-flight, checking, funded, claimable and unknown states to Activity (pointer kept)", () => {
    for (const s of ["DRAFT", "LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "NEEDS_ATTENTION", "SOMETHING_NEW", ""]) {
      expect(pendingBannerAction(s), s).toBe("activity");
    }
  });

  it("treats terminal states as finished", () => {
    for (const s of ["DELIVERED", "FAILED"]) expect(pendingBannerAction(s), s).toBe("finished");
  });

  it("claimable funded payment: points to Activity's Finish delivery, never a Send-side continue", () => {
    const onContinue = vi.fn();
    render(<PendingPaymentBanner state={{ status: "ready", transferStatus: "SERVER_FUNDED", statusLabel: "Action needed — Finish delivery" }} onContinue={onContinue} />);
    expect(screen.getByText("Action needed — Finish delivery")).toBeTruthy();
    expect(screen.getByText(/such as Finish\s+delivery/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View in Activity/ }).getAttribute("href")).toBe("/app/activity");
    expect(screen.queryByRole("button")).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("status unreadable: safe default is View in Activity, never Continue", () => {
    render(<PendingPaymentBanner state={{ status: "error" }} onContinue={() => undefined} />);
    expect(screen.getByRole("link", { name: /View in Activity/ })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("while loading: no actionable control", () => {
    render(<PendingPaymentBanner state={{ status: "loading" }} onContinue={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
