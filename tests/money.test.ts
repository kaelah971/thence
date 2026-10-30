import { describe, expect, it } from "vitest";
import {
  atomicToDecimal,
  compareAtomic,
  decimalToAtomic,
  isAtomicAmount,
  parseAtomicAmount,
  toAtomicAmount,
} from "@/domain/money";

describe("monetary precision — no floats (B0)", () => {
  it("accepts canonical atomic strings only", () => {
    expect(isAtomicAmount("0")).toBe(true);
    expect(isAtomicAmount("50000000")).toBe(true);
    expect(isAtomicAmount("007")).toBe(false); // non-canonical leading zeros
    expect(isAtomicAmount("")).toBe(false);
    expect(isAtomicAmount("-5")).toBe(false);
    expect(isAtomicAmount("50.00")).toBe(false);
    expect(isAtomicAmount(50)).toBe(false);
    expect(isAtomicAmount(50.0)).toBe(false);
  });

  it("round-trips bigint <-> atomic string", () => {
    expect(toAtomicAmount(0n)).toBe("0");
    expect(toAtomicAmount(50_000_000n)).toBe("50000000");
    expect(parseAtomicAmount("50000000")).toBe(50_000_000n);
    expect(() => parseAtomicAmount("50.5")).toThrow();
    expect(() => toAtomicAmount(-1n)).toThrow();
  });

  it("converts human decimals to atomic units without floats", () => {
    // 50.00 USDC (6 decimals) -> 50000000
    expect(decimalToAtomic("50.00", 6)).toBe("50000000");
    expect(decimalToAtomic("0.1", 6)).toBe("100000");
    expect(decimalToAtomic("1", 18)).toBe("1000000000000000000");
    expect(() => decimalToAtomic("50.0000001", 6)).toThrow(); // over-precision
    expect(() => decimalToAtomic("abc", 6)).toThrow();
  });

  it("converts atomic units back to exact decimals", () => {
    expect(atomicToDecimal("50000000", 6)).toBe("50");
    expect(atomicToDecimal("100000", 6)).toBe("0.1");
    expect(atomicToDecimal("0", 6)).toBe("0");
  });

  it("compares atomic amounts exactly", () => {
    expect(compareAtomic("100", "200")).toBe(-1);
    expect(compareAtomic("200", "200")).toBe(0);
    expect(compareAtomic("300", "200")).toBe(1);
  });

  it("classic 0.1 + 0.2 float trap never touches amounts", () => {
    // The float trap: 0.1 + 0.2 !== 0.3 in IEEE754. Atomic math is exact.
    const a = decimalToAtomic("0.1", 6);
    const b = decimalToAtomic("0.2", 6);
    const sum = toAtomicAmount(parseAtomicAmount(a) + parseAtomicAmount(b));
    expect(sum).toBe(decimalToAtomic("0.3", 6));
    expect(0.1 + 0.2).not.toBe(0.3); // documents why floats are banned
  });
});
