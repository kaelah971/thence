/**
 * F6.2.1 + S0 regression guard: production can never be selected for test
 * writes, and local commands can never silently target production.
 *
 * Pure unit tests — no database, no network, no real credentials. All URLs
 * below are obviously fake (.invalid) fixtures; anchor probes are injected.
 */
import { describe, expect, it } from "vitest";
import {
  APP_DATABASE_URL_KEY,
  TEST_DATABASE_URL_KEY,
  TEST_DB_PROOF_KEY,
  TEST_PROJECT_ID,
  hashDatabaseUrl,
  installTestDatabaseUrl,
  isLiveTestingEnabled,
  parseDbTarget,
  resolveTestDatabaseUrl,
  testTargetConflictsProduction,
  type TestDbProof,
} from "./test-db";
import { normalizeDbHost, sameDatabase, verifyNonProductionTarget, type AnchorProbe } from "../scripts/db-guard";

const PROD = "postgresql://neondb_owner:fake-prod-pw@ep-prod-123.region.aws.neon.invalid:5432/neondb";
const PROD_POOLER = "postgresql://neondb_owner:fake-prod-pw@ep-prod-123-pooler.region.aws.neon.invalid/neondb?sslmode=require";
const PROD_OTHER_ROLE = "postgresql://readonly:other-pw@ep-prod-123.region.aws.neon.invalid/neondb";
const GOOD_TEST = "postgresql://staging_owner:fake-test-pw@ep-test-456.region.aws.neon.invalid:5432/staging";

const proofFor = (url: string): TestDbProof => ({ urlHash: hashDatabaseUrl(url), projectId: TEST_PROJECT_ID });
const anchored = async (): Promise<AnchorProbe> => ({ anchored: true, projectId: TEST_PROJECT_ID, reason: "anchored" });
const unanchored = async (): Promise<AnchorProbe> => ({ anchored: false, projectId: null, reason: "no-anchor" });

