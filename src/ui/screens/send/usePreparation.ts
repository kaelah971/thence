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
  refreshQuoteForResume,
  requoteTransfer,
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

/**
 * F8.12 — end-to-end preparation deadline (independent of individual awaits).
 * The whole run must resolve within this budget or fail loudly with retry;
 * a newer run or the deadline invalidates the generation, and every later
 * dispatch (progress UI, retries, attach, authorize) becomes a no-op so a
 * late completion can neither overwrite the timeout state nor trigger
 * authorization after the deadline.
 */
export const RUN_TIMEOUT_MS = 90_000;
/** Gateway network calls (fetch status, prepare): fail fast, the run deadline stays the backstop. */
export const NETWORK_TIMEOUT_MS = 30_000;
/** Browser-side swap creation via the provider SDK (unfunded until approved). */
export const SWAP_CREATE_TIMEOUT_MS = 60_000;

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
  resumeWithInput: (input: PreparationInput, transferId: string) => Promise<void>;
  /** Explicit refresh-the-price recovery: re-quote the SAME failed transfer
   * (no new transfer, no budget impact) and continue it with fresh terms. */
  requoteAndRetry: () => Promise<void>;
  /** Explicit accept-the-new-price recovery: authorize the SAME failed
   * transfer with the exact reviewed live sats. The server re-reads live
   * state and refuses anything above the accepted figure. */
  acceptReprice: (acceptedSourceSats: string) => Promise<void>;
  retry: () => Promise<void>;
  reset: () => void;
  pendingFor: (ownerUserId: string | null) => PendingPointer | null;
} {
  const [state, setPreparationState] = useState<PreparationPhase>({ phase: "idle" });
  const inflight = useRef(false);
  const lastInput = useRef<PreparationInput | null>(null);
  /** F8.12: run generation. Bumped on every run start, timeout, and reset —
   * late async completions compare against it and become no-ops. */
  const generationRef = useRef(0);
  /** F8.12: end-to-end deadline timer, cleared on settle or reset. */
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const baseFail = useCallback((issue: PreparationIssue, step: PreparationStep, transferId: string | null) => {
    setPreparationState({ phase: "failed", issue, step, transferId });
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
      // F8.12: generation-guarded dispatch. `alive` gates every dispatch
      // below (progress UI, retries, attach, authorize): a newer run, a
      // reset, or the end-to-end deadline invalidates this generation, so
      // late completions can neither overwrite the timeout state nor
      // trigger authorization after the deadline. These shadow the outer
      // setters within this run only; reset/outer logic is untouched.
      const runGen = ++generationRef.current;
      const alive = (): boolean => generationRef.current === runGen;
      const setState = (next: PreparationPhase): void => {
        if (alive()) setPreparationState(next);
      };
      const fail = (issue: PreparationIssue, step: PreparationStep, transferId: string | null): void => {
        if (alive()) baseFail(issue, step, transferId);
      };
      const deadline = setTimeout(() => {
        generationRef.current += 1;
        inflight.current = false;
        baseFail(
          {
            title: "Couldn't continue",
            body: "This is taking too long. Nothing was sent or approved. Try again when your connection is stable.",
            retryable: true,
            action: "retry",
          },
          "preparing",
          activeTransferId,
        );
      }, RUN_TIMEOUT_MS);
      deadlineRef.current = deadline;
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
          // Bounded: a hanging status read must fail fast, not stall the run.
          const current = await withTimeout(fetchTransfer(transferId), NETWORK_TIMEOUT_MS, "transfer status");
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
          const prepared = await withTimeout(prepareTransfer(tid, quoteRevision), NETWORK_TIMEOUT_MS, "prepare handoff");
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
                isAlive: alive,
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
        const transferNow = await withTimeout(fetchTransfer(tid), NETWORK_TIMEOUT_MS, "freshness check");
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
              isAlive: alive,
            });
            return;
          }
        }

        // 5 — browser-side swap (exact receive; secrets never leave the device).
        // Never create a swap after the deadline: it would be a new provider-side
        // obligation superseded before the user ever sees it.
        if (!alive()) return;
        setState({ phase: "working", step: "swapping", message: STEP_COPY.swapping, transferId: tid });
        let swap: { satoraSwapId: string; bolt11Invoice: string; paymentHash: string; sourceSats: string; targetAtomic: string };
        try {
          // Bounded like every other network call: an unresponsive provider SDK
          // must surface as a retryable error instead of an endless spinner.
          // A late success is harmless: the swap is unfunded until approved.
          swap = await withTimeout(
            createExactReceiveSwap({
              targetAddress: transferDestination,
              tokenAddress: input.tokenAddress as string,
              evmChainId: input.evmChainId as number,
              targetAmountAtomic: transferTargetAtomic,
            }),
            SWAP_CREATE_TIMEOUT_MS,
            "create swap",
          );
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
        const saved = await withTimeout(saveBindingDurable(binding), VAULT_READ_TIMEOUT_MS, "recovery vault save");
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
          isAlive: alive,
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
        // Only release the lock if no newer run claimed it (a retry started
        // after a timeout must not be unlocked by the stale run finishing).
        if (generationRef.current === runGen) {
          inflight.current = false;
        }
        if (deadlineRef.current === deadline) {
          clearTimeout(deadline);
          deadlineRef.current = null;
        }
      }
    },
    [baseFail],
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

  const requoteAndRetry = useCallback(async () => {
    const tid = state.phase === "failed" ? state.transferId : null;
    const input = lastInput.current;
    if (!tid || !input) return;
    // Same transfer, fresh price: the server re-locks terms without creating
    // anything (QUOTED-only, revision-checked). The resumed run below then
    // re-reads the new revision from the transfer itself.
    setPreparationState({ phase: "working", step: "preparing", message: STEP_COPY.preparing, transferId: tid });
    const rq = await withTimeout(refreshQuoteForResume(tid), NETWORK_TIMEOUT_MS, "requote");
    if (!rq.ok) {
      baseFail(classifyPreparationFailure(rq), "preparing", tid);
      return;
    }
    await run(input, tid);
  }, [run, state, baseFail]);

  const acceptReprice = useCallback(async (acceptedSourceSats: string) => {
    const tid = state.phase === "failed" ? state.transferId : null;
    const input = lastInput.current;
    const pending = loadPending(input?.ownerUserId ?? null);
    const token = pending !== null && tid !== null && pending.transferId === tid ? pending.attemptToken : null;
    if (!tid || !input || !token) return;
    if (!/^[1-9][0-9]*$/.test(acceptedSourceSats)) return;
    await authorizeWithReviewedPrice({
      tid,
      attemptToken: token,
      acceptedSourceSats,
      input,
      setState: setPreparationState,
      fail: baseFail,
      isAlive: () => true,
    });
  }, [state, baseFail]);

  const resume = useCallback(
    async (transferId: string, ownerUserId: string) => {
      const input = lastInput.current;
      if (!input) return;
      await run({ ...input, ownerUserId }, transferId);
    },
    [run],
  );

  // Deep-link resume from Activity on a fresh page load: there is no
  // in-memory prior run, so resume() would silently no-op and leave the
  // handoff step on its idle spinner. The caller rebuilt the exact input
  // from the authoritative transfer, so run with the SAME transfer id.
  // Never creates a new transfer: resumeTransferId skips creation.
  const resumeWithInput = useCallback(
    async (input: PreparationInput, transferId: string) => {
      await run(input, transferId);
    },
    [run],
  );

  const reset = useCallback(() => {
    lastInput.current = null;
    // Invalidate any in-flight run: its late completions become no-ops.
    generationRef.current += 1;
    // Free the duplicate-swipe lock too: the retired run's own finally can
    // no longer unlock a future run (generation mismatch), so leaving it
    // set would brick explicit retries after an orphaned run stalls short
    // of its own timeout. Continue-after-interruption depends on this.
    inflight.current = false;
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
    setPreparationState({ phase: "idle" });
  }, []);

  const pendingFor = useCallback((ownerUserId: string | null) => loadPending(ownerUserId), []);

  return { state, start: run, resume, resumeWithInput, requoteAndRetry, acceptReprice, retry, reset, pendingFor };
}

