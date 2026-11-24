import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

/**
 * GET /api/stats — public, aggregate-only Thence counters.
 *
 * Nothing identifying: three counts and nothing else. Cached for a minute at
 * the edge so a busy Activity screen cannot hammer the database, and marked
 * no-store for the client so it always sees the latest minute.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cached: { at: number; body: StatsBody } | null = null;
const TTL_MS = 60_000;

interface StatsBody {
  people: number;
  payers: number;
  payments: number;
}

async function read(): Promise<StatsBody> {
  const { rows } = await getPool().query<{ people: number; payers: number; payments: number }>(
    `SELECT (SELECT count(*)::int FROM users) AS people,
            (SELECT count(DISTINCT owner_user_id)::int FROM transfers) AS payers,
            (SELECT count(*)::int FROM transfers) AS payments`,
  );
  return rows[0]!;
}

export async function GET(): Promise<NextResponse> {
  try {
    if (cached && Date.now() - cached.at < TTL_MS) {
      return NextResponse.json(cached.body, { headers: { "Cache-Control": "no-store" } });
    }
    const body = await read();
    cached = { at: Date.now(), body };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "STATS_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
