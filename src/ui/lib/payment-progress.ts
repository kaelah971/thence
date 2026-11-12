/**
 * ONE authoritative view of a payment in progress (Send and Activity).
 *
 * Pure: derives exactly one headline, one short sentence, one timeline and
 * one next action from server facts. It never decides whether a claim is
 * allowed — that stays with the server's `claimReady`, the client-clock claim
 * window and the claim-pending record (useSettlement / claim-gate). It only
 * decides what the owner is told.
 *
 * 2026-11-05 live payment: after Finish delivery the screen still said
 * "Action needed — Finish delivery" next to "On its way", and a static
 * "What happens after you approve" timeline still said "Approve the NIM
 * payment" — while the chain verifier was simply waiting for 256
 * confirmations. Every state below has exactly one message.
 */
import type { TransferStatus } from "@/domain/transfers";
import { needsOwnerClaim, type SettlementVerdict } from "./settlement-client";
import { timelineFor, type TimelineStep } from "./status";

export type NextAction =
  /** Waiting on something the owner can't speed up; nothing to tap. */
  | "wait"
  /** The owner must tap Finish delivery (the button itself still obeys the claim gates). */
  | "finish"
  /** Finish delivery was submitted; the chain verifier decides. Never a second tap. */
  | "verifying"
  /** Delivered with a receipt. */
  | "receipt"
  /** Something needs a look; "Check again" is the only control. */
  | "check"
  /** Closed (cancelled / refunded / expired): nothing to do. */
  | "none";

export type ProgressTone = "neutral" | "action" | "warn" | "done";

export interface ProgressInput {
  phase: string;
  transferStatus: string | null;
  providerStatus: string | null;
  claimReady: boolean;
  claimPending?: boolean;
  identityMismatch?: boolean;
  verifyVerdict?: SettlementVerdict | null;
  receiptReady: boolean;
  /** Error/attention text from the tracker (session ended, network, mismatch). */
  message?: string;
  /** This browser already handed the payment to Nimiq Pay (server may not know yet). */
  handedOff?: boolean;
  /**
   * Nimiq Pay refused before asking for approval (local handoff record). Replaces
   * only the generic "checking" explanation while the server is still checking
   * and the provider shows no movement; never changes the action or outcome.
   */
  refusal?: { title: string; body: string } | null;
}

/** Provider statuses that show no funding movement (null = not read yet). */
const NO_PROVIDER_MOVEMENT: ReadonlySet<string> = new Set(["", "pending", "expired", "unknown"]);

export interface ProgressView {
  headline: string;
  body: string;
  tone: ProgressTone;
  action: NextAction;
  steps: TimelineStep[] | null;
}

/** Provider says the claim already landed: verification, not another tap. */
const REDEEMED: ReadonlySet<string> = new Set(["clientredeemed", "serverredeemed"]);
const FINALITY_PENDING: ReadonlySet<string> = new Set(["PENDING", "INSUFFICIENT_CONFIRMATIONS"]);

export const VERIFYING_HEADLINE = "Delivery submitted — verifying on Polygon";
export const FINISH_HEADLINE = "Action required — Finish delivery";

function isStatus(value: string | null): value is TransferStatus {
  return typeof value === "string" && value.length > 0;
}

