/**
 * A3c.2 — NIM card conversion preview. No trusted NIM→USDC rate exists, so
 * the preview must never produce a USDC figure; it shows the exact NIM
 * balance and an honest unavailable state.
 */
import { describe, expect, it } from "vitest";
import { nimUsdcPreview, RATE_UNAVAILABLE_MESSAGE } from "@/ui/lib/conversion";

describe("nimUsdcPreview", () => {
  it("shows the exact NIM balance and no invented USDC value", () => {
    const preview = nimUsdcPreview({
      status: "loaded",
      luna: 123456789n,
      basicLuna: 123456789n,
      vaultLuna: null,
      vaultUnknown: false,
      source: "chain",
      network: "mainnet",
    });
    expect(preview.status).toBe("rate-unavailable");
    if (preview.status === "rate-unavailable") {
      expect(preview.nim.text).toBe("1,234.56789");
      expect(preview.message).toBe(RATE_UNAVAILABLE_MESSAGE);
    }
    expect(JSON.stringify(preview)).not.toMatch(/usdc"?\s*:\s*"?\d/i);
  });

  it("says it won't guess and points to Nimiq Pay's exact amount", () => {
    expect(RATE_UNAVAILABLE_MESSAGE).toMatch(/won't guess/);
    expect(RATE_UNAVAILABLE_MESSAGE).toMatch(/Nimiq Pay shows the exact NIM/);
    expect(RATE_UNAVAILABLE_MESSAGE).not.toMatch(/\d/);
  });

  it("is honest when no balance is available", () => {
    expect(nimUsdcPreview({ status: "loading" })).toEqual({ status: "loading" });
    expect(nimUsdcPreview({ status: "disconnected" }).status).toBe("no-balance");
    expect(nimUsdcPreview({ status: "error", reason: "network" }).status).toBe("no-balance");
    expect(nimUsdcPreview({ status: "unavailable", reason: "not-in-host" }).status).toBe("no-balance");
  });
});
