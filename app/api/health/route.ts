import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db";
import { parseEnabledRoutes, validateEnv } from "@/lib/env";

/**
 * GET /api/health — minimal B0 health endpoint with safe diagnostics.
 * Returns status + version + environment name + DB reachability.
 * NEVER returns credentials, connection strings, tokens or secrets.
 */
export async function GET(request?: Request): Promise<NextResponse> {
  const started = Date.now();
  // `?probe=app` skips the database on purpose. A one-minute uptime check must
  // not keep a serverless Postgres awake: Neon only suspends after 5 minutes
  // idle, and waking it every minute burned the free plan's compute quota.
  const appOnly = request ? new URL(request.url).searchParams.get("probe") === "app" : false;
  const validation = validateEnv(process.env);
  const configured = validation.ok;

  let db: { reachable: boolean; latencyMs: number } | { reachable: false; reason: string };
  if (appOnly) {
    db = { reachable: true, reason: "not-probed" } as unknown as { reachable: boolean; latencyMs: number };
  } else if (configured && process.env["DATABASE_URL"]) {
    db = await checkDatabase(3000);
  } else {
    db = { reachable: false, reason: "not-configured" };
  }

  const body = {
    status: configured && (db as { reachable: boolean }).reachable ? "ok" : "degraded",
    service: "thence-backend",
    version: configured ? validation.env.APP_VERSION : "unknown",
    env: configured ? validation.env.NODE_ENV : "unknown",
    enabledRoutes: configured ? parseEnabledRoutes(validation.env.THENCE_ENABLED_ROUTES) : [],
    db: appOnly ? { probed: false } : "reason" in db ? { reachable: false, reason: db.reason } : db,
    uptimeSec: Math.floor(process.uptime()),
    latencyMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: 200 });
}
