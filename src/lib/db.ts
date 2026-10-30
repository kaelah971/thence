/**
 * Thence backend — PostgreSQL connection (B0 foundation).
 *
 * - Single lazily-created `pg` Pool (production-shaped: bounded pool).
 * - Drizzle ORM instance over node-postgres.
 * - No custody, no secrets in logs, no wallet logic here.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";

let pool: Pool | null = null;
let dbInstance: NodePgDatabase<typeof schema> | null = null;

function connectionString(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Invalid environment configuration: DATABASE_URL");
  return url;
}

/** Lazily create (or reuse) the shared pool. Safe: never logs the URL. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Keep idle sockets warm so Neon/proxy idle kills surface as
      // replaceable connection errors, not silent stalls.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    // An 'error' event on an idle client would otherwise throw unhandled
    // and crash the process. The failed client is discarded by the pool;
    // the message is deliberately static (never credentials or query text).
    pool.on("error", () => {
      console.error("thence: database pool client error (client discarded)");
    });
  }
  return pool;
}

/** Drizzle database handle. */
export function getDb(): NodePgDatabase<typeof schema> {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

/** Lightweight connectivity probe for the health endpoint. Never exposes credentials. */
export async function checkDatabase(timeoutMs = 3000): Promise<{ reachable: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    const client = await getPool().connect();
    try {
      await Promise.race([
        client.query("SELECT 1"),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("db probe timeout")), timeoutMs),
        ),
      ]);
    } finally {
      client.release();
    }
    return { reachable: true, latencyMs: Date.now() - started };
  } catch {
    return { reachable: false, latencyMs: Date.now() - started };
  }
}

/** Test/CLI helper: close the shared pool. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
}
