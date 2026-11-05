/**
 * P6 — automatic server-side reconciliation (no browser required).
 *
 * Runs the SAME reconciliation core as the owner route (src/lib/reconcile.ts
 * `reconcileCore`, system actor): identical identity checks, identical
 * independent refund verification, identical legal-edge planner, identical
 * audit trail. There is no second state machine here — only selection,
 * bounding and scheduling.
 *
 * Never: claims, releases preimages, initiates payments, creates swaps or
 * invoices, refunds, closes uncertain exposure, or applies P4's owner-only
 * EXPIRED_UNFUNDED close (the planner only *reports* that exit).
 *
 * Bounds:
 * - single runner via a job lease (atomic upsert, no long-held DB lock),
 *   with a minimum spacing that absorbs duplicate scheduled deliveries;
 * - at most `maxTransfers` reconciliations per run, sequential, inside a
 *   wall-clock budget; each uses the provider/RPC timeouts of the core;
 * - per-transfer due intervals (P2 deadline-aware, error backoff, slow lane
 *   for terminal-looking provider states), so external calls stay bounded;
 * - one transfer failing never aborts the batch (counted, retried on a
 *   later run — Vercel does not retry cron invocations).
 *
 * Observability: the run summary (counts, durations, transfer ids and
 * status transitions only — no invoices, hashes, addresses or credentials)
 * is returned, logged as one JSON line, and stored on the lease row.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { jobLeases } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { reconcileCore } from "@/lib/reconcile";
import { verifySettlementCore } from "@/lib/settlement";
import { claimWindowAt } from "@/domain/claim-deadline";
import type { TransferStatus } from "@/domain/transfers";

export const RECONCILER_LEASE = "server-reconciler";
/** Lease TTL: longer than the function's max duration so a crashed run cannot block forever. */
export const LEASE_TTL_MS = 5 * 60_000;
/** Duplicate deliveries / replays inside this spacing are skipped. */
export const MIN_RUN_SPACING_MS = 30_000;
export const DEFAULT_MAX_TRANSFERS = 10;
export const DEFAULT_TIME_BUDGET_MS = 45_000;
/** Candidate scan bound (pilot scale; selection is by due time and priority). */
export const CANDIDATE_LIMIT = 500;

/** Statuses the server reconciler refreshes (all have a bound, authorized swap). */
export const SERVER_RECONCILABLE: readonly TransferStatus[] = [
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
  "NEEDS_ATTENTION",
];

const FUNDED = new Set<string>(["CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"]);

export interface Candidate {
  transferId: string;
  status: string;
  claimDeadline: Date | null;
  invoiceExpiresAt: Date | null;
  lastObservedAt: Date | null;
  lastProviderStatus: string | null;
  lastKind: string | null;
}

/**
 * Minimum time between server refreshes of one transfer. Pure.
 * - funded: 1 min while a claim is still possible (deadline awareness),
 *   2 min after it closes (watch for the provider refund);
 * - pre-funding/uncertain: 2 min while the invoice is live, 10 min after;
 * - provider reported terminal `expired`: 6 h (only the owner's P4 close
 *   can retire it; refreshing faster learns nothing);
 * - last read failed: at least 5 min (backoff; Vercel never retries).
 */
export function dueIntervalMs(c: Candidate, now: number): number {
  let interval: number;
  if (FUNDED.has(c.status)) {
    const window = claimWindowAt(c.claimDeadline?.getTime() ?? null, now);
    interval = window === "passed" ? 2 * 60_000 : 60_000;
  } else if (c.lastProviderStatus === "expired" && c.lastKind === "observation") {
    interval = 6 * 60 * 60_000;
  } else if (c.invoiceExpiresAt && c.invoiceExpiresAt.getTime() > now) {
    interval = 2 * 60_000;
  } else {
    interval = 10 * 60_000;
  }
  if (c.lastKind === "provider_error") interval = Math.max(interval, 5 * 60_000);
  return interval;
}

export function isDue(c: Candidate, now: number): boolean {
  if (!c.lastObservedAt) return true;
  return now - c.lastObservedAt.getTime() >= dueIntervalMs(c, now);
}

