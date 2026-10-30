/**
 * POST /api/requests — create a payment request (B2.2, authenticated).
 * GET /api/requests — list the caller's requests (B2.2, authenticated).
 * Creating a request initiates nothing: no payment, no swap, no quote.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { createRequest, listRequests, readJsonBody } from "@/lib/requests";
import type { RequestStatus } from "@/lib/requests";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "REQUESTS_FAILED", message: "Request failed." }, { status: 500 });
}

async function writeGuard(request: Request, userId: string): Promise<null | NextResponse> {
  const env = getEnv();
  const limited = await checkRateLimit(
    `requests-write:${rateLimitKeyFor(userId, request.headers)}`,
    env.THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE,
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const blocked = await writeGuard(request, session.userId);
    if (blocked) return blocked;
    const created = await createRequest(session.userId, await readJsonBody(request));
    return NextResponse.json({ request: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const LIST_STATUSES: ReadonlySet<string> = new Set(["active", "expired", "cancelled", "all"]);

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const url = new URL(request.url);
    const parsePositiveInt = (value: string | null, fallback: number): number => {
      if (value === null) return fallback;
      const n = Math.floor(Number(value));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const statusParam = url.searchParams.get("status") ?? "all";
    if (!LIST_STATUSES.has(statusParam)) {
      throw new AuthError(400, "BAD_BODY", "status must be active, expired, cancelled or all.");
    }
    const result = await listRequests(session.userId, {
      status: statusParam as RequestStatus | "all",
      page: parsePositiveInt(url.searchParams.get("page"), 1),
      pageSize: Math.min(100, parsePositiveInt(url.searchParams.get("pageSize"), 20)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
