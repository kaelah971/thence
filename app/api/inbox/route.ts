/** GET/POST /api/inbox — owner-scoped notification inbox, derived from events. */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { listInbox, markInboxSeen } from "@/lib/inbox";

export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    return NextResponse.json(await listInbox(session.userId), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    return NextResponse.json({ error: "INBOX_FAILED", message: "Could not read notifications." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    await markInboxSeen(session.userId);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    return NextResponse.json({ error: "INBOX_FAILED", message: "Could not update notifications." }, { status: 500, headers: NO_STORE });
  }
}
