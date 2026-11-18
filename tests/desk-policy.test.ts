import { describe, expect, it } from "vitest";
import { deskCharge, amountAtomic, reservesUsdc, assertPayout } from "../src/lib/desk/policy";

describe("treasury desk money and recovery policy", () => {
  it("rounds the NIM charge up and keeps fee separate from exact USDC delivery", () => {
    expect(deskCharge(1_000_000n, 200_000_000_000_000n, 50)).toEqual({ baseLuna: 500_000_000n, feeLuna: 2_500_000n, totalLuna: 502_500_000n });
    expect(deskCharge(300_001n, 300_000_000_000_000n, 0).totalLuna).toBe(100_000_334n);
  });
  it("rejects floats, negative values, excess decimal places and overflow", () => {
    expect(amountAtomic("0.30", 6)).toBe(300000n);
    for (const s of ["-1", "1e3", "0.0000001", "Infinity", "01", " 1"]) expect(() => amountAtomic(s, 6)).toThrow();
    expect(() => deskCharge(0n, 1n, 50)).toThrow();
    expect(() => deskCharge(1n, 0n, 50)).toThrow();
  });
  it("never releases an authorized or uncertain payment's reservation on quote expiry", () => {
    expect(reservesUsdc("QUOTED", false)).toBe(false);
    for (const s of ["AWAITING_NIM", "VERIFIED", "PAYOUT_PREPARED", "PAYOUT_SUBMITTED"]) expect(reservesUsdc(s, false)).toBe(true);
    expect(reservesUsdc("DELIVERED", true)).toBe(false);
  });
  it("checks all signed transaction terms before persisting or broadcasting", () => {
    const terms = { chainId: 137, to: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", value: 0n, nonce: 3, recipient: "0x21e5fc03e4305cc8cfb874253c6d66a8bdb0bcda", amount: 300000n };
    expect(() => assertPayout(terms, terms)).not.toThrow();
    for (const patch of [{ chainId: 42161 }, { amount: 300001n }, { value: 1n }, { nonce: 4 }, { recipient: "0x0000000000000000000000000000000000000001" }]) expect(() => assertPayout({ ...terms, ...patch }, terms)).toThrow();
  });
});
