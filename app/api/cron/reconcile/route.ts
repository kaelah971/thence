/**
 * GET /api/cron/reconcile — P6 scheduled server-side reconciliation.
 *
 * Invoked by Vercel Cron (GET + `Authorization: Bearer <CRON_SECRET>`), or by
 * any other scheduler that holds the secret. Fail-closed authentication:
 * without a configured secret (>= 32 chars) nothing runs (503). The handler
 * runs one bounded, lease-protected batch of the SAME reconciliation core
 * the owner route uses, and returns/logs a non-secret summary.
 *
 * Never claims, releases preimages, pays, creates swaps, refunds, clears
 * uncertain exposure or applies the owner-only P4 close. Not gated by the
 * pilot kill switch: reconciliation is recovery, not new funding.
 *
 * Scheduling limits (verified 2026-11-03): the project's team is on the
 * Vercel Hobby plan — cron runs at most ONCE PER DAY, invoked anywhere within
 * the scheduled hour; more frequent expressions fail deployment. See
 * docs/SERVER_RECONCILER.md.
 */
import { NextResponse } from "next/server";
import { cronRunOptions, runServerReconciliation, verifyCronAuthorization } from "@/lib/server-reconciler";

/** Seconds. Below the Hobby 300 s ceiling; the batch budget is 45 s. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const auth = verifyCronAuthorization(request.headers.get("authorization"), process.env["CRON_SECRET"]);
  if (auth === "not-configured") {
    return NextResponse.json({ error: "CRON_NOT_CONFIGURED", message: "Scheduled reconciliation is not configured." }, { status: 503 });
  }
  if (auth !== "ok") {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Unauthorized." }, { status: 401 });
  }
  try {
    const summary = await runServerReconciliation(cronRunOptions());
    // One structured, non-secret line for log-based observability.
    console.log(`thence-reconciler ${JSON.stringify(summary)}`);
    return NextResponse.json({ reconciler: summary }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("thence-reconciler run failed (no details logged)");
    return NextResponse.json({ error: "RECONCILER_FAILED", message: "Reconciliation run failed." }, { status: 500 });
  }
}
