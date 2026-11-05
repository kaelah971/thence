/**
 * /api/diagnostics/storage — iOS WebView storage diagnostic (owner only, no money).
 *
 * GET    → { owner, session: { authenticated, tag, createdAt, expiresAt }, diagCookie, serverTime }
 * POST   { runId } → sets the non-sensitive `thence_diag` cookie (owner only)
 * DELETE → clears `thence_diag` (owner only)
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
  readDiagCookie,
  serializeClearedDiagCookie,
  serializeDiagCookie,
  sessionCreatedAt,
  sessionTag,
} from "@/lib/diagnostics";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function notFound(): NextResponse {
  return NextResponse.json({ error: "NOT_FOUND", message: "Not found." }, { status: 404, headers: NO_STORE });
}

async function ownerSession(request: Request): Promise<{ session: AuthenticatedSession | null; owner: boolean }> {
  const session = await getAuthenticatedSession(readSessionToken(request.headers.get("cookie")));
  return { session, owner: session !== null && isDiagnosticsOwner(session.nimiqAddress) };
}

async function payload(session: AuthenticatedSession, diagRunId: string | null) {
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
    const diagRunId = readDiagCookie(request.headers.get("cookie"));
    const { session, owner } = await ownerSession(request);
    if (!session) {
      const body: Record<string, unknown> = { error: "UNAUTHORIZED", message: "Authentication required." };
      if (diagRunId !== null) body["diagCookie"] = { present: true, runId: diagRunId };
      return NextResponse.json(body, { status: 401, headers: NO_STORE });
    }
    if (!owner) return notFound();
    return NextResponse.json(await payload(session, diagRunId), { status: 200, headers: NO_STORE });
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
    const res = NextResponse.json(await payload(session, runId), { status: 200, headers: NO_STORE });
    res.headers.append("Set-Cookie", serializeDiagCookie(runId));
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
    const res = NextResponse.json(await payload(session, null), { status: 200, headers: NO_STORE });
    res.headers.append("Set-Cookie", serializeClearedDiagCookie());
    return res;
  } catch (err) {
    return failure(err);
  }
}
