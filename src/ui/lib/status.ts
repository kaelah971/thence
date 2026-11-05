import { isTerminal, USER_FACING_LABEL, type TransferStatus } from "@/domain/transfers";

/** Product stages used for grouping, filters and tone. The backend label stays authoritative. */
export type TransferStage = "ready" | "approval" | "moving" | "checking" | "attention" | "delivered" | "closed";

export const STAGE_OF: Record<TransferStatus, TransferStage> = {
  DRAFT: "ready",
  QUOTED: "ready",
  SWAP_CREATED: "ready",
  QUOTE_EXPIRED: "closed",
  USER_CANCELLED: "closed",
  REFUNDED: "closed",
  EXPIRED_UNFUNDED: "closed",
  AWAITING_NIM_APPROVAL: "approval",
  LIGHTNING_HANDOFF: "moving",
  CLIENT_FUNDED: "moving",
  SERVER_FUNDED: "moving",
  CLAIMING: "moving",
  OUTCOME_UNKNOWN: "checking",
  RECONCILING: "checking",
  NEEDS_ATTENTION: "attention",
  FAILED: "attention",
  DELIVERED: "delivered",
};

export const STAGE_LABEL: Record<Exclude<TransferStage, "closed">, string> = {
  ready: "Preparing payment",
  approval: "Waiting for approval",
  moving: "On its way",
  checking: "Checking your payment",
  attention: "Needs your attention",
  delivered: "Delivered",
};

/** Short pill label: the stage name, or the backend label for closed states. */
/** Resume CTA label for activity details (F8.10). Only unpaid pre-approval states offer it; funded, checking, attention and terminal states must not (recovery runs through reconcile/receipt, never a resume). */
export function resumeLabelFor(status: TransferStatus): string | null {
  switch (status) {
    case "QUOTED":
    case "SWAP_CREATED":
      return "Resume payment";
    case "AWAITING_NIM_APPROVAL":
      return "Continue to approval";
    default:
      return null;
  }
}

/**
 * The cancel-unpaid affordance is only for states with a verified, reversible
 * pre-funding path. Provider evidence can add a safe close path, but it must
 * never override an unresolved or funded lifecycle status.
 */
export function canShowCancelUnpaid(status: TransferStatus, expiredUnfundedEvidence: boolean): boolean {
  // Terminal payments are already closed; nothing to cancel (P4: this
  // previously re-offered "Cancel unpaid payment" on any non-listed status,
  // e.g. EXPIRED_UNFUNDED, when the evidence read expired).
  if (isTerminal(status)) return false;
  if (["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "NEEDS_ATTENTION"].includes(status)) return false;
  return status === "QUOTED" || status === "SWAP_CREATED" || expiredUnfundedEvidence;
}

export function pillLabel(status: TransferStatus): string {
  // P3: a funded payment waits for the owner's Finish delivery (Nov 2: "On
  // its way" here told the owner nothing was needed while the deadline ran).
  if (status === "SERVER_FUNDED") return "Finish delivery needed";
  // After Finish delivery the chain verifier decides; nothing more to tap.
  if (status === "CLAIMING") return "Verifying delivery";
  // Funds are being locked on Polygon; the owner's tap comes next.
  if (status === "CLIENT_FUNDED") return "Preparing delivery";
  if (status === "LIGHTNING_HANDOFF") return "Confirming approval";
  const stage = STAGE_OF[status];
  return stage === "closed" ? USER_FACING_LABEL[status] : STAGE_LABEL[stage];
}

export type ActivityFilter = "all" | "progress" | "delivered" | "attention" | "archived";

export function matchesFilter(status: TransferStatus, filter: ActivityFilter): boolean {
  const stage = STAGE_OF[status];
  switch (filter) {
    case "all":
      return true;
    case "progress":
      return stage === "ready" || stage === "approval" || stage === "moving" || stage === "checking";
    case "delivered":
      return stage === "delivered";
    case "attention":
      return stage === "attention";
    case "archived":
      // Archived is a local Activity view, not a transfer status.
      return false;
  }
}

export type StepState = "done" | "current" | "upcoming" | "paused";

export interface TimelineStep {
  key: "approve" | "finish" | "verify" | "delivered";
  label: string;
  detail: string;
  state: StepState;
}

/**
 * Context the server status alone cannot carry (UI-only, never authority):
 * - claimSubmitted: THIS browser already submitted Finish delivery (local
 *   claim record) — the step must not ask for it again.
 * - awaitingFinality: the chain verifier saw the delivery but it needs more
 *   confirmations (INSUFFICIENT_CONFIRMATIONS / PENDING).
 */
export interface TimelineContext {
  claimSubmitted?: boolean;
  awaitingFinality?: boolean;
}

const STEP_ORDER = ["approve", "finish", "verify", "delivered"] as const;

/** Index of the CURRENT step (4 = all done). Approval completes only on funding evidence. */
function progressIndex(status: TransferStatus, ctx: TimelineContext): number {
  switch (status) {
    case "CLIENT_FUNDED":
      return 1;
    case "SERVER_FUNDED":
      return ctx.claimSubmitted ? 2 : 1;
    case "CLAIMING":
      return 2;
    case "DELIVERED":
      return 4;
    default:
      // Preparing, approval, handoff, checking, attention and closed states:
      // nothing after approval is proven yet.
      return 0;
  }
}

/**
 * The single, status-driven payment timeline (Send and Activity).
 * Delivered is "done" only for DELIVERED. Finish delivery is shown as the
 * owner's own step, never as something that happens on its own.
 */
export function timelineFor(status: TransferStatus, ctx: TimelineContext = {}): TimelineStep[] {
  const stage = STAGE_OF[status];
  const index = progressIndex(status, ctx);
  const copy: Record<TimelineStep["key"], { label: string; detail: string }> = {
    approve: {
      label: index > 0 ? "Approved in Nimiq Pay" : "Approve in Nimiq Pay",
      detail:
        stage === "closed"
          ? USER_FACING_LABEL[status]
          : stage === "checking"
            ? "We can't confirm the outcome yet. Do not resend."
            : stage === "attention"
              ? "Follow the next step before starting another payment."
              : status === "LIGHTNING_HANDOFF"
                ? "Confirming your Nimiq Pay payment."
                : "Nimiq Pay shows the exact NIM amount first.",
    },
    finish: {
      label: "Finish delivery",
      detail: status === "CLIENT_FUNDED" ? "Locking the USDC on Polygon. You'll tap Finish delivery next." : "Your tap is needed to release the funds.",
    },
    verify: {
      label: "Verifying on Polygon",
      detail: ctx.awaitingFinality ? "Seen on Polygon. Waiting for confirmations — usually about 10 minutes." : "Usually about 10 minutes.",
    },
    delivered: { label: "Delivered", detail: "Confirmed on their network." },
  };
  return STEP_ORDER.map((key, i) => {
    let state: StepState = i < index ? "done" : i === index ? "current" : "upcoming";
    if (i === 0 && index === 0 && (stage === "closed" || stage === "checking" || stage === "attention")) state = "paused";
    return { key, ...copy[key], state };
  });
}
