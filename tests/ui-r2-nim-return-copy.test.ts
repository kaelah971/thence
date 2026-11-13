/**
 * R2 owner-facing refund status. "Your NIM came back" appears ONLY when the
 * server returns an on-chain-verified `nimReturn` for an EXPIRED_UNFUNDED
 * transfer; every other expired payment keeps the P4 copy that never claims a
 * refund.
 */
import { describe, expect, it } from "vitest";
import { EXPIRED_UNFUNDED_BODY, expiredNimReturnedBody, nimFromLuna, NIM_RETURN_CLOSABLE } from "@/ui/lib/settlement-client";
import { toActivityItem, type ApiTransfer } from "@/ui/lib/transfers-api";

const RETURN = { refundTxHash: "ab".repeat(32), returnedLuna: "724409283", feeLuna: "100" };
const base: ApiTransfer = {
  id: "6f44918d-0000-4000-8000-000000000000",
  status: "EXPIRED_UNFUNDED",
  statusLabel: "Expired — not delivered",
  routeId: "usdc-polygon",
  recipientName: "Tester",
  asset: "USDC",
  network: "Polygon",
  destination: "0x0000000000000000000000000000000000000001",
  targetAmountAtomic: "1500000",
  recipientDestinationId: null,
  createdAt: "2026-11-13T08:02:44.309Z",
  updatedAt: "2026-11-13T08:03:52.350Z",
};

describe("R2 refund status copy", () => {
  it("converts luna exactly (1 NIM = 100,000 luna)", () => {
    expect(nimFromLuna("724409383")).toBe("7244.09383");
    expect(nimFromLuna("724409283")).toBe("7244.09283");
    expect(nimFromLuna("100")).toBe("0.001");
    expect(nimFromLuna("0")).toBe("0");
    expect(nimFromLuna("-1")).toBeNull();
  });

  it("verified return: names the amount, the fee and the verifying transaction; separates non-delivery from the refund", () => {
    const body = expiredNimReturnedBody(RETURN);
    expect(body).toMatch(/^Nothing was delivered/);
    expect(body).toContain("7244.09283 NIM came back to your wallet");
    expect(body).toContain("network fee of 0.001 NIM");
    expect(body).toContain("verified the return on the Nimiq blockchain");
    expect(body).toContain("abababab…ababab");
  });

  it("the P4 copy still never claims a refund", () => {
    expect(EXPIRED_UNFUNDED_BODY).not.toMatch(/came back|refunded|returned to you/i);
  });

  it("Activity carries a verified return only for EXPIRED_UNFUNDED with server evidence", () => {
    expect(toActivityItem({ ...base, nimReturn: RETURN })?.nimReturn).toEqual(RETURN);
    expect(toActivityItem({ ...base })?.nimReturn).toBeNull();
    expect(toActivityItem({ ...base, nimReturn: null })?.nimReturn).toBeNull();
    // A stray field on any other status is ignored, never displayed.
    expect(toActivityItem({ ...base, status: "LIGHTNING_HANDOFF", nimReturn: RETURN })?.nimReturn).toBeNull();
  });

  it("only failed-handoff statuses can offer the NIM return check", () => {
    expect([...NIM_RETURN_CLOSABLE].sort()).toEqual(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]);
  });
});
