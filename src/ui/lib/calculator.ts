/**
 * Thence amount calculator (F1, client-only).
 *
 * Exact decimal arithmetic on bigint fixed-point values — never floats.
 * Operands are limited to the receiving asset's entry precision; results
 * that cannot be represented exactly are rounded DOWN (toward zero) and
 * flagged so the UI can say so. Negative and zero results are never valid
 * payment amounts.
 */
import { decimalToAtomic } from "@/domain/money";

export const OPERATORS = ["+", "−", "×", "÷"] as const;
export type Operator = (typeof OPERATORS)[number];
export type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type CalcKey = Digit | "." | "back" | "clear" | Operator;

export type CalcRejection = "precision" | "too-large" | "leading-operator" | "too-long";

export type CalcTokens = readonly string[];

export const MAX_INTEGER_DIGITS = 9;
export const MAX_TOKENS = 15;

const INTERNAL_SCALE_DIGITS = 18;
const INTERNAL_SCALE = 10n ** BigInt(INTERNAL_SCALE_DIGITS);

export function isOperator(token: string | undefined): token is Operator {
  return token !== undefined && (OPERATORS as readonly string[]).includes(token);
}

export interface PressResult {
  tokens: CalcTokens;
  rejected: CalcRejection | null;
}

/** Apply one key press. Pure: returns a new token list (or the same one plus a rejection). */
export function press(tokens: CalcTokens, key: CalcKey, decimals: number): PressResult {
  const next = [...tokens];
  const last = next[next.length - 1];
  const ok = (): PressResult => ({ tokens: next, rejected: null });
  const reject = (rejected: CalcRejection): PressResult => ({ tokens, rejected });

  if (key === "clear") return { tokens: [], rejected: null };

  if (key === "back") {
    if (last === undefined) return ok();
    if (isOperator(last) || last.length <= 1) next.pop();
    else next[next.length - 1] = last.slice(0, -1);
    return ok();
  }

  if (isOperator(key)) {
    if (last === undefined) return reject("leading-operator");
    if (isOperator(last)) {
      next[next.length - 1] = key;
      return ok();
    }
    if (next.length + 1 > MAX_TOKENS) return reject("too-long");
    if (last.endsWith(".")) next[next.length - 1] = last.slice(0, -1);
    next.push(key);
    return ok();
  }

  if (key === ".") {
    if (decimals === 0) return reject("precision");
    if (last === undefined || isOperator(last)) {
      if (next.length + 1 > MAX_TOKENS) return reject("too-long");
      next.push("0.");
      return ok();
    }
    if (last.includes(".")) return ok();
    next[next.length - 1] = `${last}.`;
    return ok();
  }

  // Digit
  if (last === undefined || isOperator(last)) {
    if (next.length + 1 > MAX_TOKENS) return reject("too-long");
    next.push(key);
    return ok();
  }
  const [intPart = "", fracPart] = last.split(".");
  if (fracPart !== undefined) {
    if (fracPart.length >= decimals) return reject("precision");
    next[next.length - 1] = `${last}${key}`;
    return ok();
  }
  if (intPart === "0") {
    next[next.length - 1] = key;
    return ok();
  }
  if (intPart.length >= MAX_INTEGER_DIGITS) return reject("too-large");
  next[next.length - 1] = `${last}${key}`;
  return ok();
}

function toScaled(operand: string): bigint {
  const [intPart = "0", fracPart = ""] = operand.split(".");
  const frac = fracPart.padEnd(INTERNAL_SCALE_DIGITS, "0").slice(0, INTERNAL_SCALE_DIGITS);
  return BigInt(intPart || "0") * INTERNAL_SCALE + BigInt(frac || "0");
}

function fromScaled(value: bigint, decimals: number): { text: string; exact: boolean } {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(INTERNAL_SCALE_DIGITS - decimals);
  const truncated = abs / unit;
  const exact = abs % unit === 0n;
  const base = 10n ** BigInt(decimals);
  const intPart = (truncated / base).toString(10);
  const frac = decimals > 0 ? (truncated % base).toString(10).padStart(decimals, "0").replace(/0+$/, "") : "";
  const text = frac ? `${intPart}.${frac}` : intPart;
  return { text: negative && truncated !== 0n ? `-${text}` : text, exact };
}