/** Priority: open claim windows by soonest deadline, then funded, then uncertain, then oldest. Pure. */
export function priorityOrder(a: Candidate, b: Candidate, now: number): number {
  const rank = (c: Candidate): number => {
    const w = claimWindowAt(c.claimDeadline?.getTime() ?? null, now);
    if (FUNDED.has(c.status) && (w === "open" || w === "closing" || w === "unsafe")) return 0;
    if (FUNDED.has(c.status)) return 1;
    if (c.status === "OUTCOME_UNKNOWN" || c.status === "RECONCILING" || c.status === "LIGHTNING_HANDOFF") return 2;
    return 3;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a.claimDeadline?.getTime() ?? Infinity) - (b.claimDeadline?.getTime() ?? Infinity);
  return (a.lastObservedAt?.getTime() ?? 0) - (b.lastObservedAt?.getTime() ?? 0);
}

/**
 * Provider swap ids are UUIDs: the provider rejects anything else outright
 * ("UUID parsing failed"), and attach only binds ids the provider returned.
 * Pre-S0 test rows written to production (ids like `swap-1111…`) can never
 * be read from the provider, so the scheduled reconciler skips them — they
 * would only accumulate provider_error rows and crowd out real payments.
 * Scheduled selection ONLY: the rows stay untouched and visible, and the
 * owner route / P4 / settlement paths are unchanged.
 */
export const PROVIDER_SWAP_ID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const PROVIDER_SWAP_ID_RE = new RegExp(PROVIDER_SWAP_ID_PATTERN);

export function isWellFormedProviderSwapId(id: string | null | undefined): boolean {
  return typeof id === "string" && PROVIDER_SWAP_ID_RE.test(id);
}

