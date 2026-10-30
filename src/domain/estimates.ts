/**
 * Thence domain — Home "Send value as" estimate contract (B3.2, read-only).
 *
 * Product context: the future Home card shows the real NIM balance (from
 * Nimiq Pay, client-side) plus an indicative destination value per route.
 *
 * Hard boundaries (do NOT relax without a verified integration):
 * - The backend NEVER reads a user's NIM balance (Nimiq Pay owns it).
 * - Satora quotes are denominated in Lightning sats, which are NOT NIM.
 *   Sats must never be presented as, or converted to, a NIM debit.
 * - No authoritative NIM→Lightning indicative pricing source has been
 *   verified, so the only honest answer today is `unavailable`.
 * - The final NIM debit is always shown by native Nimiq Pay at approval.
 *
 * The `available` variant is specified here so the future UI/server slice
 * has a typed contract to implement against — it is intentionally
 * unreachable until a verified pricing source exists.
 */
export type SendValueEstimate =
  | {
      status: "unavailable";
      /** Machine-readable reason (e.g. "no-nim-pricing-source"). */
      reason: string;
      /** Human-safe explanation for UI fallback copy. */
      message: string;
    }
  | {
      status: "estimate";
      routeId: string;
      /** Exact destination atomic units for the indicated amount. */
      destinationAmountAtomic: string;
      /** Source amount in Lightning sats — explicitly NOT NIM. */
      sourceAmountSats: string;
      /** Where the indicative figure came from and when. */
      basis: string;
      observedAt: string;
    };

export interface SendValueEstimateInput {
  routeId: string;
  /** Real NIM balance atomic units — informational only, never converted here. */
  nimBalanceAtomic?: string;
}

/**
 * Current behavior: always unavailable. Sats are not NIM, and no verified
 * NIM→Lightning indicative pricing source exists. Returns a typed,
 * UI-safe fallback instead of inventing market prices.
 */
export function getSendValueEstimate(_input: SendValueEstimateInput): SendValueEstimate {
  return {
    status: "unavailable",
    reason: "no-nim-pricing-source",
    message:
      "Send-value estimates are unavailable: provider quotes are denominated in Lightning sats, which are not NIM debits, and no verified NIM pricing source exists yet. The exact NIM debit is shown by Nimiq Pay at approval.",
  };
}
