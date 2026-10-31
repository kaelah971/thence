"use client";

import { useCallback, useRef, useState } from "react";
import {
  attachTransferSwap,
  authorizeTransferHandoff,
  buildTransferBody,
  canReuseBinding,
  classifyPreparationFailure,
  clearPending,
  createTransfer,
  fetchAttempt,
  fetchTransfer,
  isQuoteFresh,
  loadPending,
  newIdempotencyKey,
  prepareTransfer,
  savePending,
  withTimeout,
  type FixedTerms,
  type PayeeTerms,
  type PendingPointer,
  type PreparationIssue,
  type PreparationStep,
} from "@/ui/lib/prepare-flow";
import {
  createMemoryVault,
  isVaultAvailable,
  loadBinding,
  saveAndVerifyBinding,
  shouldDiscardBindingOnAttachFailure,
  type RecoveryBinding,
  type VaultLike,
} from "@/ui/lib/recovery-vault";
import { createExactReceiveSwap, readBackSwap } from "@/ui/lib/satora-browser";

export type PreparationPhase =
  | { phase: "idle" }
  | { phase: "working"; step: PreparationStep; message: string; transferId: string | null }
  | { phase: "ready"; transferId: string; sourceSats: string; invoiceBolt11: string | null; statusLabel: string }
  | { phase: "failed"; issue: PreparationIssue; step: PreparationStep; transferId: string | null };

export interface PreparationInput {
  payee: PayeeTerms;
  fixed: FixedTerms | null;
  targetAmountAtomic: string;
  destination: string;
  ownerUserId: string;
  quoteRevisionHint?: number | null;
  tokenAddress: string | null;
  evmChainId: number | null;
}

/**
 * F8.11: client-side storage/SDK reads have no native timeouts. A hang
 * here used to leave the UI on an infinite spinner with no error and no
 * retry. Reads slower than this fail into the normal retryable path.
 */
const VAULT_READ_TIMEOUT_MS = 15_000;

const STEP_COPY: Record<PreparationStep, string> = {
  creating: "Creating your payment…",
  preparing: "Preparing your payment…",
  swapping: "Creating the swap…",
  saving: "Saving recovery information…",
  attaching: "Verifying the swap…",
  authorizing: "Getting approval ready…",
};

function vaultForTests(): VaultLike | null {
  // Unit tests inject via global; browsers use IndexedDB directly.
  const injected = (globalThis as unknown as { __thenceVault?: VaultLike }).__thenceVault;
  return injected ?? null;
}

async function saveBindingDurable(binding: RecoveryBinding): Promise<{ ok: boolean; reason?: string }> {
  const injected = vaultForTests();
  if (injected) {
    if (!injected.available) return { ok: false, reason: "Durable storage is unavailable in this browser." };
    const result = await injected.saveAndVerify(binding);
    return result.status === "ok" ? { ok: true } : { ok: false, reason: result.status === "unavailable" ? result.reason : "Recovery information did not save correctly." };
  }
  if (!isVaultAvailable()) return { ok: false, reason: "Durable storage is unavailable in this browser." };
  const result = await saveAndVerifyBinding(binding);
  if (result.status === "ok") return { ok: true };
  if (result.status === "unavailable") return { ok: false, reason: result.reason };
  if (result.status === "foreign") return { ok: false, reason: "Recovery information belongs to a different sign-in." };
  return { ok: false, reason: "Recovery information did not save correctly." };
}

async function loadBindingDurable(transferId: string, ownerUserId: string) {
  const injected = vaultForTests();
  if (injected) {
    if (!injected.available) return { status: "unavailable", reason: "Durable storage is unavailable in this browser." } as const;
    return injected.load(transferId, ownerUserId);
  }
  return loadBinding(transferId, ownerUserId);
}