async function loadCandidates(scope: string[] | null): Promise<{ candidates: Candidate[]; excludedMalformedSwapIds: number }> {
  const statuses = sql.join(SERVER_RECONCILABLE.map((s) => sql`${s}`), sql`, `);
  const scoped: SQL = scope && scope.length > 0 ? sql`AND t.id IN (${sql.join(scope.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  if (scope && scope.length === 0) return { candidates: [], excludedMalformedSwapIds: 0 };
  const eligible: SQL = sql`
    t.status IN (${statuses})
      AND (t.status <> 'AWAITING_NIM_APPROVAL' OR EXISTS (
        SELECT 1 FROM handoff_attempts h WHERE h.transfer_id = t.id AND h.status = 'HANDOFF_AUTHORIZED'))
      ${scoped}`;
  const result = await getDb().execute(sql`
    SELECT t.id AS transfer_id, t.status, a.evm_refund_locktime, a.invoice_expires_at,
           o.observed_at AS last_observed_at, o.provider_status AS last_provider_status, o.kind AS last_kind
    FROM transfers t
    JOIN swap_attachments a ON a.transfer_id = t.id
    LEFT JOIN LATERAL (
      SELECT observed_at, provider_status, kind FROM reconciliation_observations
      WHERE transfer_id = t.id ORDER BY observed_at DESC LIMIT 1
    ) o ON true
    WHERE ${eligible}
      AND a.satora_swap_id ~ ${PROVIDER_SWAP_ID_PATTERN}
    ORDER BY o.observed_at ASC NULLS FIRST
    LIMIT ${CANDIDATE_LIMIT}
  `);
  const excluded = await getDb().execute(sql`
    SELECT count(*)::int AS n
    FROM transfers t
    JOIN swap_attachments a ON a.transfer_id = t.id
    WHERE ${eligible}
      AND a.satora_swap_id !~ ${PROVIDER_SWAP_ID_PATTERN}
  `);
  const excludedMalformedSwapIds = Number((excluded as unknown as { rows: Array<{ n: unknown }> }).rows[0]?.n ?? 0);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const date = (v: unknown): Date | null => (v instanceof Date ? v : typeof v === "string" ? new Date(v) : null);
  const candidates = rows.map((r) => ({
    transferId: String(r["transfer_id"]),
    status: String(r["status"]),
    claimDeadline: date(r["evm_refund_locktime"]),
    invoiceExpiresAt: date(r["invoice_expires_at"]),
    lastObservedAt: date(r["last_observed_at"]),
    lastProviderStatus: typeof r["last_provider_status"] === "string" ? (r["last_provider_status"] as string) : null,
    lastKind: typeof r["last_kind"] === "string" ? (r["last_kind"] as string) : null,
  }));
  return { candidates, excludedMalformedSwapIds };
}

/* ---------------- lease ---------------- */

export async function acquireLease(name: string, holder: string, now = Date.now()): Promise<"acquired" | "held" | "too-soon"> {
  const expires = new Date(now + LEASE_TTL_MS);
  const spacingCutoff = new Date(now - MIN_RUN_SPACING_MS);
  const nowDate = new Date(now);
  const result = await getDb().execute(sql`
    INSERT INTO job_leases (name, holder, acquired_at, expires_at, last_started_at)
    VALUES (${name}, ${holder}, ${nowDate}, ${expires}, ${nowDate})
    ON CONFLICT (name) DO UPDATE
      SET holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at,
          expires_at = EXCLUDED.expires_at, last_started_at = EXCLUDED.last_started_at
      WHERE job_leases.expires_at <= ${nowDate}
        AND (job_leases.last_started_at IS NULL OR job_leases.last_started_at <= ${spacingCutoff})
    RETURNING holder
  `);
  const rows = (result as unknown as { rows: Array<{ holder: string }> }).rows;
  if (rows[0]?.holder === holder) return "acquired";
  const existing = await getDb().select().from(jobLeases).where(eq(jobLeases.name, name)).limit(1);
  return existing[0] && existing[0].expiresAt.getTime() > now ? "held" : "too-soon";
}

export async function releaseLease(name: string, holder: string, summary: Record<string, unknown>): Promise<void> {
  // P5: one clock for every lease timestamp. acquireLease compares against
  // the application clock; stamping release with the database's now() made a
  // released lease look "held" whenever the DB clock ran ahead (observed
  // ~240 ms against the test database), misreporting skip reasons.
  const now = new Date();
  await getDb().execute(sql`
    UPDATE job_leases SET expires_at = ${now}, last_finished_at = ${now}, last_summary = ${JSON.stringify(summary)}::jsonb
    WHERE name = ${name} AND holder = ${holder}
  `);
}

/* ---------------- run ---------------- */

/** Provider statuses that mean a claim was submitted or settled (verify delivery). */
const CLAIM_PROGRESS: ReadonlySet<string> = new Set(["clientredeeming", "clientredeemed", "serverredeemed"]);

export interface RunOptions {
  maxTransfers?: number;
  timeBudgetMs?: number;
  leaseName?: string;
  /** Restrict to these transfer ids (tests/operator diagnostics). */
  scope?: string[] | null;
}

export interface RunSummary {
  outcome: "completed" | "skipped";
  skipReason?: "lease-held" | "too-soon";
  runId: string;
  startedAt: string;
  durationMs: number;
  candidates: number;
  /** Eligible rows skipped because their bound swap id is not a provider UUID (pre-S0 synthetic history). Count only. */
  excludedMalformedSwapIds: number;
  due: number;
  reconciled: number;
  deferredByBudget: number;
  advanced: Array<{ transferId: string; from: string; to: string }>;
  errors: Record<string, number>;
}

/** One bounded reconciliation run. Safe to invoke concurrently and repeatedly. */
export async function runServerReconciliation(options: RunOptions = {}): Promise<RunSummary> {
  const started = Date.now();
  const runId = randomUUID();
  const leaseName = options.leaseName ?? RECONCILER_LEASE;
  const base: RunSummary = {
    outcome: "completed",
    runId,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    candidates: 0,
    excludedMalformedSwapIds: 0,
    due: 0,
    reconciled: 0,
    deferredByBudget: 0,
    advanced: [],
    errors: {},
  };
  const lease = await acquireLease(leaseName, runId, started);
  if (lease !== "acquired") {
    return { ...base, outcome: "skipped", skipReason: lease === "held" ? "lease-held" : "too-soon", durationMs: Date.now() - started };
  }
  const summary = base;
  try {
    const maxTransfers = Math.max(1, Math.min(options.maxTransfers ?? DEFAULT_MAX_TRANSFERS, 50));
    const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    const now = Date.now();
    const { candidates, excludedMalformedSwapIds } = await loadCandidates(options.scope ?? null);
    const due = candidates.filter((c) => isDue(c, now)).sort((a, b) => priorityOrder(a, b, now));
    summary.candidates = candidates.length;
    summary.excludedMalformedSwapIds = excludedMalformedSwapIds;
    summary.due = due.length;
    const batch = due.slice(0, maxTransfers);
    for (const [index, candidate] of batch.entries()) {
      if (Date.now() - started > budget) {
        summary.deferredByBudget = batch.length - index;
        break;
      }
      try {
        const result = await reconcileCore(candidate.transferId, { kind: "system", ownerUserId: null });
        summary.reconciled += 1;
        if (result.advanced) summary.advanced.push({ transferId: candidate.transferId, from: candidate.status, to: result.status });
        if (result.lastError) summary.errors[result.lastError] = (summary.errors[result.lastError] ?? 0) + 1;
        // P3: once the provider reports claim activity, independently verify
        // destination delivery here too, so DELIVERED (with proof) never
        // depends on the owner's browser staying open after Finish delivery.
        if ((result.status === "CLAIMING" || result.status === "SERVER_FUNDED") && CLAIM_PROGRESS.has(result.providerStatus) && !result.lastError) {
          try {
            const settled = await verifySettlementCore(candidate.transferId, { kind: "system", ownerUserId: null });
            if (settled.status === "DELIVERED" && settled.verdict === "VERIFIED") {
              summary.advanced.push({ transferId: candidate.transferId, from: result.status, to: "DELIVERED" });
            } else if (settled.verdict === "INVALID" || settled.verdict === "UNAVAILABLE") {
              const code = `SETTLEMENT_${settled.verdict}`;
              summary.errors[code] = (summary.errors[code] ?? 0) + 1;
            }
          } catch (err) {
            const code = err instanceof AuthError ? `SETTLEMENT_${err.code}` : "SETTLEMENT_FAILED";
            summary.errors[code] = (summary.errors[code] ?? 0) + 1;
          }
        }
      } catch (err) {
        const code = err instanceof AuthError ? err.code : "RECONCILE_FAILED";
        summary.errors[code] = (summary.errors[code] ?? 0) + 1;
      }
    }
  } catch {
    summary.errors["RUN_FAILED"] = (summary.errors["RUN_FAILED"] ?? 0) + 1;
  } finally {
    summary.durationMs = Date.now() - started;
    try {
      await releaseLease(leaseName, runId, summary as unknown as Record<string, unknown>);
    } catch {
      // The lease expires on its own (TTL); never mask the run result.
    }
  }
  return summary;
}

let cronOptionsOverride: RunOptions | null = null;
/** Test seam: restrict the cron route's batch (scope/lease) so tests never touch unrelated rows. */
export function setCronRunOptionsForTests(options: RunOptions | null): void {
  cronOptionsOverride = options;
}
/** Options the cron route runs with (production: defaults). */
export function cronRunOptions(): RunOptions {
  return cronOptionsOverride ?? {};
}

/* ---------------- cron authentication ---------------- */

export const CRON_SECRET_MIN_LENGTH = 32;

/**
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`. Fail closed: without a
 * configured secret of sufficient length nothing runs. Constant-time compare.
 * Never logs or returns the header or the secret.
 */
export function verifyCronAuthorization(header: string | null, secret: string | undefined): "ok" | "not-configured" | "unauthorized" {
  if (!secret || secret.length < CRON_SECRET_MIN_LENGTH) return "not-configured";
  if (!header) return "unauthorized";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  if (given.length !== expected.length) return "unauthorized";
  return timingSafeEqual(given, expected) ? "ok" : "unauthorized";
}
