/**
 * ONE recovery classification for a payment opened in Activity.
 *
 * Every payment the owner looks at falls into exactly one of five kinds, each
 * with exactly one primary action:
 *
 * 1. preparation  — never reached a verified approval/funding step. Resume or
 *                   cancel; nothing has been proven to move.
 * 2. uncertain    — the outcome can't be confirmed yet. One "Check payment
 *                   status" control (server reconcile + fresh provider read).
 * 3. funds-moved  — funding was independently verified by the server (NIM
 *                   source on-chain, or Polygon funding/claim). The live
 *                   progress card drives it (Finish delivery / verifying).
 * 4. expired-closable — the SERVER's evidence gates say a close may proceed
 *                   (P4 expired-unfunded, or R2 NIM-return proof). The action
 *                   re-verifies everything before changing anything.
 * 5. closed       — delivered, delivered short, refunded, expired, cancelled
 *                   or otherwise terminal. Receipt or nothing.
 *
 * Pure and conservative: missing client evidence (no NIM hash, no provider
 * read, invoice expiry alone) never proves funds moved, stayed put, were
 * locked, returned or delivered. Only server facts move a payment between
 * kinds, and only `closeEligibility` from the server surfaces a close.
 */
import { isTerminal, TRANSFER_STATUSES, type TransferStatus } from "@/domain/transfers";
import { providerEvidenceDisposition, type ProviderEvidence } from "./settlement-client";
import type { SettlementNetwork } from "./network-copy";

export type RecoveryKind = "preparation" | "uncertain" | "funds-moved" | "expired-closable" | "closed";

export type RecoveryAction =
  /** Continue the same payment (never a new one). */
  | "resume"
  /** Retire a payment that never reached approval, or whose swap the provider reports expired before approval. */
  | "cancel-unpaid"
  /** The single status check: reconcile on the server, then a fresh provider read. */
  | "check-status"
  /** The live progress card owns the action (Finish delivery, or nothing while verifying). */
  | "live"
  /** P4 close, server-gated. */
  | "close-expired"
  /** R2 NIM-return proof + close, server-gated. */
  | "check-nim-return"
  /** Delivered: the receipt is the proof. */
  | "receipt"
  | "none";

export type RecoveryTone = "info" | "warn" | "done";

export interface RecoveryView {
  kind: RecoveryKind;
  primary: RecoveryAction;
  title: string;
  body: string;
  tone: RecoveryTone;
}

export interface RecoveryInput {
  status: TransferStatus;
  /** Latest fresh provider read for this payment (null until checked). */
  evidence: ProviderEvidence | null;
  /** Server-verified NIM source (from the live tracker); never inferred client-side. */
  sourceVerified?: boolean;
  /** Archived/preview screens never offer actions. */
  readOnly?: boolean;
  /** Settlement network of the payment's route (copy only; defaults to Polygon). */
  network?: SettlementNetwork;
}

/**
 * The provider's EVM refund returns the PROVIDER's lock. The owner's NIM sits
 * in Nimiq Pay's own HTLC, which only Nimiq Pay (or its timeout) releases.
 */
export const NIM_RETURN_NOTE =
  "Your NIM is returned separately: Nimiq Pay's lock releases it to your wallet after its own timeout. Thence can't see that step, so check your Nimiq Pay balance; if it isn't back after the timeout, refund the expired swap in Nimiq Pay.";

const PREPARATION: ReadonlySet<TransferStatus> = new Set(["DRAFT", "QUOTED", "SWAP_CREATED", "AWAITING_NIM_APPROVAL"]);
/**
 * Provider-reported funding (CLIENT_FUNDED / SERVER_FUNDED follow the
 * provider's status) or an authorized claim (CLAIMING: claim-intent verified
 * the funding on-chain first). Copy must not call provider funding verified.
 */
const FUNDED: ReadonlySet<TransferStatus> = new Set(["CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"]);
/**
 * P4 accepts only RECONCILING; R2 accepts a failed handoff in any of these,
 * and NEEDS_ATTENTION after a provider refusal to fund (defect D4).
 */
const P4_FROM: ReadonlySet<TransferStatus> = new Set(["RECONCILING"]);
const R2_FROM: ReadonlySet<TransferStatus> = new Set(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "NEEDS_ATTENTION"]);

