import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    // Live Neon integration tests issue many sequential round-trips; the
    // default 5s budget flakes under normal cloud latency.
    testTimeout: 60_000,
    // Bound parallel workers: integration files share the isolated test
    // database (THENCE_TEST_DATABASE_URL — never production) and the live
    // Satora API. Unbounded parallelism exhausts connections and trips
    // provider throttling, producing load flakes. Prefer --maxWorkers=2.
    minWorkers: 1,
    maxWorkers: 4,
  },
});