export type Evaluation =
  | { kind: "empty" }
  | { kind: "error"; reason: "divide-by-zero" }
  | {
      kind: "value";
      /** Human decimal string at entry precision, rounded toward zero. */
      value: string;
      /** False when digits beyond the entry precision were dropped. */
      exact: boolean;
      /** True when the token list contains an operation (shows "= result"). */
      isExpression: boolean;
      /** True when a trailing operator was ignored. */
      pending: boolean;
    };

/** Evaluate tokens with standard precedence (× ÷ before + −). */
export function evaluate(tokens: CalcTokens, decimals: number): Evaluation {
  const list = [...tokens];
  let pending = false;
  while (list.length > 0 && isOperator(list[list.length - 1])) {
    list.pop();
    pending = true;
  }
  if (list.length === 0) return { kind: "empty" };

  let exact = true;
  const terms: bigint[] = [];
  const addOps: Operator[] = [];
  let current = toScaled(list[0] as string);
  for (let i = 1; i < list.length; i += 2) {
    const op = list[i] as Operator;
    const operand = toScaled(list[i + 1] as string);
    if (op === "×") {
      current = (current * operand) / INTERNAL_SCALE;
    } else if (op === "÷") {
      if (operand === 0n) return { kind: "error", reason: "divide-by-zero" };
      const numerator = current * INTERNAL_SCALE;
      if (numerator % operand !== 0n) exact = false;
      current = numerator / operand;
    } else {
      terms.push(current);
      addOps.push(op);
      current = operand;
    }
  }
  terms.push(current);

  let total = terms[0] as bigint;
  addOps.forEach((op, index) => {
    const term = terms[index + 1] as bigint;
    total = op === "+" ? total + term : total - term;
  });

  const formatted = fromScaled(total, decimals);
  return {
    kind: "value",
    value: formatted.text,
    exact: exact && formatted.exact,
    isExpression: list.length > 1,
    pending,
  };
}

export type AmountIssue = "empty" | "zero" | "negative" | "divide-by-zero" | "too-large";

/** Validate an evaluation as a payment amount. */
export function amountIssue(evaluation: Evaluation): AmountIssue | null {
  if (evaluation.kind === "empty") return "empty";
  if (evaluation.kind === "error") return "divide-by-zero";
  if (evaluation.value.startsWith("-")) return "negative";
  if (/^0(\.0*)?$/.test(evaluation.value)) return "zero";
  const intDigits = (evaluation.value.split(".")[0] ?? "").length;
  if (intDigits > MAX_INTEGER_DIGITS) return "too-large";
  return null;
}

/**
 * Exact conversion of a validated human amount ("25.5") into the token's
 * smallest unit ("25500000" for 6 decimals). Integer string math only;
 * returns null instead of rounding when the value can't be represented.
 */
export function toAtomic(value: string, tokenDecimals: number): string | null {
  try {
    const atomic = decimalToAtomic(value, tokenDecimals);
    return atomic === "0" ? null : atomic;
  } catch {
    return null;
  }
}

/** Commit an evaluation as the new single-operand token list (the "= result" tap). */
export function commit(tokens: CalcTokens, decimals: number): CalcTokens {
  const result = evaluate(tokens, decimals);
  if (result.kind !== "value" || result.value.startsWith("-")) return tokens;
  return [result.value];
}

/** Group an operand's integer digits for display: "1234.5" → "1,234.5". */
export function groupOperand(operand: string): string {
  const negative = operand.startsWith("-");
  const body = negative ? operand.slice(1) : operand;
  const [intPart = "", fracPart] = body.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${fracPart !== undefined ? `.${fracPart}` : ""}`;
}

/** Format a final amount with fixed display decimals: ("25", 2) → "25.00". */
export function formatFixed(value: string, decimals: number): string {
  const [intPart = "0", fracPart = ""] = value.split(".");
  const frac = decimals > 0 ? `.${fracPart.padEnd(decimals, "0").slice(0, decimals)}` : "";
  return `${groupOperand(intPart)}${frac}`;
}

/** Map a physical keyboard key to a calculator key. */
export function keyFromKeyboard(key: string): CalcKey | null {
  if (/^[0-9]$/.test(key)) return key as Digit;
  switch (key) {
    case ".":
    case ",":
      return ".";
    case "Backspace":
      return "back";
    case "Escape":
      return "clear";
    case "+":
      return "+";
    case "-":
      return "−";
    case "*":
    case "x":
      return "×";
    case "/":
      return "÷";
    default:
      return null;
  }
}
