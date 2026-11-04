/**
 * P7 E2E — environment bring-up (Playwright globalSetup).
 *
 * Refuses to run unless the database is PROVEN to be the isolated test
 * project, using the same anchor proof as the vitest suite (tests/test-db.ts):
 * THENCE_TEST_DATABASE_URL must reach a database carrying the
 * `__thence_test_anchor` row of project empty-wildflower-93415146 and must not
 * match the operator-held production reference. Production is never touched.
 *
 * Then:
 * 1. starts the SIMULATED Satora + Polygon services (e2e/mock-services.ts);
 * 2. generates an ephemeral E2E wallet (ed25519; this run only) and puts its
 *    Nimiq address on the pilot owner allowlist of the E2E server ONLY;
 * 3. makes sure the TEST database pilot switch allows test payments
 *    (restored afterwards);
 * 4. builds `.next-e2e` (payment + claim flags on — never the release `.next`);
 * 5. starts `next start` against the test database with every external URL
 *    pointed at the simulator.
 */
import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { loadProductionDatabaseUrl } from "../scripts/db-guard";
import { resolveTestDatabaseUrl, testTargetConflictsProduction, verifyTestProjectIdentity } from "../tests/test-db";
import { deriveNimiqAddress } from "../src/lib/nimiq";
import { startMockServices } from "./mock-services";
import { E2E_APP_PORT, E2E_MOCK_PORT, E2E_MOCK_TLS_PORT, RUN_DIR } from "./config";

const ROOT = join(__dirname, "..");

