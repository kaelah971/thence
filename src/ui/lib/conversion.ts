/**
 * A3c.2 — NIM wallet card conversion preview (display only).
 *
 * Thence has no trusted NIM→USDC rate: live quotes are priced in Lightning
 * sats for an exact USDC amount, and Nimiq Pay shows the exact NIM debit only
 * at approval. So the USDC equivalent is reported as UNAVAILABLE, never
 * guessed, and nothing here is a quote or a spendable balance.
 *
 * If a trustworthy rate source is added later, it must enter through this
 * module (with its own source label and age) rather than in the card.
 */
import type { BalanceState } from "./balance";
import { formatLuna, type FormattedNim } from "./luna";

export type ConversionPreview =
  | { status: "loading" }
  | { status: "no-balance"; message: string }
  | { status: "rate-unavailable"; nim: FormattedNim; message: string };

export const RATE_UNAVAILABLE_MESSAGE =
  "No trusted NIM-to-USDC rate is available, so Thence won't guess. When you send, Nimiq Pay shows the exact NIM before you approve.";

export function nimUsdcPreview(balance: BalanceState): ConversionPreview {
  switch (balance.status) {
    case "loading":
      return { status: "loading" };
    case "loaded":
      return { status: "rate-unavailable", nim: formatLuna(balance.luna), message: RATE_UNAVAILABLE_MESSAGE };
    case "disconnected":
      return { status: "no-balance", message: "Connect your wallet to see your NIM balance." };
    default:
      return { status: "no-balance", message: "Your NIM balance isn't available right now, so no USDC value is shown." };
  }
}
