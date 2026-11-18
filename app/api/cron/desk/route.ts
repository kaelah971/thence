import { NextResponse } from "next/server";
import { verifyCronAuthorization } from "@/lib/server-reconciler";
import { runDeskBatch } from "@/lib/desk/worker";

export const runtime = "nodejs";
export const maxDuration = 60;
/** This separate authenticated worker CAN broadcast saved treasury payouts. */
export async function GET(request: Request) {
  const auth = verifyCronAuthorization(request.headers.get("authorization"), process.env["CRON_SECRET"]);
  if (auth !== "ok") return NextResponse.json({ error: auth === "not-configured" ? "CRON_NOT_CONFIGURED" : "UNAUTHORIZED" }, { status: auth === "not-configured" ? 503 : 401 });
  try {
    const summary = await runDeskBatch();
    console.log(`thence-desk ${JSON.stringify(summary)}`);
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "DESK_WORKER_UNAVAILABLE" }, { status: 503 });
  }
}
