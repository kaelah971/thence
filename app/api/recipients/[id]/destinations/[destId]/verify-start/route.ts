/**
 * POST /api/recipients/:id/destinations/:destId/verify-start (B2.3, authenticated).
 * Starts EVM wallet verification for an owned destination and returns a
 * shareable challenge (token + url + exact message to personal_sign).
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { startDestinationVerification } from "@/lib/verification";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "VERIFY_START_FAILED", message: "Request failed." }, { status: 500 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; destId: string }> },
): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `verification-write:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_VERIFICATION_RATE_PER_MINUTE,
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id, destId } = await context.params;
    const started = await startDestinationVerification(session.userId, id, destId);
    return NextResponse.json({ verification: started }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
