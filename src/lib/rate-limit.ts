/**
 * Thence backend — deployment-safe fixed-window rate limiting (B1).
 *
 * Counters live in PostgreSQL (`auth_rate_limits`), so limits hold across
 * processes and instances. This is deliberately NOT a per-process in-memory
 * limiter: in-memory state must never be presented as production security.
 *
 * Window: 60 seconds. Key: "<scope>:<client>" where client is derived from
 * proxy headers or the socket address (never a secret, only a rough key).
 */
import { sql } from "drizzle-orm";
import { getDb, getPool } from "@/lib/db";

export interface RateLimitDecision {
  allowed: boolean;
  /** 1-based position of this attempt inside the window. */
  count: number;
  limit: number;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSeconds: number;
}

/**
 * Atomically increment the counter for (key, current window) and report
 * whether the attempt is within `limit`. Opportunistically prunes windows
 * older than one hour.
 */
export async function checkRateLimit(key: string, limit: number, now = new Date()): Promise<RateLimitDecision> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const db = getDb();
  // drizzle node-postgres `execute` resolves the raw pg QueryResult ({ rows }).
  const result = (await db.execute(sql`
    INSERT INTO auth_rate_limits (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = auth_rate_limits.count + 1
    RETURNING count
  `)) as unknown as { rows: Array<{ count: number }> };
  const count = result.rows[0]?.count ?? limit + 1;
  if (count === 1) {
    // Prune stale windows at most once per fresh window (cheap, best-effort).
    void getPool()
      .query("DELETE FROM auth_rate_limits WHERE window_start < NOW() - INTERVAL '1 hour'")
      .catch(() => undefined);
  }
  if (count <= limit) return { allowed: true, count, limit, retryAfterSeconds: 0 };
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000));
  return { allowed: false, count, limit, retryAfterSeconds };
}

/**
 * Check several independent limits, failing closed on the first denial.
 * Used to layer a forgeable client key (headers) with an unforgeable one
 * (server-issued challenge/token, or a shared global ceiling). Counters
 * increment for every evaluated scope even when an earlier one denies,
 * so abuse remains observable across all dimensions.
 */
export async function checkRateLimits(
  entries: ReadonlyArray<{ key: string; limit: number }>,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const results = await Promise.all(entries.map((e) => checkRateLimit(e.key, e.limit)));
  const denied = results.find((r) => !r.allowed);
  if (denied) return { allowed: false, retryAfterSeconds: denied.retryAfterSeconds };
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Global abuse ceiling key for a scope, shared across all clients. */
export function globalRateKey(scope: string): string {
  return `${scope}:global`;
}

/**
 * Rate-limit key for a request. Authenticated callers are keyed by their
 * server-derived session user id, which cannot be forged: rotating
 * `x-forwarded-for`/`x-real-ip` must not reset the counter. Only
 * genuinely unauthenticated endpoints fall back to the header-derived key.
 */
export function rateLimitKeyFor(userId: string | null | undefined, headers: Headers): string {
  if (typeof userId === "string" && userId.length > 0) return `user:${userId}`;
  return clientKeyFromHeaders(headers);
}

/** Derive a rough client key from proxy headers, falling back to "unknown". */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 80);
  return "unknown";
}
