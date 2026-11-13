/**
 * R4 — operator-only Fastspot swap diagnostics for one transfer. READ-ONLY.
 *
 *   npx tsx scripts/fastspot-diag.ts <transferId>                 (local non-production DB)
 *   npx tsx scripts/fastspot-diag.ts <transferId> --production    (operator production env file)
 *   ... --lookup   also runs ONE read-only Fastspot GET /swap/{id}
 *
 * - The database is read inside BEGIN READ ONLY ... ROLLBACK. Nothing is written.
 * - It prints the host-reported Fastspot swap id (an untrusted hint), its
 *   conflicts and when it was recorded. The full id is shown only here.
 * - `--lookup` is off unless THENCE_FASTSPOT_DIAG_BASE_URL and
 *   THENCE_FASTSPOT_DIAG_API_KEY are set to a key Thence is authorized to use.
 *   It can only GET (src/lib/fastspot-diag.ts): no funding proof, payment,
 *   refund or claim is possible. Its result is a diagnostic snapshot, never
 *   proof of NIM funding or settlement.
 * Prints no connection strings, keys, preimages or wallet secrets.
 */
import "dotenv/config";
import { Client } from "pg";
import { loadProductionDatabaseUrl, probeAnchor, productionEnvFile, verifyNonProductionTarget } from "./db-guard";
import { normalizeHostSwapId } from "../src/domain/host-swap-id";
import { lookupFastspotSwap } from "../src/lib/fastspot-diag";

const USAGE = "usage: npx tsx scripts/fastspot-diag.ts <transferId> [--production] [--lookup]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const flag = (name: string): boolean => process.argv.includes(name);

async function resolveUrl(): Promise<{ url: string; production: boolean }> {
  if (flag("--production")) {
    const url = loadProductionDatabaseUrl();
    if (!url) {
      console.error(`fastspot-diag: --production requires DATABASE_URL in ${productionEnvFile()}.`);
      process.exit(2);
    }
    const anchor = await probeAnchor(url);
    if (anchor.reason !== "no-anchor") {
      console.error("fastspot-diag: production target refused.");
      process.exit(2);
    }
    return { url, production: true };
  }
  const url = (process.env["DATABASE_URL"] ?? "").trim();
  const verdict = await verifyNonProductionTarget(url);
  if (!verdict.ok) {
    console.error(`fastspot-diag: local DATABASE_URL is not proven non-production (${verdict.reason}).`);
    process.exit(2);
  }
  return { url, production: false };
}

async function main(): Promise<void> {
  const transferId = process.argv[2] ?? "";
  if (!UUID_RE.test(transferId)) {
    console.error(USAGE);
    process.exit(2);
  }
  const { url, production } = await resolveUrl();
  const client = new Client({ connectionString: url, ssl: production ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10_000 });
  await client.connect();
  let rows: Array<{ evidence: Record<string, unknown> | null; created_at: Date; from_status: string }> = [];
  try {
    await client.query("BEGIN READ ONLY");
    const res = await client.query(
      "SELECT evidence, created_at, from_status FROM transfer_transitions WHERE transfer_id = $1 AND reason_code = 'HOST_SWAP_HINT_RECORDED' ORDER BY created_at ASC",
      [transferId],
    );
    rows = res.rows;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
  if (rows.length === 0) {
    console.log("fastspot-diag: no host swap id recorded for this transfer (older client, cancelled, or not reported).");
    return;
  }
  const hints = rows.map((r) => ({
    hostSwapId: normalizeHostSwapId(r.evidence?.["hostSwapId"]),
    recordedAt: r.created_at.toISOString(),
    atStatus: r.from_status,
    conflictsWithFirst: r.evidence?.["conflictsWithFirst"] === true,
    reportedOnOtherTransfer: r.evidence?.["reportedOnOtherTransfer"] === true,
  }));
  console.log(JSON.stringify({ transferId, trust: "untrusted_host_hint", hints }, null, 2));
  const first = hints[0]?.hostSwapId;
  if (!flag("--lookup") || !first) return;
  const baseUrl = (process.env["THENCE_FASTSPOT_DIAG_BASE_URL"] ?? "").trim();
  const apiKey = (process.env["THENCE_FASTSPOT_DIAG_API_KEY"] ?? "").trim();
  const result = await lookupFastspotSwap(first, baseUrl && apiKey ? { baseUrl, apiKey } : null);
  console.log(JSON.stringify({ fastspotLookup: result, note: "Diagnostic snapshot only; not proof of NIM funding or settlement." }, null, 2));
}

main().catch((err) => {
  console.error("fastspot-diag: failed", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
