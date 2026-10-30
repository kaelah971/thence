/**
 * GET /api/verify/:token — public challenge review (B2.3, unauthenticated).
 * Returns only the terms needed to review and sign. `Cache-Control: no-store`.
 *
 * POST /api/verify/:token — public proof submission (B2.3, unauthenticated).
 * Body: { signature: "0x…" } (65-byte EIP-191 personal_sign signature).
 * Recovers the signer, binds proof on match. No session is ever created.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin } from "@/lib/auth";
import { checkRateLimits, clientKeyFromHeaders, globalRateKey } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { readJsonBody } from "@/lib/recipients";
import { completeVerification, getPublicVerification } from "@/lib/verification";
import type { PublicVerificationView } from "@/lib/verification";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "VERIFY_FAILED", message: "Request failed." }, { status: 500 });
}

async function publicGuard(request: Request, token?: string): Promise<null | NextResponse> {
  const env = getEnv();
  // Layered: per-header key always applies. Submissions additionally carry
  // a per-token cap (hashed; the raw token is never stored in counters),
  // reads fall back to a shared global ceiling as forged IPs rotate.
  const entries: Array<{ key: string; limit: number }> = [
    { key: `verification-public:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_VERIFICATION_RATE_PER_MINUTE },
  ];
  if (token !== undefined) {
    const tokenId = createHash("sha256").update(token, "utf8").digest("hex");
    entries.push({ key: `verification-token:${tokenId}`, limit: env.THENCE_VERIFY_ATTEMPTS_PER_TOKEN });
  } else {
    entries.push({ key: globalRateKey("verification-public"), limit: env.THENCE_ANON_GLOBAL_PER_MINUTE });
  }
  const limited = await checkRateLimits(entries);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" },
      },
    );
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  try {
    const blocked = await publicGuard(request);
    if (blocked) return blocked;
    const { token } = await context.params;
    const view: PublicVerificationView | null = await getPublicVerification(token);
    if (!view) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Verification request not found." }, { status: 404 });
    }
    return NextResponse.json({ verification: view }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const { token } = await context.params;
    const blocked = await publicGuard(request, token);
    if (blocked) return blocked;
    const body = await readJsonBody(request);
    const signature =
      typeof body === "object" && body !== null && "signature" in body
        ? (body as { signature?: unknown }).signature
        : undefined;
    if (typeof signature !== "string") {
      throw new AuthError(400, "BAD_BODY", "signature is required.");
    }
    const completed = await completeVerification(token, signature);
    return NextResponse.json(
      { verification: { verified: true, ...completed } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
