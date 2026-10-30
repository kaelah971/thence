"use client";

import { useCallback, useRef, useState } from "react";
import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { clearPending, fetchAttempt, fetchTransfer } from "@/ui/lib/prepare-flow";
import { mapHostResultToServerOutcome, reportHandoffResult, type ServerHandoffOutcome } from "@/ui/lib/handoff-client";
import { hasLightningPaymentSupport, payAuthorizedInvoice, type LightningCapableProvider } from "@/ui/lib/nimiq-pay";
import { evaluatePaymentGate, isPaymentFlagEnabled } from "@/ui/lib/payment-gate";
import { getHostProvider } from "@/ui/lib/nimiq-provider";
import { loadBinding, type VaultLike } from "@/ui/lib/recovery-vault";

export type HandoffPhase =
  | { phase: "ready"; transferId: string }
  | { phase: "confirming"; transferId: string; message: string }
  | { phase: "checking"; transferId: string; message: string }
  | { phase: "cancelled"; transferId: string; message: string }
  | { phase: "attention"; transferId: string | null; message: string };

export interface HandoffInvokeInput {
  transferId: string;
  authorizedInvoice: string;
  sourceSats: string;
  ownerUserId: string;
  sessionValid: boolean;
  previewMode: boolean;
}

interface HandoffRecord {
  transferId: string;
  ownerUserId: string;
  invoice: string;
  invokedAt: string;
  outcomeReported: boolean;
  reportedOutcome: ServerHandoffOutcome | null;
}

const HANDOFF_KEY = "thence.f4.2.handoff.v1";
const ALLOWED_NETWORKS = ["mainnet"] as const;

function handoffStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadHandoffRecord(transferId: string, ownerUserId: string): HandoffRecord | null {
  try {
    const raw = handoffStore()?.getItem(`${HANDOFF_KEY}:${transferId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HandoffRecord>;
    if (
      parsed.transferId !== transferId ||
      parsed.ownerUserId !== ownerUserId ||
      typeof parsed.invoice !== "string" ||
      typeof parsed.invokedAt !== "string"
    ) {
      return null;
    }
    return {
      transferId,
      ownerUserId,
      invoice: parsed.invoice,
      invokedAt: parsed.invokedAt,
      outcomeReported: parsed.outcomeReported === true,
      reportedOutcome:
        parsed.reportedOutcome === "cancelled" || parsed.reportedOutcome === "initiated" || parsed.reportedOutcome === "unknown"
          ? parsed.reportedOutcome
          : null,
    };
  } catch {
    return null;
  }
}

export function saveHandoffRecord(record: HandoffRecord): void {
  try {
    handoffStore()?.setItem(`${HANDOFF_KEY}:${record.transferId}`, JSON.stringify(record));
  } catch {
    /* best-effort; authoritative state lives server-side */
  }
}

function vaultForTests(): VaultLike | null {
  return (globalThis as unknown as { __thenceVault?: VaultLike }).__thenceVault ?? null;
}

function providerForTests(): LightningCapableProvider | null {
  return (globalThis as unknown as { __thencePayProvider?: LightningCapableProvider }).__thencePayProvider ?? null;
}

async function loadVaultBinding(transferId: string, ownerUserId: string) {
  const injected = vaultForTests();
  if (injected) {
    if (!injected.available) return { status: "unavailable" } as const;
    return injected.load(transferId, ownerUserId);
  }
  return loadBinding(transferId, ownerUserId);
}

function invoiceLive(invoiceExpiresAt: unknown, now: number = Date.now()): boolean {
  if (typeof invoiceExpiresAt !== "string") return false;
  const until = Date.parse(invoiceExpiresAt);
  return Number.isFinite(until) && until > now;
}

/**
 * Pure resume decision (unit-testable without React).
 * Never authorizes a second native payment: unresolved outcomes stay in
 * checking and converge via idempotent unknown-reports + reconcile (F4.3).
 */
export function decideResumeAction(
  status: string,
  record: HandoffRecord | null,
): { action: "report-unknown" | "none"; phase: "checking" | "cancelled" | "ready" | "attention" } {
  if (status === "LIGHTNING_HANDOFF" || status === "OUTCOME_UNKNOWN" || status === "RECONCILING") {
    return { action: record && !record.outcomeReported ? "report-unknown" : "none", phase: "checking" };
  }
  if (status === "USER_CANCELLED") return { action: "none", phase: "cancelled" };
  if (status === "AWAITING_NIM_APPROVAL") {
    // A stored unreported invocation means the native response was lost
    // (termination/timeout): outcome unknown until reconciled.
    if (record && !record.outcomeReported) return { action: "none", phase: "checking" };
    return { action: "none", phase: "ready" };
  }
  if (status === "DELIVERED") {
    // Nothing left for the handoff to do; the settlement view owns Delivered.
    // Idle handoff state keeps the receipt/progress visible without a
    // misleading attention banner.
    return { action: "none", phase: "ready" };
  }
  return { action: "none", phase: "attention" };
}

export function useHandoff(): {
  state: HandoffPhase;
  invoke: (input: HandoffInvokeInput) => Promise<void>;
  resume: (transferId: string, ownerUserId: string, sessionValid: boolean, previewMode: boolean) => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<HandoffPhase>({ phase: "ready", transferId: "" });
  const inflight = useRef(false);

  const invoke = useCallback(async (input: HandoffInvokeInput) => {
    // Double-swipe/back-button guard: one native call at a time, ever.
    if (inflight.current) return;
    // Never auto-invoke without a rendered transfer context.
    if (!input.transferId || !input.authorizedInvoice) {
      setState({ phase: "attention", transferId: input.transferId || null, message: "This payment isn't ready yet." });
      return;
    }
    inflight.current = true;
    try {
      setState({ phase: "confirming", transferId: input.transferId, message: "Confirm in Nimiq Pay…" });

      // Authoritative transfer state first: only AWAITING_NIM_APPROVAL is payable.
      const current = await fetchTransfer(input.transferId);
      if (!current.ok) {
        setState({
          phase: current.kind === "unauthorized" ? "attention" : "checking",
          transferId: input.transferId,
          message:
            current.kind === "unauthorized"
              ? "Your session has ended. Sign in again."
              : "Checking payment — do not resend.",
        });
        return;
      }
      const transferAuthorized = current.data.transfer.status === "AWAITING_NIM_APPROVAL";
      if (!transferAuthorized) {
        setState({
          phase: "checking",
          transferId: input.transferId,
          message: `${current.data.transfer.statusLabel ?? "This payment changed state"}. Checking payment — do not resend.`,
        });
        return;
      }

      // Attempt + swap: bind the exact authorized swap and check invoice liveness.
      const attemptRes = await fetchAttempt(input.transferId);
      const attempt = attemptRes.ok ? attemptRes.data.attempt : null;
      const swap = attemptRes.ok ? (attemptRes.data.swap as { satoraSwapId?: string; invoiceExpiresAt?: string | null } | null) : null;
      if (!attemptRes.ok || !attempt || !swap?.satoraSwapId) {
        setState({ phase: "checking", transferId: input.transferId, message: "Checking payment — do not resend." });
        return;
      }
      const live = invoiceLive(swap.invoiceExpiresAt);
      if (!live) {
        setState({ phase: "attention", transferId: input.transferId, message: "The invoice is missing or expired. Do not approve anything." });
        return;
      }

      // Persisted recovery must match this transfer+owner before any invocation.
      const vault = await loadVaultBinding(input.transferId, input.ownerUserId);
      const vaultMatched =
        vault.status === "ok" &&
        vault.binding.transferId === input.transferId &&
        vault.binding.ownerUserId === input.ownerUserId &&
        vault.binding.satoraSwapId === swap.satoraSwapId &&
        vault.binding.attemptToken.length > 0;
      if (!vaultMatched) {
        setState({
          phase: "attention",
          transferId: input.transferId,
          message:
            vault.status === "foreign"
              ? "Your session has ended. Sign in again."
              : "Recovery information doesn't match. Do not pay.",
        });
        return;
      }

      // Host capability (verified method, never assumed).
      const provider: unknown = providerForTests() ?? (await getHostProvider().catch(() => null));
      if (!provider || !hasLightningPaymentSupport(provider)) {
        setState({
          phase: "attention",
          transferId: input.transferId,
          message: "This version of Nimiq Pay can't pay Lightning invoices.",
        });
        return;
      }

      // Invoice binding: the exact authorized string is forwarded byte-identical
      // by payAuthorizedInvoice (asserted there). Binding to this transfer is
      // enforced above via AWAITING status + vault swap == attempt swap.

      // Strict gate: OFF by default; stays OFF in this milestone.
      const gate = evaluatePaymentGate({
        flagEnabled: isPaymentFlagEnabled(),
        hostSupported: true,
        hostNetwork: typeof getHostNetwork === "function" ? (getHostNetwork() ?? null) : null,
        allowedHostNetworks: ALLOWED_NETWORKS,
        sessionValid: input.sessionValid,
        transferAuthorized,
        vaultMatched,
        invoiceLive: live,
        explicitAction: true,
        previewMode: input.previewMode,
      });
      if (!gate.allowed) {
        setState({ phase: "attention", transferId: input.transferId, message: gate.reasons[0] ?? "Payments are paused in this preview. Nothing was sent." });
        return;
      }

      // Persist handoff intent BEFORE the native call (replay safety).
      saveHandoffRecord({
        transferId: input.transferId,
        ownerUserId: input.ownerUserId,
        invoice: input.authorizedInvoice,
        invokedAt: new Date().toISOString(),
        outcomeReported: false,
        reportedOutcome: null,
      });

      const result = await payAuthorizedInvoice(provider as LightningCapableProvider, input.authorizedInvoice);
      const outcome = mapHostResultToServerOutcome(result);
      if (result.kind === "cancelled") {
        const reported = await reportHandoffResult(input.transferId, outcome);
        saveHandoffRecord({
          transferId: input.transferId,
          ownerUserId: input.ownerUserId,
          invoice: input.authorizedInvoice,
          invokedAt: new Date().toISOString(),
          outcomeReported: reported.ok,
          reportedOutcome: reported.ok ? outcome : null,
        });
        // Terminal cancellation: the interrupted-payment pointer is now stale.
        if (reported.ok) clearPending(input.ownerUserId, input.transferId);
        setState({
          phase: reported.ok ? "cancelled" : "checking",
          transferId: input.transferId,
          message: reported.ok ? "Payment cancelled. Nothing moved." : "Checking payment — do not resend.",
        });
        return;
      }
      if (result.kind === "initiated") {
        const reported = await reportHandoffResult(input.transferId, outcome);
        if (!reported.ok) {
          // Native call succeeded but the report timed out: outcome unknown
          // until the server confirms. Never retry the native payment.
          setState({ phase: "checking", transferId: input.transferId, message: "Payment being checked. Do not resend." });
          return;
        }
        setState({ phase: "checking", transferId: input.transferId, message: "Payment being checked. Do not resend." });
        return;
      }
      // unknown / unavailable / unsupported / invalid → report unknown, never retry natively.
      const reported = await reportHandoffResult(input.transferId, "unknown");
      saveHandoffRecord({
        transferId: input.transferId,
        ownerUserId: input.ownerUserId,
        invoice: input.authorizedInvoice,
        invokedAt: new Date().toISOString(),
        outcomeReported: reported.ok,
        reportedOutcome: reported.ok ? "unknown" : null,
      });
      setState({
        phase: reported.ok ? "checking" : "checking",
        transferId: input.transferId,
        message:
          result.kind === "unavailable"
            ? "Nimiq Pay isn't available. Checking payment — do not resend."
            : "Payment needs attention. Checking payment — do not resend.",
      });
    } finally {
      inflight.current = false;
    }
  }, []);

  const resume = useCallback(async (transferId: string, ownerUserId: string, sessionValid: boolean, previewMode: boolean) => {
    void sessionValid;
    void previewMode;
    // Reopen after invocation/termination: authoritative state only, never re-invoke blindly.
    const record = loadHandoffRecord(transferId, ownerUserId);
    const current = await fetchTransfer(transferId);
    if (!current.ok) {
      setState({ phase: "checking", transferId, message: "Checking payment — do not resend." });
      return;
    }
    const decided = decideResumeAction(current.data.transfer.status, record);
    if (decided.action === "report-unknown") {
      // Report unknown once for an unreported invocation; idempotent server-side.
      await reportHandoffResult(transferId, "unknown").catch(() => undefined);
    }
    switch (decided.phase) {
      case "checking":
        setState({ phase: "checking", transferId, message: "Payment being checked. Do not resend." });
        return;
      case "cancelled":
        clearPending(ownerUserId, transferId);
        setState({ phase: "cancelled", transferId, message: "Payment cancelled. Nothing moved." });
        return;
      case "ready":
        setState({ phase: "ready", transferId });
        return;
      default:
        setState({ phase: "attention", transferId, message: "Payment needs attention. Checking payment — do not resend." });
        return;
    }
  }, []);

  const reset = useCallback(() => setState({ phase: "ready", transferId: "" }), []);

  return { state, invoke, resume, reset };
}
