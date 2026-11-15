/**
 * Arbitrum vertical slice — pure client/server gates not covered by the
 * A3a/A3b lifecycle suites: the trusted-RPC handoff precondition, the
 * L1-finality funding wait (cadence, budget, copy) and route-aware progress
 * copy. Polygon behaviour is asserted unchanged alongside each case.
 */
import { describe, expect, it } from "vitest";
import { settlementChainVerifiable } from "@/lib/handoff";
import {
  FUNDING_NOT_CONFIRMED,
  FUNDING_RETRY_BUDGET_MS,
  FUNDING_RETRY_INTERVAL_MS,
  FUNDING_RETRY_L1_BUDGET_MS,
  FUNDING_RETRY_L1_INTERVAL_MS,
  fundingFinalityFrom,
  fundingWaitMessage,
  nextFundingRetry,
} from "@/ui/screens/send/useSettlement";
import { paymentProgress, VERIFYING_HEADLINE } from "@/ui/lib/payment-progress";
import { timelineFor } from "@/ui/lib/status";
import { settlementNetworkFor } from "@/ui/lib/network-copy";

describe("trusted RPC precondition before any Arbitrum payment starts", () => {
  it("refuses usdc-arbitrum without a configured 42161 RPC", () => {
    expect(settlementChainVerifiable("usdc-arbitrum", {})).toBe(false);
    expect(settlementChainVerifiable("usdc-arbitrum", { "137": "https://polygon.invalid" })).toBe(false);
    expect(settlementChainVerifiable("usdc-arbitrum", { "42161": "  " })).toBe(false);
    expect(settlementChainVerifiable("usdc-arbitrum", null)).toBe(false);
    expect(settlementChainVerifiable("usdc-arbitrum", { "42161": "https://arb.invalid" })).toBe(true);
  });

  it("leaves Polygon exactly as before (no new precondition)", () => {
    expect(settlementChainVerifiable("usdc-polygon", {})).toBe(true);
    expect(settlementChainVerifiable("usdc-polygon", null)).toBe(true);
  });
});

describe("L1-finality funding wait", () => {
  const start = 1_000_000;

  it("reads the server's finality kind only from an explicit l1 detail", () => {
    expect(fundingFinalityFrom({ finality: "l1", network: "Arbitrum" })).toBe("l1");
    expect(fundingFinalityFrom({ confirmations: "9", required: "32" })).toBeNull();
    expect(fundingFinalityFrom(null)).toBeNull();
    expect(fundingFinalityFrom({ finality: "soft" })).toBeNull();
  });

  it("keeps Polygon's 8 s cadence and 4 min budget", () => {
    expect(nextFundingRetry({ code: FUNDING_NOT_CONFIRMED, startedAtMs: start, nowMs: start, active: true })).toEqual({ retry: true, delayMs: FUNDING_RETRY_INTERVAL_MS });
    expect(nextFundingRetry({ code: FUNDING_NOT_CONFIRMED, startedAtMs: start, nowMs: start + FUNDING_RETRY_BUDGET_MS, active: true })).toEqual({ retry: false });
  });

  it("waits through ~20 min Arbitrum finality on a slower cadence, bounded at 45 min", () => {
    const at25min = start + 25 * 60_000;
    expect(nextFundingRetry({ code: FUNDING_NOT_CONFIRMED, startedAtMs: start, nowMs: at25min, active: true, finality: "l1" })).toEqual({ retry: true, delayMs: FUNDING_RETRY_L1_INTERVAL_MS });
    // The same elapsed time would have ended a Polygon wait.
    expect(nextFundingRetry({ code: FUNDING_NOT_CONFIRMED, startedAtMs: start, nowMs: at25min, active: true })).toEqual({ retry: false });
    expect(nextFundingRetry({ code: FUNDING_NOT_CONFIRMED, startedAtMs: start, nowMs: start + FUNDING_RETRY_L1_BUDGET_MS, active: true, finality: "l1" })).toEqual({ retry: false });
  });

  it("never retries any other refusal, including the deadline gate, on Arbitrum", () => {
    for (const code of ["DEADLINE_TOO_CLOSE", "FUNDING_INVALID", "HTLC_NOT_ACTIVE", "CHAIN_UNAVAILABLE", "SWAP_MISMATCH", null]) {
      expect(nextFundingRetry({ code, startedAtMs: start, nowMs: start, active: true, finality: "l1" })).toEqual({ retry: false });
    }
    expect(nextFundingRetry({ code: FUNDING_NOT_CONFIRMED, startedAtMs: start, nowMs: start, active: false, finality: "l1" })).toEqual({ retry: false });
  });

  it("explains finality on Arbitrum without a confirmation count", () => {
    const msg = fundingWaitMessage(null, null, "l1");
    expect(msg).toMatch(/^Securing the payment on Arbitrum/);
    expect(msg).toMatch(/Ethereum finality, usually about 20 minutes/);
    expect(msg).not.toMatch(/of 32|Polygon/);
    expect(fundingWaitMessage(9, 32)).toBe("Securing the payment on Polygon (9 of 32 confirmations). Thence finishes delivery automatically — keep this screen open.");
  });
});

describe("route-aware progress copy", () => {
  const base = { phase: "finishing", transferStatus: "CLAIMING", providerStatus: "clientredeemed", claimReady: false, receiptReady: false } as const;

  it("maps routes to their settlement network", () => {
    expect(settlementNetworkFor("usdc-arbitrum")).toBe("Arbitrum");
    expect(settlementNetworkFor("usdc-polygon")).toBe("Polygon");
    expect(settlementNetworkFor(null)).toBe("Polygon");
  });

  it("names Arbitrum and its finality wait after Finish delivery", () => {
    const v = paymentProgress({ ...base, verifyVerdict: "INSUFFICIENT_CONFIRMATIONS", network: "Arbitrum" });
    expect(v.headline).toBe("Delivery submitted — verifying on Arbitrum");
    expect(v.body).toMatch(/Seen on Arbitrum\. Waiting for finality — usually about 20 minutes/);
    expect(JSON.stringify(v)).not.toMatch(/Polygon/);
    const verify = v.steps?.find((s) => s.key === "verify");
    expect(verify).toMatchObject({ label: "Verifying on Arbitrum", detail: "Waiting for Ethereum finality." });
  });

  it("keeps Polygon wording unchanged by default", () => {
    const v = paymentProgress({ ...base, verifyVerdict: "INSUFFICIENT_CONFIRMATIONS" });
    expect(v.headline).toBe(VERIFYING_HEADLINE);
    expect(v.body).toBe("Seen on Polygon. Waiting for confirmations — usually about 10 minutes. You can leave this screen.");
    expect(timelineFor("CLIENT_FUNDED").find((s) => s.key === "finish")?.detail).toBe("Locking the USDC on Polygon first.");
  });

  it("names the Arbitrum lock on refund and delivery", () => {
    expect(paymentProgress({ ...base, phase: "refunded", network: "Arbitrum" }).headline).toBe("Not delivered — Arbitrum lock refunded");
    expect(paymentProgress({ ...base, phase: "delivered", transferStatus: "DELIVERED", receiptReady: true, network: "Arbitrum" }).body).toBe("Verified on Arbitrum. The receipt below is the proof.");
  });
});
