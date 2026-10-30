/**
 * Migration runner (B0.1). Usage: `npm run db:migrate`.
 * Requires DATABASE_URL. Never prints the connection string.
 *
 * Single versioned strategy: applies the drizzle-kit journal
 * (`src/db/migrations/meta/_journal.json` + numbered SQL files) via the
 * official drizzle-orm migrator, which tracks applied entries in the
 * `__drizzle_migrations` table — re-runs are safe and repeatable.
 * Schema evolution: `npm run db:generate` (drizzle-kit), then `db:migrate`.
 */
import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, getPool, closePool } from "@/lib/db";

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    console.error("Migration skipped: DATABASE_URL is not configured.");
    process.exit(2);
  }
  await migrate(getDb(), { migrationsFolder: "./src/db/migrations" });
  // Verify via the migrator's own tracking table (no credentials involved).
  const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations");
  console.log(`Migrations applied and verified (${(rows as { n: number }[])[0]?.n ?? 0} tracked).`);
  await closePool();
}

main().catch((err: unknown) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