describe("test database isolation guard (F6.2.1 + S0)", () => {
  it("1. refuses a test target identical to production and SCRUBS DATABASE_URL", () => {
    expect(testTargetConflictsProduction(PROD, PROD)).toBe(true);
    const env: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: PROD, [APP_DATABASE_URL_KEY]: PROD };
    // Production named by the operator file: refused even with a forged proof.
    const result = installTestDatabaseUrl(env, proofFor(PROD), PROD);
    expect(result.installed).toBe(false);
    expect(env[APP_DATABASE_URL_KEY]).toBeUndefined();
    expect(isLiveTestingEnabled(env)).toBe(false);
  });

  it("1b. refuses an unparseable test URL (fail closed)", () => {
    expect(testTargetConflictsProduction("not-a-url", PROD)).toBe(true);
    expect(testTargetConflictsProduction("", PROD)).toBe(true);
  });

  it("1c. S0: the Neon pooler endpoint and other roles of production are the SAME database", () => {
    expect(normalizeDbHost("ep-prod-123-pooler.region.aws.neon.invalid")).toBe("ep-prod-123.region.aws.neon.invalid");
    expect(sameDatabase(PROD, PROD_POOLER)).toBe(true);
    expect(sameDatabase(PROD, PROD_OTHER_ROLE)).toBe(true);
    expect(testTargetConflictsProduction(PROD_POOLER, PROD)).toBe(true);
    expect(testTargetConflictsProduction(PROD_OTHER_ROLE, PROD)).toBe(true);
    expect(sameDatabase(PROD, GOOD_TEST)).toBe(false);
  });

  it("2. missing test configuration fails safely and removes DATABASE_URL", () => {
    expect(resolveTestDatabaseUrl({})).toBeNull();
    expect(resolveTestDatabaseUrl({ [TEST_DATABASE_URL_KEY]: "   " })).toBeNull();
    expect(isLiveTestingEnabled({})).toBe(false);
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: PROD })).toBe(false);
    const env: Record<string, string | undefined> = { [APP_DATABASE_URL_KEY]: PROD };
    expect(installTestDatabaseUrl(env, null, null).installed).toBe(false);
    // S0: previously left as PROD; now no database is reachable at all.
    expect(env[APP_DATABASE_URL_KEY]).toBeUndefined();
  });

  it("2b. S0: an unproven test URL is refused even when it looks isolated", () => {
    const env: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    expect(installTestDatabaseUrl(env, null, null).installed).toBe(false);
    expect(env[APP_DATABASE_URL_KEY]).toBeUndefined();
    const env2: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    // Proof for a different URL (test URL changed after the global proof).
    expect(installTestDatabaseUrl(env2, proofFor(GOOD_TEST + "x"), null).reason).toBe("test URL changed after identity proof");
    const env3: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST };
    expect(installTestDatabaseUrl(env3, { urlHash: hashDatabaseUrl(GOOD_TEST), projectId: "some-other-project" }, null).installed).toBe(false);
  });

  it("3. accepts a genuinely isolated, anchor-proven test database", () => {
    const env: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    const result = installTestDatabaseUrl(env, proofFor(GOOD_TEST), PROD);
    expect(result.installed).toBe(true);
    expect(env[APP_DATABASE_URL_KEY]).toBe(GOOD_TEST);
    expect(isLiveTestingEnabled(env)).toBe(true);
  });

  it("3b. S0: local dev config (DATABASE_URL === proven test URL) is accepted", () => {
    const env: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: GOOD_TEST };
    expect(installTestDatabaseUrl(env, proofFor(GOOD_TEST), PROD).installed).toBe(true);
    expect(isLiveTestingEnabled(env)).toBe(true);
  });

  it("4. a generic DATABASE_URL alone cannot authorize mutating tests", () => {
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: PROD })).toBe(false);
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: GOOD_TEST })).toBe(false);
    // Even with the test key set, no proof marker means not live.
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: GOOD_TEST, [TEST_DATABASE_URL_KEY]: GOOD_TEST })).toBe(false);
  });

  it("5. integration uses only the installed test URL", () => {
    const env: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    installTestDatabaseUrl(env, proofFor(GOOD_TEST), null);
    expect(isLiveTestingEnabled(env)).toBe(true);
    expect(env[APP_DATABASE_URL_KEY]).toBe(GOOD_TEST);
    expect(parseDbTarget(env[APP_DATABASE_URL_KEY] ?? "")).toEqual(parseDbTarget(GOOD_TEST));
  });

  it("6. tests cannot switch to production after setup", () => {
    const env: Record<string, string | undefined> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    expect(installTestDatabaseUrl(env, proofFor(GOOD_TEST), null).installed).toBe(true);
    // A later misconfiguration pointing the test key at production is not
    // covered by the proof: live mode turns off immediately.
    env[TEST_DATABASE_URL_KEY] = PROD;
    expect(isLiveTestingEnabled(env)).toBe(false);
    // The only proof a worker can hold is the global one for GOOD_TEST
    // (production has no anchor, so no proof for it can exist).
    const retry = installTestDatabaseUrl(env, proofFor(GOOD_TEST), null);
    expect(retry.installed).toBe(false);
    expect(env[APP_DATABASE_URL_KEY]).toBeUndefined();
    expect(env[TEST_DB_PROOF_KEY]).toBeUndefined();
  });
});

describe("local command guard (S0, scripts/db-guard.ts)", () => {
  it("refuses production by reference, including its pooler endpoint, without probing", async () => {
    let probed = false;
    const spy = async (): Promise<AnchorProbe> => {
      probed = true;
      return anchored();
    };
    expect(await verifyNonProductionTarget(PROD_POOLER, PROD, spy)).toEqual({ ok: false, reason: "matches-production-reference" });
    expect(probed).toBe(false);
  });

  it("refuses an unanchored remote database even when no production reference is available", async () => {
    expect(await verifyNonProductionTarget(PROD, null, unanchored)).toEqual({ ok: false, reason: "no-anchor" });
  });

  it("refuses missing and unparseable targets", async () => {
    expect((await verifyNonProductionTarget("", PROD, anchored)).ok).toBe(false);
    expect((await verifyNonProductionTarget("nope", PROD, anchored)).ok).toBe(false);
  });

  it("accepts the anchored test project and localhost", async () => {
    expect(await verifyNonProductionTarget(GOOD_TEST, PROD, anchored)).toEqual({ ok: true, reason: "anchored", projectId: TEST_PROJECT_ID });
    expect((await verifyNonProductionTarget("postgresql://postgres:postgres@localhost:5432/thence", PROD, unanchored)).ok).toBe(true);
  });
});
