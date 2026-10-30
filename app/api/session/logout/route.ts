/**
 * POST /api/session/logout — revoke the session and clear the cookie (B1).
 * Idempotent: missing or unknown sessions still return 200 with clearing.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, revokeSession, serializeClearedSessionCookie } from "@/lib/auth";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    await revokeSession(request.headers.get("cookie"));
    const response = NextResponse.json({ ok: true }, { status: 200 });
    response.headers.set("Set-Cookie", serializeClearedSessionCookie());
    return response;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "LOGOUT_FAILED", message: "Could not log out." }, { status: 500 });
  }
}
