/**
 * POST /api/transfers/:id/reconcile — one bounded read-only provider refresh (B4.3).
 * Records the observation, advances along legal edges only, never fails unknowns.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { reconcileTransfer } from "@/lib/reconcile";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `transfers-write:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE,
    );
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id } = await context.params;
    const summary = await reconcileTransfer(session.userId, id);
    // Provider-read failures still record a durable observation (committed
    // inside reconcileTransfer) but surface as 503 so callers retry;
    // state never advances on an unreadable provider view.
    if (summary.lastError && summary.lastError.startsWith("PROVIDER_")) {
      return NextResponse.json({ error: summary.lastError, message: "Route provider is temporarily unavailable." }, { status: 503 });
    }
    return NextResponse.json({ reconciliation: summary }, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "RECONCILE_FAILED", message: "Could not reconcile." }, { status: 500 });
  }
}
