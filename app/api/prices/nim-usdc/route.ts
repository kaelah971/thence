/**
 * GET /api/prices/nim-usdc — display-only NIM/USDC indicative market rate.
 *
 * Public market data from one fixed source (CoinGecko), server-cached. Not a
 * quote, not a balance, never used for payments. Rate-limited per client and
 * globally like other anonymous reads; the upstream itself is hit at most once
 * per cache window regardless of traffic. Fails closed with 200 +
 * `{ status: "unavailable" }` so the UI shows an honest fallback.
 */
import { NextResponse } from "next/server";
import { checkRateLimits, clientKeyFromHeaders, globalRateKey } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { getNimUsdcPrice } from "@/lib/nim-price";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();
    const limited = await checkRateLimits([
      { key: `nim-price:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_REQUESTS_READ_RATE_PER_MINUTE },
      { key: globalRateKey("nim-price"), limit: env.THENCE_ANON_GLOBAL_PER_MINUTE },
    ]);
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" } },
      );
    }
    const price = await getNimUsdcPrice();
    return NextResponse.json({ price }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    // Thence-side failure (config, rate-limit store): never blamed on the upstream.
    return NextResponse.json({ price: { status: "unavailable", reason: "internal" } }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
