/**
 * GET /api/recipients — list the authenticated user's recipients (B2.1).
 * POST /api/recipients — create a recipient (B2.1).
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import {
  createRecipient,
  listRecipients,
  readJsonBody,
  rejectForbiddenKeys,
} from "@/lib/recipients";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "RECIPIENTS_FAILED", message: "Request failed." }, { status: 500 });
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const url = new URL(request.url);
    const parsePositiveInt = (value: string | null, fallback: number): number => {
      if (value === null) return fallback;
      const n = Math.floor(Number(value));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const result = await listRecipients(session.userId, {
      q: url.searchParams.get("q") ?? undefined,
      includeArchived: url.searchParams.get("archived") === "true",
      page: parsePositiveInt(url.searchParams.get("page"), 1),
      pageSize: Math.min(100, parsePositiveInt(url.searchParams.get("pageSize"), 20)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // F3.1: the browser now calls this; enforce the documented same-origin rule.
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
    const body = await readJsonBody(request);
    rejectForbiddenKeys(body);
    const displayName =
      typeof body === "object" && body !== null && "displayName" in body
        ? (body as { displayName?: unknown }).displayName
        : undefined;
    if (typeof displayName !== "string") {
      throw new AuthError(400, "BAD_BODY", "displayName is required.");
    }
    const created = await createRecipient(session.userId, displayName);
    return NextResponse.json({ recipient: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
