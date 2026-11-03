/**
 * F8.2 — pilot database kill-switch operator tool.
 *
 * The database switch (KEY 2 of the two-key rule) is the ONLY instantaneous
 * pilot control: Vercel env changes need a redeploy, this UPDATE does not.
 *
 *   npx tsx scripts/pilot-switch.ts status                          (local non-production DB)
 *   npx tsx scripts/pilot-switch.ts status --production             (read-only)
 *   npx tsx scripts/pilot-switch.ts disable --production --yes --note "reason"
 *   npx tsx scripts/pilot-switch.ts enable  --production --yes --note "reason"
 *
 * - `status` is read-only: prints enabled/updated_at/note (never secrets).
 * - `disable` stops NEW funded pilot execution immediately. Recovery
 *   (reconcile, resume, attempt status, receipt, settlement verification)
 *   keeps working — it never reads this switch.
 * - `enable` requires --yes AND only makes sense after the deployed env is
 *   armed (THENCE_PILOT_ENABLED=1 + allowlist + caps) on a fresh production
 *   deployment that was verified healthy. Enabling here alone changes
 *   nothing unless the deployed env gate is also armed.
 *
 * S0 TARGET SELECTION (explicit, never implicit):
 * - Without --production the target is DATABASE_URL from .env and it must
 *   be PROVEN non-production (localhost or test anchor; scripts/db-guard.ts).
 *   Until S0, .env held the production URL, so a bare local run silently
 *   wrote production.
 * - With --production the target is DATABASE_URL from the operator-held
 *   production env file OUTSIDE the repo (default ~/.thence/production.env,
 *   override THENCE_PRODUCTION_ENV_FILE). It is parsed in isolation, never
 *   merged into process.env, must NOT carry the test anchor, and any write
 *   (enable OR disable) additionally requires --yes.
 * NEVER commit URLs or print connection strings (this script prints none).
 */
import "dotenv/config";
import { Client } from "pg";
import { loadProductionDatabaseUrl, probeAnchor, productionEnvFile, verifyNonProductionTarget } from "./db-guard";

const USAGE = "usage: npx tsx scripts/pilot-switch.ts status|enable|disable [--production] [--note \"...\"] [--yes]";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function resolveTarget(command: string): Promise<{ url: string; production: boolean }> {
  if (flag("--production")) {
    const prodUrl = loadProductionDatabaseUrl();
    if (!prodUrl) {
      console.error(`pilot-switch: --production requires DATABASE_URL in ${productionEnvFile()} (operator-held, outside the repo).`);
      process.exit(2);
    }
    const anchor = await probeAnchor(prodUrl);
    if (anchor.reason !== "no-anchor") {
      console.error(`pilot-switch: production target refused (${anchor.reason === "anchored" ? "it carries the test anchor" : "unreachable"}); no change made.`);
      process.exit(2);
    }
    if (command !== "status" && !flag("--yes")) {
      console.error(`pilot-switch: refusing to ${command} PRODUCTION without --yes.`);
      process.exit(2);
    }
    console.log("pilot-switch: target = PRODUCTION (operator production env file).");
    return { url: prodUrl, production: true };
  }
  const url = (process.env["DATABASE_URL"] ?? "").trim();
  const verdict = await verifyNonProductionTarget(url);
  if (!verdict.ok) {
    console.error(`pilot-switch: local DATABASE_URL is not proven non-production (${verdict.reason}); refusing. Use --production for the real switch.`);
    process.exit(2);
  }
  console.log(`pilot-switch: target = non-production (${verdict.reason}).`);
  return { url, production: false };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "status" && command !== "enable" && command !== "disable") {
    console.error(USAGE);
    process.exit(2);
  }
  if (command === "enable" && !flag("--yes")) {
    console.error("pilot-switch: refusing to enable without --yes. Confirm the deployed env is armed and verified first.");
    process.exit(2);
  }
  const { url, production } = await resolveTarget(command);
  const note = arg("--note") ?? (command === "status" ? null : command === "enable" ? "enabled by operator" : "emergency stop by operator");
  const client = new Client({
    connectionString: url,
    ssl: production ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    if (command === "status") {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const rows = await client.query("SELECT enabled, updated_at, note FROM pilot_controls WHERE id = 'pilot' LIMIT 1");
      await client.query("ROLLBACK");
      const row = rows.rows[0] as { enabled: boolean; updated_at: string; note: string | null } | undefined;
      if (!row) {
        console.log("pilot database switch: MISSING (fail-closed: new funding is blocked; apply migrations).");
        return;
      }
      console.log(`pilot database switch: ${row.enabled ? "ENABLED" : "DISABLED"} (updated_at=${row.updated_at}, note=${row.note ?? "-"})`);
      return;
    }
    const enabled = command === "enable";
    const result = await client.query(
      "UPDATE pilot_controls SET enabled = $1, updated_at = NOW(), note = $2 WHERE id = 'pilot' RETURNING enabled, updated_at",
      [enabled, note],
    );
    const row = result.rows[0] as { enabled: boolean; updated_at: string } | undefined;
    if (!row) {
      console.error("pilot-switch: pilot_controls row is missing; apply migrations first (fail-closed).");
      process.exit(3);
    }
    console.log(`pilot database switch: ${row.enabled ? "ENABLED" : "DISABLED"} (updated_at=${row.updated_at})`);
    if (!enabled) {
      console.log("New funded pilot execution is now blocked on all deployments. Recovery endpoints stay available.");
    } else {
      console.log("Reminder: this alone authorizes nothing unless the deployed env gate is also armed (THENCE_PILOT_ENABLED=1 + allowlist).");
    }
  } catch (error) {
    // Static text only: pg errors can embed hosts and database names.
    console.error("pilot-switch: database operation failed; no change was confirmed.");
    void error;
    process.exit(4);
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore close errors.
    }
  }
}

void main();
