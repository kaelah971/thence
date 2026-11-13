/**
 * S0 — local database target guard (development, scripts, tests).
 *
 * WHY: until S0 the local `.env` DATABASE_URL pointed at the production
 * Neon database, so `next dev`, `next start`, migrations, drizzle push/studio
 * and the pilot switch all wrote to production by default. The production
 * connection string now lives OUTSIDE the repository (see
 * `productionEnvFile()`), is never auto-loaded, and every local writer must
 * prove its target is NOT production before connecting.
 *
 * Positive identity, not hostname heuristics:
 * - A non-production database carries the `__thence_test_anchor` marker
 *   table (production has no such table — verified read-only on 2026-11-03).
 * - localhost targets are accepted without the marker (cannot be Neon).
 * - Any target whose (host, port, database) matches the production
 *   reference is refused, with Neon `-pooler` hosts normalized so the pooled
 *   and direct endpoints of the same database compare equal. The role is
 *   deliberately ignored: a different role on the same database is still the
 *   same database.
 *
 * Never prints, logs or returns connection strings or passwords. Reasons are
 * static strings; identity comparisons use parsed components only.
 *
 * Remote connections are certificate-verified (`scripts/db-tls.ts`): the
 * anchor probe is the first thing that touches a candidate database, so it
 * must not be the one connection that accepts any certificate.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { isLocalhostTarget, parseDbTarget, sameDatabase } from "./db-target";
import { verifiedClientConfig } from "./db-tls";

// Shared with `db-tls.ts` through `db-target.ts`; re-exported for existing callers.
export { isLocalhostTarget, normalizeDbHost, parseDbTarget, sameDatabase } from "./db-target";
export type { DbTarget } from "./db-target";

/** Neon project that owns the isolated automated-test database. */
export const TEST_PROJECT_ID = "empty-wildflower-93415146";
/** Marker table proving a connection reached a non-production database. Absent in production. */
export const TEST_ANCHOR_TABLE = "__thence_test_anchor";
/** Override for the production env file location (path only; never a URL). */
export const PRODUCTION_ENV_FILE_KEY = "THENCE_PRODUCTION_ENV_FILE";

/** Location of the operator-held production env file (outside the repository). */
export function productionEnvFile(env: Record<string, string | undefined> = process.env): string {
  const override = (env[PRODUCTION_ENV_FILE_KEY] ?? "").trim();
  return override || join(homedir(), ".thence", "production.env");
}

/**
 * Production reference URL from the operator-held file, or null when the
 * file is absent. Parsed in isolation: it is NEVER merged into process.env.
 */
export function loadProductionDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const file = productionEnvFile(env);
  try {
    if (!existsSync(file)) return null;
    const parsed = parseDotenv(readFileSync(file));
    const url = (parsed["DATABASE_URL"] ?? "").trim();
    return url || null;
  } catch {
    return null;
  }
}

export interface AnchorProbe {
  /** True when the marker table exists and holds a project id. */
  anchored: boolean;
  /** Project id read from the marker, or null. Identifier only — never a credential. */
  projectId: string | null;
  /** Static reason string. */
  reason: "anchored" | "no-anchor" | "unreachable";
}

/**
 * Read-only marker probe. Uses a READ ONLY transaction and `to_regclass`, so
 * it can never write and never errors on a missing table. Error text is
 * static (pg errors can embed hosts and database names).
 */
export async function probeAnchor(url: string): Promise<AnchorProbe> {
  try {
    const { Client } = await import("pg");
    // Certificate-verified TLS for every remote target; connection-string TLS
    // parameters cannot re-enable `sslmode=no-verify` (scripts/db-tls.ts).
    const client = new Client({
      ...verifiedClientConfig(url),
      connectionTimeoutMillis: 15_000,
      statement_timeout: 15_000,
    });
    try {
      await client.connect();
      await client.query("BEGIN TRANSACTION READ ONLY");
      const exists = await client.query(`SELECT to_regclass('public.${TEST_ANCHOR_TABLE}') IS NOT NULL AS present`);
      if (exists.rows[0]?.present !== true) {
        await client.query("ROLLBACK");
        return { anchored: false, projectId: null, reason: "no-anchor" };
      }
      const rows = await client.query(`SELECT project_id FROM ${TEST_ANCHOR_TABLE} LIMIT 1`);
      await client.query("ROLLBACK");
      const projectId = rows.rows[0]?.project_id;
      if (typeof projectId === "string" && projectId.length > 0) return { anchored: true, projectId, reason: "anchored" };
      return { anchored: false, projectId: null, reason: "no-anchor" };
    } finally {
      try {
        await client.end();
      } catch {
        // Ignore close errors; the decision is already made.
      }
    }
  } catch {
    return { anchored: false, projectId: null, reason: "unreachable" };
  }
}

export type NonProductionVerdict =
  | { ok: true; reason: "localhost" | "anchored"; projectId: string | null }
  | { ok: false; reason: "missing" | "unparseable" | "matches-production-reference" | "no-anchor" | "unreachable" };

/**
 * Prove `url` is NOT production. Fail-closed on every doubt.
 * `productionUrl` defaults to the operator-held production env file.
 */
export async function verifyNonProductionTarget(
  url: string | null | undefined,
  productionUrl: string | null = loadProductionDatabaseUrl(),
  probe: (url: string) => Promise<AnchorProbe> = probeAnchor,
): Promise<NonProductionVerdict> {
  const candidate = String(url ?? "").trim();
  if (!candidate) return { ok: false, reason: "missing" };
  if (!parseDbTarget(candidate)) return { ok: false, reason: "unparseable" };
  if (productionUrl && sameDatabase(candidate, productionUrl)) return { ok: false, reason: "matches-production-reference" };
  if (isLocalhostTarget(candidate)) return { ok: true, reason: "localhost", projectId: null };
  const anchor = await probe(candidate);
  if (anchor.anchored) return { ok: true, reason: "anchored", projectId: anchor.projectId };
  return { ok: false, reason: anchor.reason === "unreachable" ? "unreachable" : "no-anchor" };
}
