/**
 * GET /api/transfers/:id/provider-evidence — fresh, read-only provider lookup.
 * Owner-bound operator diagnostic. Unlike POST /reconcile, this never writes
 * observations or advances the transfer state.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readBoundProviderEvidence } from "@/lib/reconcile";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `transfers-read:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_TRANSFERS_READ_RATE_PER_MINUTE,
    );
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id } = await context.params;
    const evidence = await readBoundProviderEvidence(session.userId, id);
    return NextResponse.json({ evidence }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "PROVIDER_EVIDENCE_FAILED", message: "Could not inspect the route provider." }, { status: 500 });
  }
}
