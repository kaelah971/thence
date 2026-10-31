/**
 * F8 — restricted live pilot gate (server-side only).
 *
 * Before any real NIM moves, all funded execution paths require:
 * - Kill switch armed: THENCE_PILOT_ENABLED === "1" (default OFF, fail-closed)
 * - Strict route: usdc-polygon only
 * - Authenticated owner wallet allowlisted (canonical Nimiq address compare)
 * - Per-transfer atomic cap (default 3 USDC)
 * - Pilot spend + attempt caps (default 6 USDC total, 5 transfers)
 *
 * Client feature flags (NEXT_PUBLIC_THENCE_ENABLE_PAYMENT / _CLAIM) stay
 * OFF independently: this gate alone never authorizes a host payment.
 * Blocked attempts throw AuthError (403 PILOT_*, never a zero or silent pass).
 */
import { eq } from "drizzle-orm";
import { AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { transfers, users } from "@/db/schema";
import { normalizeNimiqAddress } from "@/lib/nimiq";

// Budget correction (user has ~$2 NIM total; $2 USDC target CANCELLED):
// first transfer $0.10 USDC, max total debit $0.50 USD-equiv incl fees.
// NOTE (live check 2026-10-31): 0.10 USDC quotes 134 sats source vs
// provider minimum 356 sats -> BELOW_MINIMUM, i.e. currently UNSUPPORTED.
// Caps stay at 0.10 / single attempt: do NOT auto-increase.
export const PILOT_ROUTE_ID = "usdc-polygon";
export const DEFAULT_MAX_TARGET_ATOMIC = "100000"; // 0.10 USDC
export const DEFAULT_MAX_SPEND_ATOMIC = "100000"; // 0.10 USDC total (single shot)
export const DEFAULT_MAX_TRANSFERS = 1;

export interface PilotConfig {
  enabled: boolean;
  owners: string[];
  maxTargetAtomic: string;
  maxSpendAtomic: string;
  maxTransfers: number;
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

/** Owner lookup for server-side allowlist enforcement (null when unknown). */
export async function getOwnerAddress(userId: string): Promise<string | null> {
  const rows = await getDb().select({ nimiqAddress: users.nimiqAddress }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.nimiqAddress ?? null;
}

/**
 * Pure intent check: kill switch, route, allowlist, per-transfer cap.
 * Throws AuthError on any violation (fail-closed).
 */
export function assertPilotIntent(
  input: { routeId: string; targetAmountAtomic: string; ownerAddress: string | null },
  config: PilotConfig = getPilotConfig(),
): void {
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

/**
 * Pilot budget check at creation time: total spend + attempt count across
 * the owner's pilot-route transfers (excluding idempotent replay of the
 * same idempotency key, which the caller handles before/after).
 */
export async function assertPilotBudget(
  userId: string,
  newAtomic: string,
  config: PilotConfig = getPilotConfig(),
): Promise<void> {
  const rows = await getDb()
    .select({ amount: transfers.targetAmountAtomic, status: transfers.status, routeId: transfers.routeId })
    .from(transfers)
    .where(eq(transfers.ownerUserId, userId));
  // Only pilot-route transfers count toward spend/attempts.
  const mine = rows.filter((r) => r.routeId === PILOT_ROUTE_ID && /^\d+$/.test(r.amount));
  if (mine.length >= config.maxTransfers) {
    throw new AuthError(403, "PILOT_ATTEMPTS_EXCEEDED", "Pilot attempt limit reached.");
  }
  let total = BigInt(newAtomic);
  for (const r of mine) {
    if (r.status === "FAILED") continue;
    total += BigInt(r.amount);
  }
  if (total > BigInt(config.maxSpendAtomic)) {
    throw new AuthError(403, "PILOT_SPEND_EXCEEDED", "Pilot total spend limit reached.");
  }
}
