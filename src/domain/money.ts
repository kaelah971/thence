/**
 * Thence backend — exact-value monetary representations (B0).
 *
 * INVARIANT: monetary amounts are NEVER stored or computed as floats.
 * Canonical storage form is a decimal integer string in the asset's
 * smallest unit ("atomic" units: wei for EVM assets, sats for BTC,
 * Luna-equivalent smallest unit for NIM-side accounting where needed).
 *
 * All helpers operate on bigint and serialize to atomic strings.
 * Any float input is rejected outright.
 */

export const ATOMIC_AMOUNT_RE = /^[0-9]+$/;

/** True when `value` is a canonical atomic amount string (no sign, no decimals, no empty). */
export function isAtomicAmount(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 78) return false; // well beyond uint256 digits
  if (!ATOMIC_AMOUNT_RE.test(value)) return false;
  // Canonical: no leading zeros unless the value is exactly "0".
  if (value.length > 1 && value.startsWith("0")) return false;
  return true;
}

/** Parse a canonical atomic string to bigint, throwing on any non-canonical input. */
export function parseAtomicAmount(value: string): bigint {
  if (!isAtomicAmount(value)) {
    throw new Error("Invalid atomic amount: must be a canonical uint string");
  }
  return BigInt(value);
}

/** Serialize a non-negative bigint to canonical atomic form. Rejects floats/negatives. */
export function toAtomicAmount(value: bigint): string {
  if (typeof value !== "bigint") throw new Error("Atomic amount must be a bigint");
  if (value < 0n) throw new Error("Atomic amount must be non-negative");
  return value.toString(10);
}

/**
 * Convert a human decimal string (e.g. "50.00") to atomic units given the
 * asset's decimal places — using pure string/integer arithmetic, never floats.
 */
export function decimalToAtomic(decimal: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid decimals");
  }
  const m = /^(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m) throw new Error("Invalid decimal amount");
  const intPart = m[1] as string;
  let fracPart = (m[2] ?? "") as string;
  if (fracPart.length > decimals) {
    throw new Error("Too many fractional digits for asset precision");
  }
  fracPart = fracPart.padEnd(decimals, "0");
  const combined = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "") || "0";
  if (!isAtomicAmount(combined)) throw new Error("Invalid decimal amount");
  return combined;
}

/**
 * Convert atomic units back to an exact human decimal string (no floats).
 * E.g. atomicToDecimal("50000000", 6) === "50".
 */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid decimals");
  }
  const amount = parseAtomicAmount(atomic);
  if (decimals === 0) return amount.toString(10);
  const base = 10n ** BigInt(decimals);
  const intPart = amount / base;
  const fracPart = (amount % base).toString(10).padStart(decimals, "0").replace(/0+$/, "");
  return fracPart.length === 0 ? intPart.toString(10) : `${intPart.toString(10)}.${fracPart}`;
}

/** Compare two atomic amounts: -1 | 0 | 1. */
export function compareAtomic(a: string, b: string): -1 | 0 | 1 {
  const x = parseAtomicAmount(a);
  const y = parseAtomicAmount(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Assert a float was never used: rejects number inputs outright. */
export function assertNotFloat(value: unknown): void {
  if (typeof value === "number") {
    throw new Error("Monetary amounts must not be numbers/floats — use atomic strings");
  }
}
