/**
 * GET /api/transfers/:id/reconciliation — read-only resume contract (B4.3).
 * Same transfer, same attempt, same bound invoice; never creates anything.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { getReconciliation } from "@/lib/reconcile";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `transfers-read:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_TRANSFERS_READ_RATE_PER_MINUTE,
    );
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id } = await context.params;
    const resume = await getReconciliation(session.userId, id);
    return NextResponse.json(resume, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "RECONCILIATION_FAILED", message: "Request failed." }, { status: 500 });
  }
}
