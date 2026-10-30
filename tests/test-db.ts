/**
 * F6.2.1 — test database isolation guard.
 *
 * RULE: a generic `DATABASE_URL` NEVER authorizes live integration tests.
 * Live database tests run only against an explicitly configured
 * `THENCE_TEST_DATABASE_URL` that provably targets a different database
 * than production.
 *
 * What "provably different" means (no hostname-only check — Neon databases
 * can share hostnames):
 * - The test URL must parse as postgres:// with user, host and database.
 * - The (user, host, port, database) tuple must differ from production's.
 * - Unparseable test URLs fail closed (treated as conflicting).
 *
 * This module never prints, logs, or returns connection strings or
 * passwords. Refusal reasons are static strings. Identity comparisons use
 * parsed components only.
 */

export const TEST_DATABASE_URL_KEY = "THENCE_TEST_DATABASE_URL";
export const APP_DATABASE_URL_KEY = "DATABASE_URL";

export interface DbTarget {
  /** Role (user), e.g. "staging_owner". Never a password. */
  user: string;
  host: string;
  port: string;
  database: string;
}

/** Parse a postgres connection string into non-secret identity components. Null when unparseable. */
export function parseDbTarget(url: string): DbTarget | null {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    const database = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (!parsed.hostname || !database) return null;
    return {
      user: decodeURIComponent(parsed.username),
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || "5432",
      database,
    };
  } catch {
    return null;
  }
}

/** Explicit test URL, or null when not configured. Never throws. */
export function resolveTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = (env[TEST_DATABASE_URL_KEY] ?? "").trim();
  return value ? value : null;
}

/**
 * True when the test target must be refused: unparseable, or identical to
 * production in (user, host, port, database). Fail-closed on any doubt.
 */
export function testTargetConflictsProduction(testUrl: string, prodUrl: string | undefined): boolean {
  const test = parseDbTarget(testUrl);
  if (!test) return true;
  if (!prodUrl || !prodUrl.trim()) return false;
  const prod = parseDbTarget(prodUrl);
  if (!prod) return false;
  return test.user === prod.user && test.host === prod.host && test.port === prod.port && test.database === prod.database;
}

/**
 * Original production URL per environment object, captured before the first
 * install. After installation `DATABASE_URL` holds the test target, so the
 * conflict check must compare against this snapshot — never against the
 * already-swapped value. WeakMap: no env pollution, no cross-test leakage.
 */
const prodSnapshots = new WeakMap<object, string | undefined>();

function prodReference(env: Record<string, string | undefined>): string | undefined {
  if (prodSnapshots.has(env)) return prodSnapshots.get(env);
  return env[APP_DATABASE_URL_KEY];
}

/** Live integration tests are enabled only with a safe explicit test URL. */
export function isLiveTestingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const testUrl = resolveTestDatabaseUrl(env);
  if (!testUrl) return false;
  if (testTargetConflictsProduction(testUrl, prodReference(env))) return false;
  return true;
}

export interface InstallResult {
  installed: boolean;
  /** Static reason string — never contains a URL or credential. */
  reason: string;
}

/**
 * Route application database access at `DATABASE_URL` to the isolated test
 * database. Call once from `vitest.setup.ts` before app modules initialize
 * their lazy pools. Refuses (leaving `DATABASE_URL` untouched) when the test
 * URL is missing or targets production.
 */
export function installTestDatabaseUrl(env: Record<string, string | undefined> = process.env): InstallResult {
  const testUrl = resolveTestDatabaseUrl(env);
  if (!testUrl) return { installed: false, reason: `missing ${TEST_DATABASE_URL_KEY}` };
  if (!prodSnapshots.has(env)) prodSnapshots.set(env, env[APP_DATABASE_URL_KEY]);
  if (testTargetConflictsProduction(testUrl, prodReference(env))) {
    return { installed: false, reason: "test target matches production target" };
  }
  env[APP_DATABASE_URL_KEY] = testUrl;
  return { installed: true, reason: "installed" };
}
