"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clearPending, fetchTransfer } from "@/ui/lib/prepare-flow";
import { TRANSFER_STATUSES, isTerminal, type TransferStatus } from "@/domain/transfers";
import {
  getReconciliation,
  postReconcile,
  postVerifySettlement,
  progressCopy,
  progressForStatus,
  type ProgressPhase,
  type SettlementVerdict,
} from "@/ui/lib/settlement-client";
import { evaluateClaimEligibility, isClaimFlagEnabled, isClaimWindowOpen, mayRetryClaim } from "@/ui/lib/claim-gate";
import { loadBinding, type VaultLike } from "@/ui/lib/recovery-vault";
import { claimStoredSwap, readBackSwap } from "@/ui/lib/satora-browser";
import { canHaveReceipt, getReceipt, type ApiReceipt } from "@/ui/lib/transfers-api";

export interface SettlementInput {
  transferId: string;
  ownerUserId: string;
  sessionValid: boolean;
  previewMode: boolean;
  /** Set only by an explicit owner click; tracking never authorizes a claim. */
  explicitClaimAuthorization?: boolean;
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
}

/** Bounded polling: short backoff, stops at terminal insight, never aggressive. */
const POLL_DELAYS_MS = [3000, 6000, 12000, 12000, 15000];
const MAX_VERIFY_ROUNDS = 4;

interface ClaimRecord {
  transferId: string;
  ownerUserId: string;
  satoraSwapId: string;
  txHash: string | null;
  /** Set after the SDK reports a successful claim, even when it returns no tx id. */
  submittedAt?: string | null;
  unknownAt: string | null;
  verifyCompletedSinceClaim: boolean;
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
    };
  } catch {
    return null;
  }
}

