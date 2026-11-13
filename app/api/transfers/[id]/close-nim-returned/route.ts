/**
 * POST /api/transfers/:id/close-nim-returned — R2 owner action.
 *
 * Closes a failed Nimiq Pay → Lightning handoff as EXPIRED_UNFUNDED only after
 * the server re-proves, at request time, that the locked NIM returned in full
 * to the owner on-chain (complete HTLC history, owner-signed timeout/early
 * resolve, macro-final, zero balance), plus every P4 provider and Polygon
 * no-activity gate. Any doubt keeps the payment open and its exposure slot.
 *
 * Never signs, broadcasts, claims or refunds. The body is ignored: the client
 * cannot supply evidence.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { closeExpiredNimReturned } from "@/lib/nim-return-resolution";

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
    const result = await closeExpiredNimReturned(session.userId, id);
    return NextResponse.json({ resolution: result }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "CLOSE_FAILED", message: "Could not close this payment. It stays open." }, { status: 500 });
  }
}
