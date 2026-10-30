/**
 * POST /api/transfers/:id/requote — refresh with new live provider terms (B4.1).
 * Body: { expectedQuoteRevision: number }. Optimistic concurrency: a stale
 * revision never overwrites a newer quote. Pre-funding QUOTED only.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readJsonBody, requoteTransfer } from "@/lib/transfers";

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
    const body = await readJsonBody(request);
    const expected =
      typeof body === "object" && body !== null && "expectedQuoteRevision" in body
        ? (body as { expectedQuoteRevision?: unknown }).expectedQuoteRevision
        : undefined;
    if (typeof expected !== "number") {
      throw new AuthError(400, "BAD_BODY", "expectedQuoteRevision is required.");
    }
    const transfer = await requoteTransfer(session.userId, id, expected);
    return NextResponse.json({ transfer }, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "REQUOTE_FAILED", message: "Could not re-quote transfer." }, { status: 500 });
  }
}
