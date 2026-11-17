/**
 * POST /api/transfers/:id/claim-report — f1ca0926: the owner's browser reports
 * what its claim attempt actually sent (codes and public hashes only).
 * Advisory audit evidence; never a delivery decision. See src/lib/claim-report.ts.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { claimReportSchema, recordClaimReport } from "@/lib/claim-report";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(`transfers-write:${rateLimitKeyFor(session.userId, request.headers)}`, env.THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE);
    if (limited.allowed === false) {
      return NextResponse.json({ error: "RATE_LIMITED", message: "Too many requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "BAD_REQUEST", message: "Invalid report." }, { status: 400 });
    }
    const parsed = claimReportSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "BAD_REQUEST", message: "Invalid report." }, { status: 400 });
    const { id } = await context.params;
    const write = await recordClaimReport(session.userId, id, parsed.data);
    // One secret-free journal line per attempt: the exact failing step is now
    // visible to operators (it was browser-only during f1ca0926).
    const f = parsed.data.failure;
    // Codes and step names only (never provider text) in the journal.
    console.info(
      `thence claim-report: ${parsed.data.submission}:${parsed.data.code}${parsed.data.userOpHash ? " userop:1" : ""}${parsed.data.disclosedToInfrastructure ? " disclosed:1" : ""}` +
        `${parsed.data.stage ? ` stage:${parsed.data.stage.replace(/\s+/g, "_")}` : ""}` +
        `${f ? ` fail:${f.step.replace(/\s+/g, "_")}/${f.kind}/${f.rpcCode ?? "-"}/${f.httpStatus ?? "-"}` : ""} ${write}`,
    );
    return NextResponse.json({ recorded: write === "recorded" }, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    console.warn("thence claim-report: CLAIM_REPORT_FAILED");
    return NextResponse.json({ error: "CLAIM_REPORT_FAILED", message: "Couldn't record the report." }, { status: 500 });
  }
}
