/**
 * CI gate (F6.2.1/F6.3): prove THENCE_TEST_DATABASE_URL reaches the isolated
 * test project before any integration test runs. Fail closed on any doubt.
 *
 * Checks, in order:
 * 1. Test URL is configured (else exit 2).
 * 2. Test target is not the production reference file's database (else exit 3).
 * 3. Test target differs from any non-identical DATABASE_URL (else exit 4).
 * 4. Live anchor proof: the connection serves the test-project marker row
 *    (else exit 5). Production endpoints lack the marker regardless of
 *    hostname sharing.
 * 5. Migrations tracked match the journal length (evidence of currency).
 *
 * Stdout carries identifiers and counts only — never URLs or credentials.
 * Usage: npx tsx ./tests/ci-verify-test-db.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  APP_DATABASE_URL_KEY,
  TEST_DATABASE_URL_KEY,
  TEST_PROJECT_ID,
  parseDbTarget,
  resolveTestDatabaseUrl,
  testTargetConflictsProduction,
} from "./test-db";
import { loadProductionDatabaseUrl } from "../scripts/db-guard";

async function main(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl(process.env);
  if (!testUrl) {
    console.error(`CI-GUARD: missing ${TEST_DATABASE_URL_KEY}; refusing live tests.`);
    process.exit(2);
  }
  // S0: production is identified by the operator-held production env file
  // (outside the repo). DATABASE_URL may legitimately equal the test URL in
  // local dev; any OTHER DATABASE_URL is still treated as possibly production.
  const appUrl = (process.env[APP_DATABASE_URL_KEY] ?? "").trim();
  if (testTargetConflictsProduction(testUrl, loadProductionDatabaseUrl())) {
    console.error("CI-GUARD: test target matches the production reference; refusing live tests.");
    process.exit(3);
  }
  if (appUrl && appUrl !== testUrl && testTargetConflictsProduction(testUrl, appUrl)) {
    console.error("CI-GUARD: test target matches production target; refusing live tests.");
    process.exit(4);
  }
  const client = new Client({
    connectionString: testUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 20000,
  });
  try {
    await client.connect();
    const anchor = await client.query("SELECT project_id FROM __thence_test_anchor LIMIT 1");
    const projectId = anchor.rows[0]?.project_id;
    if (projectId !== TEST_PROJECT_ID) {
      console.error("CI-GUARD: test-project anchor mismatch; refusing live tests.");
      process.exit(5);
    }
    const tracked = await client.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "src", "db", "migrations", "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    const applied = (tracked.rows[0] as { n: number } | undefined)?.n ?? -1;
    console.log(`CI-GUARD: test project verified (${projectId}); migrations ${applied}/${journal.entries.length}.`);
    if (applied !== journal.entries.length) {
      console.error("CI-GUARD: migration count mismatch; refusing live tests.");
      process.exit(6);
    }
  } catch (error) {
    // Static text only: pg errors can embed hosts and database names.
    console.error("CI-GUARD: verification failed (connection or query error); refusing live tests.");
    process.exit(7);
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore close errors.
    }
  }
}

void main();
