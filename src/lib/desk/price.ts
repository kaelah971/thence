import { DeskError } from "./policy";

/** Separate executable desk-price input. Never consumes the legacy display-only rate cache. */
export async function deskRate(now = Date.now()): Promise<{ rateE18: bigint; observedAt: string }> {
  const key = process.env["THENCE_COINGECKO_DEMO_API_KEY"];
  const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,usd-coin&vs_currencies=usd&include_last_updated_at=true", {
    cache: "no-store", signal: AbortSignal.timeout(5000), headers: key ? { "x-cg-demo-api-key": key } : {},
  });
  if (!response.ok) throw new DeskError("PRICE_UNAVAILABLE", "A fresh desk price is unavailable.", 503);
  return validateDeskRate(await response.json(), now);
}
export function validateDeskRate(input: unknown, now: number) {
  const data = input as Record<string, { usd?: number; last_updated_at?: number }>;
  const nim = data?.["nimiq-2"], usdc = data?.["usd-coin"];
  const n = nim?.usd, u = usdc?.usd, nt = nim?.last_updated_at, ut = usdc?.last_updated_at;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n >= 10 || typeof u !== "number" || !Number.isFinite(u) || u < 0.97 || u > 1.03 || !Number.isSafeInteger(nt) || !Number.isSafeInteger(ut) || Math.max(nt!, ut!) * 1000 > now + 30_000 || now - Math.min(nt!, ut!) * 1000 > 300_000) throw new DeskError("PRICE_UNAVAILABLE", "A fresh desk price is unavailable.", 503);
  const scaled = (v: number) => BigInt(v.toFixed(18).replace(".", ""));
  const rateE18 = scaled(n) * 10n ** 18n / scaled(u);
  if (rateE18 <= 0n) throw new DeskError("PRICE_UNAVAILABLE", "Invalid desk price.", 503);
  return { rateE18, observedAt: new Date(Math.min(nt!, ut!) * 1000).toISOString() };
}
