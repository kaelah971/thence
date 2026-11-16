// Vitest setup: load the local environment (.env), then route ALL database
// access to the isolated test database — never production.
//
// Live integration tests require an explicit THENCE_TEST_DATABASE_URL that
// global setup PROVED (read-only anchor check) to be the isolated test
// project. Without that proof DATABASE_URL is removed from this worker, so
// no test — gated or not — can reach any other database. Values are never
// printed.
import "dotenv/config";
import { beforeAll, inject } from "vitest";

import { installDeterministicSatora, isLiveSatoraRequested } from "./tests/satora-fixture";
import { installTestDatabaseUrl } from "./tests/test-db";

// Release tests never depend on Satora's availability: the singleton SDK
// client answers reference data and quotes from captured real responses
// (tests/satora-fixture.ts). THENCE_TEST_LIVE_SATORA=1 opts back into the live
// provider; tests/satora-live-canary.test.ts checks it explicitly.
if (isLiveSatoraRequested()) {
  console.warn("thence tests: THENCE_TEST_LIVE_SATORA=1 — quotes and reference data come from the LIVE Satora API.");
}
beforeAll(async () => {
  await installDeterministicSatora();
});

const installed = installTestDatabaseUrl(process.env, inject("thenceTestDbProof") ?? null);
if (!installed.installed) {
  console.warn(
    `thence tests: live database tests disabled (${installed.reason}; global: ${inject("thenceTestDbReason") ?? "n/a"}); DATABASE_URL removed, running database-free tests only.`,
  );
}
