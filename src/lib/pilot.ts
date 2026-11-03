/**
 * F8/F8.2 — restricted live pilot gate (server-side only).
 *
 * TWO-KEY RULE (F8.2 correction): Vercel environment-variable changes only
 * apply to NEW deployments — even server-side variables. Toggling
 * THENCE_PILOT_ENABLED in the Vercel dashboard is therefore NOT an
 * instantaneous emergency switch (it needs a redeploy to take effect).
 * New funded execution now requires BOTH keys:
 * - KEY 1 (deployed env): THENCE_PILOT_ENABLED === "1" (default OFF,
 *   fail-closed) + owner allowlist + caps below. Changed via Vercel
 *   dashboard AND a new production deployment.
 * - KEY 2 (database): the `pilot_controls` singleton row
 *   (`id = 'pilot'`) has `enabled = TRUE` (default FALSE, fail-closed).
 *   Flipped with one UPDATE — effective on the next funded request on
 *   every already-running deployment, no redeploy. This is the
 *   instantaneous emergency stop: set it FALSE to halt NEW funding while
 *   recovery keeps working.
 *
 * F8.3 PRODUCTION RULE: a production runtime never skips for missing
 * configuration. With no allowlist, non-production keeps legacy skip
 * behavior (dev/test/CI quote-only flows), but production throws
 * PILOT_NOT_AUTHORIZED on every funded path — an enabled route plus a
 * payment-capable client can never bypass ownership checks by omission.
 *
 * When configured (allowlist set), all funded execution paths require:
 * - Both kill switches armed (env AND database; default OFF, fail-closed)
 * - Strict route: usdc-polygon only
 * - Authenticated owner wallet allowlisted (canonical Nimiq address compare)
 * - Per-transfer RECIPIENT cap (default 0.30 USDC = 300000 atomic)
 * - Pilot spend + active-exposure caps (default single 0.30 shot, 1 exposure)
 *
 * SCOPE LIMIT (honest): these caps bind the RECIPIENT USDC amount only.
 * The NIM debit is set inside Nimiq Pay (host converts NIM->Lightning sats
 * and shows the exact NIM figure on its own approval screen); the server
 * never sees a NIM number, so no server gate can enforce a NIM-denominated
 * ceiling. The $0.50 NIM budget is therefore PROCEDURAL: the user reads the
 * host approval screen and aborts when it exceeds the agreed maximum.
 * Never represent the atomic caps as a NIM-spend guarantee.
 *
 * Client feature flags (NEXT_PUBLIC_THENCE_ENABLE_PAYMENT / _CLAIM) stay
 * OFF independently: this gate alone never authorizes a host payment.
 * Blocked attempts throw AuthError (403 PILOT_*, never a zero or silent pass).
 */
import { eq, sql } from "drizzle-orm";
import { AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { handoffAttempts, pilotControls, transfers, users } from "@/db/schema";
import { normalizeNimiqAddress } from "@/lib/nimiq";
import type { TransferStatus } from "@/domain/transfers";

// F8 pilot: proposed first-test $0.30 USDC (live quotes 2026-10-31: $0.28
// technical minimum at 368 sats vs 356 floor; $0.30 at 393 sats is the
// smallest with margin). One active funding exposure per allowlisted wallet.
// Max total first-test spend stays $0.50 USD-equiv in NIM incl fees
// (procedural, host-screen enforced — see SCOPE LIMIT above).
// This code ships DISARMED (kill switch OFF) and moves no funds.
export const PILOT_ROUTE_ID = "usdc-polygon";
export const DEFAULT_MAX_TARGET_ATOMIC = "300000"; // 0.30 USDC
export const DEFAULT_MAX_SPEND_ATOMIC = "300000"; // 0.30 USDC total (single shot)
export const DEFAULT_MAX_TRANSFERS = 1;

export interface PilotConfig {
  enabled: boolean;
  owners: string[];
  maxTargetAtomic: string;
  maxSpendAtomic: string;
  maxTransfers: number;
  /**
   * F8.3: true when the source env is a production runtime
   * (NODE_ENV === "production"). Production NEVER skips the pilot for
   * missing configuration — an enabled route plus a payment-capable
   * client must always hit the allowlist, or fail closed. The legacy
   * not-configured skip below applies to development/test only.
   */
  production: boolean;
}

function parseAtomic(value: string | undefined, fallback: string): string {
  if (!value || !/^\d+$/.test(value.trim()) || BigInt(value.trim()) <= 0n) return fallback;
  return value.trim();
}

function parseOwners(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return normalizeNimiqAddress(s).replace(/\s+/g, "").toUpperCase();
      } catch {
        return s.replace(/\s+/g, "").toUpperCase();
      }
    });
}

