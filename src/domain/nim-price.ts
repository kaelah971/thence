/**
 * Display-only NIM → USDC indicative value (pure, no I/O).
 *
 * This is an approximate MARKET valuation of a NIM balance, derived from two
 * USD prices (NIM/USD and USDC/USD) published by one fixed source. It is NOT a
 * swap quote, NOT a spendable USDC balance and NOT what a payment would
 * deliver: real payments go NIM → Lightning → USDC with provider fees and are
 * priced only at approval. Nothing here may feed quote or payment logic.
 *
 * All arithmetic is exact BigInt. Prices are carried as integers scaled by
 * 1e18; every division rounds DOWN, so an estimate is never overstated.
 */

export const PRICE_SCALE = 10n ** 18n;
const LUNA_PER_NIM = 100_000n;
const USDC_MICRO = 1_000_000n;

/** Reject a source whose observation is older than this. */
export const NIM_PRICE_MAX_AGE_MS = 15 * 60_000;
/** Allowed clock skew for observation timestamps in the future. */
export const NIM_PRICE_MAX_FUTURE_SKEW_MS = 2 * 60_000;
/** USDC must trade within this band of $1 or the pair is treated as unreliable. */
export const USDC_PEG_MIN = 0.97;
export const USDC_PEG_MAX = 1.03;
/** Plausibility ceiling for NIM/USD (fails closed on garbage, not on market moves). */
export const NIM_USD_MAX = 10;

export interface NimUsdcRate {
  /** USDC per 1 NIM, scaled by 1e18 (integer). */
  rateE18: bigint;
  /** Decimal string of the same rate (for display / API). */
  rate: string;
  nimUsd: string;
  usdcUsd: string;
  /** Older of the two source observations (ISO). */
  observedAt: string;
}

/** Exact decimal string → integer scaled by 1e18 (truncates beyond 18 places). */
export function decimalToE18(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").slice(0, 18).padEnd(18, "0");
  return whole * PRICE_SCALE + BigInt(frac);
}

/**
 * A JSON number from the price source → exact scaled integer, via its
 * shortest round-trip decimal text (`String(n)`, expanded from exponent form).
 */
export function priceNumberToE18(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  let text = String(value);
  const exp = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (exp) {
    const digits = `${exp[1]}${exp[2] ?? ""}`;
    const point = exp[1]!.length + Number(exp[3]);
    text = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const scaled = decimalToE18(text);
  return scaled !== null && scaled > 0n ? scaled : null;
}

/** Integer scaled by 1e18 → plain decimal string (trailing zeros trimmed). */
export function e18ToDecimal(v: bigint): string {
  const whole = v / PRICE_SCALE;
  const frac = (v % PRICE_SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export type RateValidation =
  | { ok: true; rate: NimUsdcRate }
  | { ok: false; reason: "malformed" | "implausible" | "depegged" | "stale" | "future" };

/** Validate one source response and derive the NIM/USDC rate (fail closed). */
export function deriveNimUsdcRate(
  input: { nimUsd: unknown; usdcUsd: unknown; nimUpdatedAtSec: unknown; usdcUpdatedAtSec: unknown },
  nowMs: number,
): RateValidation {
  const nim = priceNumberToE18(input.nimUsd);
  const usdc = priceNumberToE18(input.usdcUsd);
  const tNim = input.nimUpdatedAtSec;
  const tUsdc = input.usdcUpdatedAtSec;
  if (nim === null || usdc === null || !Number.isSafeInteger(tNim) || !Number.isSafeInteger(tUsdc)) return { ok: false, reason: "malformed" };
  if ((input.nimUsd as number) >= NIM_USD_MAX) return { ok: false, reason: "implausible" };
  const usdcNum = input.usdcUsd as number;
  if (usdcNum < USDC_PEG_MIN || usdcNum > USDC_PEG_MAX) return { ok: false, reason: "depegged" };
  const oldest = Math.min(tNim as number, tUsdc as number) * 1000;
  const newest = Math.max(tNim as number, tUsdc as number) * 1000;
  if (newest > nowMs + NIM_PRICE_MAX_FUTURE_SKEW_MS) return { ok: false, reason: "future" };
  if (nowMs - oldest > NIM_PRICE_MAX_AGE_MS) return { ok: false, reason: "stale" };
  const rateE18 = (nim * PRICE_SCALE) / usdc; // floor
  if (rateE18 <= 0n) return { ok: false, reason: "implausible" };
  return {
    ok: true,
    rate: { rateE18, rate: e18ToDecimal(rateE18), nimUsd: e18ToDecimal(nim), usdcUsd: e18ToDecimal(usdc), observedAt: new Date(oldest).toISOString() },
  };
}

/** Estimated USDC micro-units (6 decimals) for a luna balance; rounds down. */
export function estimateUsdcMicro(luna: bigint, rateE18: bigint): bigint {
  if (luna < 0n || rateE18 <= 0n) return 0n;
  return (luna * rateE18 * USDC_MICRO) / (LUNA_PER_NIM * PRICE_SCALE);
}

/**
 * Display form of an estimate: cents (rounded down) at or above 0.01 USDC,
 * "< 0.01" below it, "0.00" for an empty balance. Grouped thousands.
 */
export function formatUsdcEstimate(micro: bigint): string {
  if (micro <= 0n) return "0.00";
  if (micro < 10_000n) return "< 0.01";
  const cents = micro / 10_000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}
