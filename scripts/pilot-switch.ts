/**
 * F8.2 — pilot database kill-switch operator tool.
 *
 * The database switch (KEY 2 of the two-key rule) is the ONLY instantaneous
 * pilot control: Vercel env changes need a redeploy, this UPDATE does not.
 *
 *   npx tsx scripts/pilot-switch.ts status
 *   npx tsx scripts/pilot-switch.ts disable --note "reason"
 *   npx tsx scripts/pilot-switch.ts enable --note "reason" --yes
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
 * DATABASE_URL selects the target. Point it at production ONLY for the real
 * activation/stop; local runs default to the dev database in .env.
 * NEVER commit URLs or print connection strings (this script prints none).
 */
import "dotenv/config";
import { Client } from "pg";

const USAGE = "usage: npx tsx scripts/pilot-switch.ts status|enable|disable [--note \"...\"] [--yes]";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "status" && command !== "enable" && command !== "disable") {
    console.error(USAGE);
    process.exit(2);
  }
  const url = (process.env["DATABASE_URL"] ?? "").trim();
  if (!url) {
    console.error("pilot-switch: DATABASE_URL is not configured.");
    process.exit(2);
  }
  if (command === "enable" && !flag("--yes")) {
    console.error("pilot-switch: refusing to enable without --yes. Confirm the deployed env is armed and verified first.");
    process.exit(2);
  }
  const note = arg("--note") ?? (command === "status" ? null : command === "enable" ? "enabled by operator" : "emergency stop by operator");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    await client.connect();
    if (command === "status") {
      const rows = await client.query("SELECT enabled, updated_at, note FROM pilot_controls WHERE id = 'pilot' LIMIT 1");
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
