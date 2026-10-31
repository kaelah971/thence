/**
 * F8.9 — privacy-safe funded-path failure logging (pure, no DB, no network).
 *
 * Funded routes log exactly one static line per failure
 * (`thence funded <action>: <CODE>`) so production logs show WHICH check
 * failed. Only UPPER_SNAKE codes pass through; messages, bodies, cookies,
 * URLs and provider internals can never reach the logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, fundedFailureCode, logFundedFailure } from "@/lib/auth";

describe("fundedFailureCode", () => {
  it("passes static codes through", () => {
    expect(fundedFailureCode(new AuthError(403, "PILOT_DISABLED", "x"))).toBe("PILOT_DISABLED");
    expect(fundedFailureCode(new AuthError(409, "PROVIDER_MALFORMED", "x"))).toBe("PROVIDER_MALFORMED");
    expect(fundedFailureCode(new AuthError(404, "SWAP_NOT_FOUND", "x"))).toBe("SWAP_NOT_FOUND");
  });

  it("collapses anything non-static to UNKNOWN", () => {
    expect(fundedFailureCode(new AuthError(500, "weird code!", "x"))).toBe("UNKNOWN");
    expect(fundedFailureCode(new AuthError(500, "pilot_disabled", "x"))).toBe("UNKNOWN");
    expect(fundedFailureCode(new AuthError(500, "", "x"))).toBe("UNKNOWN");
    expect(fundedFailureCode(new Error("boom"))).toBe("UNKNOWN");
    expect(fundedFailureCode(null)).toBe("UNKNOWN");
  });
});

describe("logFundedFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one static line without request data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logFundedFailure("attach", new AuthError(409, "PROVIDER_MALFORMED", "secret details must never print"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("thence funded attach: PROVIDER_MALFORMED");
    logFundedFailure("authorize", new Error("conn refused"));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("thence funded authorize: UNKNOWN");
  });
});
