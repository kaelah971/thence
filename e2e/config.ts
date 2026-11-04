import { join } from "node:path";

/** Ports for the SIMULATED environment (local only). */
export const E2E_APP_PORT = Number(process.env["E2E_APP_PORT"] ?? 3100);
export const E2E_MOCK_PORT = Number(process.env["E2E_MOCK_PORT"] ?? 4311);
export const E2E_MOCK_TLS_PORT = Number(process.env["E2E_MOCK_TLS_PORT"] ?? 4312);
export const RUN_DIR = join(__dirname, ".run");
export const APP_URL = `http://localhost:${E2E_APP_PORT}`;
export const MOCK_URL = `http://127.0.0.1:${E2E_MOCK_PORT}`;
