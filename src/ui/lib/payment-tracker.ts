/**
 * P1 — the single lifecycle driver for a payment (owner × transfer).
 *
 * Replaces the per-hook self-scheduling loop in useSettlement, which:
 * - never backed off (its round counter stayed 0: a provider refresh every
 *   3 s, indefinitely, against a shared 60/min write budget);
 * - died permanently after ~12 s in the background (its visibility listener
 *   was removed after 4 × the delay);
 * - never polled when mounted at AWAITING_NIM_APPROVAL, so approval and
 *   funding went unnoticed on the Send screen;
 * - ran once per mounted hook, so two screens doubled the traffic.
 *
 * Guarantees:
 * - ONE tracker per (owner, transfer) in the page, shared by every
 *   subscriber (Send, Activity, StrictMode double-mounts); stops when the
 *   last subscriber leaves (navigation/reload) and is rebuilt from server
 *   state on the next mount — nothing is restored from client memory, and
 *   no swap, invoice, payment or claim is ever created here.
 * - At most one step in flight; triggers coalesce. Each step is
 *   cancellable (AbortController) and cancelled on stop.
 * - Read path only: POST /reconcile (bounded, read-only provider refresh,
 *   spaced ≥ 5 s) for reconcilable statuses, then GET /reconciliation.
 * - Backoff 3 → 5 → 8 → 13 → 20 → 30 s, reset on any progress (status,
 *   provider status, deadline, claim readiness) and on explicit wake-ups;
 *   capped at 15 s before funding is confirmed; 60 s after a rate limit.
 * - Hidden page: no polling (no wasted budget), but NEVER a permanent stop:
 *   visibilitychange→visible, focus, pageshow (bfcache/host return) and
 *   online all trigger an immediate, coalesced refresh. Returning from the
 *   Nimiq Pay host additionally wakes it via kickPaymentTracker (called by
 *   reportHandoffResult).
 * - Terminal statuses stop scheduling; an explicit kick still re-reads once.
 * - Never claims. Claim execution stays an explicit owner action behind the
 *   existing gates in useSettlement.attemptClaim.
 * - P3: once the provider reports claim activity (clientredeeming /
 *   clientredeemed / serverredeemed) it also asks the server to verify
 *   destination delivery on-chain (POST /verify-settlement, read-only,
 *   spaced >= 15 s) until DELIVERED, so "Delivered" never waits for another
 *   click and never appears without the server's proof.
 */
import { isTerminal, TRANSFER_STATUSES, type TransferStatus } from "@/domain/transfers";
import type { ApiFailureKind, ApiResult } from "./api";
import { getReconciliation, postReconcile, postVerifySettlement, type ReconciliationView } from "./settlement-client";
import { invalidateData } from "./resource";

export const TRACKER_BACKOFF_MS = [3_000, 5_000, 8_000, 13_000, 20_000, 30_000] as const;
export const TRACKER_PRE_FUNDING_CAP_MS = 15_000;
export const TRACKER_RATE_LIMIT_BACKOFF_MS = 60_000;
/** Minimum spacing between step starts (coalesces bursts of wake-ups). */
export const TRACKER_MIN_STEP_SPACING_MS = 2_000;
/** Minimum spacing between provider refreshes (POST /reconcile). */
export const TRACKER_MIN_RECONCILE_SPACING_MS = 5_000;
/** P3: minimum spacing between delivery verifications (POST /verify-settlement). */
export const TRACKER_MIN_VERIFY_SPACING_MS = 15_000;
/** Provider statuses that mean a claim was submitted or settled. */
const CLAIM_PROGRESS: ReadonlySet<string> = new Set(["clientredeeming", "clientredeemed", "serverredeemed"]);
const VERIFIABLE: ReadonlySet<string> = new Set(["SERVER_FUNDED", "CLAIMING"]);

