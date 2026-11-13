/**
 * R3 — payment-risk copy shared by the review screen and stalled progress.
 *
 * ESTIMATE, not a deadline: Nimiq Pay sets the NIM HTLC timeout itself and
 * Thence learns the exact value only after the NIM is locked and verified.
 * Every NIM-funded Lightning payment observed on mainnet (2026-11-06 to
 * 2026-11-13, six HTLCs read from the Nimiq chain) used ~59 h between lock
 * and timeout. If Nimiq Pay changes it, this copy must change too.
 */
export const NIM_LOCK_ESTIMATE_HOURS = 59;

/** Human estimate, explicitly labelled as such. */
export const NIM_LOCK_ESTIMATE_LABEL = "about 2½ days (an estimate from recent payments)";

/** Shown before the owner continues to approval. */
export const PRE_APPROVAL_RISK_TITLE = "If the Lightning payment fails, your NIM can stay locked";
export const PRE_APPROVAL_RISK_BODY =
  "Nimiq Pay locks your NIM in a swap and then sends the Lightning payment. Usually that takes under a minute. " +
  `If the Lightning payment doesn't reach the provider, nothing is delivered and your NIM stays locked until the swap's refund timeout — ${NIM_LOCK_ESTIMATE_LABEL}. ` +
  "Nimiq Pay sets the exact timeout; after it passes, Nimiq Pay can return your NIM. Thence can't release it sooner.";

/** Shown while a verified NIM lock has had no Lightning payment for 5+ minutes. */
export const STALLED_HEADLINE = "Payment stalled — the Lightning payment hasn't arrived";
export function stalledBody(until: string): string {
  return (
    "Nimiq Pay locked your NIM more than 5 minutes ago, but the provider still hasn't received the Lightning payment. Successful payments usually arrive within a minute." +
    `${until} If it never arrives, nothing is delivered and your NIM stays locked in Nimiq Pay's swap until its refund timeout — ${NIM_LOCK_ESTIMATE_LABEL}; ` +
    "after that Nimiq Pay can return it. Thence keeps checking and hasn't seen a refund yet. Don't pay again."
  );
}
