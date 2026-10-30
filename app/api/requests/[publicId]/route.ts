/**
 * GET /api/requests/:publicId — resolve public payment terms (B2.2).
 * Unauthenticated by design (shareable links). Returns ONLY public terms;
 * never owner ids, session data or history. `Cache-Control: no-store`.
 *
 * PATCH /api/requests/:publicId — creator-only cancellation (B2.2).
 * Terms are immutable: the only accepted body is { "action": "cancel" }.
 * Cancellation is terminal and idempotent.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, checkRateLimits, clientKeyFromHeaders, globalRateKey, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { cancelRequest, getPublicRequest, readJsonBody, rejectRequestForbiddenKeys } from "@/lib/requests";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "REQUEST_FAILED", message: "Request failed." }, { status: 500 });
}

export async function GET(request: Request, context: { params: Promise<{ publicId: string }> }): Promise<NextResponse> {
  try {
    const env = getEnv();
    const limited = await checkRateLimits([
      { key: `requests-read:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_REQUESTS_READ_RATE_PER_MINUTE },
      { key: globalRateKey("requests-read"), limit: env.THENCE_ANON_GLOBAL_PER_MINUTE },
    ]);
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" },
        },
      );
    }
    const { publicId } = await context.params;
    const view = await getPublicRequest(publicId);
    if (!view) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Request not found." }, { status: 404 });
    }
    return NextResponse.json(
      { request: view },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `requests-write:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE,
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { publicId } = await context.params;
    const body = await readJsonBody(request);
    rejectRequestForbiddenKeys(body);
    if (
      typeof body !== "object" ||
      body === null ||
      (body as Record<string, unknown>)["action"] !== "cancel" ||
      Object.keys(body).length !== 1
    ) {
      // Terms are immutable: only cancellation is permitted, nothing else.
      throw new AuthError(400, "IMMUTABLE", "Only { \"action\": \"cancel\" } is accepted.");
    }
    const cancelled = await cancelRequest(session.userId, publicId);
    if (!cancelled) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Request not found." }, { status: 404 });
    }
    return NextResponse.json({ request: cancelled }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