/** Same wording as the Activity pill banner, so every screen names this state the same way. */
export const UNCERTAIN_TITLE = "Checking your payment — do not resend";
export const DO_NOT_RESEND = "Don't pay the same invoice again while the outcome is unresolved.";

export function isTransferStatus(value: string): value is TransferStatus {
  return (TRANSFER_STATUSES as readonly string[]).includes(value);
}

/** Server-gated close kind, or null. Evidence for another transfer or an older server never qualifies. */
export function closeActionFor(status: TransferStatus, evidence: ProviderEvidence | null): "close-expired" | "check-nim-return" | null {
  const gates = evidence?.closeEligibility;
  if (!evidence || !gates || evidence.transferStatus !== status) return null;
  if (P4_FROM.has(status) && gates.expiredUnfunded.eligible === true) return "close-expired";
  if (R2_FROM.has(status) && gates.nimReturn.eligible === true) return "check-nim-return";
  return null;
}

export function recoveryState(input: RecoveryInput): RecoveryView {
  const { status, evidence } = input;
  const view = classify(status, evidence, input.sourceVerified === true, input.network ?? "Polygon");
  if (input.readOnly && view.primary !== "receipt") return { ...view, primary: "none" };
  return view;
}

function classify(status: TransferStatus, evidence: ProviderEvidence | null, sourceVerified: boolean, network: SettlementNetwork): RecoveryView {
  // 5. Closed — terminal states never offer recovery actions.
  if (isTerminal(status)) return closedView(status, network);

  // 4. Expired and eligible to close — only when the server's own gates pass.
  const close = closeActionFor(status, evidence);
  if (close === "close-expired") {
    return {
      kind: "expired-closable",
      primary: "close-expired",
      title: "Expired without funding — you can close it",
      body:
        `The provider reports this payment expired without being funded, and Thence has no record of a NIM payment or a ${network} transaction for it. ` +
        `Closing it checks the provider and the ${network} network again first, and keeps it open if anything doesn't match.`,
      tone: "info",
    };
  }
  if (close === "check-nim-return") {
    return {
      kind: "expired-closable",
      primary: "check-nim-return",
      title: "Not delivered — waiting for your NIM to come back",
      body:
        (status === "NEEDS_ATTENTION"
          ? "The provider didn't fund its side of this payment, so nothing reached their wallet. "
          : "The provider reports this payment expired. ") +
        "Thence recorded a NIM payment for it, so it can close this payment only after it " +
        "verifies on the Nimiq blockchain that the full amount was returned to your Nimiq address. Until then it stays open — don't pay again.",
      tone: "warn",
    };
  }

  // A provider refund reported while the transfer still looks funded (e.g. the
  // claim was refused and the deadline passed) must never read as "funded".
  if (FUNDED.has(status) && providerEvidenceDisposition(evidence) === "REFUNDED") return uncertainView(status, evidence, network);

  // 3. Funds reported as moved (provider funding) or verified (NIM source / authorized claim).
  if (FUNDED.has(status) || (status === "LIGHTNING_HANDOFF" && sourceVerified)) {
    return {
      kind: "funds-moved",
      primary: "live",
      title: status === "LIGHTNING_HANDOFF" ? "NIM payment verified" : "Payment funded",
      body:
        status === "LIGHTNING_HANDOFF"
          ? "Thence verified your NIM payment on the Nimiq blockchain. Delivery follows the steps below — don't pay again."
          : status === "CLAIMING"
            ? `Funding was verified on ${network} before delivery was started. Delivery follows the steps below — don't pay again.`
            : `The provider reports this payment is funded on ${network}. Thence checks that funding on-chain before delivery can be finished — don't pay again.`,
      tone: "info",
    };
  }

  // 1. Preparation — nothing proven to have moved; continue the same payment.
  if (PREPARATION.has(status)) {
    const expiredUnpaid = providerEvidenceDisposition(evidence) === "EXPIRED_UNFUNDED";
    if (expiredUnpaid) {
      return {
        kind: "preparation",
        primary: "cancel-unpaid",
        title: "Payment window expired before approval",
        body: "The provider reports this payment's swap expired without funding. You can cancel it; the server checks again first. History is kept.",
        tone: "info",
      };
    }
    if (status === "AWAITING_NIM_APPROVAL") {
      return {
        kind: "preparation",
        primary: "resume",
        title: "Waiting for your approval in Nimiq Pay",
        body: "No approval is recorded yet. Continuing opens the same payment — Nimiq Pay shows the exact NIM amount before you confirm.",
        tone: "info",
      };
    }
    return {
      kind: "preparation",
      primary: "resume",
      title: "Preparation didn't finish",
      body: "This payment was set up but never sent for approval, so nothing has been paid. You can continue it or cancel it.",
      tone: "info",
    };
  }

  // 2. Uncertain — includes provider-reported funding the server hasn't verified yet.
  return uncertainView(status, evidence, network);
}