export function getPilotConfig(source: Record<string, string | undefined> = process.env): PilotConfig {
  return {
    enabled: (source["THENCE_PILOT_ENABLED"] ?? "").trim() === "1",
    production: (source["NODE_ENV"] ?? "").trim() === "production",
    owners: parseOwners(source["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"]),
    maxTargetAtomic: parseAtomic(source["THENCE_PILOT_MAX_TARGET_ATOMIC"], DEFAULT_MAX_TARGET_ATOMIC),
    maxSpendAtomic: parseAtomic(source["THENCE_PILOT_MAX_SPEND_ATOMIC"], DEFAULT_MAX_SPEND_ATOMIC),
    maxTransfers: (() => {
      const n = Number((source["THENCE_PILOT_MAX_TRANSFERS"] ?? "").trim());
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TRANSFERS;
    })(),
  };
}

export function canonicalKey(address: string): string {
  try {
    return normalizeNimiqAddress(address).replace(/\s+/g, "").toUpperCase();
  } catch {
    return address.replace(/\s+/g, "").toUpperCase();
  }
}

type PilotDb = ReturnType<typeof getDb>;
/** Minimal handle for the budget count: plain db or a creation transaction. */
type BudgetDb = Pick<PilotDb, "select">;

/**
 * A transfer is an exposure once approval could have happened, an outcome
 * became uncertain, or a provider swap was bound. QUOTED has no provider-side
 * swap and must not lock an account out of creating another intent; the
 * SWAP_CREATED reservation remains until it is safely cancelled.
 */
