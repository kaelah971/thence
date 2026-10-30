/**
 * NIM amounts from the Nimiq provider are integers in Luna.
 * 100,000 Luna = 1 NIM. Formatting is exact (bigint), never floating-point.
 */

export const LUNA_PER_NIM = 100_000n;
export const NIM_DECIMALS = 5;

export interface FormattedNim {
  /** Grouped whole NIM, e.g. "1,234". */
  whole: string;
  /** Fraction digits (2–5, trailing zeros trimmed past 2), e.g. "50" or "00001". */
  fraction: string;
  /** "1,234.50" */
  text: string;
  isZero: boolean;
}

/** Validate a provider balance. Rejects negatives, non-integers and unsafe numbers. */
export function parseLuna(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return BigInt(value);
}

export function formatLuna(luna: bigint): FormattedNim {
  if (luna < 0n) throw new Error("Luna amount must be non-negative");
  const whole = (luna / LUNA_PER_NIM).toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rawFraction = (luna % LUNA_PER_NIM).toString(10).padStart(NIM_DECIMALS, "0");
  const fraction = rawFraction.replace(/0+$/, "").padEnd(2, "0");
  return { whole, fraction, text: `${whole}.${fraction}`, isZero: luna === 0n };
}

/** Short form of a Nimiq address for chips: "NQ12 3456 … 9ABC". */
export function shortNimiqAddress(address: string): string {
  const groups = address.trim().split(/\s+/);
  if (groups.length < 4) return address;
  return `${groups[0]} ${groups[1]} … ${groups[groups.length - 1]}`;
}
