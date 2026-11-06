/**
 * POST /api/transfers/:id/claim-intent — P3 server authorization of ONE
 * explicit Finish-delivery attempt (owner session only).
 *
 * Re-verifies, immediately before the browser's claim: owner, swap identity,
 * payment hash, destination, amount, chain/token, the on-chain HTLC lock and
 * deadline, the five-minute unsafe window and that no claim/refund exists yet;
 * then holds a short per-transfer claim lease (duplicate tabs/devices are
 * refused) and records SERVER_FUNDED → CLAIMING. The body is ignored. Nothing
 * here claims, pays or touches the preimage — that stays in the browser SDK.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { authorizeClaim } from "@/lib/claim-intent";

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
    const intent = await authorizeClaim(session.userId, id);
    console.info(`thence claim-intent: authorized:${intent.retry ? "retry" : "first"}`);
    return NextResponse.json({ claim: intent }, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      console.warn(`thence claim-intent: ${err.code}`);
      return NextResponse.json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, { status: err.status });
    }
    console.warn("thence claim-intent: CLAIM_INTENT_FAILED");
    return NextResponse.json({ error: "CLAIM_INTENT_FAILED", message: "Couldn't check this payment. Try again shortly." }, { status: 500 });
  }
}
