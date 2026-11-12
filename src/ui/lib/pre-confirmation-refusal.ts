/**
 * Honest copy for a Nimiq Pay refusal that happened BEFORE the wallet asked
 * the owner to approve the payment (incident 19cc312c, 2026-11-12).
 *
 * Source of truth: nimiq/nimiq-pay-app `useMiniAppHost.ts` `payLightningInvoice`.
 * Each reason below is thrown before `requestConfirmation`, i.e. before any
 * signing or broadcast, and is matched upstream by an EXACT allowlisted message
 * (src/lib/nimiq-pay-failure-reasons.ts). Reasons raised on or after the send
 * path (e.g. SEND_REJECTED) are deliberately absent.
 *
 * UX only. The browser still reports the conservative `unknown` outcome: a
 * client-side error never proves the invoice unpaid. The server keeps the
 * payment open until provider expiry + the Polygon scan release it (P4).
 */
import type { NimiqPayFailureReason } from "@/lib/nimiq-pay-failure-reasons";

export type PreConfirmationRefusalReason = Extract<
  NimiqPayFailureReason,
  "INSUFFICIENT_NIM_BALANCE" | "INSUFFICIENT_USDT_BALANCE" | "SWAP_LIMIT_EXCEEDED" | "SWAP_QUOTE_EXPIRED" | "INVOICE_EXPIRED"
>;

const WHAT_HAPPENED: Record<PreConfirmationRefusalReason, { title: string; lead: string }> = {
  INSUFFICIENT_NIM_BALANCE: {
    title: "Nimiq Pay: not enough NIM",
    lead: "Nimiq Pay reported that your NIM balance was too low and stopped before asking you to approve this payment.",
  },
  INSUFFICIENT_USDT_BALANCE: {
    title: "Nimiq Pay: not enough USDT",
    lead: "Nimiq Pay reported that your USDT balance (including the Polygon fee) was too low and stopped before asking you to approve this payment.",
  },
  SWAP_LIMIT_EXCEEDED: {
    title: "Nimiq Pay: above its swap limit",
    lead: "Nimiq Pay reported that this payment is above its current swap limit and stopped before asking you to approve it.",
  },
  SWAP_QUOTE_EXPIRED: {
    title: "Nimiq Pay: swap price expired",
    lead: "Nimiq Pay reported that its swap price had expired and stopped before asking you to approve this payment.",
  },
  INVOICE_EXPIRED: {
    title: "Nimiq Pay: invoice expired",
    lead: "Nimiq Pay reported that the Lightning invoice had expired and stopped before asking you to approve this payment.",
  },
};

export function isPreConfirmationRefusal(reason: unknown): reason is PreConfirmationRefusalReason {
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(WHAT_HAPPENED, reason);
}

export interface PreConfirmationRefusalCopy {
  title: string;
  body: string;
}

/**
 * Reason-specific explanation. Never suggests another payment while the
 * invoice can still be paid; points to closing it in Activity after expiry.
 */
export function preConfirmationRefusalCopy(
  reason: PreConfirmationRefusalReason,
  invoiceExpiresAt: string | null = null,
): PreConfirmationRefusalCopy {
  const { title, lead } = WHAT_HAPPENED[reason];
  const until = invoiceExpiresAt ? new Date(invoiceExpiresAt) : null;
  const when = until && !Number.isNaN(until.getTime())
    ? ` until ${until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : " until it expires";
  return {
    title,
    body:
      `${lead} Thence can't confirm that on its own, so this payment stays open and its invoice is checked${when}. ` +
      "Don't start another payment for it in the meantime. Once the invoice has expired, you can close it in Activity.",
  };
}
