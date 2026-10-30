/**
 * POST /api/me/onboarding — complete onboarding for the session user (F2).
 * Body: { displayName: string }.
 *
 * - Requires a valid session; the user id comes only from the session.
 * - Same-origin enforced; 8 KB body cap; owner/identity fields rejected.
 * - Write-once: if onboarding already completed, the saved name is kept
 *   and the existing profile is returned with `applied: false`.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { completeOnboarding } from "@/lib/profile";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { readJsonBody, rejectForbiddenKeys } from "@/lib/recipients";

const IDENTITY_KEYS = new Set(["userId", "user_id", "id", "nimiqAddress", "nimiq_address", "address", "onboardingCompletedAt"]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const limited = await checkRateLimit(
      `profile-write:${rateLimitKeyFor(session.userId, request.headers)}`,
      getEnv().THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE,
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const body = await readJsonBody(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AuthError(400, "BAD_BODY", "Request body must be a JSON object.");
    }
    rejectForbiddenKeys(body);
    for (const key of Object.keys(body)) {
      if (IDENTITY_KEYS.has(key)) throw new AuthError(400, "FIELD_FORBIDDEN", `Field "${key}" cannot be set by clients.`);
    }
    const { profile, applied } = await completeOnboarding(session.userId, (body as Record<string, unknown>)["displayName"]);
    return NextResponse.json({ profile, applied }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "PROFILE_FAILED", message: "Could not save your profile." }, { status: 500 });
  }
}
