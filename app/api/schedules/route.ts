/**
 * GET/POST /api/schedules — the owner's recurring payment intents.
 *
 * A schedule never moves money. It records an amount, a recipient and a
 * cadence so the app can surface it when it comes due; paying it still needs
 * the normal quote and the wallet's approval.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { readJsonBody } from "@/lib/recipients";
import { createSchedule, listSchedules, updateSchedule } from "@/lib/schedules";

export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    return NextResponse.json({ schedules: await listSchedules(session.userId) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    return NextResponse.json({ error: "SCHEDULES_FAILED", message: "Could not read schedules." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const body = await readJsonBody(request);
    const parsed = typeof body === "object" && body !== null && (body as { action?: unknown }).action;
    if (parsed === "create") return NextResponse.json({ schedule: await createSchedule(session.userId, body) }, { status: 201, headers: NO_STORE });
    return NextResponse.json(await updateSchedule(session.userId, body), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    return NextResponse.json({ error: "SCHEDULE_FAILED", message: "Could not update the schedule." }, { status: 500, headers: NO_STORE });
  }
}
