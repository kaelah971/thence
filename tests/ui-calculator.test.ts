import { describe, expect, it } from "vitest";
import { decimalToAtomic } from "@/domain/money";
import {
  amountIssue,
  commit,
  evaluate,
  formatFixed,
  groupOperand,
  keyFromKeyboard,
  press,
  type CalcKey,
  type CalcTokens,
} from "@/ui/lib/calculator";

function type(keys: string, decimals = 2): { tokens: CalcTokens; rejections: string[] } {
  let tokens: CalcTokens = [];
  const rejections: string[] = [];
  const map: Record<string, CalcKey> = { "<": "back", "*": "×", "/": "÷", "-": "−", "+": "+", C: "clear" };
  for (const ch of keys) {
    const key = (map[ch] ?? ch) as CalcKey;
    const result = press(tokens, key, decimals);
    tokens = result.tokens;
    if (result.rejected) rejections.push(result.rejected);
  }
  return { tokens, rejections };
}

describe("calculator input", () => {
  it("builds operands and replaces a leading zero", () => {
    expect(type("0143").tokens).toEqual(["143"]);
    expect(type(".5").tokens).toEqual(["0.5"]);
  });

  it("enforces entry precision for the asset", () => {
    const r = type("1.234");
    expect(r.tokens).toEqual(["1.23"]);
    expect(r.rejections).toEqual(["precision"]);
    expect(type("0.00000001", 8).tokens).toEqual(["0.00000001"]);
    expect(type("5.", 0).rejections).toEqual(["precision"]);
  });

  it("rejects a leading operator so amounts can never start negative", () => {
    const r = type("-5");
    expect(r.rejections).toEqual(["leading-operator"]);
    expect(r.tokens).toEqual(["5"]);
  });

  it("replaces consecutive operators and trims a dangling decimal point", () => {
    expect(type("143+*2").tokens).toEqual(["143", "×", "2"]);
    expect(type("5.+1").tokens).toEqual(["5", "+", "1"]);
  });

  it("supports backspace and clear", () => {
    expect(type("143*<").tokens).toEqual(["143"]);
    expect(type("143<<<<").tokens).toEqual([]);
    expect(type("12+3C").tokens).toEqual([]);
  });

  it("caps very large integers", () => {
    expect(type("1234567890").rejections).toEqual(["too-large"]);
  });
});

describe("calculator evaluation", () => {
  it("multiplies like the reference ($143 × 2 = 286)", () => {
    const result = evaluate(type("143*2").tokens, 2);
    expect(result).toMatchObject({ kind: "value", value: "286", exact: true, isExpression: true });
  });

  it("respects operator precedence", () => {
    expect(evaluate(type("2+3*4").tokens, 2)).toMatchObject({ value: "14" });
    expect(evaluate(type("10-4/2").tokens, 2)).toMatchObject({ value: "8" });
  });

  it("uses exact decimal arithmetic (no float drift)", () => {
    expect(evaluate(type("0.1+0.2").tokens, 2)).toMatchObject({ value: "0.3", exact: true });
    expect(evaluate(type("19.99*3").tokens, 2)).toMatchObject({ value: "59.97", exact: true });
  });

  it("rounds inexact division down and flags it", () => {
    expect(evaluate(type("10/3").tokens, 2)).toMatchObject({ value: "3.33", exact: false });
    expect(evaluate(type("2/3").tokens, 2)).toMatchObject({ value: "0.66", exact: false });
  });

  it("flags multiplication results beyond entry precision", () => {
    expect(evaluate(type("0.05*0.5").tokens, 2)).toMatchObject({ value: "0.02", exact: false });
  });

  it("ignores a trailing operator but reports it as pending", () => {
    expect(evaluate(type("143*").tokens, 2)).toMatchObject({ value: "143", pending: true, isExpression: false });
  });

  it("reports division by zero", () => {
    expect(evaluate(type("5/0").tokens, 2)).toEqual({ kind: "error", reason: "divide-by-zero" });
  });
});

describe("amount validation", () => {
  it("rejects empty, zero and negative amounts", () => {
    expect(amountIssue(evaluate([], 2))).toBe("empty");
    expect(amountIssue(evaluate(type("0.00").tokens, 2))).toBe("zero");
    expect(amountIssue(evaluate(type("5-10").tokens, 2))).toBe("negative");
    expect(amountIssue(evaluate(type("5/0").tokens, 2))).toBe("divide-by-zero");
    expect(amountIssue(evaluate(type("25").tokens, 2))).toBeNull();
  });

  it("rejects results that grow beyond the integer cap", () => {
    expect(amountIssue(evaluate(type("999999999*10").tokens, 2))).toBe("too-large");
  });

  it("commits a result as a single operand", () => {
    expect(commit(type("143*2").tokens, 2)).toEqual(["286"]);
    expect(commit(type("5-10").tokens, 2)).toEqual(["5", "−", "10"]);
  });

  it("produces values the backend atomic converter accepts", () => {
    const result = evaluate(type("120.5*2").tokens, 2);
    expect(result.kind).toBe("value");
    if (result.kind === "value") expect(decimalToAtomic(result.value, 6)).toBe("241000000");
  });
});

describe("display helpers", () => {
  it("groups digits and pads fixed decimals", () => {
    expect(groupOperand("1234567.5")).toBe("1,234,567.5");
    expect(formatFixed("25", 2)).toBe("25.00");
    expect(formatFixed("1234.5", 2)).toBe("1,234.50");
  });

  it("maps physical keys", () => {
    expect(keyFromKeyboard("7")).toBe("7");
    expect(keyFromKeyboard("*")).toBe("×");
    expect(keyFromKeyboard("Backspace")).toBe("back");
    expect(keyFromKeyboard("a")).toBeNull();
  });
});
