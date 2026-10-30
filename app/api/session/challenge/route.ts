/**
 * POST /api/session/challenge — issue a wallet-login challenge (B1).
 * Body (optional): { address?: string } to pre-bind an expected signer.
 * Rate-limited per client (DB-backed fixed window). Never logs secrets.
 */
import { NextResponse } from "next/server";
import { AuthError, issueChallenge } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { checkRateLimits, clientKeyFromHeaders, globalRateKey } from "@/lib/rate-limit";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();
    // Layered: per-header key plus a shared global ceiling. Rotating
    // forwarded headers resets only the first counter, never the second.
    const limited = await checkRateLimits([
      { key: `challenge:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_CHALLENGE_RATE_PER_MINUTE },
      { key: globalRateKey("challenge"), limit: env.THENCE_ANON_GLOBAL_PER_MINUTE },
    ]);
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many challenge requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const address =
      typeof body === "object" && body !== null && "address" in body
        ? (body as { address?: unknown }).address
        : undefined;
    const issued = await issueChallenge(typeof address === "string" ? address : undefined);
    return NextResponse.json({ challenge: issued.message, expiresAt: issued.expiresAt }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "CHALLENGE_FAILED", message: "Could not issue challenge." }, { status: 500 });
  }
}
