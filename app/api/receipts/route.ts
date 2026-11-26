/**
 * GET /api/receipts — the owner's payments, as JSON or CSV.
 * `?format=csv` returns a spreadsheet-friendly export with both tx hashes.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { listReceipts, toCsv } from "@/lib/receipts";

export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };

function range(url: URL): { from?: Date; to?: Date } {
  const days = Number(url.searchParams.get("days") ?? "");
  if (Number.isFinite(days) && days > 0 && days <= 365) {
    return { from: new Date(Date.now() - days * 86_400_000) };
  }
  return {};
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const url = new URL(request.url);
    const rows = await listReceipts(session.userId, range(url));
    if (url.searchParams.get("format") === "csv") {
      return new NextResponse(toCsv(rows), {
        status: 200,
        headers: {
          ...NO_STORE,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="thence-receipts-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }
    return NextResponse.json({ receipts: rows }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    return NextResponse.json({ error: "RECEIPTS_FAILED", message: "Could not read receipts." }, { status: 500, headers: NO_STORE });
  }
}
