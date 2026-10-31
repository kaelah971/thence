import { USER_FACING_LABEL, type TransferStatus } from "@/domain/transfers";

/** Product stages used for grouping, filters and tone. The backend label stays authoritative. */
export type TransferStage = "ready" | "approval" | "moving" | "checking" | "attention" | "delivered" | "closed";

export const STAGE_OF: Record<TransferStatus, TransferStage> = {
  DRAFT: "ready",
  QUOTED: "ready",
  SWAP_CREATED: "ready",
  QUOTE_EXPIRED: "closed",
  USER_CANCELLED: "closed",
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

export function pillLabel(status: TransferStatus): string {
  const stage = STAGE_OF[status];
  return stage === "closed" ? USER_FACING_LABEL[status] : STAGE_LABEL[stage];
}

export type ActivityFilter = "all" | "progress" | "delivered" | "attention";

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
  }
}

export type StepState = "done" | "current" | "upcoming" | "paused";

export interface TimelineStep {
  key: "ready" | "approved" | "moving" | "delivered";
  label: string;
  detail: string;
  state: StepState;
}

const STEP_ORDER = ["ready", "approved", "moving", "delivered"] as const;

function progressIndex(status: TransferStatus): number {
  switch (STAGE_OF[status]) {
    case "ready":
    case "approval":
    case "closed":
      return 0;
    case "moving":
      return status === "LIGHTNING_HANDOFF" ? 1 : 2;
    case "checking":
    case "attention":
      return 2;
    case "delivered":
      return 4;
  }
}

/** Build the readable four-step timeline for a transfer. Delivered is only "done" for DELIVERED. */
export function timelineFor(status: TransferStatus): TimelineStep[] {
  const stage = STAGE_OF[status];
  const index = progressIndex(status);
  const label = USER_FACING_LABEL[status];
  const copy: Record<TimelineStep["key"], { label: string; detail: string }> = {
    ready: {
      label: "Preparing payment",
      detail: stage === "approval" ? "Approve the NIM payment in Nimiq Pay." : stage === "closed" ? label : "Recipient, amount and route reviewed.",
    },
    approved: { label: "Approved in Nimiq Pay", detail: "You approved the NIM payment." },
    moving: {
      label: stage === "checking" ? "Checking your payment" : stage === "attention" ? "Needs your attention" : "On its way",
      detail:
        stage === "checking"
          ? "We can't confirm the outcome yet. Do not resend."
          : stage === "attention"
            ? "Follow the next step before starting another payment."
            : stage === "moving"
              ? label
              : "Converting and sending to their network.",
    },
    delivered: { label: "Delivered", detail: "Confirmed on their network." },
  };
  return STEP_ORDER.map((key, i) => {
    let state: StepState = i < index ? "done" : i === index ? "current" : "upcoming";
    if (stage === "closed" && i === 0) state = "paused";
    if ((stage === "checking" || stage === "attention") && i === index) state = "paused";
    return { key, ...copy[key], state };
  });
}
