/**
 * POST /api/transfers/:id/attach — bind a client-created swap (B4.2).
 * Verifies the swap read-only against snapshot + quote terms, records only
 * safe provider metadata, and advances QUOTED → SWAP_CREATED. Idempotent for
 * the same swap; conflicting swap ids are rejected, never merged.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, logFundedFailure, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readJsonBody } from "@/lib/transfers";
import { attachSwap } from "@/lib/handoff";

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
    const result = await attachSwap(session.userId, id, await readJsonBody(request));
    return NextResponse.json({ attachment: result.attachment, transferStatus: result.transferStatus, deduplicated: result.deduplicated }, { status: result.deduplicated ? 200 : 201 });
  } catch (err) {
    logFundedFailure("attach", err);
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "ATTACH_FAILED", message: "Could not bind the swap." }, { status: 500 });
  }
}
