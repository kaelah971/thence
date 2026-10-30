/**
 * POST /api/transfers/:id/verify-settlement — read-only on-chain
 * settlement verification (B4.4).
 *
 * The server derives the bound swap and the provider's claim transaction
 * from existing records. Any client-supplied tx hash in the body is
 * ignored: it is never trusted as proof.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { verifySettlement } from "@/lib/settlement";

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
    const result = await verifySettlement(session.userId, id);
    const status =
      result.verdict === "UNAVAILABLE"
        ? 503
        : result.verdict === "INVALID"
          ? 422
          : 200;
    return NextResponse.json({ settlement: result }, { status });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "VERIFY_FAILED", message: "Could not verify settlement." }, { status: 500 });
  }
}
