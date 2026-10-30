// Vitest setup: load the local environment (.env), then route ALL database
// access to the isolated test database — never production.
//
// Live integration tests require an explicit THENCE_TEST_DATABASE_URL that
// provably targets a different database (see tests/test-db.ts). A generic
// DATABASE_URL alone only runs database-free tests; values are never printed.
import "dotenv/config";

import { installTestDatabaseUrl } from "./tests/test-db";

const installed = installTestDatabaseUrl();
if (!installed.installed) {
  console.warn(`thence tests: live database tests disabled (${installed.reason}); running database-free tests only.`);
}