const RECONCILABLE: ReadonlySet<string> = new Set([
  "AWAITING_NIM_APPROVAL",
  "LIGHTNING_HANDOFF",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
]);
const FUNDED: ReadonlySet<string> = new Set(["CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "DELIVERED", "DELIVERED_SHORT"]);

export interface TrackerError {
  kind: ApiFailureKind;
  code: string | null;
}

export interface TrackerSnapshot {
  transferId: string;
  ownerUserId: string;
  /** Last successfully read server view (kept across transient failures). */
  view: ReconciliationView | null;
  /** Failure of the latest GET /reconciliation, if any. */
  readError: TrackerError | null;
  /** Failure of the latest POST /reconcile, if any (non-fatal). */
  refreshError: TrackerError | null;
  /** Local time of the last successful read. */
  readAt: number | null;
  /** True once the server reports a terminal status. */
  terminal: boolean;
  /**
   * P7: latest on-chain delivery verdict from POST /verify-settlement, when one
   * ran. INVALID means the chain evidence contradicts this payment (wrong
   * token, recipient or amount) — the screen must stop saying "confirming".
   */
  settlementVerdict: "VERIFIED" | "PENDING" | "INSUFFICIENT_CONFIRMATIONS" | "INCONCLUSIVE" | "INVALID" | "UNAVAILABLE" | null;
}

export type TrackerListener = (snapshot: TrackerSnapshot) => void;

export interface TrackerDeps {
  getReconciliation: (id: string, opts: { signal: AbortSignal }) => Promise<ApiResult<ReconciliationView>>;
  postReconcile: (id: string, opts: { signal: AbortSignal }) => Promise<ApiResult<unknown>>;
  /** P3: read-only delivery verification; optional so older test deps keep working. */
  postVerifySettlement?: (id: string, opts: { signal: AbortSignal }) => Promise<ApiResult<unknown>>;
}

const defaultDeps: TrackerDeps = { getReconciliation, postReconcile, postVerifySettlement };

function isStatus(value: string): value is TransferStatus {
  return (TRANSFER_STATUSES as readonly string[]).includes(value);
}

function fingerprint(view: ReconciliationView | null): string {
  if (!view) return "";
  return [view.transfer.status, view.latest.providerStatus, view.latest.claimReady, view.latest.claimDeadlineAt ?? view.swap?.claimDeadline ?? "", view.latest.identityMismatch === true].join("|");
}

class PaymentTracker {
  private readonly listeners = new Set<TrackerListener>();
  private snapshot: TrackerSnapshot;
  private backoffIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private rerunRequested = false;
  private lastStepAt = -Infinity;
  private lastReconcileAt = -Infinity;
  private lastVerifyAt = -Infinity;
  private rateLimited = false;
  private stopped = false;
  private readonly onWake = () => this.kick();
  private readonly onVisibility = () => {
    if (!isHidden()) this.kick();
  };

  constructor(
    readonly transferId: string,
    readonly ownerUserId: string,
    private readonly deps: TrackerDeps,
  ) {
    this.snapshot = { transferId, ownerUserId, view: null, readError: null, refreshError: null, readAt: null, terminal: false, settlementVerdict: null };
  }

  current(): TrackerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: TrackerListener): () => void {
    this.listeners.add(listener);
    if (this.snapshot.view || this.snapshot.readError) listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  start(): void {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.onWake);
      window.addEventListener("pageshow", this.onWake);
      window.addEventListener("online", this.onWake);
    }
    void this.step();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.inFlight?.abort();
    this.inFlight = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.onWake);
      window.removeEventListener("pageshow", this.onWake);
      window.removeEventListener("online", this.onWake);
    }
    this.listeners.clear();
  }

  /** Wake now (coalesced, spacing-limited); resets the backoff. */
  kick(): void {
    if (this.stopped) return;
    this.backoffIndex = 0;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    const wait = Math.max(0, this.lastStepAt + TRACKER_MIN_STEP_SPACING_MS - Date.now());
    this.schedule(wait);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step();
    }, ms);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }

  private async step(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    // Hidden: pause without scheduling. The visibility/focus/pageshow
    // listeners resume it — tracking never ends because of backgrounding.
    if (isHidden()) return;
    const controller = new AbortController();
    this.inFlight = controller;
    this.lastStepAt = Date.now();
    const before = fingerprint(this.snapshot.view);
    const statusBefore = this.snapshot.view?.transfer.status ?? null;
    let refreshError: TrackerError | null = null;
    try {
      const knownStatus = this.snapshot.view?.transfer.status ?? null;
      const mayRefresh = knownStatus === null || RECONCILABLE.has(knownStatus);
      if (mayRefresh && Date.now() - this.lastReconcileAt >= TRACKER_MIN_RECONCILE_SPACING_MS) {
        this.lastReconcileAt = Date.now();
        const refreshed = await this.deps.postReconcile(this.transferId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!refreshed.ok && refreshed.kind !== "aborted") refreshError = { kind: refreshed.kind, code: refreshed.code };
      }
      // P3: claim activity seen on the last read → verify delivery on-chain
      // (server-side), so the read below already reflects DELIVERED.
      const known = this.snapshot.view;
      if (
        this.deps.postVerifySettlement &&
        known &&
        VERIFIABLE.has(known.transfer.status) &&
        CLAIM_PROGRESS.has(known.latest.providerStatus) &&
        Date.now() - this.lastVerifyAt >= TRACKER_MIN_VERIFY_SPACING_MS
      ) {
        this.lastVerifyAt = Date.now();
        const verified = await this.deps.postVerifySettlement(this.transferId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!verified.ok && verified.kind === "rate-limited") refreshError = { kind: verified.kind, code: verified.code };
        // The route answers INVALID with 422; any other outcome is carried in the body.
        const verdict = verified.ok
          ? ((verified.data as { settlement?: { verdict?: TrackerSnapshot["settlementVerdict"] } }).settlement?.verdict ?? null)
          : verified.status === 422
            ? "INVALID"
            : verified.status === 503
              ? "UNAVAILABLE"
              : null;
        if (verdict !== null) this.snapshot = { ...this.snapshot, settlementVerdict: verdict };
      }
      const read = await this.deps.getReconciliation(this.transferId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      this.rateLimited = refreshError?.kind === "rate-limited" || (!read.ok && read.kind === "rate-limited");
      if (read.ok) {
        const status = read.data.transfer.status;
        this.snapshot = {
          ...this.snapshot,
          view: read.data,
          readError: null,
          refreshError,
          readAt: Date.now(),
          terminal: isStatus(status) && isTerminal(status),
        };
      } else if (read.kind !== "aborted") {
        this.snapshot = { ...this.snapshot, readError: { kind: read.kind, code: read.code }, refreshError };
      }
    } catch {
      this.snapshot = { ...this.snapshot, readError: { kind: "network", code: null }, refreshError };
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    if (this.stopped) return;
    this.backoffIndex = fingerprint(this.snapshot.view) !== before ? 0 : Math.min(this.backoffIndex + 1, TRACKER_BACKOFF_MS.length - 1);
    this.emit();
    // A new server status (e.g. CLAIMING -> DELIVERED) re-reads every mounted
    // list (Activity, Home), so no screen keeps an old snapshot. Read-only.
    if (statusBefore !== null && this.snapshot.view && this.snapshot.view.transfer.status !== statusBefore) invalidateData();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.schedule(TRACKER_MIN_STEP_SPACING_MS);
      return;
    }
    // Terminal or signed out: nothing more to learn until an explicit kick.
    if (this.snapshot.terminal || this.snapshot.readError?.kind === "unauthorized" || this.snapshot.readError?.kind === "not-found") return;
    let delay: number = TRACKER_BACKOFF_MS[this.backoffIndex] ?? TRACKER_BACKOFF_MS[TRACKER_BACKOFF_MS.length - 1]!;
    const status = this.snapshot.view?.transfer.status ?? null;
    if (status === null || !FUNDED.has(status)) delay = Math.min(delay, TRACKER_PRE_FUNDING_CAP_MS);
    if (this.rateLimited) delay = Math.max(delay, TRACKER_RATE_LIMIT_BACKOFF_MS);
    this.schedule(delay);
  }
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

const registry = new Map<string, PaymentTracker>();
const keyOf = (ownerUserId: string, transferId: string) => `${ownerUserId}:${transferId}`;

/**
 * Subscribe to the shared tracker for (owner, transfer), creating and
 * starting it on first use. The returned function unsubscribes; the last
 * unsubscribe stops and discards the tracker (cancelling any request).
 */
export function subscribePaymentTracker(
  transferId: string,
  ownerUserId: string,
  listener: TrackerListener,
  deps: TrackerDeps = defaultDeps,
): () => void {
  const key = keyOf(ownerUserId, transferId);
  let tracker = registry.get(key);
  const created = !tracker;
  if (!tracker) {
    tracker = new PaymentTracker(transferId, ownerUserId, deps);
    registry.set(key, tracker);
  }
  const unsubscribe = tracker.subscribe(listener);
  if (created) tracker.start();
  const owned = tracker;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    unsubscribe();
    if (owned.size === 0 && registry.get(key) === owned) {
      owned.stop();
      registry.delete(key);
    }
  };
}

/** Wake every tracker for this transfer now (e.g. back from Nimiq Pay, "Check again"). */
export function kickPaymentTracker(transferId: string): void {
  for (const tracker of registry.values()) if (tracker.transferId === transferId) tracker.kick();
}

/** Diagnostics/tests: number of live trackers. */
export function activePaymentTrackerCount(): number {
  return registry.size;
}

/** Test seam: stop and drop every tracker. */
export function resetPaymentTrackersForTests(): void {
  for (const tracker of registry.values()) tracker.stop();
  registry.clear();
}
