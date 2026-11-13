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
import type { ClaimWindow } from "@/domain/claim-deadline";
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
  /** P2: Polygon claim deadline (ISO) — Satora evm_refund_locktime; null when unknown. */
  claimDeadlineAt?: string | null;
  /** P2: server window at read time. Clients recompute from claimDeadlineAt with their clock. */
  claimWindow?: ClaimWindow;
  identityMismatch?: boolean;
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
    /** P2: Polygon claim deadline (ISO); NOT the invoice expiry and NOT Nimiq Pay's NIM timeout. */
    claimDeadline?: string | null;
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

export interface ProviderEvidence {
  transferId: string;
  transferStatus: string;
  providerStatus: string;
  invoiceExpired: boolean;
  invoiceExpiresAt: string | null;
  sourceSats: string;
  targetAtomic: string;
  identityMatch: boolean;
  hasEvmFundingTx: boolean;
  hasEvmClaimTx: boolean;
  observedAt: string;
}

export type ProviderEvidenceDisposition = "FUNDING_DETECTED" | "SETTLEMENT_DETECTED" | "REFUNDED" | "EXPIRED_UNFUNDED" | "UNKNOWN";

const FUNDING_STATUSES = new Set(["clientfunded", "serverfunded", "clientredeeming", "clientredeemed", "serverredeemed"]);
const SETTLEMENT_STATUSES = new Set(["clientredeemed", "serverredeemed"]);

/**
 * Satora's terminal `expired` status means the Lightning swap expired
 * without funding; it is distinct from invoice expiry, which is only a clock
 * fact. Keep the identity and transaction checks ahead of that classification
 * so contradictory evidence never becomes a close affordance.
 */
export function providerEvidenceDisposition(evidence: ProviderEvidence | null): ProviderEvidenceDisposition {
  if (!evidence || !evidence.identityMatch) return "UNKNOWN";
  if (evidence.providerStatus === "clientrefunded" || evidence.providerStatus === "clientfundedserverrefunded" || evidence.providerStatus === "clientrefundedserverfunded" || evidence.providerStatus === "clientrefundedserverrefunded" || evidence.providerStatus === "clientredeemedandclientrefunded") return "REFUNDED";
  if (evidence.hasEvmClaimTx || SETTLEMENT_STATUSES.has(evidence.providerStatus)) return "SETTLEMENT_DETECTED";
  if (evidence.hasEvmFundingTx || FUNDING_STATUSES.has(evidence.providerStatus)) return "FUNDING_DETECTED";
  if (evidence.providerStatus === "expired" && evidence.invoiceExpired) return "EXPIRED_UNFUNDED";
  return "UNKNOWN";
}

export function providerStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Pending",
    clientfundingseen: "Funding seen",
    clientfunded: "Client funded",
    serverfunded: "Server funded",
    clientredeeming: "Claim in progress",
    clientredeemed: "Claimed",
    serverredeemed: "Settled",
    clientrefunded: "Refunded",
    clientfundedserverrefunded: "Refunded after funding",
    clientrefundedserverfunded: "Refunded after funding",
    clientrefundedserverrefunded: "Refunded",
    clientredeemedandclientrefunded: "Refunded after claim attempt",
    expired: "Expired",
    unknown: "Unknown",
  };
  return labels[status] ?? "Unknown";
}

export function getProviderEvidence(id: string, opts: Opts = {}): Promise<ApiResult<{ evidence: ProviderEvidence }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/provider-evidence`, opts);
}

export function getReconciliation(id: string, opts: Opts = {}): Promise<ApiResult<ReconciliationView>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/reconciliation`, opts);
}

