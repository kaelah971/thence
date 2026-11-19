export const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
export const DESK_STATES = ["QUOTED", "AWAITING_NIM", "VERIFIED", "PAYOUT_PREPARED", "PAYOUT_SUBMITTED", "DELIVERED", "REFUND_DUE", "REFUNDED", "EXPIRED"] as const;
export type DeskState = typeof DESK_STATES[number];
export class DeskError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function amountAtomic(text: string, decimals: number): bigint {
  if (typeof text !== "string" || text.length > 40 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new DeskError("INVALID_AMOUNT", "Enter a valid amount.", 400);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new DeskError("INVALID_AMOUNT", "Too many decimal places.", 400);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}
export function deskCharge(usdc: bigint, rateE18: bigint, feeBps: number) {
  if (usdc <= 0n || rateE18 <= 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new DeskError("INVALID_RATE", "A valid desk price is required.");
  const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const baseLuna = ceil(usdc * 100_000n * 10n ** 18n, 1_000_000n * rateE18);
  const feeLuna = ceil(baseLuna * BigInt(feeBps), 10_000n);
  const totalLuna = baseLuna + feeLuna;
  if (totalLuna > BigInt(Number.MAX_SAFE_INTEGER)) throw new DeskError("INVALID_AMOUNT", "Payment exceeds wallet limits.");
  return { baseLuna, feeLuna, totalLuna };
}
export function reservesUsdc(state: string, quoteFresh: boolean): boolean {
  return state === "QUOTED" ? quoteFresh : ["AWAITING_NIM", "VERIFIED", "PAYOUT_PREPARED", "PAYOUT_SUBMITTED"].includes(state);
}
export interface PayoutTerms { chainId: number; to: string; value: bigint; nonce: number; recipient: string; amount: bigint }
export function assertPayout(actual: PayoutTerms, expected: PayoutTerms): void {
  if (actual.chainId !== expected.chainId || actual.to.toLowerCase() !== expected.to.toLowerCase() || actual.value !== expected.value || actual.nonce !== expected.nonce || actual.recipient.toLowerCase() !== expected.recipient.toLowerCase() || actual.amount !== expected.amount) throw new DeskError("PAYOUT_MISMATCH", "Payout terms did not match the saved order.", 503);
}
