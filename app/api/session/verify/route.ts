/**
 * POST /api/session/verify — verify a Nimiq Pay signature and open a session (B1).
 * Body: { challenge: string, publicKey: string, signature: string }.
 * The signer is chosen by Nimiq Pay; identity is derived from the VERIFIED
 * public key, never from client claims. Sets an HttpOnly session cookie.
 */
import { NextResponse } from "next/server";
import {
  AuthError,
  assertSafeOrigin,
  serializeSessionCookie,
  verifyChallengeAndLogin,
} from "@/lib/auth";
import { createHash } from "node:crypto";
import { getEnv } from "@/lib/env";
import { checkRateLimits, clientKeyFromHeaders } from "@/lib/rate-limit";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const env = getEnv();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "BAD_BODY", message: "Request body must be JSON." }, { status: 400 });
    }
    const { challenge, publicKey, signature } =
      (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof challenge !== "string" || typeof publicKey !== "string" || typeof signature !== "string") {
      return NextResponse.json(
        { error: "BAD_BODY", message: "challenge, publicKey and signature are required strings." },
        { status: 400 },
      );
    }
    // Layered: per-header key plus a per-challenge cap keyed by the hash of
    // the server-issued challenge. Rotating IPs cannot retry one challenge
    // beyond its cap; the raw challenge is never stored in counters.
    const challengeId = createHash("sha256").update(challenge, "utf8").digest("hex");
    const limited = await checkRateLimits([
      { key: `verify:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_VERIFY_RATE_PER_MINUTE },
      { key: `verify-challenge:${challengeId}`, limit: env.THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE },
    ]);
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many verification attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { login, sessionToken } = await verifyChallengeAndLogin({ challenge, publicKey, signature });
    const ttlMs = env.THENCE_SESSION_TTL_SECONDS * 1000;
    const response = NextResponse.json(
      { user: { id: login.userId, nimiqAddress: login.nimiqAddress } },
      { status: 200 },
    );
    response.headers.set(
      "Set-Cookie",
      serializeSessionCookie(sessionToken, new Date(Date.now() + ttlMs)),
    );
    return response;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "VERIFY_FAILED", message: "Verification failed." }, { status: 500 });
  }
}
