/**
 * F4.3 — settlement + recovery read path (existing backend contracts only).
 *
 * Reuses, never rebuilds:
 * - GET /api/transfers/:id (transfers-api, read-only snapshot)
 * - GET /api/transfers/:id/attempt (prepare-flow, resume contract)
 * - GET /api/transfers/:id/reconciliation (resume view: same transfer,
 *   same attempt, same bound invoice; never creates anything)
 * - POST /api/transfers/:id/reconcile (one bounded read-only provider
 *   refresh; advances along legal edges only, never fails unknowns)
 * - POST /api/transfers/:id/verify-settlement (server-derived chain
 *   evidence; any client tx hash is ignored by design — so none is sent)
 * - GET /api/transfers/:id/receipt (transfers-api; 409 pre-delivery)
 *
 * Customer-facing progress (everyday language, never developer jargon).
 * Unknown outcomes are never collapsed into failed or cancelled.
 */
import type { TransferStatus } from "@/domain/transfers";
import { apiRequest, type ApiOptions, type ApiResult } from "./api";

export type SettlementVerdict =
  | "VERIFIED"
  | "PENDING"
  | "INSUFFICIENT_CONFIRMATIONS"
  | "INCONCLUSIVE"
  | "INVALID"
  | "UNAVAILABLE";

export interface ReconciliationLatest {
  transferId: string;
  status: TransferStatus;
  statusLabel: string;
  providerStatus: string;
  observedAt: string;
  claimReady: boolean;
  ambiguous: boolean;
  ambiguityReasons: string[];
  invoiceExpired: boolean;
  unknownProviderState: boolean;
  lastError: string | null;
}

export interface ReconciliationView {
  transfer: {
    id: string;
    status: TransferStatus;
    statusLabel: string;
    routeId: string;
    asset: string;
    network: string;
    destination: string;
    targetAmountAtomic: string;
  };
  attempt: {
    id: string;
    status: string;
    quoteRevision: number;
    handoffAuthorizedAt: string | null;
    expiresAt: string;
  } | null;
  swap: {
    satoraSwapId: string;
    sourceSats: string;
    targetAtomic: string;
    paymentHash: string;
    invoiceBolt11: string;
    invoiceExpiresAt: string | null;
    providerStatus: string;
    verifiedAt: string;
  } | null;
  latest: ReconciliationLatest;
}

export interface SettlementProof {
  transferId: string;
  chainId: number;
  chainName: string;
  tokenContract: string;
  recipient: string;
  verifiedAmountAtomic: string;
  claimTxHash: string;
  blockNumber: string;
  blockHash: string;
  logIndexes: number[];
  finalityLevel: string;
  verifiedAt: string;
  satoraSwapId: string;
  explorerTxUrl: string;
}

export interface SettlementResult {
  verdict: SettlementVerdict;
  reason: string;
  transferId: string;
  status: TransferStatus;
  providerStatus: string;
  claimTxHash: string | null;
  proof: SettlementProof | null;
  confirmations: number | null;
}

type Opts = Pick<ApiOptions, "signal" | "fetch">;

export function getReconciliation(id: string, opts: Opts = {}): Promise<ApiResult<ReconciliationView>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/reconciliation`, opts);
}

export function postReconcile(id: string, opts: Opts = {}): Promise<ApiResult<{ reconciliation: ReconciliationLatest & { advanced: boolean; advancedPath: TransferStatus[] } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/reconcile`, { ...opts, method: "POST", body: {} });
}

/**
 * Report a cancelled-before-submit outcome for a definitively unpaid
 * payment (F8.12 retirement). The server only honors cancellation when no
 * funding could have moved (pre-handoff, never authorized); funded or
 * uncertain payments stay open and must reconcile instead. Never claims
 * success — funded/claimed/delivered reports are rejected server-side.
 */
export function postHandoffCancel(id: string, opts: Opts = {}): Promise<ApiResult<{ handoff: { transferId: string; status: TransferStatus; deduplicated: boolean } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/handoff-result`, { ...opts, method: "POST", body: { outcome: "cancelled" } });
}

/** No body is sent: the server derives the swap and claim tx itself. */
export function postVerifySettlement(id: string, opts: Opts = {}): Promise<ApiResult<{ settlement: SettlementResult }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/verify-settlement`, { ...opts, method: "POST", body: {} });
}

export type ProgressPhase =
  | "waiting-approval"
  | "on-its-way"
  | "checking"
  | "finishing"
  | "delivered"
  | "attention"
  | "cancelled";

/**
 * Map the authoritative backend status onto customer progress.
 * `receiptReady` must be true (immutable receipt loaded) for "delivered":
 * invoice submission, funding, claim attempts and broadcasts are never
 * shown as success. Unknown outcomes stay "checking".
 */
export function progressForStatus(status: string, opts: { receiptReady?: boolean } = {}): ProgressPhase {
  switch (status) {
    case "AWAITING_NIM_APPROVAL":
      return "waiting-approval";
    case "LIGHTNING_HANDOFF":
      return "on-its-way";
    case "OUTCOME_UNKNOWN":
    case "RECONCILING":
      return "checking";
    case "CLIENT_FUNDED":
    case "SERVER_FUNDED":
      return "on-its-way";
    case "CLAIMING":
      return "finishing";
    case "DELIVERED":
      return opts.receiptReady === true ? "delivered" : "finishing";
    case "NEEDS_ATTENTION":
    case "FAILED":
      return "attention";
    case "USER_CANCELLED":
    case "QUOTE_EXPIRED":
      return "cancelled";
    default:
      return "attention";
  }
}

const PROGRESS_COPY: Record<ProgressPhase, { title: string; body: string }> = {
  "waiting-approval": {
    title: "Waiting for approval",
    body: "Nimiq Pay shows the exact amount before you confirm. Nothing has moved yet.",
  },
  "on-its-way": {
    title: "Payment on its way",
    body: "Your approval went through. Thence is moving it to their wallet now.",
  },
  checking: {
    title: "Checking your payment",
    body: "We can't confirm the outcome yet. Don't start another payment — it could pay them twice.",
  },
  finishing: {
    title: "Finishing delivery",
    body: "Almost there. We're confirming the payment arrived in their wallet.",
  },
  delivered: {
    title: "Delivered",
    body: "They received the exact amount. The receipt below is the proof.",
  },
  attention: {
    title: "Payment needs attention",
    body: "Something needs a closer look. Follow the next step before starting another payment.",
  },
  cancelled: {
    title: "Payment cancelled",
    body: "This payment was cancelled. Nothing moved.",
  },
};

export function progressCopy(phase: ProgressPhase): { title: string; body: string } {
  return PROGRESS_COPY[phase];
}

/** Settlement verdicts in plain language (verdicts only describe chain proof). */
export function verdictCopy(verdict: SettlementVerdict): string {
  switch (verdict) {
    case "VERIFIED":
      return "Delivery is confirmed on their network.";
    case "PENDING":
      return "The payment is still being confirmed. Check back shortly.";
    case "INSUFFICIENT_CONFIRMATIONS":
      return "The payment is visible but needs more confirmations first.";
    case "INCONCLUSIVE":
      return "We couldn't confirm delivery yet. Checking again is safe.";
    case "INVALID":
      return "The on-chain record doesn't match this payment. It needs attention.";
    case "UNAVAILABLE":
      return "The network check is temporarily unavailable. Try again shortly.";
  }
}