function walletFile(): { address: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const pkcs8Hex = (createPrivateKey({ key: privateKey.export({ format: "der", type: "pkcs8" }), format: "der", type: "pkcs8" }).export({ format: "der", type: "pkcs8" }) as Buffer).toString("hex");
  const address = deriveNimiqAddress(publicKeyHex);
  mkdirSync(RUN_DIR, { recursive: true });
  // Ephemeral TEST key for this run only (gitignored); controls no funds anywhere.
  writeFileSync(join(RUN_DIR, "wallet.json"), JSON.stringify({ publicKeyHex, pkcs8Hex, address }), "utf8");
  return { address };
}

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  let last = "no response";
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
      last = `${res.status} ${(await res.text()).slice(0, 300)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : "fetch failed";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`E2E server did not come up at ${url} (last: ${last})`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // ---- isolation proof (fail closed) ----
  const testUrl = resolveTestDatabaseUrl(process.env);
  if (!testUrl) throw new Error("E2E refused: THENCE_TEST_DATABASE_URL is not set.");
  if (testTargetConflictsProduction(testUrl, loadProductionDatabaseUrl(process.env))) throw new Error("E2E refused: test target matches the production reference.");
  const identity = await verifyTestProjectIdentity(testUrl);
  if (!identity.ok) throw new Error(`E2E refused: test database identity not proven (${identity.reason}).`);
  console.log(`[e2e] test database proven (project ${identity.projectId}); production untouched.`);

  // Run-only self-signed certificate for the simulator's HTTPS listener,
  // trusted ONLY by the E2E server process (NODE_EXTRA_CA_CERTS).
  mkdirSync(RUN_DIR, { recursive: true });
  const keyPath = join(RUN_DIR, "sim-key.pem");
  const certPath = join(RUN_DIR, "sim-cert.pem");
  const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  if (cert.status !== 0) throw new Error("E2E: could not generate the simulator certificate (openssl).");
  const stopMocks = await startMockServices(E2E_MOCK_PORT, { port: E2E_MOCK_TLS_PORT, key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") });
  const wallet = walletFile();

  // ---- TEST database pilot switch (restored in teardown) ----
  const pool = new Pool({ connectionString: testUrl, max: 1 });
  const before = await pool.query<{ enabled: boolean }>("SELECT enabled FROM pilot_controls WHERE id = 'pilot'");
  const priorEnabled = before.rows[0]?.enabled ?? null;
  console.log(`[e2e] TEST pilot switch before run: ${priorEnabled === null ? "no row" : priorEnabled ? "ENABLED" : "DISABLED"}; enabling for this run only.`);
  if (priorEnabled !== true) {
    await pool.query("INSERT INTO pilot_controls (id, enabled, updated_at, note) VALUES ('pilot', true, NOW(), 'e2e: test database only') ON CONFLICT (id) DO UPDATE SET enabled = true, updated_at = NOW(), note = 'e2e: test database only'");
  }

  // ---- build (dedicated dir, flags on) ----
  const buildEnv = {
    ...process.env,
    THENCE_NEXT_DIST_DIR: ".next-e2e",
    NEXT_PUBLIC_THENCE_ENABLE_PAYMENT: "1",
    NEXT_PUBLIC_THENCE_ENABLE_CLAIM: "1",
    NEXT_PUBLIC_THENCE_BUILD_REF: "e2e-sim",
    DATABASE_URL: "postgresql://build:build@build.invalid:5432/none",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;
  // Always rebuild (never test stale code) unless explicitly told to reuse a build.
  if (process.env["E2E_SKIP_BUILD"] !== "1" || !existsSync(join(ROOT, ".next-e2e", "BUILD_ID"))) {
    console.log("[e2e] building .next-e2e (payment + claim flags ON, simulated environment)…");
    // `next build` rewrites these to point at the build dir; the release
    // tree must keep referencing `.next`, so restore them afterwards.
    const generated = ["next-env.d.ts", "tsconfig.json"].map((f) => [join(ROOT, f), readFileSync(join(ROOT, f), "utf8")] as const);
    const built = spawnSync("npx", ["next", "build"], { cwd: ROOT, env: buildEnv, stdio: "inherit", shell: true });
    for (const [file, content] of generated) writeFileSync(file, content, "utf8");
    if (built.status !== 0) throw new Error("E2E build failed.");
  }

  // ---- server under test ----
  const mock = `https://127.0.0.1:${E2E_MOCK_TLS_PORT}`;
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    THENCE_NEXT_DIST_DIR: ".next-e2e",
    // `test`: Next serves the production build; Thence relaxes ONLY its
    // https-origin requirement and the cookie `Secure` flag (plain localhost).
    NODE_ENV: "test",
    DATABASE_URL: testUrl,
    THENCE_APP_ORIGIN: `http://localhost:${E2E_APP_PORT}`,
    THENCE_ALLOWED_ORIGINS: `http://localhost:${E2E_APP_PORT},http://127.0.0.1:${E2E_APP_PORT}`,
    THENCE_SATORA_BASE_URL: `${mock}/satora`,
    THENCE_EVM_RPCS_JSON: JSON.stringify({ "137": `${mock}/polygon` }),
    THENCE_NIMIQ_RPC_URL: `${mock}/nimiq`,
    THENCE_ENABLED_ROUTES: "usdc-polygon",
    THENCE_ROUTE_TOKENS_JSON: JSON.stringify({ "usdc-polygon": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" }),
    THENCE_PILOT_ENABLED: "1",
    THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: wallet.address,
    THENCE_PILOT_MAX_TARGET_ATOMIC: "300000",
    THENCE_PILOT_MAX_SPEND_ATOMIC: "100000000",
    THENCE_PILOT_MAX_TRANSFERS: "50",
    THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE: "600",
    THENCE_QUOTES_RATE_PER_MINUTE: "600",
    THENCE_CHALLENGE_RATE_PER_MINUTE: "600",
    THENCE_VERIFY_RATE_PER_MINUTE: "600",
    THENCE_ANON_GLOBAL_PER_MINUTE: "6000",
    THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE: "600",
    CRON_SECRET: "",
    NODE_EXTRA_CA_CERTS: certPath,
  };
  delete serverEnv["THENCE_PRODUCTION_ENV_FILE"];
  const server: ChildProcess = spawn("npx", ["next", "start", "-p", String(E2E_APP_PORT)], { cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], shell: true });
  // Server output is kept (test run only) so specs can prove no secret is ever logged.
  const serverLog = join(RUN_DIR, "server.log");
  writeFileSync(serverLog, "", "utf8");
  const append = (d: Buffer) => appendFileSync(serverLog, d);
  server.stdout?.on("data", (d: Buffer) => {
    append(d);
    if (process.env["E2E_VERBOSE"] === "1") process.stdout.write(`[server] ${d}`);
  });
  server.stderr?.on("data", (d: Buffer) => {
    append(d);
    process.stderr.write(`[server] ${d}`);
  });
  const killServer = () => {
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGTERM");
  };
  try {
    await waitFor(`http://localhost:${E2E_APP_PORT}/api/routes/public`, 90_000);
  } catch (err) {
    killServer();
    await stopMocks();
    await pool.end();
    throw err;
  }
  console.log(`[e2e] Thence (production build, simulated externals) on http://localhost:${E2E_APP_PORT}`);

  return async () => {
    killServer();
    await stopMocks();
    // TEST database cleanup: the ephemeral E2E owner and everything it created (cascade).
    await pool.query("DELETE FROM users WHERE nimiq_address = $1", [wallet.address]);
    await pool.query("DELETE FROM job_leases WHERE name LIKE 'claim:%' AND expires_at < NOW() - interval '1 hour'");
    // Restore the suites' defined baseline (DISABLED, fail-closed — see
    // tests/f81-pilot-attempt-limits.test.ts), never a remembered value.
    await pool.query("UPDATE pilot_controls SET enabled = false, updated_at = NOW(), note = 'test baseline: DISABLED (after e2e)' WHERE id = 'pilot'");
    await pool.end();
  };
}
