/**
 * F6.2.1 + S0 — test database isolation guard.
 *
 * RULE: a generic `DATABASE_URL` NEVER authorizes live integration tests.
 * Live database tests run only against an explicitly configured
 * `THENCE_TEST_DATABASE_URL` that has been PROVEN, over the network, to be
 * the isolated test project (anchor row `__thence_test_anchor`, which
 * production lacks). The proof runs once per `vitest run` in
 * `tests/global-setup.ts`; workers receive only a SHA-256 of the proven URL
 * and install the test URL only when it hashes to the same value.
 *
 * S0 hardening over F6.2.1:
 * - The anchor proof is now MANDATORY for live tests (previously only the
 *   CI script ran it; vitest relied on a tuple comparison alone).
 * - Neon `-pooler` hosts are normalized, and the role is ignored, so the
 *   pooled endpoint or another role on the production database can no
 *   longer pass as "different" (see scripts/db-guard.ts).
 * - When live tests are NOT installed, `DATABASE_URL` is scrubbed from the
 *   test process. Previously it was left untouched — so a database-touching
 *   test without a LIVE gate would have reached whatever `.env` held, which
 *   until S0 was production.
 *
 * This module never prints, logs, or returns connection strings or
 * passwords. Refusal reasons are static strings.
 */
import { createHash } from "node:crypto";
import {
  TEST_ANCHOR_TABLE,
  TEST_PROJECT_ID,
  loadProductionDatabaseUrl,
  parseDbTarget,
  probeAnchor,
  sameDatabase,
  type DbTarget,
} from "../scripts/db-guard";

export { TEST_ANCHOR_TABLE, TEST_PROJECT_ID, parseDbTarget, type DbTarget };

export const TEST_DATABASE_URL_KEY = "THENCE_TEST_DATABASE_URL";
export const APP_DATABASE_URL_KEY = "DATABASE_URL";
/** Worker-local marker: SHA-256 of the test URL that was installed after an anchor proof. */
export const TEST_DB_PROOF_KEY = "THENCE_TEST_DB_PROOF";

/** Proof handed from global setup to workers. Contains no URL or credential. */
export interface TestDbProof {
  urlHash: string;
  projectId: string;
}

export function hashDatabaseUrl(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex");
}

/** Explicit test URL, or null when not configured. Never throws. */
export function resolveTestDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = (env[TEST_DATABASE_URL_KEY] ?? "").trim();
  return value ? value : null;
}

/**
 * True when the test target must be refused: unparseable, or the same
 * database as the given production reference (pooler-normalized, role
 * ignored). Fail-closed on any doubt about the test URL itself.
 */
export function testTargetConflictsProduction(testUrl: string, prodUrl: string | null | undefined): boolean {
  if (!parseDbTarget(testUrl)) return true;
  if (!prodUrl || !prodUrl.trim()) return false;
  if (!parseDbTarget(prodUrl)) return false;
  return sameDatabase(testUrl, prodUrl);
}

/**
 * Production references for a given env: the operator-held production env
 * file (outside the repo) and, when it differs from the test URL, the
 * original `DATABASE_URL` (captured before installation).
 */
const prodSnapshots = new WeakMap<object, string | undefined>();

function productionReferences(env: Record<string, string | undefined>, testUrl: string, productionFileUrl: string | null): string[] {
  const refs: string[] = [];
  if (productionFileUrl) refs.push(productionFileUrl);
  const app = prodSnapshots.has(env) ? prodSnapshots.get(env) : env[APP_DATABASE_URL_KEY];
  // A DATABASE_URL byte-identical to the proven test URL is the local dev
  // configuration (dev runs against the anchored test project), not a
  // production reference. Any other value is treated as possibly production.
  if (app && app.trim() && app.trim() !== testUrl) refs.push(app);
  return refs;
}

function conflictsAny(testUrl: string, refs: string[]): boolean {
  return !parseDbTarget(testUrl) || refs.some((ref) => testTargetConflictsProduction(testUrl, ref));
}

/** Live integration tests are enabled only after an anchor-proven install. */
export function isLiveTestingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const testUrl = resolveTestDatabaseUrl(env);
  if (!testUrl) return false;
  const marker = env[TEST_DB_PROOF_KEY];
  if (!marker || marker !== hashDatabaseUrl(testUrl)) return false;
  if ((env[APP_DATABASE_URL_KEY] ?? "").trim() !== testUrl) return false;
  return true;
}

export interface InstallResult {
  installed: boolean;
  /** Static reason string — never contains a URL or credential. */
  reason: string;
}

function scrub(env: Record<string, string | undefined>, reason: string): InstallResult {
  // Fail closed: never leave a possibly-production DATABASE_URL reachable
  // from a test process that did not prove its target.
  delete env[APP_DATABASE_URL_KEY];
  delete env[TEST_DB_PROOF_KEY];
  return { installed: false, reason };
}

/**
 * Route application database access at `DATABASE_URL` to the proven test
 * database. Call once from `vitest.setup.ts` before app modules initialize
 * their lazy pools. Without a matching proof, or on any production conflict,
 * `DATABASE_URL` is REMOVED from `env` and live tests stay disabled.
 */
export function installTestDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  proof: TestDbProof | null = null,
  productionFileUrl: string | null = loadProductionDatabaseUrl(env),
): InstallResult {
  const testUrl = resolveTestDatabaseUrl(env);
  if (!prodSnapshots.has(env)) prodSnapshots.set(env, env[APP_DATABASE_URL_KEY]);
  if (!testUrl) return scrub(env, `missing ${TEST_DATABASE_URL_KEY}`);
  if (conflictsAny(testUrl, productionReferences(env, testUrl, productionFileUrl))) {
    return scrub(env, "test target matches production target");
  }
  if (!proof || proof.projectId !== TEST_PROJECT_ID) return scrub(env, "test database identity not proven (anchor)");
  if (proof.urlHash !== hashDatabaseUrl(testUrl)) return scrub(env, "test URL changed after identity proof");
  env[APP_DATABASE_URL_KEY] = testUrl;
  env[TEST_DB_PROOF_KEY] = proof.urlHash;
  return { installed: true, reason: "installed" };
}

export interface IdentityProof {
  ok: boolean;
  /** Project id read from the anchor, or null. Identifiers only — never credentials. */
  projectId: string | null;
  /** Static reason string. */
  reason: string;
}

/**
 * Endpoint-agnostic identity proof: connects (read-only) with the candidate
 * URL and requires the test-project anchor row. Any endpoint of production
 * lacks the table, so this refuses regardless of hostname sharing.
 */
export async function verifyTestProjectIdentity(url: string): Promise<IdentityProof> {
  const probe = await probeAnchor(url);
  if (!probe.anchored) return { ok: false, projectId: null, reason: probe.reason === "unreachable" ? "unreachable-or-unmarked" : "unmarked" };
  if (probe.projectId === TEST_PROJECT_ID) return { ok: true, projectId: probe.projectId, reason: "verified" };
  return { ok: false, projectId: probe.projectId, reason: "unexpected-project" };
}