export function usePreparation(): {
  state: PreparationPhase;
  start: (input: PreparationInput) => Promise<void>;
  resume: (transferId: string, ownerUserId: string) => Promise<void>;
  retry: () => Promise<void>;
  reset: () => void;
  pendingFor: (ownerUserId: string | null) => PendingPointer | null;
} {
  const [state, setState] = useState<PreparationPhase>({ phase: "idle" });
  const inflight = useRef(false);
  const lastInput = useRef<PreparationInput | null>(null);

  const fail = useCallback((issue: PreparationIssue, step: PreparationStep, transferId: string | null) => {
    setState({ phase: "failed", issue, step, transferId });
  }, []);

  const run = useCallback(
    async (input: PreparationInput, resumeTransferId?: string) => {
      // Duplicate-swipe guard: one run at a time; extra taps are ignored.
      if (inflight.current) return;
      inflight.current = true;
      lastInput.current = input;
      // Tracked for the catch-all below: any unexpected throw or hang must
      // surface as a bounded, retryable failure — never an endless spinner.
      let activeTransferId: string | null = resumeTransferId ?? null;
      try {
        if (!input.tokenAddress || !input.evmChainId) {
          fail(
            { title: "Not available right now", body: "This currency can't be paid at the moment.", retryable: false, action: "abort" },
            "preparing",
            resumeTransferId ?? null,
          );
          return;
        }

        // 1 — idempotency key: stable per intent, survives reload via pending pointer.
        const existingPending = loadPending(input.ownerUserId);
        let idempotencyKey = newIdempotencyKey();
        let transferId: string | null = activeTransferId;
        let attemptToken: string | null = null;
        if (existingPending && (!resumeTransferId || existingPending.transferId === resumeTransferId)) {
          // Same user, same unresolved payment: reuse the key so a refresh or
          // double-tap converges instead of creating a duplicate.
          if (!transferId) transferId = existingPending.transferId;
          idempotencyKey = existingPending.idempotencyKey;
          attemptToken = existingPending.attemptToken;
        }

        // 2 — create (or confirm) the transfer. Quoting alone never creates.
        let quoteRevision = input.quoteRevisionHint ?? 1;
        let transferDestination = input.destination;
        let transferTargetAtomic = input.targetAmountAtomic;
        if (!transferId) {
          setState({ phase: "working", step: "creating", message: STEP_COPY.creating, transferId: null });
          const body = buildTransferBody({ payee: input.payee, fixed: input.fixed, targetAmountAtomic: input.targetAmountAtomic, idempotencyKey });
          const created = await createTransfer(body);
          if (!created.ok) {
            fail(classifyPreparationFailure(created), "creating", null);
            return;
          }
          transferId = created.data.transfer.id;
          activeTransferId = transferId;
          quoteRevision = created.data.transfer.quote?.revision ?? 1;
          transferDestination = created.data.transfer.destination;
          transferTargetAtomic = created.data.transfer.targetAmountAtomic;
          savePending({
            transferId,
            idempotencyKey,
            attemptToken: null,
            ownerUserId: input.ownerUserId,
            routeId: input.payee.routeId,
            targetAmountAtomic: transferTargetAtomic,
          });
          setState({ phase: "working", step: "creating", message: STEP_COPY.creating, transferId });
        } else {
          // Resume path: authoritative transfer state first, never assume.
          const current = await fetchTransfer(transferId);
          if (!current.ok) {
            fail(classifyPreparationFailure(current), "creating", transferId);
            return;
          }
          const t = current.data.transfer;
          // Immutable terms guard: wrong wallet/route/amount never proceeds.
          if (
            t.destination.toLowerCase() !== input.destination.toLowerCase() ||
            t.targetAmountAtomic !== input.targetAmountAtomic ||
            t.routeId !== input.payee.routeId
          ) {
            fail(
              { title: "These details changed", body: "The person, wallet, amount or currency is different from the saved payment. Start over.", retryable: false, action: "abort" },
              "creating",
              transferId,
            );
            return;
          }
          quoteRevision = t.quote?.revision ?? quoteRevision;
          transferDestination = t.destination;
          transferTargetAtomic = t.targetAmountAtomic;
          if (t.status === "AWAITING_NIM_APPROVAL") {
            const attempt = await fetchAttempt(transferId);
            if (attempt.ok) {
              const swap = attempt.data.swap as { sourceSats?: string } | null;
              setState({
                phase: "ready",
                transferId,
                sourceSats: (swap && typeof swap.sourceSats === "string" ? swap.sourceSats : null) ?? t.quote?.revision?.toString?.() ?? "",
                invoiceBolt11: null,
                statusLabel: t.statusLabel ?? "Approve in Nimiq Pay",
              });
              void attemptToken;
              return;
            }
          }
          if (t.status !== "QUOTED" && t.status !== "SWAP_CREATED") {
            fail(
              { title: "Checking payment — do not resend", body: `${t.statusLabel ?? "This payment changed state"}. Continue it from activity instead of starting over.`, retryable: true, action: "resume" },
              "creating",
              transferId,
            );
            return;
          }
        }

        const tid = transferId as string;
        savePending({
          transferId: tid,
          idempotencyKey,
          attemptToken,
          ownerUserId: input.ownerUserId,
          routeId: input.payee.routeId,
          targetAmountAtomic: transferTargetAtomic,
        });

        // 3 — prepare (server revalidates quote, route, request linkage).
        setState({ phase: "working", step: "preparing", message: STEP_COPY.preparing, transferId: tid });
        if (!attemptToken) {
          const prepared = await prepareTransfer(tid, quoteRevision);
          if (!prepared.ok) {
            // Quote expired pre-prepare is a normal path: surface requote.
            fail(classifyPreparationFailure(prepared), "preparing", tid);
            return;
          }
          // Replay returns an empty token: the original caller persisted it.
          if (prepared.data.attemptToken) {
            attemptToken = prepared.data.attemptToken;
            savePending({
              transferId: tid,
              idempotencyKey,
              attemptToken,
              ownerUserId: input.ownerUserId,
              routeId: input.payee.routeId,
              targetAmountAtomic: transferTargetAtomic,
            });
          } else if (!attemptToken) {
            // We lost the original handle (e.g. reload before persist): stop
            // safely rather than forking a second attempt while one is active.
            fail(
              { title: "Checking payment — do not resend", body: "A preparation is already in progress. Reopen this payment to continue it.", retryable: true, action: "resume" },
              "preparing",
              tid,
            );
            return;
          }
          quoteRevision = prepared.data.attempt.quoteRevision ?? quoteRevision;
        }

        // 4 — reuse check: never regenerate swap secrets blindly.
        const vaultBinding = await withTimeout(loadBindingDurable(tid, input.ownerUserId), VAULT_READ_TIMEOUT_MS, "recovery vault read");
        if (vaultBinding.status === "ok" && attemptToken) {
          const binding = vaultBinding.binding;
          if (
            canReuseBinding(binding, {
              transferId: tid,
              destination: transferDestination,
              targetAtomic: transferTargetAtomic,
              routeId: input.payee.routeId,
              quoteRevision,
              ownerUserId: input.ownerUserId,
            })
          ) {
            const readback = await withTimeout(readBackSwap(binding.satoraSwapId), VAULT_READ_TIMEOUT_MS, "swap readback");
            if (readback.ok) {
              // Same swap, verified: skip creation, continue to attach.
              await attachAndAuthorize({
                tid,
                attemptToken,
                quoteRevision,
                satoraSwapId: binding.satoraSwapId,
                sourceSatsHint: binding.sourceSats,
                setState,
                fail,
                input,
              });
              return;
            }
            // Saved binding exists but SDK material is gone: stop. The user
            // must explicitly choose to replace it (retry does that).
            if (lastInput.current) {
              fail(
                { title: "We couldn't find your saved swap", body: "Nothing was attached or approved. Trying again creates a new swap for this payment.", retryable: true, action: "retry" },
                "swapping",
                tid,
              );
              return;
            }
          }
        } else if (vaultBinding.status === "unavailable") {
          fail(
            { title: "Not saved — do not pay", body: "Durable storage is unavailable, so this payment was stopped before approval. Nothing was created.", retryable: false, action: "abort" },
            "saving",
            tid,
          );
          return;
        } else if (vaultBinding.status === "foreign") {
          fail(
            { title: "Your session has ended", body: "Sign in again to continue. Nothing was paid.", retryable: false, action: "reauth" },
            "saving",
            tid,
          );
          return;
        }
        // Corrupt/incompatible/missing bindings fall through to fresh creation
        // ONLY when no server-bound swap exists (checked at attach). A corrupt
        // binding for an unresolved transfer is never silently discarded: the
        // attach conflict path surfaces it instead.

        // Freshness gate: don't build a swap on a locally-expired quote.
        const transferNow = await fetchTransfer(tid);
        if (transferNow.ok) {
          const expiresAt = transferNow.data.transfer.quoteExpiresAt ?? transferNow.data.transfer.quote?.validUntil ?? null;
          void isQuoteFresh;
          if (typeof expiresAt === "string" && !isQuoteFresh(expiresAt)) {
            fail(classifyPreparationFailure({ kind: "conflict", code: "QUOTE_STALE" }), "preparing", tid);
            return;
          }
          // Authoritative state gate before any swap creation.
          if (transferNow.data.transfer.status !== "QUOTED" && transferNow.data.transfer.status !== "SWAP_CREATED") {
            fail(
              {
                title: "Checking payment — do not resend",
                body: `${transferNow.data.transfer.statusLabel ?? "This payment changed state"}. Continue it from activity.`,
                retryable: true,
                action: "resume",
              },
              "preparing",
              tid,
            );
            return;
          }
          // If the server already bound a swap, never create another one.
          const attemptNow = await fetchAttempt(tid);
          if (attemptNow.ok && attemptNow.data.attempt?.satoraSwapId && attemptToken) {
            await attachAndAuthorize({
              tid,
              attemptToken,
              quoteRevision,
              satoraSwapId: attemptNow.data.attempt.satoraSwapId,
              sourceSatsHint: null,
              setState,
              fail,
              input,
            });
            return;
          }
        }

        // 5 — browser-side swap (exact receive; secrets never leave the device).
        setState({ phase: "working", step: "swapping", message: STEP_COPY.swapping, transferId: tid });
        let swap: { satoraSwapId: string; bolt11Invoice: string; paymentHash: string; sourceSats: string; targetAtomic: string };
        try {
          swap = await createExactReceiveSwap({
            targetAddress: transferDestination,
            tokenAddress: input.tokenAddress as string,
            evmChainId: input.evmChainId as number,
            targetAmountAtomic: transferTargetAtomic,
          });
        } catch (error) {
          fail(
            {
              title: "Couldn't create the swap",
              body: error instanceof Error ? `Nothing was attached or approved. ${error.message}` : "Nothing was attached or approved. Try again.",
              retryable: true,
              action: "retry",
            },
            "swapping",
            tid,
          );
          return;
        }
        if (swap.targetAtomic !== transferTargetAtomic || transferDestination.toLowerCase() !== input.destination.toLowerCase()) {
          fail(
            { title: "Couldn't verify the swap", body: "The swap doesn't match this payment. Nothing was attached or approved.", retryable: false, action: "abort" },
            "swapping",
            tid,
          );
          return;
        }

        // 6 — durable persistence BEFORE proceeding + readback integrity.
        setState({ phase: "working", step: "saving", message: "Saving recovery information…", transferId: tid });
        const binding: RecoveryBinding = {
          version: 1,
          transferId: tid,
          satoraSwapId: swap.satoraSwapId,
          paymentHash: swap.paymentHash,
          sourceSats: swap.sourceSats,
          targetAtomic: swap.targetAtomic,
          destination: transferDestination,
          routeId: input.payee.routeId,
          quoteRevision,
          ownerUserId: input.ownerUserId,
          attemptToken: attemptToken as string,
          storedAt: new Date().toISOString(),
          verifiedAt: null,
        };
        const saved = await saveBindingDurable(binding);
        if (!saved.ok) {
          fail(
            { title: "Not saved — do not pay", body: `${saved.reason ?? "Recovery information couldn't be saved."} Nothing was attached or approved. Browser storage isn't automatically secure against clearing or device loss.`, retryable: false, action: "abort" },
            "saving",
            tid,
          );
          return;
        }
        const readback = await withTimeout(readBackSwap(swap.satoraSwapId), VAULT_READ_TIMEOUT_MS, "swap readback");
        if (!readback.ok || !readback.hasRecoveryMaterial) {
          fail(
            { title: "Not saved — do not pay", body: `${readback.reason ?? "The saved swap couldn't be read back."} Nothing was attached or approved.`, retryable: false, action: "abort" },
            "saving",
            tid,
          );
          return;
        }

        await attachAndAuthorize({
          tid,
          attemptToken: attemptToken as string,
          quoteRevision,
          satoraSwapId: swap.satoraSwapId,
          sourceSatsHint: swap.sourceSats,
          setState,
          fail,
          input,
          invoiceHint: swap.bolt11Invoice,
        });
      } catch {
        // F8.11: any unexpected throw (or timed-out storage read below) must
        // surface as a bounded, retryable failure — never an endless spinner
        // with no error and no retry. Nothing is created or paid here; the
        // existing transfer (if any) stays recoverable via resume.
        fail(
          {
            title: "Couldn't continue",
            body: "Something interrupted this payment before anything was sent or approved. Try again — nothing was paid.",
            retryable: true,
            action: "retry",
          },
          "preparing",
          activeTransferId,
        );
      } finally {
        inflight.current = false;
      }
    },
    [fail],
  );

  const retry = useCallback(async () => {
    const input = lastInput.current;
    if (!input) return;
    // Explicit user retry after a lost/incomplete save: allow a fresh swap by
    // clearing only this transfer's vault record first (never silently).
    if (state.phase === "failed" && state.transferId && (state.step === "swapping" || state.step === "saving")) {
      const injected = vaultForTests();
      if (injected) {
        await injected.clear(state.transferId);
      } else {
        const { clearBinding } = await import("@/ui/lib/recovery-vault");
        await clearBinding(state.transferId);
      }
    }
    await run(input, state.phase === "failed" ? (state.transferId ?? undefined) : undefined);
  }, [run, state]);

  const resume = useCallback(
    async (transferId: string, ownerUserId: string) => {
      const input = lastInput.current;
      if (!input) return;
      await run({ ...input, ownerUserId }, transferId);
    },
    [run],
  );

  const reset = useCallback(() => {
    lastInput.current = null;
    setState({ phase: "idle" });
  }, []);

  const pendingFor = useCallback((ownerUserId: string | null) => loadPending(ownerUserId), []);

  return { state, start: run, resume, retry, reset, pendingFor };
}

