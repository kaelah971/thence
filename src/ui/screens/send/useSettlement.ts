"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clearPending, fetchTransfer } from "@/ui/lib/prepare-flow";
import { TRANSFER_STATUSES, isTerminal, type TransferStatus } from "@/domain/transfers";
import {
  getReconciliation,
  postClaimIntent,
  postClaimReport,
  postVerifySettlement,
  progressCopy,
  progressForStatus,
  type ProgressPhase,
  type ReconciliationView,
  type SettlementVerdict,
} from "@/ui/lib/settlement-client";
import { evaluateClaimEligibility, isClaimFlagEnabled, isClaimWindowOpen, mayRetryClaim } from "@/ui/lib/claim-gate";
import { ACCEPTED_OUTPUT_TOLERANCE_BPS, claimActionAllowed, claimWindowAt } from "@/domain/claim-deadline";
import { loadBinding, type VaultLike } from "@/ui/lib/recovery-vault";
import { claimStoredSwap, readBackSwap, type ClaimOutcome } from "@/ui/lib/satora-browser";
import { classifyClaim, emptyEvidence, notSubmittedMessage, sanitizeClaimError, type ClaimClassification, type ClaimSubmission } from "@/ui/lib/claim-evidence";
import { aaPreflightMessage, arbitrumAaPreflight } from "@/ui/lib/arbitrum-aa";
import { settlementNetworkFor } from "@/ui/lib/network-copy";
import { previewClaimOutput, usdcDisplay } from "@/ui/lib/claim-output-preview";
import { canHaveReceipt, getReceipt, type ApiReceipt } from "@/ui/lib/transfers-api";
import { kickPaymentTracker, subscribePaymentTracker, type TrackerError, type TrackerSnapshot } from "@/ui/lib/payment-tracker";

export interface SettlementInput {
  transferId: string;
  ownerUserId: string;
  sessionValid: boolean;
  previewMode: boolean;
  /** Set only by an explicit owner click; tracking never authorizes a claim. */
  explicitClaimAuthorization?: boolean;
  /**
   * Output floor the payer explicitly accepted in the app (atomic USDC) for a
   * provider minimum inside the consent band (claim-deadline.ts). Absent =
   * only the automatic 99% floor is acceptable.
   */
  acceptedMinimumAtomic?: string;
}

export interface SettlementState {
  phase: ProgressPhase | "idle";
  transferId: string | null;
  transferStatus: string | null;
  statusLabel: string | null;
  providerStatus: string | null;
  claimReady: boolean;
  message: string;
  receipt: ApiReceipt | null;
  verifyVerdict: SettlementVerdict | null;
  /** P2: Polygon claim deadline (ms epoch) from the server; null when unknown. */
  claimDeadlineMs?: number | null;
  /** P2: the server's latest provider read diverged from the bound identity. */
  identityMismatch?: boolean;
  /** P3: outcome of the latest explicit Finish-delivery attempt (shown next to the action). */
  claimMessage?: string | null;
  /**
   * P3: this browser already submitted (or lost the outcome of) a claim that
   * verification has not cleared. The finish control must not be offered
   * again; the screen shows "confirming" instead.
   */
  claimPending?: boolean;
  /** f1ca0926: what the latest local claim attempt provably did (null = no local attempt). */
  claimSubmission?: ClaimSubmission | null;
  /** Provider minimum inside the consent band, awaiting the payer's explicit acceptance (null = none). */
  outputConsent?: { requestedAtomic: string; minimumOutAtomic: string } | null;
  /** Display-only Lightning-handoff facts (see HandoffInfo). */
  sourceVerifiedAtMs?: number | null;
  handoffAtMs?: number | null;
  invoiceExpiresAtMs?: number | null;
  invoiceExpired?: boolean;
  handoffStalled?: boolean;
}

/** P3: is a local claim attempt still awaiting verification (no second attempt yet)? */
export function claimPendingFor(record: ClaimRecord | null, claimReadyNow: boolean): boolean {
  if (!record) return false;
  const attempted = record.txHash !== null || record.submittedAt != null || record.unknownAt !== null;
  if (!attempted) return false;
  if (record.unknownAt !== null && record.txHash === null) {
    return !mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: record.verifyCompletedSinceClaim, claimReadyNow, knownClaimTxHash: false });
  }
  return true;
}

/**
 * P3: one claim attempt per transfer in this page, across every hook
 * instance (Send and Activity can both be mounted). Cross-tab and
 * cross-device duplicates are refused by the server claim lease.
 */
const claimsInFlight = new Set<string>();

/**
 * Display-only Lightning-handoff facts (2026-11-13 incident 6f44918d: the NIM
 * source was verified on-chain within a minute, yet the screen said
 * "Confirming your approval" while the provider never received the Lightning
 * payment). Never authority: state and exposure stay with the server.
 */
export interface HandoffInfo {
  sourceVerifiedAtMs: number | null;
  handoffAtMs: number | null;
  invoiceExpiresAtMs: number | null;
  invoiceExpired: boolean;
  /** R3: the server reports a stalled handoff (display only). */
  handoffStalled: boolean;
}
const EMPTY_HANDOFF_INFO: HandoffInfo = { sourceVerifiedAtMs: null, handoffAtMs: null, invoiceExpiresAtMs: null, invoiceExpired: false, handoffStalled: false };

