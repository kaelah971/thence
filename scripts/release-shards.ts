/**
 * P7 — resource-bounded release verification (docs/RELEASE_VERIFICATION_PLAN.md).
 *
 *   npx tsx scripts/release-shards.ts --check        coverage: shards == tests/*.test.ts(x)
 *   npx tsx scripts/release-shards.ts S2             run one shard
 *   npx tsx scripts/release-shards.ts all            run S1..S4 sequentially
 *
 * Every shard runs `vitest run --maxWorkers=2` (one shard at a time). Live
 * shards reach only the anchor-proven TEST database (tests/global-setup.ts);
 * without that proof they are skipped, never pointed elsewhere.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

export const SHARDS: Record<string, string[]> = {
  S1: [
    "ui-*",
    "incident-2026-11-02",
    "test-db-guard",
    "satora-swap-verify",
    "transfer-handoff",
    "f43-settlement",
    "f810-*",
    "f811-*",
    "copy-guard",
    "auth-errors",
    "proxy-origin",
    "activity-archive",
    "provider-evidence-ui",
    "money",
    "nimiq",
    "address-format",
    "env",
    "routes",
    "root-redirect",
    "send-navigation",
    "public-request-cta",
    "rate-limit",
    "db-pool",
    "schema",
    "p5-chain-timeout",
    "p4-chain-diagnostics",
    "p5-refund-consistency",
    "p3-claim-verification",
    "p7-arbitrum-recovery",
    "payments-mode",
  ],
  S2: ["reconciliation", "settlement", "f42-handoff", "f812-attach-recovery", "f812-retire-replace"],
  S3: [
    "f81-pilot-attempt-limits",
    "f8-pilot-gates",
    "f82-pilot-kill-switch",
    "diag-storage-api",
    "p2-claim-deadline",
    "p4-expiry-resolution",
    "p5-locking-audit",
    "p3-claim-intent",
    "p6-server-reconciler",
    "f41-prepare-flow",
    "f41-recovery-vault",
  ],
  S4: [
    "public-payments-mode",
    "transfers",
    "transfer-intents",
    "quotes",
    "quotes-multiroute",
    "f3-data",
    "f32-requests-quotes",
    "recipients",
    "requests",
    "verification",
    "profile",
    "auth",
    "f6-balance",
    "f7-send-flow",
  ],
};

function allTestFiles(): string[] {
  return readdirSync(join(ROOT, "tests"))
    .filter((f) => /\.test\.tsx?$/.test(f))
    .sort();
}

function matches(file: string, pattern: string): boolean {
  const base = file.replace(/\.test\.tsx?$/, "");
  if (pattern.endsWith("*")) return base.startsWith(pattern.slice(0, -1));
  return base === pattern;
}

export function shardFiles(name: string): string[] {
  const patterns = SHARDS[name];
  if (!patterns) throw new Error(`unknown shard ${name}`);
  return allTestFiles().filter((f) => patterns.some((p) => matches(f, p)));
}

export function coverage(): { total: number; unassigned: string[]; duplicated: string[] } {
  const files = allTestFiles();
  const seen = new Map<string, number>();
  for (const name of Object.keys(SHARDS)) for (const f of shardFiles(name)) seen.set(f, (seen.get(f) ?? 0) + 1);
  return {
    total: files.length,
    unassigned: files.filter((f) => !seen.has(f)),
    duplicated: [...seen].filter(([, n]) => n > 1).map(([f]) => f),
  };
}

function run(name: string): number {
  const files = shardFiles(name).map((f) => `tests/${f}`);
  console.log(`\n=== ${name}: ${files.length} files (vitest --maxWorkers=2) ===`);
  const res = spawnSync("npx", ["vitest", "run", "--maxWorkers=2", ...files], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  return res.status ?? 1;
}

if (require.main === module) {
  const arg = process.argv[2] ?? "--check";
  const cov = coverage();
  if (cov.unassigned.length > 0 || cov.duplicated.length > 0) {
    console.error(`Shard coverage broken: unassigned=${JSON.stringify(cov.unassigned)} duplicated=${JSON.stringify(cov.duplicated)}`);
    process.exit(2);
  }
  console.log(`Shard coverage OK: ${cov.total} test files, each in exactly one shard.`);
  if (arg === "--check") process.exit(0);
  const names = arg === "all" ? Object.keys(SHARDS) : [arg];
  const failed: string[] = [];
  for (const name of names) if (run(name) !== 0) failed.push(name);
  if (failed.length > 0) {
    console.error(`\nFailed shards: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nAll shards passed: ${names.join(", ")}`);
}
