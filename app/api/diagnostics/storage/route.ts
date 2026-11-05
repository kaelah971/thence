/**
 * /api/diagnostics/storage — iOS WebView storage diagnostic (owner only, no money).
 *
 * GET    → { owner, session: { authenticated, tag, createdAt, expiresAt }, diagCookie, diagCookies, serverTime }
 * POST   { runId } → sets the non-sensitive diagnostic cookie variants (owner only)
 * DELETE → clears every diagnostic cookie variant (owner only)
 *
 * - No session: 401. When the request still carries `thence_diag`, the body
 *   echoes only that cookie's presence and run id (the caller's own random
 *   marker) so the page can tell "only the session cookie was lost" from
 *   "every cookie was lost". Nothing about any account is returned.
 * - Signed in but not an owner: 404 (indistinguishable from a missing page).
 * - Never returns tokens, token hashes, session ids or cookie values other
 *   than the diagnostic run id. Writes nothing to the database.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, getAuthenticatedSession, readSessionToken, type AuthenticatedSession } from "@/lib/auth";
import {
  DIAG_RUN_ID,
  isDiagnosticsOwner,
  readDiagCookies,
  serializeClearedDiagCookieVariants,
  serializeDiagCookieVariants,
  sessionCreatedAt,
  sessionTag,
  type DiagCookieVariant,
} from "@/lib/diagnostics";

type CookieEcho = Record<DiagCookieVariant, string | null>;
const NO_COOKIES: CookieEcho = { persistent: null, session: null, sameSiteNone: null, script: null };

const NO_STORE = { "Cache-Control": "no-store" } as const;

function notFound(): NextResponse {
  return NextResponse.json({ error: "NOT_FOUND", message: "Not found." }, { status: 404, headers: NO_STORE });
}

async function ownerSession(request: Request): Promise<{ session: AuthenticatedSession | null; owner: boolean }> {
  const session = await getAuthenticatedSession(readSessionToken(request.headers.get("cookie")));
  return { session, owner: session !== null && isDiagnosticsOwner(session.nimiqAddress) };
}

async function payload(session: AuthenticatedSession, cookies: CookieEcho) {
  const diagRunId = cookies.persistent;
  const createdAt = await sessionCreatedAt(session.sessionId);
  return {
    owner: true,
    session: {
      authenticated: true,
      tag: sessionTag(session.sessionId),
      createdAt: createdAt?.toISOString() ?? null,
      expiresAt: session.expiresAt.toISOString(),
    },
    diagCookie: { present: diagRunId !== null, runId: diagRunId },
    diagCookies: cookies,
    serverTime: new Date().toISOString(),
  };
}

function failure(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
  }
  return NextResponse.json({ error: "DIAGNOSTIC_FAILED", message: "Diagnostic check failed." }, { status: 500, headers: NO_STORE });
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const cookies = readDiagCookies(request.headers.get("cookie"));
    const diagRunId = cookies.persistent;
    const { session, owner } = await ownerSession(request);
    if (!session) {
      const body: Record<string, unknown> = { error: "UNAUTHORIZED", message: "Authentication required." };
      if (diagRunId !== null) body["diagCookie"] = { present: true, runId: diagRunId };
      if (Object.values(cookies).some((v) => v !== null)) body["diagCookies"] = cookies;
      return NextResponse.json(body, { status: 401, headers: NO_STORE });
    }
    if (!owner) return notFound();
    return NextResponse.json(await payload(session, cookies), { status: 200, headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const { session, owner } = await ownerSession(request);
    if (!session) return NextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (!owner) return notFound();
    let runId: unknown;
    try {
      runId = ((await request.json()) as { runId?: unknown }).runId;
    } catch {
      runId = undefined;
    }
    if (typeof runId !== "string" || !DIAG_RUN_ID.test(runId)) {
      return NextResponse.json({ error: "INVALID_RUN_ID", message: "Invalid diagnostic run id." }, { status: 400, headers: NO_STORE });
    }
    // The script variant is written by the page; echo what this request carried.
    const sent = readDiagCookies(request.headers.get("cookie"));
    const echo: CookieEcho = { persistent: runId, session: runId, sameSiteNone: runId, script: sent.script };
    const res = NextResponse.json(await payload(session, echo), { status: 200, headers: NO_STORE });
    for (const cookie of serializeDiagCookieVariants(runId)) res.headers.append("Set-Cookie", cookie);
    return res;
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const { session, owner } = await ownerSession(request);
    if (!session) return NextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (!owner) return notFound();
    const res = NextResponse.json(await payload(session, NO_COOKIES), { status: 200, headers: NO_STORE });
    for (const cookie of serializeClearedDiagCookieVariants()) res.headers.append("Set-Cookie", cookie);
    return res;
  } catch (err) {
    return failure(err);
  }
}
