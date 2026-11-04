// @vitest-environment jsdom
/**
 * Production phone smoke test (2026-11-04) — rendered regression for the
 * review screen when the live pilot is DISABLED.
 *
 * With payments paused the review screen must say so plainly and offer no
 * actionable approval control (swipe and tap both disabled), even with a fresh
 * live quote. With payments available the same screen stays actionable.
 * Pure UI: no database, network, provider or wallet. Server enforcement is
 * covered separately (tests/f81-pilot-attempt-limits.test.ts).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiQuote } from "@/ui/lib/quotes-api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const QUOTE: ApiQuote = {
  routeId: "usdc-polygon",
  asset: "USDC",
  network: "Polygon",
  targetAmountAtomic: "300000",
  targetAmount: "0.3",
  netTargetAmountAtomic: "300000",
  exact: true,
  sourceAmountSats: "388",
  sourceAmountPreFeeSats: "386",
  sourceChain: "Lightning",
  fees: { networkFeeSats: 0, gaslessNetworkFeeSats: 0, protocolFeeSats: 2, protocolFeeRate: 0.005, unit: "sats" },
  limits: { minSats: 356, maxSats: 20000000 },
  observedAt: "2026-11-04T19:45:42.000Z",
  validUntil: "2026-11-04T19:50:42.000Z",
  availability: "available",
  settlementProven: false,
  warnings: [],
};

vi.mock("@/ui/screens/send/useLiveQuote", () => ({
  useLiveQuote: () => ({ status: "ready", quote: QUOTE, freshness: { expired: false, secondsLeft: 300, countdown: "5:00" }, refresh: () => undefined }),
}));

import { ReviewStep, type Payee } from "@/ui/screens/send/SendFlow";

const PAYEE: Payee = {
  id: null,
  name: "",
  tone: "teal" as Payee["tone"],
  routeId: "usdc-polygon",
  address: "0x0000000000000000000000000000000000000001",
  walletVerified: false,
  isNew: true,
  destinationId: null,
  walletCount: 0,
};

function renderReview(paymentsPaused: boolean) {
  const onApprove = vi.fn();
  render(
    <ReviewStep
      payee={PAYEE}
      amount="0.3"
      decimals={2}
      tokenDecimals={6}
      fixed={null}
      quoteInput={{ routeId: "usdc-polygon", targetAmountAtomic: "300000" }}
      unavailableReason={null}
      paymentsPaused={paymentsPaused}
      onBack={() => undefined}
      onApprove={onApprove}
    />,
  );
  return { onApprove };
}

afterEach(() => cleanup());

describe("review screen with the live pilot DISABLED", () => {
  it("shows 'Payments temporarily unavailable' and no actionable approval, even with a fresh quote", () => {
    const { onApprove } = renderReview(true);
    expect(screen.getAllByText("Payments temporarily unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/Nothing has been created or charged/)).toBeTruthy();
    const tap = screen.getByRole("button", { name: /Continue with a tap/ }) as HTMLButtonElement;
    expect(tap.disabled).toBe(true);
    fireEvent.click(tap);
    const swipe = screen.getByLabelText(/Payments temporarily unavailable\. Swipe right/);
    expect(swipe.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(swipe, { key: "Enter" });
    expect(onApprove).not.toHaveBeenCalled();
    // No "do not resend" / resume language for a payment that was never created.
    expect(screen.queryByText(/do not resend/i)).toBeNull();
  });

  it("enabled pilot: the same review stays actionable with a fresh quote", () => {
    const { onApprove } = renderReview(false);
    expect(screen.queryByText("Payments temporarily unavailable")).toBeNull();
    const tap = screen.getByRole("button", { name: /Continue with a tap/ }) as HTMLButtonElement;
    expect(tap.disabled).toBe(false);
    fireEvent.click(tap);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});

/* ---------- preparation flow (usePreparation) against a fake API ---------- */

import { act, renderHook } from "@testing-library/react";
import { loadPending, savePending } from "@/ui/lib/prepare-flow";
import { usePreparation, type PreparationInput } from "@/ui/screens/send/usePreparation";

const OWNER = "owner-1";
const OLD_ID = "eddaa6de-0000-4000-8000-000000000000";
const DEST = "0x0000000000000000000000000000000000000001";

const INPUT: PreparationInput = {
  payee: { id: null, destinationId: null, routeId: "usdc-polygon", address: DEST, name: null },
  fixed: null,
  targetAmountAtomic: "300000",
  destination: DEST,
  ownerUserId: OWNER,
  tokenAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  evmChainId: 137,
};

type Call = { method: string; path: string };
function fakeFetch(routes: Record<string, { status: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname });
    const hit = routes[`${method} ${url.pathname}`];
    if (!hit) return new Response(JSON.stringify({ error: "NOT_MOCKED" }), { status: 599 });
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("preparation with the pilot DISABLED and an old unresolved payment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("resuming the old unresolved payment is refused as 'do not resend', keeps its pointer, and creates nothing", async () => {
    savePending({ transferId: OLD_ID, idempotencyKey: "k-old-unresolved-0001", attemptToken: null, ownerUserId: OWNER, routeId: "usdc-polygon", targetAmountAtomic: "300000" });
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch(
        {
          [`GET /api/transfers/${OLD_ID}`]: {
            status: 200,
            body: { transfer: { id: OLD_ID, status: "RECONCILING", statusLabel: "Checking your payment", destination: DEST, targetAmountAtomic: "300000", routeId: "usdc-polygon", quote: { revision: 1 } } },
          },
        },
        calls,
      ),
    );
    const { result } = renderHook(() => usePreparation());
    await act(async () => {
      await result.current.resumeWithInput(INPUT, OLD_ID);
    });
    const state = result.current.state;
    expect(state.phase).toBe("failed");
    if (state.phase === "failed") {
      expect(state.issue.title).toBe("Checking payment — do not resend");
      expect(state.issue.action).toBe("resume");
    }
    // Duplicate protection preserved: the unresolved payment is not dismissed.
    expect(loadPending(OWNER, OLD_ID)?.transferId).toBe(OLD_ID);
    // Read-only: no create, prepare, attach or authorize.
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a NEW payment refused with PILOT_DISABLED reads 'Payments temporarily unavailable' and saves no pointer", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch({ "POST /api/transfers": { status: 403, body: { error: "PILOT_DISABLED", message: "Live pilot is not enabled." } } }, calls),
    );
    const { result } = renderHook(() => usePreparation());
    await act(async () => {
      await result.current.start(INPUT);
    });
    const state = result.current.state;
    expect(state.phase).toBe("failed");
    if (state.phase === "failed") {
      expect(state.issue.title).toBe("Payments temporarily unavailable");
      expect(state.issue.body).toMatch(/Nothing was created or charged/);
      expect(state.issue.action).toBe("abort");
      expect(state.issue.retryable).toBe(false);
      expect(state.transferId).toBeNull();
    }
    expect(result.current.pendingFor(OWNER)).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/transfers"]);
  });
});
