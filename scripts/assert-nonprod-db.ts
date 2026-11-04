/**
 * S0 — preflight for local commands that open the application database
 * (`npm run dev`, `npm run start`, `db:migrate`, `db:push`, `db:studio`).
 *
 * Collects every DATABASE_URL a local command could pick up — the process
 * environment and each Next.js/dotenv env file in the repo root — and
 * refuses (exit 1) unless EACH one is proven non-production:
 * localhost, or carrying the `__thence_test_anchor` marker that production
 * lacks, and never the database named by the operator-held production env
 * file (outside the repo). Read-only; prints no URLs or credentials.
 *
 * Production operations never go through these commands: use
 * `scripts/pilot-switch.ts --production` (explicit, confirmed) instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { productionEnvFile, verifyNonProductionTarget } from "./db-guard";

const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"];

async function main(): Promise<void> {
  const candidates: Array<{ source: string; url: string }> = [];
  const fromProcess = (process.env["DATABASE_URL"] ?? "").trim();
  if (fromProcess) candidates.push({ source: "process environment", url: fromProcess });
  for (const name of ENV_FILES) {
    const file = join(process.cwd(), name);
    if (!existsSync(file)) continue;
    const url = (parseDotenv(readFileSync(file))["DATABASE_URL"] ?? "").trim();
    if (url) candidates.push({ source: name, url });
  }
  if (candidates.length === 0) {
    console.error("db-guard: no DATABASE_URL configured; set a non-production database in .env (see docs/LOCAL_DB.md).");
    process.exit(1);
  }
  for (const candidate of candidates) {
    const verdict = await verifyNonProductionTarget(candidate.url);
    if (!verdict.ok) {
      console.error(`db-guard: REFUSED — DATABASE_URL from ${candidate.source} is not proven non-production (${verdict.reason}).`);
      console.error(`db-guard: production credentials belong only in ${productionEnvFile()} and are used only via explicit --production operator commands.`);
      process.exit(1);
    }
  }
  console.log(`db-guard: ${candidates.length} DATABASE_URL source(s) verified non-production.`);
}

void main();
