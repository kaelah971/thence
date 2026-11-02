/**
 * POST /api/transfers/:id/handoff-result — minimal client outcome report (B4.3).
 * Accepts owner retirement only when the server verifies no funding (including
 * terminal Satora expiry), initiated, or unknown. Client claims of
 * funded/claimed/delivered/refunded are rejected: only provider evidence
 * advances a transfer.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, fundedFailureCode, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readJsonBody } from "@/lib/transfers";
import { reportHandoffOutcome } from "@/lib/reconcile";

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
    const result = await reportHandoffOutcome(session.userId, id, await readJsonBody(request));
    // Static outcome line (status union only — never request data): without
    // it, 4xx/5xx outcomes are indistinguishable from success in dashboards.
    console.info(`thence handoff-result: closed:${result.status}`);
    return NextResponse.json({ handoff: result }, { status: 200 });
  } catch (err) {
    console.warn(`thence handoff-result: ${fundedFailureCode(err)}`);
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "REPORT_FAILED", message: "Could not record handoff outcome." }, { status: 500 });
  }
}