function uncertainView(status: TransferStatus, evidence: ProviderEvidence | null, network: SettlementNetwork): RecoveryView {
  const base = { kind: "uncertain" as const, primary: "check-status" as const, tone: "warn" as const };
  const disposition = providerEvidenceDisposition(evidence);
  if (disposition === "REFUNDED") {
    return {
      ...base,
      title: "Not delivered — provider reports a refund",
      body:
        `The provider reports that its ${network} lock was refunded to the provider, so nothing reached their wallet. That is not a refund of your NIM. ` +
        "Thence keeps this payment open until it verifies the refund on-chain. Don't pay again. " +
        NIM_RETURN_NOTE,
    };
  }
  if (disposition === "FUNDING_DETECTED" || disposition === "SETTLEMENT_DETECTED") {
    return {
      ...base,
      title: "Provider reports activity — Thence is verifying it",
      body: "The provider reports this payment was funded. Thence hasn't independently verified it on-chain yet. Don't pay again.",
    };
  }
  if (status === "NEEDS_ATTENTION") {
    return { ...base, title: "Needs attention — do not resend", body: "Something about this payment doesn't match. Thence keeps it open for review. " + DO_NOT_RESEND };
  }
  // A refused close stays uncertain and says why (the action's own wording).
  const refused = evidence?.closeEligibility && evidence.transferStatus === status ? evidence.closeEligibility.expiredUnfunded : null;
  const refusal = refused && !refused.eligible && refused.reason !== "NOT_RESOLVABLE" && refused.message ? ` ${refused.message}` : "";
  return {
    ...base,
    title: UNCERTAIN_TITLE,
    body:
      "Thence hasn't independently confirmed whether this payment was funded. That is not proof that funds moved, and it is not proof that they stayed put." +
      refusal +
      " " +
      DO_NOT_RESEND,
  };
}

function closedView(status: TransferStatus, network: SettlementNetwork): RecoveryView {
  const kind = "closed" as const;
  switch (status) {
    case "DELIVERED":
      return { kind, primary: "receipt", title: "Delivered", body: `Verified on ${network}. The receipt is the proof.`, tone: "done" };
    case "DELIVERED_SHORT":
      return {
        kind,
        primary: "receipt",
        title: "Delivered — less than requested",
        body: `Verified on ${network}, but they received less than you asked to send. The receipt shows both amounts. Don't pay again for this.`,
        tone: "warn",
      };
    case "REFUNDED":
      return {
        kind,
        primary: "none",
        title: `Not delivered — ${network} lock refunded`,
        body: `Thence verified on ${network} that the provider's lock was refunded to the provider, so nothing reached their wallet. ` + NIM_RETURN_NOTE,
        tone: "warn",
      };
    case "EXPIRED_UNFUNDED":
      return { kind, primary: "none", title: "Payment expired — not delivered", body: "Closed after Thence verified nothing reached their network.", tone: "info" };
    case "USER_CANCELLED":
      return { kind, primary: "none", title: "Payment cancelled", body: "Nothing was paid.", tone: "info" };
    case "QUOTE_EXPIRED":
      return { kind, primary: "none", title: "Price expired", body: "The price expired before an approval was recorded, so this payment can't continue.", tone: "info" };
    default:
      // FAILED: terminal, but Thence never claims where the funds are from its absence of evidence.
      return { kind, primary: "none", title: "Payment ended without delivery", body: "Thence couldn't confirm a delivery for this payment. Don't pay again for it; keep its ID for support.", tone: "warn" };
  }
}