export function paymentProgress(s: ProgressInput): ProgressView {
  const status = s.transferStatus;
  const awaitingFinality = FINALITY_PENDING.has(s.verifyVerdict ?? "");
  const claimLanded = REDEEMED.has(s.providerStatus ?? "") && !s.claimReady;
  // CLAIMING means a claim was authorized somewhere. While the server refuses
  // another (claimReady false: lease / pending horizon) it is verification.
  // If the server re-allows ONE retry after an unknown outcome (claimReady
  // true, nothing pending here), the owner's tap is the next step again.
  const submitted = s.claimPending === true || claimLanded || (status === "CLAIMING" && !s.claimReady);
  // Handed to Nimiq Pay but the server hasn't recorded it yet: same step, "confirming" wording.
  const stepStatus = status === "AWAITING_NIM_APPROVAL" && s.handedOff === true ? "LIGHTNING_HANDOFF" : status;
  const steps = isStatus(stepStatus) ? timelineFor(stepStatus as TransferStatus, { claimSubmitted: submitted, awaitingFinality }) : null;

  if (s.phase === "delivered" || status === "DELIVERED") {
    return s.receiptReady
      ? { headline: "Delivered", body: "Verified on Polygon. The receipt below is the proof.", tone: "done", action: "receipt", steps }
      : { headline: "Delivered", body: "Verified on Polygon. Loading the receipt…", tone: "done", action: "wait", steps };
  }
  if (s.phase === "cancelled") return { headline: "Payment cancelled", body: "Nothing was paid.", tone: "neutral", action: "none", steps };
  if (s.phase === "refunded") return { headline: "Not delivered — Polygon lock refunded", body: s.message || "", tone: "warn", action: "none", steps };
  if (s.phase === "expired") return { headline: "Payment expired — not delivered", body: s.message || "", tone: "warn", action: "none", steps };
  if (s.phase === "attention" || s.verifyVerdict === "INVALID") {
    return {
      headline: "Payment needs attention",
      body: s.message || "Something doesn't match. Don't start another payment.",
      tone: "warn",
      action: "check",
      steps,
    };
  }

  // Funded on Polygon and the owner's tap is the next step (and not yet made here).
  if (!submitted && needsOwnerClaim({ phase: s.phase, transferStatus: status, providerStatus: s.providerStatus, claimReady: s.claimReady, identityMismatch: s.identityMismatch === true })) {
    return {
      headline: FINISH_HEADLINE,
      body: "Tap Finish delivery to release the USDC to their wallet. Only this device can do it.",
      tone: "action",
      action: "finish",
      steps,
    };
  }
  if (submitted && (status === "SERVER_FUNDED" || status === "CLAIMING")) {
    const body =
      s.verifyVerdict === "UNAVAILABLE" || s.verifyVerdict === "INCONCLUSIVE"
        ? "Polygon couldn't be checked just now. Thence keeps checking — don't pay again."
        : awaitingFinality
          ? "Seen on Polygon. Waiting for confirmations — usually about 10 minutes. You can leave this screen."
          : "Usually about 10 minutes. You can leave this screen; the receipt appears once it's confirmed.";
    return { headline: VERIFYING_HEADLINE, body, tone: "neutral", action: "verifying", steps };
  }
  if (status === "CLIENT_FUNDED") {
    return {
      headline: "Payment received — preparing delivery",
      body: "Stay here: you'll need to tap Finish delivery in a moment.",
      tone: "neutral",
      action: "wait",
      steps,
    };
  }
  if (
    s.refusal &&
    (status === "LIGHTNING_HANDOFF" || status === "OUTCOME_UNKNOWN" || status === "RECONCILING" || (status === "AWAITING_NIM_APPROVAL" && s.handedOff === true)) &&
    NO_PROVIDER_MOVEMENT.has(s.providerStatus ?? "")
  ) {
    return { headline: s.refusal.title, body: s.refusal.body, tone: "warn", action: "check", steps };
  }
  if (status === "LIGHTNING_HANDOFF") {
    return { headline: "Confirming your approval", body: "Checking that Nimiq Pay sent the payment. Don't pay again.", tone: "neutral", action: "wait", steps };
  }
  if ((status === "AWAITING_NIM_APPROVAL" || s.phase === "waiting-approval") && s.handedOff === true) {
    return { headline: "Confirming your approval", body: "Checking that Nimiq Pay sent the payment. Don't pay again.", tone: "neutral", action: "wait", steps };
  }
  if (status === "AWAITING_NIM_APPROVAL" || s.phase === "waiting-approval") {
    return { headline: "Approve in Nimiq Pay", body: "Nimiq Pay shows the exact NIM amount before you confirm.", tone: "neutral", action: "wait", steps };
  }
  return {
    headline: "Checking your payment",
    body: s.message && s.phase === "checking" ? s.message : "We can't confirm the outcome yet. Don't start another payment.",
    tone: "warn",
    action: "check",
    steps,
  };
}
