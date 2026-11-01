/**
 * POST /api/transfers/:id/authorize-handoff — single handoff authorization (B4.2).
 * Revalidates the live swap (still pending, invoice live) and the repricing
 * invariant, then records exactly one authorization per attempt and advances
 * SWAP_CREATED → AWAITING_NIM_APPROVAL. Never invokes Nimiq Pay.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, logFundedFailure, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readJsonBody } from "@/lib/transfers";
import { authorizeHandoff } from "@/lib/handoff";

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
    const body = await readJsonBody(request);
    const attemptToken =
      typeof body === "object" && body !== null && "attemptToken" in body
        ? (body as { attemptToken?: unknown }).attemptToken
        : undefined;
    if (typeof attemptToken !== "string") {
      throw new AuthError(400, "BAD_BODY", "attemptToken is required.");
    }
    // Optional explicit price acceptance (see authorizeHandoff): the exact
    // live sats figure the owner already reviewed. Absent otherwise.
    const acceptRepricedSourceSats =
      typeof body === "object" && body !== null && "acceptRepricedSourceSats" in body
        ? (body as { acceptRepricedSourceSats?: unknown }).acceptRepricedSourceSats
        : undefined;
    const result = await authorizeHandoff(session.userId, id, attemptToken, { acceptRepricedSourceSats });
    return NextResponse.json({ handoff: result }, { status: 200 });
  } catch (err) {
    logFundedFailure("authorize", err);
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        { status: err.status },
      );
    }
    return NextResponse.json({ error: "AUTHORIZE_FAILED", message: "Could not authorize handoff." }, { status: 500 });
  }
}
