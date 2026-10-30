/**
 * GET /api/routes/public — supported routes + live availability (B3.1, public).
 * No secrets, no private provider configuration. Rate-limited; no-store.
 */
import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { checkRateLimits, clientKeyFromHeaders, globalRateKey } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { listPublicRoutes } from "@/lib/quotes";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();
    const limited = await checkRateLimits([
      { key: `routes-public:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_REQUESTS_READ_RATE_PER_MINUTE },
      { key: globalRateKey("routes-public"), limit: env.THENCE_ANON_GLOBAL_PER_MINUTE },
    ]);
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" },
        },
      );
    }
    const result = await listPublicRoutes();
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "ROUTES_FAILED", message: "Request failed." }, { status: 500 });
  }
}