export function saveClaimRecord(record: ClaimRecord): void {
  try {
    claimStore()?.setItem(`${CLAIM_KEY}:${record.transferId}`, JSON.stringify(record));
  } catch {
    /* best-effort; authoritative state lives server-side */
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

/** Non-terminal states where a bounded reconcile is allowed. */
function isReconcilable(status: string): boolean {
  return (
    status === "LIGHTNING_HANDOFF" ||
    status === "OUTCOME_UNKNOWN" ||
    status === "RECONCILING" ||
    status === "CLIENT_FUNDED" ||
    status === "SERVER_FUNDED" ||
    status === "CLAIMING"
  );
}

const copyFor = (phase: ProgressPhase): { title: string; body: string } => progressCopy(phase);

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
  const runId = useRef(0);
  const claimInFlight = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const lastInput = useRef<SettlementInput | null>(null);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const stop = useCallback(() => {
    runId.current += 1;
    clearTimers();
  }, [clearTimers]);

  useEffect(() => stop, [stop]);

  const later = useCallback(
    (ms: number, fn: () => void, id: number) => {
      // Pause while hidden: resume on visible instead of polling in background.
      if (typeof document !== "undefined" && document.hidden) {
        const onVisible = () => {
          if (runId.current !== id) return;
          document.removeEventListener("visibilitychange", onVisible);
          void fn();
        };
        document.addEventListener("visibilitychange", onVisible);
        timers.current.push(setTimeout(() => document.removeEventListener("visibilitychange", onVisible), ms * 4));
        return;
      }
      timers.current.push(setTimeout(() => void fn(), ms));
    },
    [],
  );

  const readAuthoritative = useCallback(async (transferId: string) => {
    const [transferRes, reconRes] = await Promise.all([fetchTransfer(transferId), getReconciliation(transferId)]);
    return { transferRes, reconRes };
  }, []);

  const settleFromView = useCallback(
    async (
      input: SettlementInput,
      status: string,
      statusLabel: string | null,
      view: { latest: { providerStatus: string; claimReady: boolean; ambiguous: boolean }; transfer: { routeId: string } },
      round: number,
      id: number,
      resume: () => void,
    ): Promise<void> => {
      if (runId.current !== id) return;
      const phase = progressForStatus(status);
      const copy = copyFor(phase === "delivered" ? "finishing" : phase);
      if (phase === "cancelled") {
        setState({
          phase: "cancelled",
          transferId: input.transferId,
          transferStatus: status,
          statusLabel,
          providerStatus: view.latest.providerStatus,
          claimReady: false,
          message: copy.body,
          receipt: null,
          verifyVerdict: null,
        });
        // Terminal: the interrupted-payment pointer is now stale.
        clearPending(input.ownerUserId, input.transferId);
        return;
      }
      if (phase === "attention") {
        setState({
          phase: "attention",
          transferId: input.transferId,
          transferStatus: status,
          statusLabel,
          providerStatus: view.latest.providerStatus,
          claimReady: view.latest.claimReady,
          message: statusLabel ? `${statusLabel}. Follow the next step before starting another payment.` : copy.body,
          receipt: null,
          verifyVerdict: null,
        });
        // Terminal (e.g. FAILED): the interrupted-payment pointer is stale.
        // Non-terminal attention keeps it for resume.
        if ((TRANSFER_STATUSES as readonly string[]).includes(status) && isTerminal(status as TransferStatus)) {
          clearPending(input.ownerUserId, input.transferId);
        }
        return;
      }
      if (phase === "delivered") {
        // Receipts load ONLY for backend-confirmed DELIVERED transfers.
        const receiptRes = await getReceipt(input.transferId);
        if (runId.current !== id) return;
        if (receiptRes.ok) {
          setState({
            phase: "delivered",
            transferId: input.transferId,
            transferStatus: status,
            statusLabel,
            providerStatus: view.latest.providerStatus,
            claimReady: false,
            message: copyFor("delivered").body,
            receipt: receiptRes.data.receipt,
            verifyVerdict: "VERIFIED",
          });
          clearClaimRecord(input.transferId, input.ownerUserId);
          // Terminal: the interrupted-payment pointer is now stale.
          clearPending(input.ownerUserId, input.transferId);
          return;
        }
        setState({
          phase: "finishing",
          transferId: input.transferId,
          transferStatus: status,
          statusLabel,
          providerStatus: view.latest.providerStatus,
          claimReady: false,
          message: "The receipt is still being put together. Check back shortly.",
          receipt: null,
          verifyVerdict: null,
        });
        return;
      }
      // In-flight: one bounded reconcile, then re-read; repeat while rounds remain.
      if (round < POLL_DELAYS_MS.length && isReconcilable(status)) {
        const reconciled = await postReconcile(input.transferId);
        if (runId.current !== id) return;
        if (!reconciled.ok && reconciled.kind !== "unauthorized") {
          setState({
            phase: "checking",
            transferId: input.transferId,
            transferStatus: status,
            statusLabel,
            providerStatus: view.latest.providerStatus,
            claimReady: view.latest.claimReady,
            message: reconciled.code === "RATE_LIMITED" || reconciled.kind === "rate-limited" ? "Too many tries at once. Checking again shortly — do not resend." : "The network check is temporarily unavailable. Checking again shortly — do not resend.",
            receipt: null,
            verifyVerdict: null,
          });
          later(POLL_DELAYS_MS[round] ?? 15000, resume, id);
          return;
        }
        if (!reconciled.ok && reconciled.kind === "unauthorized") {
          setState({
            phase: "attention",
            transferId: input.transferId,
            transferStatus: status,
            statusLabel,
            providerStatus: view.latest.providerStatus,
            claimReady: false,
            message: "Your session has ended. Sign in again.",
            receipt: null,
            verifyVerdict: null,
          });
          return;
        }
      }
      const fresh = await getReconciliation(input.transferId);
      if (runId.current !== id) return;
      if (!fresh.ok) {
        setState({
          phase: "checking",
          transferId: input.transferId,
          transferStatus: status,
          statusLabel,
          providerStatus: view.latest.providerStatus,
          claimReady: view.latest.claimReady,
          message: "Checking your payment — do not resend.",
          receipt: null,
          verifyVerdict: null,
        });
        return;
      }
      const nextPhase = progressForStatus(fresh.data.transfer.status);
      const nextCopy = copyFor(nextPhase === "delivered" ? "finishing" : nextPhase);
      setState({
        phase: nextPhase === "delivered" ? "finishing" : nextPhase,
        transferId: input.transferId,
        transferStatus: fresh.data.transfer.status,
        statusLabel: fresh.data.transfer.statusLabel,
        providerStatus: fresh.data.latest.providerStatus,
        claimReady: fresh.data.latest.claimReady,
        message: view.latest.ambiguous || fresh.data.latest.ambiguous ? "Checking your payment — do not resend." : nextCopy.body,
        receipt: null,
        verifyVerdict: null,
      });
      if (isReconcilable(fresh.data.transfer.status) && round + 1 < POLL_DELAYS_MS.length) {
        later(POLL_DELAYS_MS[round] ?? 15000, resume, id);
      }
    },
    [later],
  );

  const track = useCallback(
    async (input: SettlementInput) => {
      if (!input.transferId || !input.ownerUserId) {
        setState((s) => ({ ...s, phase: "attention", transferId: input.transferId || null, message: "This payment isn't ready yet." }));
        return;
      }
      const id = ++runId.current;
      clearTimers();
      lastInput.current = input;
      const { transferRes, reconRes } = await readAuthoritative(input.transferId);
      if (runId.current !== id) return;
      if (!transferRes.ok || !reconRes.ok) {
        const unauthorized = (!transferRes.ok && transferRes.kind === "unauthorized") || (!reconRes.ok && reconRes.kind === "unauthorized");
        setState({
          phase: unauthorized ? "attention" : "checking",
          transferId: input.transferId,
          transferStatus: null,
          statusLabel: null,
          providerStatus: null,
          claimReady: false,
          message: unauthorized ? "Your session has ended. Sign in again." : "Checking your payment — do not resend.",
          receipt: null,
          verifyVerdict: null,
        });
        return;
      }
      // The resume callback is invoked later, after this stable track callback exists.
      // eslint-disable-next-line react-hooks/immutability
      await settleFromView(input, transferRes.data.transfer.status as string, transferRes.data.transfer.statusLabel ?? null, reconRes.data, 0, id, () => void track(input));
    },
    [clearTimers, readAuthoritative, settleFromView],
  );

  const runVerifyLoopRef = useRef<((input: SettlementInput, round: number) => Promise<void>) | null>(null);

  const checkAgain = useCallback(
    async (input: SettlementInput) => {
      await track(input);
    },
    [track],
  );

  const attemptClaim = useCallback(
    async (input: SettlementInput): Promise<{ ok: boolean; reason: string }> => {
      if (claimInFlight.current) return { ok: false, reason: "A delivery attempt is already in progress. Check payment status — do not try again." };
      claimInFlight.current = true;
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
      const record = loadClaimRecord(input.transferId, input.ownerUserId);
      const claimRetryAllowed = record !== null && record.unknownAt !== null
        ? mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: record.verifyCompletedSinceClaim, claimReadyNow: view.data.latest.claimReady, knownClaimTxHash: record.txHash !== null })
        : false;
      const claimAlreadySubmitted = record !== null && (record.txHash !== null || record.submittedAt != null) && !claimRetryAllowed;
      const gate = evaluateClaimEligibility({
        flagEnabled: isClaimFlagEnabled(),
        explicitAuthorization: input.explicitClaimAuthorization === true,
        sessionValid: input.sessionValid,
        timelockSafe: readbackIdentityMatched && isClaimWindowOpen(readback.evmRefundLocktime),
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
      let outcome: { success: boolean; txHash: string | null; message: string };
      try {
        outcome = await claimStoredSwap(swap.satoraSwapId);
      } catch (error) {
        saveClaimRecord({ transferId: input.transferId, ownerUserId: input.ownerUserId, satoraSwapId: swap.satoraSwapId, txHash: null, unknownAt: new Date().toISOString(), verifyCompletedSinceClaim: false });
        setState((s) => ({ ...s, phase: "checking", message: error instanceof Error ? `${error.message} Checking payment — do not resend.` : "Checking payment — do not resend." }));
        return { ok: false, reason: "The delivery attempt couldn't be confirmed. Checking payment — do not resend." };
      }
      if (!outcome.success) {
        // SDK-reported failure (not unknown): surface attention, keep state for retry.
        setState((s) => ({ ...s, phase: "attention", message: `${outcome.message} Follow the next step before starting another payment.` }));
        return { ok: false, reason: outcome.message };
      }
      saveClaimRecord({ transferId: input.transferId, ownerUserId: input.ownerUserId, satoraSwapId: swap.satoraSwapId, txHash: outcome.txHash, submittedAt: new Date().toISOString(), unknownAt: null, verifyCompletedSinceClaim: false });
      await runVerifyLoopRef.current?.(input, 0);
      return { ok: true, reason: outcome.txHash ? "Delivery submitted. Confirming it arrived." : "Delivery submitted. Confirming it arrived." };
      } finally {
        claimInFlight.current = false;
      }
    },
    [],
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

  return { state, track, stop, attemptClaim, checkAgain };
}
