// Vitest setup: load the local environment (.env), then route ALL database
// access to the isolated test database — never production.
//
// Live integration tests require an explicit THENCE_TEST_DATABASE_URL that
// global setup PROVED (read-only anchor check) to be the isolated test
// project. Without that proof DATABASE_URL is removed from this worker, so
// no test — gated or not — can reach any other database. Values are never
// printed.
import "dotenv/config";
import { inject } from "vitest";

import { installTestDatabaseUrl } from "./tests/test-db";

const installed = installTestDatabaseUrl(process.env, inject("thenceTestDbProof") ?? null);
if (!installed.installed) {
  console.warn(
    `thence tests: live database tests disabled (${installed.reason}; global: ${inject("thenceTestDbReason") ?? "n/a"}); DATABASE_URL removed, running database-free tests only.`,
  );
}
