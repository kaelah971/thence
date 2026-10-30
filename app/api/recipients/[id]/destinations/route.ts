/**
 * GET /api/recipients/:id/destinations — list owned destinations (B2.1).
 * POST /api/recipients/:id/destinations — add a destination (B2.1).
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import {
  createDestination,
  getRecipientDetail,
  parseDestinationInput,
  readJsonBody,
} from "@/lib/recipients";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "DESTINATIONS_FAILED", message: "Request failed." }, { status: 500 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const { id } = await context.params;
    const detail = await getRecipientDetail(session.userId, id);
    if (!detail) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Recipient not found." }, { status: 404 });
    }
    return NextResponse.json({ destinations: detail.destinations }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `recipients-write:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE,
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id } = await context.params;
    const input = parseDestinationInput(await readJsonBody(request));
    const created = await createDestination(session.userId, id, input);
    return NextResponse.json({ destination: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
