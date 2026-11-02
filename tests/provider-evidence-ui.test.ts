import { deriveSwapActions } from "@satora/swap";
import { describe, expect, it } from "vitest";
import {
  getProviderEvidence,
  providerEvidenceDisposition,
  providerStatusLabel,
  type ProviderEvidence,
} from "@/ui/lib/settlement-client";

const base: ProviderEvidence = {
  transferId: "t-1",
  transferStatus: "AWAITING_NIM_APPROVAL",
  providerStatus: "pending",
  invoiceExpired: false,
  invoiceExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  sourceSats: "390",
  targetAtomic: "300000",
  identityMatch: true,
  hasEvmFundingTx: false,
  hasEvmClaimTx: false,
  observedAt: new Date().toISOString(),
};

describe("owner payment status evidence", () => {
  it("uses the read-only GET endpoint", async () => {
    let method = "";
    let body: BodyInit | null | undefined;
    const fetcher: typeof fetch = (async (_input, init) => {
      method = init?.method ?? "GET";
      body = init?.body;
      return new Response(JSON.stringify({ evidence: base }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await getProviderEvidence("t-1", { fetch: fetcher });
    expect(result.ok).toBe(true);
    expect(method).toBe("GET");
    expect(body).toBeUndefined();
  });

  it("distinguishes invoice expiry from Satora's terminal expired status", () => {
    expect(providerEvidenceDisposition(base)).toBe("UNKNOWN");
    expect(providerEvidenceDisposition({ ...base, invoiceExpired: true, providerStatus: "pending" })).toBe("UNKNOWN");
    expect(providerEvidenceDisposition({ ...base, invoiceExpired: true, providerStatus: "expired" })).toBe("EXPIRED_UNFUNDED");
    expect(providerEvidenceDisposition({ ...base, invoiceExpired: true, providerStatus: "expired", hasEvmFundingTx: true })).toBe("FUNDING_DETECTED");
    expect(providerEvidenceDisposition({ ...base, providerStatus: "clientfunded" })).toBe("FUNDING_DETECTED");
    expect(providerEvidenceDisposition({ ...base, providerStatus: "serverredeemed", hasEvmClaimTx: false })).toBe("SETTLEMENT_DETECTED");
    expect(providerEvidenceDisposition({ ...base, identityMatch: false, providerStatus: "clientfunded" })).toBe("UNKNOWN");
  });

  it("pins the SDK's expired semantics as terminal and unfunded", () => {
    const result = deriveSwapActions({
      status: "expired",
      clientChainNow: 0,
      serverChainNow: 0,
      clientRefundLocktime: 1,
      serverRefundLocktime: 1,
      clientFunds: false,
    });
    expect(result.recommended).toBe("none");
    expect(result.actions[0]).toMatchObject({
      id: "none",
      outcome: "expired",
      reason: "The swap expired without funding — nothing was locked.",
    });
  });

  it("uses safe labels for unknown provider states", () => {
    expect(providerStatusLabel("mystery-state")).toBe("Unknown");
  });
});