export function handoffInfoFrom(view: Pick<ReconciliationView, "latest" | "swap">): HandoffInfo {
  return {
    sourceVerifiedAtMs: deadlineMsFrom(view.latest.sourceVerifiedAt),
    handoffAtMs: deadlineMsFrom(view.latest.handoffAt),
    invoiceExpiresAtMs: deadlineMsFrom(view.swap?.invoiceExpiresAt),
    invoiceExpired: view.latest.invoiceExpired === true,
    handoffStalled: view.latest.handoffStall?.stalled === true,
  };
}

/** P2: parse a server deadline; anything unparseable is unknown (fail closed). */
export function deadlineMsFrom(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Verify-after-claim rounds (tracking cadence lives in payment-tracker.ts). */
const MAX_VERIFY_ROUNDS = 4;
/** P3: wait this long after an unknown claim outcome before the verification round. */
export const UNKNOWN_CLAIM_VERIFY_DELAY_MS = 20_000;

/**
 * F9.1 — one tap is enough. The server refuses a claim with
 * FUNDING_NOT_CONFIRMED until the provider's Polygon funding has
 * CLAIM_FUNDING_MIN_CONFIRMATIONS (32, ~70 s). The Finish delivery control
 * appears as soon as the provider reports the funding, so an early tap used to
 * end in "try again in a minute" and repeated manual taps (first live public
 * payment, 2026-11-06: four refusals in 30 s). The same explicit tap now keeps
 * re-asking the server, ONLY for that code, on this cadence and within this
 * budget. A refused intent reveals nothing; every claim gate, the deadline
 * window and the server claim lease still apply on each attempt.
 */
export const FUNDING_RETRY_INTERVAL_MS = 8_000;
export const FUNDING_RETRY_BUDGET_MS = 4 * 60_000;
/**
 * Arbitrum: the server authorizes a claim only once the funding is covered by
 * the L1-finalized block (~20 min observed). Ask less often, for longer. The
 * server's DEADLINE_TOO_CLOSE refusal (not retried) still ends the wait before
 * the unsafe window, so this budget is only an upper bound.
 */
export const FUNDING_RETRY_L1_INTERVAL_MS = 30_000;
export const FUNDING_RETRY_L1_BUDGET_MS = 45 * 60_000;
export const FUNDING_NOT_CONFIRMED = "FUNDING_NOT_CONFIRMED";
/** Refusals that change nothing server-side and may clear on the next read. */
export const TRANSIENT_WAIT_CODES: ReadonlySet<string> = new Set(["PROVIDER_UNAVAILABLE", "CHAIN_UNAVAILABLE", "RATE_LIMITED", "AA_UNREACHABLE"]);

export type FundingRetryDecision = { retry: true; delayMs: number } | { retry: false };

/** Retry cadence and budget for the funding wait the server reported. */
export function fundingRetryPolicy(finality: string | null | undefined): { intervalMs: number; budgetMs: number } {
  return finality === "l1"
    ? { intervalMs: FUNDING_RETRY_L1_INTERVAL_MS, budgetMs: FUNDING_RETRY_L1_BUDGET_MS }
    : { intervalMs: FUNDING_RETRY_INTERVAL_MS, budgetMs: FUNDING_RETRY_BUDGET_MS };
}

/**
 * Pure retry rule. Retry only the funding-confirmation refusal, only within
 * the budget measured from the user's tap, and never after the screen stopped
 * tracking. Every other outcome (network failure, rate limit, deadline,
 * mismatch, success) ends the attempt exactly as before.
 */
export function nextFundingRetry(input: { code: string | null | undefined; startedAtMs: number; nowMs: number; active: boolean; finality?: string | null; waitingForFunding?: boolean }): FundingRetryDecision {
  if (!input.active) return { retry: false };
  // f1ca0926: one transient provider/chain read failure ended a 20-minute
  // finality wait and left an error on screen while nothing retried. Once a
  // funding wait is under way, transient refusals (nothing authorized,
  // nothing revealed) keep the same wait alive within the same budget.
  const transient = input.waitingForFunding === true && TRANSIENT_WAIT_CODES.has(input.code ?? "");
  if (input.code !== FUNDING_NOT_CONFIRMED && !transient) return { retry: false };
  const { intervalMs, budgetMs } = fundingRetryPolicy(input.finality);
  if (input.nowMs + intervalMs - input.startedAtMs > budgetMs) return { retry: false };
  return { retry: true, delayMs: intervalMs };
}

/** Progress copy while the tap waits for the funding to settle. */
export function fundingWaitMessage(confirmations: number | null, required: number | null, finality?: string | null): string {
  if (finality === "l1") {
    return "Securing the payment on Arbitrum — waiting for Ethereum finality, usually about 20 minutes. Thence finishes delivery automatically — keep this screen open.";
  }
  const progress =
    typeof confirmations === "number" && typeof required === "number" && required > 0
      ? ` (${Math.min(confirmations, required)} of ${required} confirmations)`
      : "";
  return `Securing the payment on Polygon${progress}. Thence finishes delivery automatically — keep this screen open.`;
}

/** The server's funding-wait kind ("l1" for Arbitrum), or null. */
export function fundingFinalityFrom(details: Record<string, string> | null | undefined): "l1" | null {
  return details?.["finality"] === "l1" ? "l1" : null;
}

/**
 * Wait `ms`, then keep waiting while the page is hidden (no claim attempt from
 * a backgrounded webview), until it is visible again, the screen stops
 * tracking, or the retry budget ends.
 */
export async function waitVisible(
  ms: number,
  active: () => boolean,
  deadlineMs: number,
  deps: { sleep?: (ms: number) => Promise<void>; hidden?: () => boolean; now?: () => number } = {},
): Promise<void> {
  const sleep = deps.sleep ?? ((t: number) => new Promise<void>((resolve) => setTimeout(resolve, t)));
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.hidden === true);
  const now = deps.now ?? Date.now;
  await sleep(ms);
  while (active() && hidden() && now() < deadlineMs) await sleep(1_000);
}

