/**
 * P7 — browser E2E (Playwright) against the real Thence production build and
 * real backend, with SIMULATED externals only (Nimiq Pay host, Satora API,
 * Polygon RPC). See e2e/README.md for what this does and does NOT prove.
 *
 * One worker: every spec shares one server and one simulator, and each spec
 * resets the simulator. Chromium (desktop + Pixel 7) and WebKit (iPhone 14)
 * — WebKit is the closest available engine to the Nimiq Pay iOS webview.
 */
import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./e2e/config";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] } },
    { name: "webkit-iphone", use: { ...devices["iPhone 14"] } },
  ],
});
