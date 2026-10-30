/**
 * GET /api/recipients/:id — fetch one owned recipient with destinations (B2.1).
 * PATCH /api/recipients/:id — rename / archive / unarchive (B2.1).
 * Cross-user ids resolve to 404 (no existence oracle).
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import {
  getRecipientDetail,
  readJsonBody,
  rejectForbiddenKeys,
  updateRecipient,
} from "@/lib/recipients";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "RECIPIENT_FAILED", message: "Request failed." }, { status: 500 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const { id } = await context.params;
    const detail = await getRecipientDetail(session.userId, id);
    if (!detail) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Recipient not found." }, { status: 404 });
    }
    return NextResponse.json({ recipient: detail }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
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
    const body = await readJsonBody(request);
    rejectForbiddenKeys(body);
    if (typeof body !== "object" || body === null) {
      throw new AuthError(400, "BAD_BODY", "Request body must be a JSON object.");
    }
    const { displayName, archived } = body as Record<string, unknown>;
    if (displayName !== undefined && typeof displayName !== "string") {
      throw new AuthError(400, "BAD_BODY", "displayName must be a string.");
    }
    if (archived !== undefined && typeof archived !== "boolean") {
      throw new AuthError(400, "BAD_BODY", "archived must be a boolean.");
    }
    if (displayName === undefined && archived === undefined) {
      throw new AuthError(400, "BAD_BODY", "Nothing to update.");
    }
    const updated = await updateRecipient(session.userId, id, {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(archived !== undefined ? { archived } : {}),
    });
    if (!updated) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Recipient not found." }, { status: 404 });
    }
    return NextResponse.json({ recipient: updated }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
