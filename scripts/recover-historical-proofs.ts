/**
 * A3d.6 operator-only historical source-proof recovery (NOV6, NOV7 only).
 *
 *   Dry run (default, reads only):
 *     npx tsx scripts/recover-historical-proofs.ts [--case NOV6] [--case NOV7]
 *
 *   Apply (separately approved; writes append-only evidence + guarded fill):
 *     npx tsx scripts/recover-historical-proofs.ts --apply \
 *       --operator-ref <approval-id> --confirm NOV6,NOV7
 *
 * DATABASE_URL selects the database and is never printed. Nothing here
 * publishes: the public feed stays behind THENCE_PUBLIC_PROOFS_ENABLED.
 * Output is redacted (no payment hashes, owner address or full ids).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { closePool, getDb } from "@/lib/db";
import {
  applyRecovery,
  HISTORICAL_RECOVERY_CASES,
  HISTORICAL_RECOVERY_POLICY,
  planRecovery,
  recoveryCase,
  redactPlan,
  type HistoricalRecoveryCase,
} from "@/lib/historical-proof-recovery";

function parseArgs(argv: string[]): { cases: HistoricalRecoveryCase[]; apply: boolean; operatorRef: string; confirm: string } {
  const cases: HistoricalRecoveryCase[] = [];
  let apply = false;
  let operatorRef = "";
  let confirm = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--case") {
      const c = recoveryCase(argv[++i] ?? "");
      if (!c) throw new Error(`--case must be one of ${HISTORICAL_RECOVERY_CASES.map((x) => x.caseId).join(", ")}`);
      if (!cases.includes(c)) cases.push(c);
    } else if (a === "--apply") apply = true;
    else if (a === "--operator-ref") operatorRef = argv[++i] ?? "";
    else if (a === "--confirm") confirm = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { cases: cases.length > 0 ? cases : [...HISTORICAL_RECOVERY_CASES], apply, operatorRef, confirm };
}

function verifierVersion(): { sha: string; clean: boolean } {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  return { sha, clean: dirty.length === 0 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env["DATABASE_URL"]) throw new Error("DATABASE_URL is not configured.");
  const version = verifierVersion();
  console.log(JSON.stringify({ mode: args.apply ? "APPLY" : "DRY_RUN", policy: HISTORICAL_RECOVERY_POLICY.id, verifierVersion: version.sha.slice(0, 12), cases: args.cases.map((c) => c.caseId) }));

  if (args.apply) {
    const expected = args.cases.map((c) => c.caseId).sort().join(",");
    if (args.confirm.split(",").map((s) => s.trim()).sort().join(",") !== expected) {
      throw new Error(`--confirm must list exactly: ${expected}`);
    }
    if (!args.operatorRef.trim()) throw new Error("--operator-ref is required with --apply.");
    if (!version.clean) throw new Error("Refusing to apply from a modified working tree (verifier version must be a clean commit).");
  }

  const db = getDb();
  let failures = 0;
  for (const c of args.cases) {
    const plan = await planRecovery(db, c);
    console.log(JSON.stringify(redactPlan(plan)));
    if (plan.status === "BLOCKED") failures++;
    if (args.apply && plan.status !== "BLOCKED") {
      const result = await applyRecovery(db, plan, { operatorRef: args.operatorRef, verifierVersion: version.sha });
      console.log(JSON.stringify(result));
      if (result.outcome === "REFUSED") failures++;
    }
  }
  process.exitCode = failures > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(`recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  })
  .finally(() => closePool().catch(() => {}));
