/**
 * POST /api/quotes — exact-receive read-only quote (B3.1, authenticated).
 * Never creates a swap, invoice, approval, transfer or payment.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { createQuote } from "@/lib/quotes";
import { readJsonBody } from "@/lib/recipients";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `quotes:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_QUOTES_RATE_PER_MINUTE,
    );
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const quote = await createQuote(await readJsonBody(request));
    return NextResponse.json({ quote }, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "QUOTE_FAILED", message: "Could not obtain a quote." }, { status: 500 });
  }
}
