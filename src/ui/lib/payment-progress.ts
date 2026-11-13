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
  /** Server: NIM source independently verified on-chain (ms). Copy only. */
  sourceVerifiedAtMs?: number | null;
  /** Server: first entry into LIGHTNING_HANDOFF (ms). */
  handoffAtMs?: number | null;
  /** Lightning invoice expiry (ms) and the server's expired verdict. */
  invoiceExpiresAtMs?: number | null;
  invoiceExpired?: boolean;
  /** Clock for the delay message (defaults to Date.now()). */
  nowMs?: number;
}

/**
 * On 2026-11-12 the provider saw the Lightning payment 22–35 s after Nimiq
 * Pay returned. Past this, the owner is told delivery is delayed.
 */
export const LIGHTNING_DELAY_MS = 2 * 60_000;

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Incident 6f44918d (2026-11-13): NIM was verified on-chain within a minute,
 * but the provider never received the Lightning payment and the screen kept
 * saying "Confirming your approval". Once the NIM source is verified the
 * approval is done; what is outstanding is the Lightning leg. Wording never
 * claims a refund: Thence cannot see one until it is independently verified.
 */
function lightningHandoffView(s: ProgressInput, steps: TimelineStep[] | null): ProgressView | null {
  if (s.transferStatus !== "LIGHTNING_HANDOFF" || !s.sourceVerifiedAtMs) return null;
  const now = s.nowMs ?? Date.now();
  const expired = s.invoiceExpired === true || (typeof s.invoiceExpiresAtMs === "number" && s.invoiceExpiresAtMs <= now);
  if (expired) {
    return {
      headline: "Not delivered — the Lightning payment never arrived",
      body:
        "Nimiq Pay locked your NIM, but the provider never received the Lightning payment and its invoice has expired, so nothing was delivered. " +
        "Your NIM stays locked in Nimiq Pay's swap until its timeout; after that Nimiq Pay can return it. Thence hasn't seen a refund yet. Don't pay again.",
      tone: "warn",
      action: "check",
      steps,
    };
  }
  const since = s.handoffAtMs ?? s.sourceVerifiedAtMs;
  const until = typeof s.invoiceExpiresAtMs === "number" ? ` If it arrives before ${clock(s.invoiceExpiresAtMs)}, delivery continues.` : "";
  if (now - since >= LIGHTNING_DELAY_MS) {
    return {
      headline: "Delivery delayed — waiting for the Lightning payment",
      body: `Approved in Nimiq Pay and your NIM is locked, but the provider hasn't received the Lightning payment yet.${until} Don't pay again.`,
      tone: "warn",
      action: "wait",
      steps,
    };
  }
  return {
    headline: "Approved — sending the Lightning payment",
    body: "Your NIM is locked in Nimiq Pay's swap. Waiting for the provider to receive the Lightning payment. Don't pay again.",
    tone: "neutral",
    action: "wait",
    steps,
  };
}

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
  const steps = isStatus(stepStatus) ? timelineFor(stepStatus as TransferStatus, { claimSubmitted: submitted, awaitingFinality, sourceVerified: Boolean(s.sourceVerifiedAtMs) }) : null;

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
  if (status === "LIGHTNING_HANDOFF") {
    const lightning = lightningHandoffView(s, steps);
    if (lightning) return lightning;
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
