/**
 * GET /api/pilot/status — advisory, read-only payment availability.
 *
 * Session required. Returns only `{ payments: "available" | "paused" }`:
 * no caps, allowlist, switch timestamps or refusal reason. Writes nothing.
 * The UI uses it to show "Payments temporarily unavailable" before an
 * actionable approval screen; createTransfer/prepare enforce the same
 * gates independently, so a stale or spoofed answer cannot fund anything.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { getOwnerAddress, pilotPaymentAvailability } from "@/lib/pilot";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const payments = await pilotPaymentAvailability(await getOwnerAddress(session.userId));
    return NextResponse.json({ payments }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "PILOT_STATUS_FAILED", message: "Could not check payment availability." }, { status: 500 });
  }
}