function confirmationsFrom(details: Record<string, string> | null | undefined): { confirmations: number | null; required: number | null } {
  const n = (v: string | undefined) => (v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : null);
  return { confirmations: n(details?.["confirmations"]), required: n(details?.["required"]) };
}

interface ClaimRecord {
  transferId: string;
  ownerUserId: string;
  satoraSwapId: string;
  txHash: string | null;
  /** Set after the SDK reports a successful claim, even when it returns no tx id. */
  submittedAt?: string | null;
  unknownAt: string | null;
  verifyCompletedSinceClaim: boolean;
  /** f1ca0926: the attempt provably sent nothing (no submission request, or an explicit refusal). */
  notSubmittedAt?: string | null;
  /** Secret-free outcome code of the latest attempt (claim-evidence.ts). */
  outcomeCode?: string | null;
  /** ERC-4337 UserOperation hash when the bundler accepted the claim. */
  userOpHash?: string | null;
}

/** f1ca0926: what the latest local attempt provably did, or null when none. */
export function claimSubmissionOf(record: ClaimRecord | null): ClaimSubmission | null {
  if (!record) return null;
  if (record.txHash !== null || record.submittedAt != null) return "submitted";
  if (record.unknownAt !== null) return "unknown";
  if (record.notSubmittedAt != null) return "not-submitted";
  return null;
}

const CLAIM_KEY = "thence.f4.3.claim.v1";

function claimStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type { ClaimRecord };
export function loadClaimRecord(transferId: string, ownerUserId: string): ClaimRecord | null {
  try {
    const raw = claimStore()?.getItem(`${CLAIM_KEY}:${transferId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>;
    if (parsed.transferId !== transferId || parsed.ownerUserId !== ownerUserId || typeof parsed.satoraSwapId !== "string") return null;
    return {
      transferId,
      ownerUserId,
      satoraSwapId: parsed.satoraSwapId,
      txHash: typeof parsed.txHash === "string" ? parsed.txHash : null,
      submittedAt: typeof parsed.submittedAt === "string" ? parsed.submittedAt : null,
      unknownAt: typeof parsed.unknownAt === "string" ? parsed.unknownAt : null,
      verifyCompletedSinceClaim: parsed.verifyCompletedSinceClaim === true,
      notSubmittedAt: typeof parsed.notSubmittedAt === "string" ? parsed.notSubmittedAt : null,
      outcomeCode: typeof parsed.outcomeCode === "string" ? parsed.outcomeCode.slice(0, 40) : null,
      userOpHash: typeof parsed.userOpHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed.userOpHash) ? parsed.userOpHash : null,
    };
  } catch {
    return null;
  }
}

export function saveClaimRecord(record: ClaimRecord): boolean {
  try {
    const store = claimStore();
    if (!store) return false;
    const key = `${CLAIM_KEY}:${record.transferId}`;
    const serialized = JSON.stringify(record);
    store.setItem(key, serialized);
    return store.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function clearClaimRecord(transferId: string, ownerUserId: string): void {
  try {
    const raw = claimStore()?.getItem(`${CLAIM_KEY}:${transferId}`);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>;
    if (parsed.ownerUserId === ownerUserId) claimStore()?.removeItem(`${CLAIM_KEY}:${transferId}`);
  } catch {
    /* best-effort */
  }
}

function vaultForTests(): VaultLike | null {
  return (globalThis as unknown as { __thenceVault?: VaultLike }).__thenceVault ?? null;
}

async function loadVaultBinding(transferId: string, ownerUserId: string) {
  const injected = vaultForTests();
  if (injected) {
    if (!injected.available) return { status: "unavailable" } as const;
    return injected.load(transferId, ownerUserId);
  }
  const { loadBinding } = await import("@/ui/lib/recovery-vault");
  return loadBinding(transferId, ownerUserId);
}

const copyFor = (phase: ProgressPhase): { title: string; body: string } => progressCopy(phase);

function refreshFailureMessage(error: TrackerError): string {
  return error.kind === "rate-limited"
    ? "Too many tries at once. Checking again shortly — do not resend."
    : "The network check is temporarily unavailable. Checking again shortly — do not resend.";
}

/**
 * P1: settlement view of ONE shared lifecycle driver (src/ui/lib/payment-tracker.ts).
 * This hook no longer schedules provider refreshes itself; it subscribes to
 * the per-(owner, transfer) tracker and maps its snapshots to customer
 * state. The explicit claim path and its gates are unchanged.
 */
export function useSettlement(): {
  state: SettlementState;
  track: (input: SettlementInput) => Promise<void>;
  stop: () => void;
  attemptClaim: (input: SettlementInput) => Promise<{ ok: boolean; reason: string }>;
  checkAgain: (input: SettlementInput) => Promise<void>;
} {
  const [state, setState] = useState<SettlementState>({
    phase: "idle",
    transferId: null,
    transferStatus: null,
    statusLabel: null,
    providerStatus: null,
    claimReady: false,
    message: "",
    receipt: null,
    verifyVerdict: null,
  });
  const [claimInfo, setClaimInfo] = useState<{ claimDeadlineMs: number | null; identityMismatch: boolean }>({ claimDeadlineMs: null, identityMismatch: false });
  const [handoffInfo, setHandoffInfo] = useState<HandoffInfo>(EMPTY_HANDOFF_INFO);
  const runId = useRef(0);
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const unsubscribe = useRef<(() => void) | null>(null);
  const tracked = useRef<{ transferId: string; ownerUserId: string } | null>(null);
  const receiptFor = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const stop = useCallback(() => {
    runId.current += 1;
    clearTimers();
    unsubscribe.current?.();
    unsubscribe.current = null;
    tracked.current = null;
  }, [clearTimers]);

  useEffect(() => stop, [stop]);

  /** Verify-after-claim rounds only (bounded); tracking itself is the shared driver. */
  const later = useCallback((ms: number, fn: () => void, id: number) => {
    timers.current.push(
      setTimeout(() => {
        if (runId.current === id) void fn();
      }, ms),
    );
  }, []);

  const applySnapshot = useCallback(async (input: SettlementInput, snapshot: TrackerSnapshot, id: number): Promise<void> => {
    if (runId.current !== id) return;
    const unauthorized = snapshot.readError?.kind === "unauthorized" || snapshot.refreshError?.kind === "unauthorized";
    if (unauthorized) {
      setState((s) => ({ ...s, phase: "attention", transferId: input.transferId, claimReady: false, message: "Your session has ended. Sign in again." }));
      return;
    }
    const view = snapshot.view;
    if (!view) {
      setState((s) => ({
        ...s,
        phase: "checking",
        transferId: input.transferId,
        claimReady: false,
        message: snapshot.readError ? refreshFailureMessage(snapshot.readError) : "Checking your payment — do not resend.",
      }));
      return;
    }
    setClaimInfo({
      claimDeadlineMs: deadlineMsFrom(view.latest.claimDeadlineAt ?? view.swap?.claimDeadline),
      identityMismatch: view.latest.identityMismatch === true,
    });
    setHandoffInfo(handoffInfoFrom(view));
    const status = view.transfer.status;
    const statusLabel = view.transfer.statusLabel ?? null;
    const providerStatus = view.latest.providerStatus;
    // P3: DELIVERED (server proof committed) takes the receipt branch below.
    // progressForStatus maps it to "finishing" until a receipt is loaded, so
    // without this a payment delivered while only tracking (Activity, reload,
    // server cron) never showed its receipt.
    const phase: ProgressPhase = status === "DELIVERED" || status === "DELIVERED_SHORT" ? "delivered" : progressForStatus(status);
    // Display only: the tracker's latest on-chain verdict (e.g. waiting for
    // confirmations) lets the screen say WHY delivery isn't final yet. It
    // never moves the payment — DELIVERED still needs the server's proof.
    const base = { transferId: input.transferId, transferStatus: status as string, statusLabel, providerStatus, receipt: null, verifyVerdict: snapshot.settlementVerdict };
    if (phase === "cancelled") {
      setState({ ...base, phase: "cancelled", claimReady: false, message: copyFor("cancelled").body });
      clearPending(input.ownerUserId, input.transferId);
      return;
    }
    if (phase === "refunded" || phase === "expired") {
      setState({ ...base, phase, claimReady: false, message: copyFor(phase).body });
      clearClaimRecord(input.transferId, input.ownerUserId);
      clearPending(input.ownerUserId, input.transferId);
      return;
    }
    if (phase === "attention") {
      setState({ ...base, phase: "attention", claimReady: view.latest.claimReady, message: statusLabel ? `${statusLabel}. Follow the next step before starting another payment.` : copyFor("attention").body });
      if ((TRANSFER_STATUSES as readonly string[]).includes(status) && isTerminal(status as TransferStatus)) {
        clearPending(input.ownerUserId, input.transferId);
      }
      return;
    }
    if (phase === "delivered") {
      // Receipts load ONLY for backend-confirmed DELIVERED transfers (once).
      if (receiptFor.current === input.transferId) return;
      const receiptRes = await getReceipt(input.transferId);
      if (runId.current !== id) return;
      if (receiptRes.ok) {
        receiptFor.current = input.transferId;
        setState({ ...base, phase: "delivered", claimReady: false, message: copyFor("delivered").body, receipt: receiptRes.data.receipt, verifyVerdict: status === "DELIVERED_SHORT" ? "VERIFIED_SHORT" : "VERIFIED" });
        clearClaimRecord(input.transferId, input.ownerUserId);
        clearPending(input.ownerUserId, input.transferId);
        return;
      }
      setState({ ...base, phase: "finishing", claimReady: false, message: "The receipt is still being put together. Check back shortly." });
      return;
    }
    // P7: on-chain evidence that contradicts this payment is never "confirming".
    if (snapshot.settlementVerdict === "INVALID" && (status === "CLAIMING" || status === "SERVER_FUNDED")) {
      const localClaim = loadClaimRecord(input.transferId, input.ownerUserId);
      const claimPending = claimPendingFor(localClaim, view.latest.claimReady);
      const claimSubmission = claimSubmissionOf(localClaim);
      setState({
        ...base,
        phase: "attention",
        claimReady: false,
        claimPending,
        claimSubmission,
        verifyVerdict: "INVALID",
        message: "The on-chain record doesn't match this payment (token, wallet or amount). It is NOT delivered and needs attention — don't pay again.",
      });
      return;
    }
    const copy = copyFor(phase);
    const message = snapshot.refreshError && snapshot.refreshError.kind !== "conflict"
      ? refreshFailureMessage(snapshot.refreshError)
      : view.latest.ambiguous
        ? "Checking your payment — do not resend."
        : copy.body;
    const localClaim = loadClaimRecord(input.transferId, input.ownerUserId);
    const claimPending = claimPendingFor(localClaim, view.latest.claimReady);
    const claimSubmission = claimSubmissionOf(localClaim);
    setState({ ...base, phase, claimReady: view.latest.claimReady, message, claimPending, claimSubmission });
  }, []);

  const track = useCallback(
    async (input: SettlementInput) => {
      if (!input.transferId || !input.ownerUserId) {
        setState((s) => ({ ...s, phase: "attention", transferId: input.transferId || null, message: "This payment isn't ready yet." }));
        return;
      }
      const same = tracked.current?.transferId === input.transferId && tracked.current.ownerUserId === input.ownerUserId;
      if (same && unsubscribe.current) {
        kickPaymentTracker(input.transferId);
        return;
      }
      stop();
      const id = ++runId.current;
      tracked.current = { transferId: input.transferId, ownerUserId: input.ownerUserId };
      receiptFor.current = null;
      unsubscribe.current = subscribePaymentTracker(input.transferId, input.ownerUserId, (snapshot) => {
        void applySnapshot(input, snapshot, id);
      });
    },
    [applySnapshot, stop],
  );

  const runVerifyLoopRef = useRef<((input: SettlementInput, round: number) => Promise<void>) | null>(null);

  /** Manual "Check again": wake the shared driver now (coalesced, rate-safe). */
  const checkAgain = useCallback(
    async (input: SettlementInput) => {
      await track(input);
    },
    [track],
  );

  const attemptClaimOnce = useCallback(
    async (input: SettlementInput): Promise<{ ok: boolean; reason: string; code?: string | null; details?: Record<string, string> | null }> => {
      if (claimsInFlight.has(input.transferId)) return { ok: false, reason: "A delivery attempt is already in progress. Check payment status — do not try again." };
      claimsInFlight.add(input.transferId);
      try {
      const view = await getReconciliation(input.transferId);
      if (!view.ok) return { ok: false, reason: "Checking your payment — do not resend." };
      const swap = view.data.swap;
      const transfer = view.data.transfer;
      if (!swap) return { ok: false, reason: "There's nothing to finish yet." };
      const vault = await loadVaultBinding(input.transferId, input.ownerUserId);
      const vaultMatched =
        vault.status === "ok" &&
        vault.binding.transferId === input.transferId &&
        vault.binding.ownerUserId === input.ownerUserId &&
        vault.binding.satoraSwapId === swap.satoraSwapId &&
        vault.binding.attemptToken.length > 0;
      const readback = vaultMatched ? await readBackSwap(swap.satoraSwapId) : { ok: false as const, hasRecoveryMaterial: false as const, paymentHash: null, evmRefundLocktime: null };
      const readbackIdentityMatched =
        readback.ok &&
        readback.hasRecoveryMaterial &&
        typeof readback.paymentHash === "string" &&
        readback.paymentHash.toLowerCase() === swap.paymentHash.toLowerCase();
      // P2: the server-verified deadline must be known, still allow a claim,
      // and equal the locktime the SDK reads back (identity cross-check).
      const serverDeadlineMs = deadlineMsFrom(swap.claimDeadline ?? view.data.latest.claimDeadlineAt);
      const serverWindowOk = claimActionAllowed(claimWindowAt(serverDeadlineMs, Date.now()));
      const deadlinesAgree =
        serverDeadlineMs !== null && typeof readback.evmRefundLocktime === "number" && readback.evmRefundLocktime * 1000 === serverDeadlineMs;
      const record = loadClaimRecord(input.transferId, input.ownerUserId);
      const claimRetryAllowed = record !== null && record.unknownAt !== null
        ? mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: record.verifyCompletedSinceClaim, claimReadyNow: view.data.latest.claimReady, knownClaimTxHash: record.txHash !== null })
        : false;
      const claimAlreadySubmitted = record !== null && (record.txHash !== null || record.submittedAt != null) && !claimRetryAllowed;
      const gate = evaluateClaimEligibility({
        flagEnabled: isClaimFlagEnabled(),
        explicitAuthorization: input.explicitClaimAuthorization === true,
        sessionValid: input.sessionValid,
        timelockSafe: readbackIdentityMatched && isClaimWindowOpen(readback.evmRefundLocktime) && serverWindowOk && deadlinesAgree,
        claimAlreadySubmitted,
        transferStatus: transfer.status,
        providerStatus: view.data.latest.providerStatus,
        vaultMatched,
        readbackOk: readbackIdentityMatched,
        networkMatch: vault.status === "ok" ? vault.binding.routeId === transfer.routeId : false,
        destinationMatch:
          vault.status === "ok"
            ? vault.binding.destination.toLowerCase() === transfer.destination.toLowerCase() &&
              vault.binding.targetAtomic === transfer.targetAmountAtomic
            : false,
        earlierClaimUnknown: record !== null && record.unknownAt !== null && !claimRetryAllowed,
        previewMode: input.previewMode,
      });
      if (!gate.allowed) {
        const reason = gate.reasons[0] ?? "Finishing delivery is paused in this preview. Check Activity for the latest status \u2014 don\u2019t try again yet.";
        setState((s) => ({ ...s, message: reason }));
        return { ok: false, reason };
      }
      const network = settlementNetworkFor(transfer.routeId);
      // f1ca0926: on Arbitrum the claim is a sponsored UserOperation. Check the
      // bundler, EntryPoint and sponsorship (non-financial, nothing revealed)
      // BEFORE taking the server's claim lease, so an unreachable service
      // never consumes the claim window.
      if (network === "Arbitrum") {
        const aa = await arbitrumAaPreflight();
        if (!aa.ok) {
          return { ok: false, reason: aaPreflightMessage(aa.code), code: aa.code };
        }
      }
      // Output floor (claim-deadline.ts): previewed BEFORE the server claim
      // lease, from the same public provider endpoint the SDK will use.
      const preview = await previewClaimOutput({ satoraSwapId: swap.satoraSwapId, requestedAtomic: transfer.targetAmountAtomic, destination: transfer.destination });
      if (preview.ok) {
        const p = preview.preview;
        if (p.decision === "refuse") {
          const message = `The provider would deliver at most ${usdcDisplay(p.minimumOutAtomic)} USDC of the ${usdcDisplay(p.requestedAtomic)} requested — more than 3% short, so delivery was not started. Nothing was sent. If it can't be finished, the provider refunds and your NIM can be reclaimed.`;
          setState((s) => ({ ...s, outputConsent: null }));
          return { ok: false, reason: message, code: "OUTPUT_TOO_LOW" };
        }
        const accepted = input.acceptedMinimumAtomic && /^[0-9]+$/.test(input.acceptedMinimumAtomic) ? BigInt(input.acceptedMinimumAtomic) : null;
        if (p.decision === "consent" && (accepted === null || BigInt(p.minimumOutAtomic) < accepted - (BigInt(p.requestedAtomic) * ACCEPTED_OUTPUT_TOLERANCE_BPS) / 10_000n)) {
          setState((s) => ({ ...s, outputConsent: { requestedAtomic: p.requestedAtomic, minimumOutAtomic: p.minimumOutAtomic } }));
          return { ok: false, reason: `The recipient would receive at least ${usdcDisplay(p.minimumOutAtomic)} USDC instead of ${usdcDisplay(p.requestedAtomic)}. Confirm below to finish delivery.`, code: "OUTPUT_NEEDS_CONSENT" };
        }
        setState((s) => ({ ...s, outputConsent: null }));
      }
      // P3: the server re-verifies everything immediately before the claim
      // (fresh provider read, the on-chain HTLC lock and deadline, the unsafe
      // window, no claim/refund yet) and takes the per-transfer claim lease.
      const intent = await postClaimIntent(input.transferId);
      if (!intent.ok) {
        const reason = intent.message
          ? intent.message
          : intent.kind === "rate-limited"
            ? "Too many tries at once. Wait a moment — do not resend."
            : "We couldn't confirm it's safe to finish right now. Check again shortly — don't resend.";
        kickPaymentTracker(input.transferId);
        return { ok: false, reason, code: intent.code, details: intent.details ?? null };
      }
      const authorized = intent.data.claim;
      // The server's answer must describe exactly the swap this browser holds
      // the recovery material for — otherwise nothing is revealed.
      const sameSwap =
        vault.status === "ok" &&
        readback.ok &&
        typeof readback.paymentHash === "string" &&
        typeof readback.evmRefundLocktime === "number" &&
        authorized.transferId === input.transferId &&
        authorized.satoraSwapId === swap.satoraSwapId &&
        authorized.paymentHash.toLowerCase() === readback.paymentHash.toLowerCase() &&
        Date.parse(authorized.claimDeadline) === readback.evmRefundLocktime * 1000 &&
        authorized.destination.toLowerCase() === vault.binding.destination.toLowerCase() &&
        authorized.targetAmountAtomic === vault.binding.targetAtomic;
      if (!sameSwap) return { ok: false, reason: "Recovery information doesn't match this payment. Do not continue." };
      if (!isClaimWindowOpen(readback.evmRefundLocktime)) {
        return { ok: false, reason: "The delivery deadline is too close or unavailable. Check Activity for the latest status — don’t try again yet." };
      }
      kickPaymentTracker(input.transferId);
      let outcome: ClaimOutcome;
      if (!saveClaimRecord({ transferId: input.transferId, ownerUserId: input.ownerUserId, satoraSwapId: swap.satoraSwapId, txHash: null, unknownAt: new Date().toISOString(), verifyCompletedSinceClaim: false })) {
        return { ok: false, reason: "This device cannot save a claim safety record. No delivery attempt was started." };
      }
      try {
        outcome = await claimStoredSwap(swap.satoraSwapId, authorized, input.acceptedMinimumAtomic && /^[0-9]+$/.test(input.acceptedMinimumAtomic) ? BigInt(input.acceptedMinimumAtomic) : null);
      } catch (error) {
        // claimStoredSwap classifies every SDK outcome itself and never
        // throws. A throw here has no network evidence at all, so it cannot
        // prove nothing was sent: treat it as UNKNOWN (verify, never resend).
        outcome = {
          success: false,
          txHash: null,
          message: "The delivery outcome couldn't be determined.",
          classification: { submission: "unknown", code: "SDK_ERROR", disclosedToInfrastructure: false, userOpHash: null, txHash: null },
          errorText: sanitizeClaimError(error) || null,
        };
      }
      // Defensive: an outcome without evidence (older client shape) is
      // submitted only when the SDK itself reported success.
      const c: ClaimClassification = outcome.classification ?? (outcome.success
        ? classifyClaim({ evidence: emptyEvidence(), sdkSuccess: true, sdkTxHash: outcome.txHash })
        : { submission: "unknown", code: "SDK_ERROR", disclosedToInfrastructure: false, userOpHash: null, txHash: null });
      // f1ca0926: report what was ACTUALLY sent (codes and public hashes only).
      void postClaimReport(input.transferId, {
        submission: c.submission,
        code: c.code,
        disclosedToInfrastructure: c.disclosedToInfrastructure,
        userOpHash: c.userOpHash,
        txHash: c.txHash ?? outcome.txHash,
        errorText: outcome.errorText ?? null,
        stage: c.stage ?? null,
        failure: c.failure ?? null,
      });
      const base = { transferId: input.transferId, ownerUserId: input.ownerUserId, satoraSwapId: swap.satoraSwapId, verifyCompletedSinceClaim: false, outcomeCode: c.code, userOpHash: c.userOpHash };
      if (c.submission === "not-submitted") {
        // Nothing reached the chain: say so, never "submitted". A later
        // attempt is still gated by the server (claim lease, unspent lock,
        // deadline window).
        saveClaimRecord({ ...base, txHash: null, unknownAt: null, notSubmittedAt: new Date().toISOString() });
        const message = notSubmittedMessage(c.code, network, c.disclosedToInfrastructure);
        setState((s) => ({ ...s, phase: "attention", message }));
        return { ok: false, reason: message, code: `CLAIM_NOT_SUBMITTED:${c.code}` };
      }
      if (c.submission === "unknown") {
        saveClaimRecord({ ...base, txHash: null, unknownAt: new Date().toISOString() });
        setState((s) => ({ ...s, phase: "checking", message: `The delivery was sent to ${network} but no answer came back. Checking payment — do not resend.` }));
        // P3: an unknown outcome is resolved by verification, never by a blind
        // retry. One verify round (after the claim had time to land) records
        // whether a claim reached the chain; only then may mayRetryClaim allow
        // a second attempt — and the server claim lease still refuses one
        // while the first could be in flight.
        later(UNKNOWN_CLAIM_VERIFY_DELAY_MS, () => void runVerifyLoopRef.current?.(input, 0), runId.current);
        return { ok: false, reason: "The delivery attempt couldn't be confirmed. Checking payment — do not resend." };
      }
      // Submission evidence exists (UserOperation hash, relay acceptance or SDK success).
      saveClaimRecord({ ...base, txHash: c.txHash ?? outcome.txHash, submittedAt: new Date().toISOString(), unknownAt: null });
      if (c.code === "USEROP_REVERTED") {
        setState((s) => ({ ...s, phase: "checking", message: `The delivery reached ${network} but reverted. Checking payment — do not resend.` }));
        later(UNKNOWN_CLAIM_VERIFY_DELAY_MS, () => void runVerifyLoopRef.current?.(input, 0), runId.current);
        return { ok: false, reason: `The delivery reached ${network} but reverted. Checking payment — do not resend.` };
      }
      await runVerifyLoopRef.current?.(input, 0);
      return { ok: true, reason: "Delivery submitted. Confirming it arrived." };
      } finally {
        claimsInFlight.delete(input.transferId);
      }
    },
    [later],
  );

  const attemptClaim = useCallback(
    async (input: SettlementInput): Promise<{ ok: boolean; reason: string }> => {
      setClaimMessage(null);
      // F9.1: the one explicit tap keeps waiting for the funding confirmations
      // (FUNDING_NOT_CONFIRMED, plus transient refusals once that wait has
      // started; see nextFundingRetry).
      const id = runId.current;
      const startedAtMs = Date.now();
      let waiting = false;
      let lastFinality: "l1" | null = null;
      let result = await attemptClaimOnce(input);
      for (;;) {
        const transient = TRANSIENT_WAIT_CODES.has(result.code ?? "");
        // A transient refusal carries no finality details: keep the wait's own.
        const finality: "l1" | null = transient ? lastFinality : fundingFinalityFrom(result.details);
        const decision = nextFundingRetry({ code: result.code, startedAtMs, nowMs: Date.now(), active: runId.current === id, finality, waitingForFunding: waiting });
        if (!decision.retry) break;
        if (result.code === FUNDING_NOT_CONFIRMED) {
          waiting = true;
          lastFinality = finality;
        }
        const { confirmations, required } = confirmationsFrom(result.details);
        setClaimMessage(
          transient
            ? `${fundingWaitMessage(null, null, finality)} (The last check couldn't reach the provider; still waiting.)`
            : fundingWaitMessage(confirmations, required, finality),
        );
        await waitVisible(decision.delayMs, () => runId.current === id, startedAtMs + fundingRetryPolicy(finality).budgetMs);
        if (runId.current !== id) break;
        result = await attemptClaimOnce(input);
      }
      setClaimMessage(result.reason);
      const record = loadClaimRecord(input.transferId, input.ownerUserId);
      setState((st) => ({ ...st, claimPending: claimPendingFor(record, st.claimReady), claimSubmission: claimSubmissionOf(record) }));
      return result;
    },
    [attemptClaimOnce],
  );

  const runVerifyLoop = useCallback(
    async (input: SettlementInput, verifyRound: number): Promise<void> => {
      const id = runId.current;
      const verified = await postVerifySettlement(input.transferId);
      if (runId.current !== id) return;
      if (!verified.ok) {
        setState((s) => ({ ...s, phase: "checking", message: "Checking your payment — do not resend." }));
        return;
      }
      const settlement = verified.data.settlement;
      const record = loadClaimRecord(input.transferId, input.ownerUserId);
      if (record) saveClaimRecord({ ...record, verifyCompletedSinceClaim: true });
      switch (settlement.verdict) {
        case "VERIFIED": {
          const transferRes = await fetchTransfer(input.transferId);
          if (runId.current !== id) return;
          if (transferRes.ok && canHaveReceipt(transferRes.data.transfer.status as never)) {
            const receiptRes = await getReceipt(input.transferId);
            if (runId.current !== id) return;
            if (receiptRes.ok) {
              setState({
                phase: "delivered",
                transferId: input.transferId,
                transferStatus: transferRes.data.transfer.status,
                statusLabel: transferRes.data.transfer.statusLabel,
                providerStatus: settlement.providerStatus,
                claimReady: false,
                message: copyFor("delivered").body,
                receipt: receiptRes.data.receipt,
                verifyVerdict: settlement.verdict,
              });
              clearClaimRecord(input.transferId, input.ownerUserId);
              return;
            }
          }
          setState((s) => ({ ...s, phase: "finishing", verifyVerdict: settlement.verdict, message: "Finishing delivery. Confirming the payment arrived." }));
          return;
        }
        case "PENDING":
        case "INSUFFICIENT_CONFIRMATIONS":
          setState((s) => ({ ...s, phase: "finishing", verifyVerdict: settlement.verdict, message: settlement.verdict === "PENDING" ? "The payment is still being confirmed. Check back shortly." : "The payment is visible but needs more confirmations first." }));
          if (verifyRound + 1 < MAX_VERIFY_ROUNDS) {
            later(12000, () => void runVerifyLoopRef.current?.(input, verifyRound + 1), id);
          }
          return;
        case "INCONCLUSIVE":
        case "UNAVAILABLE":
          setState((s) => ({ ...s, phase: "checking", verifyVerdict: settlement.verdict, message: "We couldn't confirm delivery yet. Checking again is safe — do not resend." }));
          return;
        case "INVALID":
          setState((s) => ({ ...s, phase: "attention", verifyVerdict: settlement.verdict, message: "The on-chain record doesn't match this payment. It needs attention." }));
          return;
      }
    },
    [later],
  );

  useEffect(() => {
    runVerifyLoopRef.current = runVerifyLoop;
  }, [runVerifyLoop]);

  return { state: { ...state, ...claimInfo, ...handoffInfo, claimMessage }, track, stop, attemptClaim, checkAgain };
}