export function postReconcile(id: string, opts: Opts = {}): Promise<ApiResult<{ reconciliation: ReconciliationLatest & { advanced: boolean; advancedPath: TransferStatus[] } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/reconcile`, { ...opts, method: "POST", body: {} });
}

/**
 * Request owner retirement for a definitively unpaid payment (F8.12).
 * The server re-verifies the bound provider swap: pre-handoff payments are
 * trivially safe, while an authorized payment may close only on terminal
 * Satora `expired` evidence. Funded or uncertain payments stay open and must
 * reconcile instead. Never claims success — funded/claimed/delivered reports
 * are rejected server-side.
 */
export function postHandoffCancel(id: string, opts: Opts = {}): Promise<ApiResult<{ handoff: { transferId: string; status: TransferStatus; deduplicated: boolean } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/handoff-result`, { ...opts, method: "POST", body: { outcome: "cancelled" } });
}

/**
 * P4: owner request to close an expired, never-funded payment. The server
 * re-proves provider expiry/identity, local history, Nimiq-side records and
 * on-chain HTLC absence; any doubt keeps the payment open (plain-language
 * refusal in `message`). No body: the client cannot supply evidence.
 */
export function postCloseExpired(id: string, opts: Opts = {}): Promise<ApiResult<{ resolution: { transferId: string; status: TransferStatus; deduplicated: boolean } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/close-expired`, { ...opts, method: "POST", body: {} });
}

/**
 * R2: owner request to close a failed Lightning handoff after the server
 * proves on-chain that the locked NIM returned in full. No body: the client
 * cannot supply evidence; any doubt keeps the payment open.
 */
export function postCloseNimReturned(
  id: string,
  opts: Opts = {},
): Promise<ApiResult<{ resolution: { transferId: string; status: TransferStatus; deduplicated: boolean; nimReturn: { refundTxHash: string; returnedLuna: string; feeLuna: string } | null } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/close-nim-returned`, { ...opts, method: "POST", body: {} });
}

/** Statuses a failed Lightning handoff can sit in while its NIM is locked or returning. */
export const NIM_RETURN_CLOSABLE: ReadonlySet<string> = new Set(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]);

/** NIM amount from luna (1 NIM = 100,000 luna), exact, trailing zeros trimmed. */
export function nimFromLuna(luna: string): string | null {
  if (!/^\d+$/.test(luna)) return null;
  const v = BigInt(luna);
  const whole = v / 100_000n;
  const frac = (v % 100_000n).toString().padStart(5, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * R2 copy for EXPIRED_UNFUNDED closed with an on-chain-verified NIM return.
 * Shown ONLY when the server returns `nimReturn`; every other expired payment
 * keeps EXPIRED_UNFUNDED_BODY, which never claims a refund.
 */
export function expiredNimReturnedBody(nimReturn: { refundTxHash: string; returnedLuna: string; feeLuna: string }): string {
  const returned = nimFromLuna(nimReturn.returnedLuna);
  const fee = nimFromLuna(nimReturn.feeLuna);
  const amount = returned ? `${returned} NIM` : "the locked NIM";
  const feeNote = fee && fee !== "0" ? ` (a network fee of ${fee} NIM was paid from the locked amount)` : "";
  // Verified fact: an on-chain transfer to the authenticated Nimiq address.
  // Not claimed: that Nimiq Pay already shows it as spendable balance.
  return (
    `Nothing was delivered: the provider never received the Lightning payment. Thence verified on the Nimiq blockchain that ${amount} ` +
    `was returned to your Nimiq address${feeNote} in transaction ${nimReturn.refundTxHash.slice(0, 8)}…${nimReturn.refundTxHash.slice(-6)}. ` +
    "Nimiq Pay may take a while to show it in your balance; if it doesn't appear, contact Nimiq Pay support with this transaction."
  );
}

/** P3: server authorization of ONE explicit Finish-delivery attempt (see src/lib/claim-intent.ts). */
export interface ClaimIntentView {
  transferId: string;
  status: TransferStatus;
  satoraSwapId: string;
  paymentHash: string;
  destination: string;
  targetAmountAtomic: string;
  claimDeadline: string;
  leaseExpiresAt: string;
  fundingConfirmations: number | null;
  retry: boolean;
}

/** No body: the server re-derives and re-verifies everything itself. */
export function postClaimIntent(id: string, opts: Opts = {}): Promise<ApiResult<{ claim: ClaimIntentView }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/claim-intent`, { ...opts, method: "POST", body: {} });
}

/** No body is sent: the server derives the swap and claim tx itself. */
export function postVerifySettlement(id: string, opts: Opts = {}): Promise<ApiResult<{ settlement: SettlementResult }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/verify-settlement`, { ...opts, method: "POST", body: {} });
}

