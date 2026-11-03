/**
 * POST /api/transfers/:id/close-expired — P4 owner action.
 *
 * Closes an authorized payment stuck in RECONCILING as EXPIRED_UNFUNDED only
 * after the server re-proves, at request time: fresh provider identity +
 * terminal expiry with no EVM transactions, no recorded movement/mismatch/
 * proof/NIM funding, and an independent on-chain scan showing the bound HTLC
 * never moved for this hash lock. Any doubt keeps the payment open.
 *
 * Never initiates payments, claims or refunds. The body is ignored: the
 * client cannot supply evidence.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { closeExpiredUnfunded } from "@/lib/expiry-resolution";

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
    const result = await closeExpiredUnfunded(session.userId, id);
    return NextResponse.json({ resolution: result }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "CLOSE_FAILED", message: "Could not close this payment. It stays open." }, { status: 500 });
  }
}