async function attachAndAuthorize(args: {
  tid: string;
  attemptToken: string;
  quoteRevision: number;
  satoraSwapId: string;
  sourceSatsHint: string | null;
  setState: (s: PreparationPhase) => void;
  fail: (issue: PreparationIssue, step: PreparationStep, transferId: string | null) => void;
  input: PreparationInput;
  invoiceHint?: string;
}): Promise<void> {
  const { tid, attemptToken, quoteRevision, satoraSwapId, setState, fail, input } = args;
  setState({ phase: "working", step: "attaching", message: STEP_COPY.attaching, transferId: tid });
  const attached = await attachTransferSwap(tid, {
    attemptToken,
    expectedQuoteRevision: quoteRevision,
    satoraSwapId,
    recoveryAcknowledged: true,
  });
  if (!attached.ok) {
    // Idempotent edge: same swap already bound elsewhere surfaces as resume,
    // never as a second payment.
    // F8.10: a server-verified expired invoice proves the bound swap is dead.
    // Drop it so the next attempt creates a fresh swap for the SAME transfer
    // and attempt instead of re-attaching the dead one forever.
    if (attached.code !== null && shouldDiscardBindingOnAttachFailure(attached.code)) {
      const injected = vaultForTests();
      if (injected) {
        await injected.clear(tid);
      } else {
        const { clearBinding } = await import("@/ui/lib/recovery-vault");
        await clearBinding(tid);
      }
    }
    fail(classifyPreparationFailure(attached), "attaching", tid);
    return;
  }
  setState({ phase: "working", step: "authorizing", message: STEP_COPY.authorizing, transferId: tid });
  const authorized = await authorizeTransferHandoff(tid, attemptToken);
  if (!authorized.ok) {
    // 409 ALREADY_AUTHORIZED converges to ready (single authorization held).
    if (authorized.code === "ALREADY_AUTHORIZED") {
      const current = await fetchTransfer(tid);
      const label = current.ok ? current.data.transfer.statusLabel : "Approve in Nimiq Pay";
      setState({ phase: "ready", transferId: tid, sourceSats: args.sourceSatsHint ?? "", invoiceBolt11: args.invoiceHint ?? null, statusLabel: label });
      savePending({
        transferId: tid,
        idempotencyKey: loadPending(input.ownerUserId)?.idempotencyKey ?? newIdempotencyKey(),
        attemptToken,
        ownerUserId: input.ownerUserId,
        routeId: input.payee.routeId,
        targetAmountAtomic: input.targetAmountAtomic,
      });
      return;
    }
    fail(classifyPreparationFailure(authorized), "authorizing", tid);
    return;
  }
  // Preserve handoff for F4.2 — DO NOT invoke any payment provider here.
  savePending({
    transferId: tid,
    idempotencyKey: loadPending(input.ownerUserId)?.idempotencyKey ?? newIdempotencyKey(),
    attemptToken,
    ownerUserId: input.ownerUserId,
    routeId: input.payee.routeId,
    targetAmountAtomic: input.targetAmountAtomic,
  });
  setState({
    phase: "ready",
    transferId: tid,
    sourceSats: authorized.data.handoff.sourceSats,
    invoiceBolt11: authorized.data.handoff.invoiceBolt11,
    statusLabel: "Approve in Nimiq Pay",
  });
}

export function __memoryVaultForTests(): VaultLike {
  return createMemoryVault();
}
