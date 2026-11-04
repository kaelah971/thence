/**
 * S0 — once-per-run test database identity proof (vitest globalSetup).
 *
 * Runs in the vitest main process BEFORE any worker starts. It proves, over
 * a READ ONLY connection, that THENCE_TEST_DATABASE_URL reaches the isolated
 * test project (anchor row present; production has no such table) and that
 * it is not the production database named by the operator-held production
 * env file. Workers receive only `{ urlHash, projectId }` via `provide` —
 * never a URL or credential — and `vitest.setup.ts` installs the test URL
 * only when it hashes to the proven value. No proof ⇒ no live tests, and
 * DATABASE_URL is scrubbed from every worker.
 */
import "dotenv/config";
import type { GlobalSetupContext } from "vitest/node";
import { loadProductionDatabaseUrl } from "../scripts/db-guard";
import {
  hashDatabaseUrl,
  resolveTestDatabaseUrl,
  testTargetConflictsProduction,
  verifyTestProjectIdentity,
  type TestDbProof,
} from "./test-db";

declare module "vitest" {
  export interface ProvidedContext {
    thenceTestDbProof: TestDbProof | null;
    thenceTestDbReason: string;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const testUrl = resolveTestDatabaseUrl(process.env);
  const refuse = (reason: string) => {
    provide("thenceTestDbProof", null);
    provide("thenceTestDbReason", reason);
  };
  if (!testUrl) return refuse("missing THENCE_TEST_DATABASE_URL");
  if (testTargetConflictsProduction(testUrl, loadProductionDatabaseUrl(process.env))) {
    return refuse("test target matches production reference");
  }
  const identity = await verifyTestProjectIdentity(testUrl);
  if (!identity.ok || !identity.projectId) return refuse(`test database identity not proven (${identity.reason})`);
  provide("thenceTestDbProof", { urlHash: hashDatabaseUrl(testUrl), projectId: identity.projectId });
  provide("thenceTestDbReason", "verified");
}
