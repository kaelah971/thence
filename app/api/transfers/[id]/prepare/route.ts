/**
 * POST /api/transfers/:id/prepare — durable handoff preparation (B4.2).
 * Revalidates snapshot + quote + route, then issues (or replays) a single
 * active attempt. No swap is created; nothing is funded or approved.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, logFundedFailure, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readJsonBody } from "@/lib/transfers";
import { prepareHandoff } from "@/lib/handoff";

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
    const expectedQuoteRevision =
      typeof body === "object" && body !== null && "expectedQuoteRevision" in body
        ? (body as { expectedQuoteRevision?: unknown }).expectedQuoteRevision
        : undefined;
    const { attempt, token, deduplicated } = await prepareHandoff(session.userId, id, expectedQuoteRevision);
    return NextResponse.json({ attempt, attemptToken: token, deduplicated }, { status: deduplicated ? 200 : 201 });
  } catch (err) {
    logFundedFailure("prepare", err);
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "PREPARE_FAILED", message: "Could not prepare handoff." }, { status: 500 });
  }
}
