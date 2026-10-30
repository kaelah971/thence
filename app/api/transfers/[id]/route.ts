/**
 * GET /api/transfers/:id — owner-scoped transfer detail (B4.1).
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { getTransferDetail } from "@/lib/transfers";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const { id } = await context.params;
    const transfer = await getTransferDetail(session.userId, id);
    if (!transfer) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Transfer not found." }, { status: 404 });
    }
    return NextResponse.json({ transfer }, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "TRANSFER_FAILED", message: "Request failed." }, { status: 500 });
  }
}