const FUNDING_ACTIVE_EXPOSURE: ReadonlySet<TransferStatus> = new Set([
  "SWAP_CREATED",
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
  "NEEDS_ATTENTION",
]);
const ACTUAL_SPEND: ReadonlySet<TransferStatus> = new Set(["CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "DELIVERED"]);
export function isFundingExposureStatus(status: string): boolean {
  return FUNDING_ACTIVE_EXPOSURE.has(status as TransferStatus);
}

export function isActualSpendStatus(status: string): boolean {
  return ACTUAL_SPEND.has(status as TransferStatus);
}

/** Per-owner pilot mutex: serializes creation and exposure reservation
 * checks across independent intents. Transaction-scoped (released at
 * commit/rollback), same advisory-lock pattern as handoff attempt locks. */
export async function lockPilotCreate(tx: { execute: PilotDb["execute"] }, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"pilot-create:" + userId}))`);
}

/** Owner lookup for server-side allowlist enforcement (null when unknown). */
export async function getOwnerAddress(userId: string): Promise<string | null> {
  const rows = await getDb().select({ nimiqAddress: users.nimiqAddress }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.nimiqAddress ?? null;
}

/**
 * Pure intent check: kill switch, route, allowlist, per-transfer cap.
 * Throws AuthError on any violation (fail-closed when configured).
 *
 * NOT-CONFIGURED SKIP (non-production only): when no owner allowlist is
 * set AND the kill switch is OFF, the pilot is not configured and all
 * checks are skipped — legacy paths keep their existing protections
 * (auth, route-enabled, single-attempt, swap verification, client
 * payment/claim flags OFF). This keeps the pre-existing suite and normal
 * quote-only flows working in envs without pilot variables.
 *
 * F8.3 PRODUCTION RULE: a production runtime (NODE_ENV === "production")
 * NEVER skips for missing configuration. An enabled route plus a
 * payment-capable client must always hit the allowlist — a missing
 * allowlist in production throws PILOT_NOT_AUTHORIZED instead of
 * silently permitting funded execution. Misconfiguration fails closed
 * everywhere; production additionally fails closed on absence.
 *
 * MISCONFIGURED FAIL-CLOSED: kill switch ON with an empty allowlist is
 * incomplete configuration and blocks everything — an armed pilot with no
 * authorized wallets must never permit funded execution.
 */
export function assertPilotIntent(
  input: { routeId: string; targetAmountAtomic: string; ownerAddress: string | null },
  config: PilotConfig = getPilotConfig(),
): void {
  if (config.owners.length === 0) {
    if (config.enabled) throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "Pilot allowlist is missing; funded execution is blocked.");
    // F8.3: production must be explicitly allowlisted. Missing allowlist
    // with an enabled route and payment-capable client must never skip.
    if (config.production) {
      throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "Pilot allowlist is missing; funded execution is blocked.");
    }
    return;
  }
  if (!config.enabled) throw new AuthError(403, "PILOT_DISABLED", "Live pilot is not enabled.");
  if (input.routeId !== PILOT_ROUTE_ID) {
    throw new AuthError(403, "PILOT_ROUTE_ONLY", "Pilot is restricted to USDC on Polygon.");
  }
  if (!input.ownerAddress || !config.owners.includes(canonicalKey(input.ownerAddress))) {
    throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "This wallet is not authorized for the live pilot.");
  }
  if (!/^\d+$/.test(input.targetAmountAtomic) || BigInt(input.targetAmountAtomic) <= 0n) {
    throw new AuthError(400, "BAD_AMOUNT", "targetAmountAtomic must be a positive atomic integer string.");
  }
  if (BigInt(input.targetAmountAtomic) > BigInt(config.maxTargetAtomic)) {
    throw new AuthError(403, "PILOT_AMOUNT_EXCEEDS_MAX", "Pilot transfer exceeds the per-transfer maximum.");
  }
}

/** Singleton id of the database kill-switch row. */
export const PILOT_DB_ID = "pilot";

/** Read handle for the kill switch: plain db or a creation transaction. */
type KillSwitchDb = Pick<PilotDb, "select">;

/**
 * F8.2 database kill switch (KEY 2 of the two-key rule).
 *
 * Returns TRUE only when the `pilot_controls` singleton row exists and has
 * `enabled = TRUE`. Fail-closed: a missing row, a missing table
 * (pre-migration database) or any read error reads as DISABLED — never as
 * permission. Recovery paths (reconcile, resume, attempt status, receipt,
 * outcome reports, settlement verification) never call this, so an
 * emergency stop halts NEW funding without stranding already-funded
 * transfers.
 *
 * NO-OP unless the env gate is armed with an allowlist: unconfigured envs
 * (no allowlist) keep legacy behavior and never touch this table — old
 * databases without the migration keep working, and disarmed/misconfigured
 * envs already failed closed in assertPilotIntent before any read here.
 */
export async function isPilotDbEnabled(
  config: PilotConfig = getPilotConfig(),
  db: KillSwitchDb = getDb(),
): Promise<boolean> {
  if (config.owners.length === 0 || !config.enabled) return false;
  try {
    const rows = await db
      .select({ enabled: pilotControls.enabled })
      .from(pilotControls)
      .where(eq(pilotControls.id, PILOT_DB_ID))
      .limit(1);
    return rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * F8.2 database kill-switch assertion for funded-execution paths.
 *
 * Throws AuthError(403 PILOT_DISABLED) unless the env gate is armed AND the
 * database switch is enabled. Call AFTER assertPilotIntent so misconfigured
 * envs keep their specific codes (PILOT_NOT_AUTHORIZED / PILOT_ROUTE_ONLY /
 * PILOT_AMOUNT_EXCEEDS_MAX) and a stopped database reports PILOT_DISABLED.
 * Idempotent replays (same key / same swap) stay BEFORE both gates so crash
 * recovery never strands a durable attempt.
 */
export async function assertPilotDbEnabled(
  config: PilotConfig = getPilotConfig(),
  db: KillSwitchDb = getDb(),
): Promise<void> {
  // F8.3: production with a missing allowlist fails closed here too, so a
  // caller that reaches the database gate first can never slip through.
  // (Normal ordering runs assertPilotIntent first, which throws first.)
  if (config.owners.length === 0) {
    if (config.production) {
      throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "Pilot allowlist is missing; funded execution is blocked.");
    }
    return;
  }
  // Unconfigured non-production envs skip the pilot entirely
  // (legacy/quote-only flows); disarmed envs already failed closed in
  // assertPilotIntent. Only an armed-with-allowlist env consults the
  // database switch.
  if (!config.enabled) return;
  if (!(await isPilotDbEnabled(config, db))) {
    throw new AuthError(403, "PILOT_DISABLED", "Live pilot is stopped (database kill switch). No new funding is permitted.");
  }
}

/**
 * Creation-time spend check. This is deliberately not a transfer-count
 * check: a quoted intent has no funding exposure and must not lock the owner
 * out of creating another independent intent. Actual exposure is reserved at
 * prepare time by assertFundingExposure below.
 */
export async function assertPilotBudget(
  userId: string,
  newAtomic: string,
  config: PilotConfig = getPilotConfig(),
  db: BudgetDb = getDb(),
): Promise<void> {
  if (config.owners.length === 0) {
    if (config.enabled) throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "Pilot allowlist is missing; funded execution is blocked.");
    if (config.production) {
      throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "Pilot allowlist is missing; funded execution is blocked.");
    }
    return;
  }
  const rows = await db
    .select({ id: transfers.id, amount: transfers.targetAmountAtomic, status: transfers.status, routeId: transfers.routeId })
    .from(transfers)
    .where(eq(transfers.ownerUserId, userId));
  const mine = rows.filter((r) => r.routeId === PILOT_ROUTE_ID && /^\d+$/.test(r.amount));
  // Only provider-confirmed or delivered spend consumes the aggregate spend
  // ceiling here. A refund releases capacity only after reconciliation has
  // durably transitioned the transfer to terminal REFUNDED.
  let total = BigInt(newAtomic);
  for (const r of mine) {
    if (isActualSpendStatus(r.status)) total += BigInt(r.amount);
  }
  if (total > BigInt(config.maxSpendAtomic)) {
    throw new AuthError(403, "PILOT_SPEND_EXCEEDED", "Pilot total spend limit reached.");
  }
}

/**
 * Reserve funding exposure before creating a handoff attempt. This lifecycle
 * guard runs even while the pilot is OFF: one unresolved/prepared payment
 * gets an explicit double-payment warning instead of silently opening a
 * second funding path. When armed, pilot count and spend caps are applied
 * independently. Active PREPARED/SWAP_ATTACHED attempts count as
 * reservations; expired attempts do not. Same-payment replays are handled
 * before this function is called.
 */
export async function assertFundingExposure(
  userId: string,
  newAtomic: string,
  config: PilotConfig = getPilotConfig(),
  db: Pick<PilotDb, "select"> = getDb(),
  excludeTransferId: string | null = null,
): Promise<void> {
  if (config.owners.length === 0 && (config.enabled || config.production)) {
    throw new AuthError(403, "PILOT_NOT_AUTHORIZED", "Pilot allowlist is missing; funded execution is blocked.");
  }
  // Funding exposure is a lifecycle safety rule even while the pilot is OFF.
  // When the pilot is armed, it narrows the same rule to its configured route
  // and applies its independent count/spend caps below.
  const pilotArmed = config.enabled && config.owners.length > 0;
  const rows = await db
    .select({ id: transfers.id, amount: transfers.targetAmountAtomic, status: transfers.status, routeId: transfers.routeId })
    .from(transfers)
    .where(eq(transfers.ownerUserId, userId));
  const mine = rows.filter((r) => (!pilotArmed || r.routeId === PILOT_ROUTE_ID) && /^\d+$/.test(r.amount));
  const byId = new Map(mine.map((row) => [row.id, row]));
  const reservations = await db
    .select({ transferId: handoffAttempts.transferId })
    .from(handoffAttempts)
    .where(
      sql`${handoffAttempts.status} IN ('PREPARED', 'SWAP_ATTACHED') AND ${handoffAttempts.expiresAt} > NOW()`,
    );
  const exposed = new Set<string>();
  for (const row of mine) {
    if (row.id !== excludeTransferId && isFundingExposureStatus(row.status)) exposed.add(row.id);
  }
  for (const reservation of reservations) {
    const reservedTransfer = byId.get(reservation.transferId);
    // A stale attempt row must not resurrect exposure after its transfer was
    // safely cancelled or failed. Reservations apply only to reversible
    // pre-funding states; funded/uncertain states are already covered above.
    if (
      reservedTransfer &&
      reservedTransfer.id !== excludeTransferId &&
      (reservedTransfer.status === "QUOTED" || reservedTransfer.status === "SWAP_CREATED")
    ) {
      exposed.add(reservedTransfer.id);
    }
  }
  const exposureLimit = pilotArmed ? config.maxTransfers : 1;
  if (exposed.size >= exposureLimit) {
    throw new AuthError(
      409,
      pilotArmed ? "PILOT_EXPOSURE_LIMIT" : "PAYMENT_EXPOSURE_UNCERTAIN",
      pilotArmed
        ? "Another payment may still be funded; check it before preparing a separate payment."
        : "Another payment is still being prepared or checked; check it before starting a separate payment.",
    );
  }

  if (pilotArmed) {
    let potential = BigInt(newAtomic);
    for (const row of mine) {
      if (row.id === excludeTransferId) continue;
      if (isActualSpendStatus(row.status) || exposed.has(row.id)) potential += BigInt(row.amount);
    }
    if (potential > BigInt(config.maxSpendAtomic)) {
      throw new AuthError(403, "PILOT_SPEND_EXCEEDED", "This payment would exceed the remaining pilot exposure limit.");
    }
  }
}
