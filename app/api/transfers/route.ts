/**
 * POST /api/transfers — create a transfer intent with live quote binding (B4.1).
 * GET /api/transfers — list the caller's transfers (B4.1).
 * Creation never creates a swap, invoice, approval or payment.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { TRANSFER_STATUSES } from "@/domain/transfers";
import type { TransferStatus } from "@/domain/transfers";
import { createTransfer, listTransfers, readJsonBody, rejectTransferForbiddenFields } from "@/lib/transfers";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "TRANSFER_FAILED", message: "Request failed." }, { status: 500 });
}

async function writeGuard(request: Request, userId: string): Promise<null | NextResponse> {
  const env = getEnv();
  const limited = await checkRateLimit(
    `transfers-write:${rateLimitKeyFor(userId, request.headers)}`,
    env.THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE,
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
    const body = await readJsonBody(request);
    rejectTransferForbiddenFields(body);
    const { transfer, deduplicated } = await createTransfer(session.userId, body);
    return NextResponse.json({ transfer, deduplicated }, { status: deduplicated ? 200 : 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
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
    const statusParam = url.searchParams.get("status");
    if (statusParam !== null && !(TRANSFER_STATUSES as readonly string[]).includes(statusParam)) {
      throw new AuthError(400, "BAD_BODY", "Unknown transfer status.");
    }
    const result = await listTransfers(session.userId, {
      status: (statusParam ?? undefined) as TransferStatus | undefined,
      page: parsePositiveInt(url.searchParams.get("page"), 1),
      pageSize: Math.min(100, parsePositiveInt(url.searchParams.get("pageSize"), 20)),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
