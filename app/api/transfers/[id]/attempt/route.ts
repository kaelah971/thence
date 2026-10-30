/**
 * GET /api/transfers/:id/attempt — read-only resume contract (B4.2).
 * Latest attempt + bound swap summary (no secrets), plus transfer status,
 * so a crashed client can recover the same attempt without new side effects.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { getAttemptStatus } from "@/lib/handoff";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const { id } = await context.params;
    const resume = await getAttemptStatus(session.userId, id);
    if (!resume.attempt) {
      return NextResponse.json({ error: "NOT_FOUND", message: "No handoff attempt for this transfer." }, { status: 404 });
    }
    return NextResponse.json(resume, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "ATTEMPT_FAILED", message: "Request failed." }, { status: 500 });
  }
}