export async function attachAndAuthorize(args: {
  tid: string;
  attemptToken: string;
  quoteRevision: number;
  satoraSwapId: string;
  sourceSatsHint: string | null;
  setState: (s: PreparationPhase) => void;
  fail: (issue: PreparationIssue, step: PreparationStep, transferId: string | null) => void;
  input: PreparationInput;
  invoiceHint?: string;
  /** F8.12: checked before attach and authorize so a superseded or timed-out
   * run can never bind a swap or authorize a handoff after the deadline. */
  isAlive: () => boolean;
}): Promise<void> {
  const { tid, quoteRevision, satoraSwapId, setState, fail, input, isAlive } = args;
  let attemptToken = args.attemptToken;
  setState({ phase: "working", step: "attaching", message: STEP_COPY.attaching, transferId: tid });
  if (!isAlive()) return;
  // Bounded like every other network hop: a late completion converges via
  // the idempotent attach path instead of racing the timeout UI.
  const attachOnce = (token: string) =>
    withTimeout(attachTransferSwap(tid, {
      attemptToken: token,
      expectedQuoteRevision: quoteRevision,
      satoraSwapId,
      recoveryAcknowledged: true,
    }), NETWORK_TIMEOUT_MS, "attach swap");
  let attached = await attachOnce(attemptToken);
  if (!attached.ok && attached.code === "ATTEMPT_INVALID") {
    // Stale handle: this run holds a token the server no longer honors
    // (prepared before an interruption window, since expired server-side;
    // raw tokens are hash-stored, never re-issued). Re-prepare the SAME
    // transfer + revision ONCE for a fresh handle and retry the SAME swap:
    // never a new transfer, never a new swap here.
    const re = await withTimeout(prepareTransfer(tid, quoteRevision), NETWORK_TIMEOUT_MS, "prepare handoff");
    if (re.ok && typeof re.data.attemptToken === "string" && re.data.attemptToken.length > 0) {
      attemptToken = re.data.attemptToken;
      savePending({
        transferId: tid,
        idempotencyKey: loadPending(input.ownerUserId)?.idempotencyKey ?? newIdempotencyKey(),
        attemptToken,
        ownerUserId: input.ownerUserId,
        routeId: input.payee.routeId,
        targetAmountAtomic: input.targetAmountAtomic,
      });
      setState({ phase: "working", step: "attaching", message: STEP_COPY.attaching, transferId: tid });
      if (!isAlive()) return;
      attached = await attachOnce(attemptToken);
    } else if (!re.ok) {
      // Recovery itself refused: surface the error whose action unblocks
      // the user. A stale quote offers refresh-the-price (retrying the
      // dead handle would loop forever); anything else keeps the original
      // retryable failure so Try again self-heals once gates re-arm.
      const reIssue = classifyPreparationFailure(re);
      fail(reIssue.action === "requote" ? reIssue : classifyPreparationFailure(attached), "attaching", tid);
      return;
    }
  }
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
  if (!isAlive()) return;
  // Bounded like every other network hop: a late success converges through
  // ALREADY_AUTHORIZED instead of racing the timeout UI.
  const authorized = await withTimeout(authorizeTransferHandoff(tid, attemptToken), NETWORK_TIMEOUT_MS, "authorize handoff");
  if (!authorized.ok) {
    // 409 ALREADY_AUTHORIZED converges to ready (single authorization held).
    if (authorized.code === "ALREADY_AUTHORIZED") {
      const current = await withTimeout(fetchTransfer(tid), NETWORK_TIMEOUT_MS, "transfer status");
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

/**
 * Owner-explicit price acceptance (F8.12): authorize the SAME transfer +
 * attempt with the exact reviewed live sats. The server re-reads live swap
 * state inside the authorization transaction and refuses any figure above
 * the accepted one, so cost can never silently increase here. Nothing new
 * is created: same transfer, same attempt, same swap.
 */
export async function authorizeWithReviewedPrice(args: {
  tid: string;
  attemptToken: string;
  acceptedSourceSats: string;
  input: PreparationInput;
  setState: (s: PreparationPhase) => void;
  fail: (issue: PreparationIssue, step: PreparationStep, transferId: string | null) => void;
  isAlive: () => boolean;
}): Promise<void> {
  const { tid, attemptToken, acceptedSourceSats, input, setState, fail, isAlive } = args;
  setState({ phase: "working", step: "authorizing", message: STEP_COPY.authorizing, transferId: tid });
  if (!isAlive()) return;
  const res = await withTimeout(
    authorizeTransferHandoff(tid, attemptToken, { acceptRepricedSourceSats: acceptedSourceSats }),
    NETWORK_TIMEOUT_MS,
    "authorize handoff",
  );
  if (!res.ok) {
    fail(classifyPreparationFailure(res), "authorizing", tid);
    return;
  }
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
    sourceSats: res.data.handoff.sourceSats,
    invoiceBolt11: res.data.handoff.invoiceBolt11,
    statusLabel: "Approve in Nimiq Pay",
  });
}

export function __memoryVaultForTests(): VaultLike {
  return createMemoryVault();
}
