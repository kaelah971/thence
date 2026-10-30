/**
 * F6.2.1 regression guard: production can never be selected for test writes.
 *
 * Pure unit tests — no database, no network, no real credentials. All URLs
 * below are obviously fake (.invalid) fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  APP_DATABASE_URL_KEY,
  TEST_DATABASE_URL_KEY,
  installTestDatabaseUrl,
  isLiveTestingEnabled,
  parseDbTarget,
  resolveTestDatabaseUrl,
  testTargetConflictsProduction,
} from "./test-db";

const PROD = "postgresql://neondb_owner:fake-prod-pw@prod.invalid:5432/neondb";
const GOOD_TEST = "postgresql://staging_owner:fake-test-pw@test.invalid:5432/staging";

describe("test database isolation guard (F6.2.1)", () => {
  it("1. refuses a test target identical to production", () => {
    expect(testTargetConflictsProduction(PROD, PROD)).toBe(true);
    const env: Record<string, string> = { [TEST_DATABASE_URL_KEY]: PROD, [APP_DATABASE_URL_KEY]: PROD };
    const result = installTestDatabaseUrl(env);
    expect(result.installed).toBe(false);
    expect(env[APP_DATABASE_URL_KEY]).toBe(PROD);
  });

  it("1b. refuses an unparseable test URL (fail closed)", () => {
    expect(testTargetConflictsProduction("not-a-url", PROD)).toBe(true);
    expect(testTargetConflictsProduction("", PROD)).toBe(true);
  });

  it("2. missing test configuration fails safely", () => {
    expect(resolveTestDatabaseUrl({})).toBeNull();
    expect(resolveTestDatabaseUrl({ [TEST_DATABASE_URL_KEY]: "   " })).toBeNull();
    expect(isLiveTestingEnabled({})).toBe(false);
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: PROD })).toBe(false);
    const env: Record<string, string> = { [APP_DATABASE_URL_KEY]: PROD };
    expect(installTestDatabaseUrl(env).installed).toBe(false);
    expect(env[APP_DATABASE_URL_KEY]).toBe(PROD);
  });

  it("3. accepts a genuinely isolated test database", () => {
    expect(testTargetConflictsProduction(GOOD_TEST, PROD)).toBe(false);
    const env: Record<string, string> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    const result = installTestDatabaseUrl(env);
    expect(result.installed).toBe(true);
    expect(env[APP_DATABASE_URL_KEY]).toBe(GOOD_TEST);
    expect(isLiveTestingEnabled(env)).toBe(true);
  });

  it("4. a generic DATABASE_URL alone cannot authorize mutating tests", () => {
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: PROD })).toBe(false);
    expect(isLiveTestingEnabled({ [APP_DATABASE_URL_KEY]: GOOD_TEST })).toBe(false);
  });

  it("5. integration uses only the installed test URL", () => {
    const env: Record<string, string> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    installTestDatabaseUrl(env);
    // Helpers derive LIVE from the same env: live suites see the test target.
    expect(isLiveTestingEnabled(env)).toBe(true);
    expect(env[APP_DATABASE_URL_KEY]).toBe(GOOD_TEST);
    expect(parseDbTarget(env[APP_DATABASE_URL_KEY] ?? "")).toEqual(parseDbTarget(GOOD_TEST));
  });

  it("6. tests cannot switch to production after setup", () => {
    const env: Record<string, string> = { [TEST_DATABASE_URL_KEY]: GOOD_TEST, [APP_DATABASE_URL_KEY]: PROD };
    expect(installTestDatabaseUrl(env).installed).toBe(true);
    // A later misconfiguration pointing at production must be refused,
    // leaving the installed isolated target in place.
    env[TEST_DATABASE_URL_KEY] = PROD;
    const retry = installTestDatabaseUrl(env);
    expect(retry.installed).toBe(false);
    expect(env[APP_DATABASE_URL_KEY]).toBe(GOOD_TEST);
    expect(isLiveTestingEnabled(env)).toBe(false);
  });
});
