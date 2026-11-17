/**
 * P2 — Polygon claim deadline (shared by server, client and tests).
 *
 * The deadline is Satora's `evm_refund_locktime`: the moment the provider may
 * take back the WBTC it locked in the Polygon HTLC. It is fixed when the swap
 * is CREATED (≈ creation + 1 h on Satora Lightning→EVM), not when it is
 * funded — every minute between swap creation and funding is lost claim time
 * (incident 077770a1: created 21:12:44, funded 21:13:27, deadline 22:12:42).
 *
 * It is NOT:
 * - the Lightning invoice expiry (later, ≈ creation + 1.5 h), and
 * - NOT Nimiq Pay's own NIM HTLC timeout (unknown to Thence).
 * Copy must keep these separate.
 *
 * Claiming reveals the preimage. A claim that lands after the provider
 * refunds would let the provider settle the Lightning payment AND keep the
 * Polygon funds, so the last minutes before the deadline are unsafe and no
 * claim action is offered there.
 */

/** No claim action inside this window before the deadline. */
export const CLAIM_UNSAFE_WINDOW_MS = 5 * 60_000;
/** Escalate the warning inside this window before the deadline. */
export const CLAIM_WARNING_WINDOW_MS = 15 * 60_000;

/**
 * Plausibility bounds for a provider-reported locktime relative to the swap
 * bind time. Satora uses ≈ 1 h; anything outside (10 min, 6 h] is treated as
 * an identity anomaly, not a deadline.
 */
export const LOCKTIME_MIN_AFTER_BIND_MS = 10 * 60_000;
export const LOCKTIME_MAX_AFTER_BIND_MS = 6 * 60 * 60_000;

export type ClaimWindow = "unknown" | "open" | "closing" | "unsafe" | "passed";

/** Window classification at `nowMs` for an absolute deadline (ms epoch). */
export function claimWindowAt(deadlineMs: number | null | undefined, nowMs: number): ClaimWindow {
  if (deadlineMs === null || deadlineMs === undefined || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return "unknown";
  const left = deadlineMs - nowMs;
  if (left <= 0) return "passed";
  if (left <= CLAIM_UNSAFE_WINDOW_MS) return "unsafe";
  if (left <= CLAIM_WARNING_WINDOW_MS) return "closing";
  return "open";
}

/** A claim action may be offered only while the window is open or closing. */
export function claimActionAllowed(window: ClaimWindow): boolean {
  return window === "open" || window === "closing";
}

/**
 * Validate a provider locktime (unix seconds) against the bind time and the
 * Lightning invoice expiry. Returns the deadline as a Date, null when the
 * provider did not report one, or "implausible" when it must be refused.
 */
export function validateLocktime(
  locktimeSec: number | null,
  bindTimeMs: number,
  invoiceExpiresAt: Date | null,
): Date | null | "implausible" {
  if (locktimeSec === null) return null;
  if (!Number.isSafeInteger(locktimeSec) || locktimeSec <= 0) return "implausible";
  const ms = locktimeSec * 1000;
  if (ms - bindTimeMs < LOCKTIME_MIN_AFTER_BIND_MS || ms - bindTimeMs > LOCKTIME_MAX_AFTER_BIND_MS) return "implausible";
  // The provider's Polygon refund must come before the Lightning invoice can
  // no longer be settled; otherwise the provider would be exposed and the
  // value cannot be the deadline we think it is.
  if (invoiceExpiresAt && ms >= invoiceExpiresAt.getTime()) return "implausible";
  return new Date(ms);
}

/*
 * Output floor: the lowest `minAmountOut` the browser accepts before it
 * reveals the preimage (the provider's redeem calldata / DEX estimate decides
 * what the recipient can receive; delivery itself is measured on-chain).
 *
 * Evidence (public chain data decoded 2026-11-17):
 * - Polygon: in all seven Thence deliveries Satora's `minAmountOut` was
 *   exactly 99% of the requested amount (its 100 bps slippage) and delivery
 *   was 99.96%-100.07%.
 * - Arbitrum: the claim floor is Satora's DEX estimate for the locked BTC
 *   (`/dex-calldata/fund estimated_amount_out`); for f1ca0926 it was 98.48%
 *   and 98.72% of the request, i.e. price drift after the quote.
 *
 * Policy (quote-bound, never silent):
 * - >= 99% of the request: within the provider's own slippage; automatic.
 * - 97% to 99%: only after the payer explicitly accepts the exact minimum the
 *   recipient may receive (shown in the app); the claim is then bound to that
 *   accepted amount (minus a 0.25% re-quote tolerance, never below 97%).
 * - < 97%: refused before any secret is disclosed; the payment refunds.
 * Anything delivered below the request is still recorded as DELIVERED_SHORT
 * with exact amounts.
 */
export const AUTO_OUTPUT_FLOOR_BPS = 9_900n;
export const CONSENT_OUTPUT_FLOOR_BPS = 9_700n;
/** Re-quote tolerance between the payer's acceptance and the SDK's own read. */
export const ACCEPTED_OUTPUT_TOLERANCE_BPS = 25n;

const ceilBps = (amount: bigint, bps: bigint): bigint => (amount * bps + 9_999n) / 10_000n;

export type OutputFloorDecision = "auto" | "consent" | "refuse";

/** Pure: how a provider minimum compares with the requested amount. */
export function outputFloorDecision(requestedAtomic: bigint, minimumOutAtomic: bigint): OutputFloorDecision {
  if (requestedAtomic <= 0n || minimumOutAtomic <= 0n) return "refuse";
  if (minimumOutAtomic >= ceilBps(requestedAtomic, AUTO_OUTPUT_FLOOR_BPS)) return "auto";
  if (minimumOutAtomic >= ceilBps(requestedAtomic, CONSENT_OUTPUT_FLOOR_BPS)) return "consent";
  return "refuse";
}

/**
 * Smallest `minAmountOut` the disclosure guard accepts. Without an accepted
 * minimum: the automatic floor (99%). With one (only valid inside the consent
 * band): the accepted amount minus the re-quote tolerance, never below 97%.
 */
export function requiredClaimMinimum(requestedAtomic: bigint, acceptedMinimumAtomic?: bigint | null): bigint {
  const autoFloor = ceilBps(requestedAtomic, AUTO_OUTPUT_FLOOR_BPS);
  const hardFloor = ceilBps(requestedAtomic, CONSENT_OUTPUT_FLOOR_BPS);
  if (acceptedMinimumAtomic === undefined || acceptedMinimumAtomic === null) return autoFloor;
  if (acceptedMinimumAtomic < hardFloor) return autoFloor; // invalid acceptance: ignore it, fail to the strict floor
  const tolerant = acceptedMinimumAtomic - (requestedAtomic * ACCEPTED_OUTPUT_TOLERANCE_BPS) / 10_000n;
  const bound = tolerant > hardFloor ? tolerant : hardFloor;
  return bound < autoFloor ? bound : autoFloor;
}
