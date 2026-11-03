/**
 * F8 — restricted pilot gate unit tests (pure, no DB, no network, no funds).
 * Budget: $0.30 USDC single shot (300000 atomic), usdc-polygon only.
 */
import { describe, expect, it } from "vitest";
import { AuthError } from "@/lib/auth";
import {
  DEFAULT_MAX_SPEND_ATOMIC,
  DEFAULT_MAX_TARGET_ATOMIC,
  assertPilotIntent,
  canonicalKey,
  isActualSpendStatus,
  isFundingExposureStatus,
  getPilotConfig,
} from "@/lib/pilot";

const OWNER = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const OTHER = "NQ32 1111 2222 3333 4444 5555 6666 7777 8888";

function config(over: Record<string, string> = {}) {
  return getPilotConfig({
    THENCE_PILOT_ENABLED: "1",
    THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER,
    ...over,
  });
}

describe("F8 pilot gate", () => {
  it("defaults to $0.30 single-shot caps", () => {
    expect(DEFAULT_MAX_TARGET_ATOMIC).toBe("300000");
    expect(DEFAULT_MAX_SPEND_ATOMIC).toBe("300000");
    const c = getPilotConfig({
      THENCE_PILOT_ENABLED: "1",
      THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER,
    });
    expect(c.maxTargetAtomic).toBe("300000");
    expect(c.maxSpendAtomic).toBe("300000");
    expect(c.maxTransfers).toBe(1);
  });

  it("kill switch blocks everything when not armed", () => {
    const off = getPilotConfig({ THENCE_PILOT_ENABLED: "0", THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER });
    expect(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, off)).toThrowError(
      expect.objectContaining({ code: "PILOT_DISABLED" }),
    );
  });

  it("allows exactly $0.30 usdc-polygon for the allowlisted owner", () => {
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, config()),
    ).not.toThrow();
  });

  it("rejects other routes, other wallets, and amounts above $0.30", () => {
    expect(() =>
      assertPilotIntent({ routeId: "usdc-arbitrum", targetAmountAtomic: "300000", ownerAddress: OWNER }, config()),
    ).toThrowError(expect.objectContaining({ code: "PILOT_ROUTE_ONLY" }));
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OTHER }, config()),
    ).toThrowError(expect.objectContaining({ code: "PILOT_NOT_AUTHORIZED" }));
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300001", ownerAddress: OWNER }, config()),
    ).toThrowError(expect.objectContaining({ code: "PILOT_AMOUNT_EXCEEDS_MAX" }));
    // Signed-out (null address) never passes.
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: null }, config()),
    ).toThrowError(expect.objectContaining({ code: "PILOT_NOT_AUTHORIZED" }));
  });

  it("skips all checks when no allowlist is configured (legacy/test envs)", () => {
    const unconfigured = getPilotConfig({});
    expect(unconfigured.owners).toEqual([]);
    expect(() =>
      assertPilotIntent({ routeId: "usdc-arbitrum", targetAmountAtomic: "999999999", ownerAddress: OTHER }, unconfigured),
    ).not.toThrow();
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: null }, unconfigured),
    ).not.toThrow();
  });

  it("blocks everything when armed with a missing allowlist (misconfigured)", () => {
    const misconfigured = getPilotConfig({ THENCE_PILOT_ENABLED: "1" });
    expect(misconfigured.owners).toEqual([]);
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, misconfigured),
    ).toThrowError(expect.objectContaining({ code: "PILOT_NOT_AUTHORIZED" }));
  });

  it("releases exposure and spend accounting after a terminal refund", () => {
    expect(isFundingExposureStatus("REFUNDED")).toBe(false);
    expect(isActualSpendStatus("REFUNDED")).toBe(false);
    expect(isFundingExposureStatus("RECONCILING")).toBe(true);
  });

  it("matches owner addresses canonically (spacing/case-insensitive)", () => {
    const compact = OWNER.replace(/\s+/g, "").toLowerCase();
    expect(canonicalKey(compact)).toBe(canonicalKey(OWNER));
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: compact }, config()),
    ).not.toThrow();
    expect(AuthError).toBeDefined();
  });
});
