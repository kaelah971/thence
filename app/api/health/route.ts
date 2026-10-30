import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db";
import { parseEnabledRoutes, validateEnv } from "@/lib/env";

/**
 * GET /api/health — minimal B0 health endpoint with safe diagnostics.
 * Returns status + version + environment name + DB reachability.
 * NEVER returns credentials, connection strings, tokens or secrets.
 */
export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  const validation = validateEnv(process.env);
  const configured = validation.ok;

  let db: { reachable: boolean; latencyMs: number } | { reachable: false; reason: string };
  if (configured && process.env["DATABASE_URL"]) {
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
    db: "reason" in db ? { reachable: false, reason: db.reason } : db,
    uptimeSec: Math.floor(process.uptime()),
    latencyMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: 200 });
}