/**
 * P4 owner copy for EXPIRED_UNFUNDED. Deliberately silent about a NIM
 * refund: Thence cannot see Nimiq Pay's own swap, so it states only what was
 * independently verified (nothing reached the provider or Polygon) and where
 * the owner can check their NIM.
 */
export const EXPIRED_UNFUNDED_BODY =
  "This payment expired before any money reached the provider. Nothing was delivered and nothing is locked on Polygon for it. Thence can't see inside Nimiq Pay: if Nimiq Pay still shows NIM on hold for this payment, Nimiq Pay releases it back to you when its own timeout ends.";

/**
 * P5: a verified REFUNDED is the POLYGON side only — the provider's USDC lock
 * returned to the provider. It is never a NIM refund: Thence cannot observe
 * Nimiq Pay's NIM HTLC, so the two refunds are always described separately.
 */
export const REFUNDED_BODY =
  "Nothing reached their wallet. The USDC locked on Polygon for this payment went back to the provider, and Thence verified that on-chain. That is not a refund of your NIM. Thence can't see inside Nimiq Pay: if Nimiq Pay still shows NIM on hold for this payment, Nimiq Pay releases it back to you when its own timeout ends.";

const OWNER_CLAIM_PROVIDER = new Set(["serverfunded", "clientredeeming", "clientredeemed"]);

/**
 * P2: the payment is funded on Polygon and waiting for the OWNER's claim —
 * an action, never "on its way". True regardless of the deadline window so
 * the screen keeps explaining the deadline (closing / unsafe / passed)
 * instead of falling back to reassuring copy. Never true after an identity
 * mismatch, or once the provider reports anything other than funded.
 * Whether the finish control may render is decided separately
 * (server claimReady AND the client-clock window).
 */
export function needsOwnerClaim(s: {
  phase: string;
  transferStatus: string | null;
  providerStatus: string | null;
  claimReady: boolean;
  identityMismatch?: boolean;
}): boolean {
  if (s.identityMismatch === true) return false;
  if (s.phase !== "on-its-way" && s.phase !== "finishing") return false;
  if (s.claimReady) return true;
  return (s.transferStatus === "SERVER_FUNDED" || s.transferStatus === "CLAIMING") && OWNER_CLAIM_PROVIDER.has(s.providerStatus ?? "");
}

export type ProgressPhase =
  | "waiting-approval"
  | "on-its-way"
  | "checking"
  | "finishing"
  | "delivered"
  | "attention"
  | "cancelled"
  | "refunded"
  | "expired";

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
    case "REFUNDED":
      return "refunded";
    case "EXPIRED_UNFUNDED":
      return "expired";
    default:
      return "attention";
  }
}

const PROGRESS_COPY: Record<ProgressPhase, { title: string; body: string }> = {
  "waiting-approval": {
    title: "Waiting for approval",
    body: "No approval is recorded yet. Nimiq Pay shows the exact amount before you confirm.",
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
    body: "This payment was cancelled. The server confirmed no settlement.",
  },
  refunded: {
    title: "Not delivered — Polygon lock refunded",
    body: REFUNDED_BODY,
  },
  expired: {
    title: "Payment expired — not delivered",
    body: EXPIRED_UNFUNDED_BODY,
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
