/**
 * F4.1 — transfer preparation orchestration (client).
 *
 * Connects the Send review/swipe to the existing backend lifecycle:
 * create (idempotent) → prepare → browser Satora swap → durable vault +
 * SDK readback → attach → authorize. STOPS before any Nimiq Pay approval.
 *
 * Safety rules enforced here (never bypassed):
 * - Explicit user intent (swipe) before any creation; quoting never creates.
 * - Stable idempotency key per intent; double-click reuses the in-flight run.
 * - Quote freshness checked locally AND by the server; stale → requote path.
 * - Swap terms must equal the server-approved transfer (chain/token/address/amount).
 * - Vault save + SDK readback BEFORE attach; attach requires recoveryAcknowledged.
 * - Resume inspects authoritative transfer/attempt state + local vault first;
 *   swaps are never regenerated blindly for an existing transfer.
 * - 401 stops with re-auth; unknown outcomes never create a second payment.
 * - This module never calls payLightningInvoice, claim or refund.
 */
import { pairForRouteId, type RouteId } from "@/domain/routes";
import { TRANSFER_STATUSES, isTerminal, type TransferStatus } from "@/domain/transfers";
import { apiRequest, type ApiResult } from "./api";
import type { RecoveryBinding } from "./recovery-vault";
import { humanAmount } from "./transfers-api";

export const PENDING_KEY = "thence.f4.1.pending.v1";

export interface FixedTerms {
  publicId: string;
  amountAtomic: string;
}

export interface PayeeTerms {
  id: string | null;
  destinationId: string | null;
  routeId: RouteId;
  address: string;
  name: string | null;
}

export interface TransferBody {
  routeId: string;
  targetAmountAtomic: string;
  idempotencyKey: string;
  recipientDestinationId?: string;
  requestPublicId?: string;
  recipientName?: string;
  direct?: { asset: string; network: string; address: string };
}

export interface PendingPointer {
  transferId: string;
  idempotencyKey: string;
  attemptToken: string | null;
  ownerUserId: string;
  routeId: string;
  targetAmountAtomic: string;
}

export type PreparationAction =
  | "retry"
  | "requote"
  | "reprepare"
  | "resume"
  | "reauth"
  | "abort"
  | "wait"
  | "accept-reprice";

export interface PreparationIssue {
  title: string;
  body: string;
  retryable: boolean;
  action: PreparationAction;
  /** Owner-reviewed price figures for an explicit accept-the-new-price step.
   * Present only on REPRICED failures whose response carried both figures. */
  reprice?: { quotedSourceSats: string; liveSourceSats: string };
}

export type PreparationStep =
  | "creating"
  | "preparing"
  | "swapping"
  | "saving"
  | "attaching"
  | "authorizing";

/** Build the POST /api/transfers body for exactly one initiation path. */
export function buildTransferBody(input: {
  payee: PayeeTerms;
  fixed: FixedTerms | null;
  targetAmountAtomic: string;
  idempotencyKey: string;
}): TransferBody {
  const { payee, fixed, targetAmountAtomic, idempotencyKey } = input;
  if (!/^[1-9][0-9]*$/.test(targetAmountAtomic)) throw new Error("Invalid amount.");
  if (fixed) {
    if (!fixed.publicId) throw new Error("Invalid request.");
    if (targetAmountAtomic !== fixed.amountAtomic) throw new Error("Amount must equal the request amount.");
    return { routeId: payee.routeId, targetAmountAtomic, idempotencyKey, requestPublicId: fixed.publicId };
  }
  if (payee.destinationId) {
    return {
      routeId: payee.routeId,
      targetAmountAtomic,
      idempotencyKey,
      recipientDestinationId: payee.destinationId,
    };
  }
  const pair = pairForRouteId(payee.routeId);
  if (!pair) throw new Error("Unknown route.");
  const body: TransferBody = {
    routeId: payee.routeId,
    targetAmountAtomic,
    idempotencyKey,
    direct: { asset: pair.asset, network: pair.network, address: payee.address },
  };
  if (payee.name) body.recipientName = payee.name.slice(0, 80);
  return body;
}

/**
 * Bounded wait for client-side reads that have no native timeout
 * (IndexedDB opens/transactions, SDK storage readback). A hang here used
 * to leave the UI on an infinite spinner with no error and no retry;
 * timing out converts it into the normal retryable failure path.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
  });
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };
  // Settle the timer either way and mark the loser handled (no unhandled rejections).
  void promise.then(clear, clear);
  return Promise.race([promise, timeout]);
}

/** Stable idempotency key: crypto-random, durable per intent via pending pointer. */
export function newIdempotencyKey(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === "string" && uuid.length >= 8) return uuid;
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.length >= 16 ? hex : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function savePending(pointer: PendingPointer): void {
  storage()?.setItem(PENDING_KEY, JSON.stringify(pointer));
}

export function loadPending(ownerUserId: string | null): PendingPointer | null {
  if (!ownerUserId) return null;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(PENDING_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingPointer>;
    if (
      typeof parsed.transferId !== "string" ||
      typeof parsed.idempotencyKey !== "string" ||
      typeof parsed.ownerUserId !== "string" ||
      typeof parsed.routeId !== "string" ||
      typeof parsed.targetAmountAtomic !== "string" ||
      parsed.transferId.length === 0 ||
      parsed.idempotencyKey.length < 8
    ) {
      return null;
    }
    if (parsed.ownerUserId !== ownerUserId) return null; // never leak across users
    if (parsed.attemptToken !== null && parsed.attemptToken !== undefined && typeof parsed.attemptToken !== "string") return null;
    return {
      transferId: parsed.transferId,
      idempotencyKey: parsed.idempotencyKey,
      attemptToken: typeof parsed.attemptToken === "string" ? parsed.attemptToken : null,
      ownerUserId: parsed.ownerUserId,
      routeId: parsed.routeId,
      targetAmountAtomic: parsed.targetAmountAtomic,
    };
  } catch {
    return null;
  }
}

export function clearPending(ownerUserId: string | null, transferId?: string): void {
  try {
    const store = storage();
    if (!store) return;
    if (!transferId) {
      // Only clear our own pointer, never another user's.
      const existing = ownerUserId ? loadPending(ownerUserId) : null;
      if (existing) store.removeItem(PENDING_KEY);
      return;
    }
    const raw = store.getItem(PENDING_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PendingPointer>;
    if (parsed.ownerUserId === ownerUserId && parsed.transferId === transferId) store.removeItem(PENDING_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Whether a stored pending pointer is still worth offering for resume.
 * True only for known, non-terminal transfer states. Terminal states must
 * clear the pointer (see continuePendingPayment / sign-out / settlement);
 * unknown states hide the offer without destroying anything.
 */
export function isPendingTransferResumable(status: string): boolean {
  if (!(TRANSFER_STATUSES as readonly string[]).includes(status)) return false;
  return !isTerminal(status as TransferStatus);
}

/**
 * Display amount for the handoff hero. Request-fixed amounts win; otherwise
 * the exact human amount is derived from the transfer's atomic terms (which
 * survive a reload when the calculator is empty); the live-review value is
 * only a fallback. Never fabricates: unrepresentable amounts fall through.
 */
export function displayAmountForHandoff(input: {
  fixedAmount: string | null;
  targetAmountAtomic: string;
  asset: string;
  fallback: string;
}): string {
  if (input.fixedAmount) return input.fixedAmount;
  return humanAmount(input.targetAmountAtomic, input.asset) ?? input.fallback;
}

/** Local quote-freshness gate (server revalidates; this only avoids wasted calls). */
export function isQuoteFresh(validUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (!validUntil) return false;
  const until = Date.parse(validUntil);
  return Number.isFinite(until) && until > now;
}

/** Map backend failure codes to everyday language + safe next action. */
export function classifyPreparationFailure(failure: { kind: string; code: string | null; details?: Record<string, string> | null }): PreparationIssue {
  const { kind, code } = failure;
  if (kind === "unauthorized") {
    return { title: "Your session has ended", body: "Sign in again to continue. Nothing was created or paid.", retryable: false, action: "reauth" };
  }
  if (kind === "rate-limited") {
    return { title: "Too many tries at once", body: "Wait a moment, then try again. Nothing was paid.", retryable: true, action: "retry" };
  }
  if (kind === "network") {
    return { title: "Couldn't reach Thence", body: "Check your connection. If a step already started, continue it instead of starting over — do not resend.", retryable: true, action: "resume" };
  }
  switch (code) {
    case "QUOTE_STALE":
    case "QUOTE_EXPIRED":
      return { title: "That price has expired", body: "Prices only last a few minutes. Refresh the price, then continue.", retryable: true, action: "requote" };
    case "REQUEST_EXPIRED":
    case "REQUEST_CANCELLED":
    case "REQUEST_NOT_FOUND":
    case "SNAPSHOT_MISMATCH":
      return { title: "These payment terms can't be used", body: "The amount or destination no longer matches. Ask for a new link or start over.", retryable: false, action: "abort" };
    case "VERSION_CONFLICT":
      return { title: "Something changed", body: "The price was refreshed elsewhere. We'll re-read it and continue — nothing was paid.", retryable: true, action: "resume" };
    case "NOT_PREPARABLE":
    case "NOT_ATTACHABLE":
    case "NOT_AUTHORIZABLE":
    case "NOT_REQUOTEABLE":
      return { title: "This payment can't continue", body: "Its state changed. Check the latest status before trying again — do not resend.", retryable: true, action: "resume" };
    case "ATTEMPT_IN_PROGRESS":
    case "ATTEMPT_INVALID":
      return { title: "Checking payment — do not resend", body: "A preparation is already in progress. Continue it instead of starting a new one.", retryable: true, action: "resume" };
    case "SWAP_CONFLICT":
    case "SWAP_ALREADY_BOUND":
      return { title: "Checking payment — do not resend", body: "This payment already has a swap. Continue it instead of creating another.", retryable: true, action: "resume" };
    case "SWAP_MISMATCH":
    case "SWAP_STATE_UNEXPECTED":
    case "INVOICE_EXPIRED":
      return { title: "Couldn't verify the swap", body: "The swap doesn't match this payment any more. Do not approve anything.", retryable: false, action: "abort" };
    case "REPRICED_NEEDS_CONFIRMATION": {
      // Owner-explicit acceptance path: the response carries both figures so
      // the UI can show old vs new cost. Without figures there is nothing
      // safe to accept — stay on the generic bounded failure instead.
      const quoted = failure.details?.quotedSourceSats;
      const live = failure.details?.liveSourceSats;
      if (
        typeof quoted === "string" && /^[1-9][0-9]*$/.test(quoted) &&
        typeof live === "string" && /^[1-9][0-9]*$/.test(live) &&
        BigInt(live) > BigInt(quoted)
      ) {
        return {
          title: "The price moved",
          body: "Review the new cost before anything continues. Your recipient still receives exactly the agreed amount.",
          retryable: true,
          action: "accept-reprice",
          reprice: { quotedSourceSats: quoted, liveSourceSats: live },
        };
      }
      return { title: "The price moved", body: "The swap now costs more than the quoted price. Stopping here — nothing was approved.", retryable: false, action: "abort" };
    }
    case "RECOVERY_NOT_CONFIRMED":
      return { title: "Not saved — do not pay", body: "Recovery information wasn't confirmed. Nothing was attached or approved.", retryable: true, action: "retry" };
    case "ALREADY_AUTHORIZED":
      return { title: "Already prepared", body: "This payment was already prepared. Continue to approval.", retryable: true, action: "resume" };
    case "ROUTE_DISABLED":
    case "ROUTE_NOT_QUOTEABLE":
    case "UNSUPPORTED_ROUTE":
    case "UNKNOWN_ROUTE":
      return { title: "Not available right now", body: "This currency can't be paid at the moment.", retryable: false, action: "abort" };
    case "IDEMPOTENCY_CONFLICT":
      return { title: "Checking payment — do not resend", body: "A different payment already used this reference. Continue it instead of starting over.", retryable: true, action: "resume" };
    case "PILOT_ATTEMPTS_EXCEEDED":
      return { title: "You already have this payment in progress", body: "Continue it from Activity instead of starting over — nothing new was created.", retryable: true, action: "resume" };
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_MALFORMED":
    case "SWAP_NOT_FOUND":
      // F8.9: transient provider-side verification failures (seen live as
      // an unmapped 409/404/503 behind the generic fallback). Safe to retry
      // the SAME payment (a fresh swap is created for the same attempt) —
      // never start a new one.
      return { title: "Provider hiccup — safe to retry", body: "The route provider didn't answer cleanly. Nothing was created or paid. Try again to continue the same payment — do not start a new one.", retryable: true, action: "retry" };
    default:
      break;
  }
  if (kind === "invalid") return { title: "Check the details", body: "Something doesn't match. Nothing was paid.", retryable: false, action: "abort" };
  return { title: "Couldn't prepare payment", body: "Nothing was sent or paid. Try again, or continue the existing payment.", retryable: true, action: "retry" };
}

/** True when an existing vault binding may be reused (never regenerate blindly). */
export function canReuseBinding(
  binding: RecoveryBinding,
  current: { transferId: string; destination: string; targetAtomic: string; routeId: string; quoteRevision: number; ownerUserId: string },
): boolean {
  return (
    binding.transferId === current.transferId &&
    binding.destination.toLowerCase() === current.destination.toLowerCase() &&
    binding.targetAtomic === current.targetAtomic &&
    binding.routeId === current.routeId &&
    binding.quoteRevision === current.quoteRevision &&
    binding.ownerUserId === current.ownerUserId &&
    binding.satoraSwapId.length > 0 &&
    binding.attemptToken.length > 0
  );
}

/* ---------- thin API wrappers (reuse existing backend contracts) ---------- */

export interface TransferRecord {
  id: string;
  status: string;
  statusLabel: string;
  routeId: string;
  recipientName: string | null;
  asset: string;
  network: string;
  destination: string;
  targetAmountAtomic: string;
  recipientDestinationId: string | null;
  requestPublicId?: string | null;
  idempotencyKey?: string | null;
  quote: { revision: number; validUntil?: string } | null;
  quotedAt?: string | null;
  quoteExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

type FetchFn = typeof fetch;

export async function createTransfer(
  body: TransferBody,
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ transfer: TransferRecord; deduplicated: boolean }>> {
  return apiRequest("/api/transfers", { method: "POST", body, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

export async function requoteTransfer(
  transferId: string,
  expectedQuoteRevision: number,
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ transfer: TransferRecord }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(transferId)}/requote`, {
    method: "POST",
    body: { expectedQuoteRevision },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export async function prepareTransfer(
  transferId: string,
  expectedQuoteRevision: number,
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ attempt: { id: string; status: string; quoteRevision: number }; attemptToken: string; deduplicated: boolean }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(transferId)}/prepare`, {
    method: "POST",
    body: { expectedQuoteRevision },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export async function attachTransferSwap(
  transferId: string,
  input: { attemptToken: string; expectedQuoteRevision: number; satoraSwapId: string; recoveryAcknowledged: true },
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ attachment: { satoraSwapId: string }; transferStatus: string; deduplicated: boolean }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(transferId)}/attach`, {
    method: "POST",
    body: input,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export async function authorizeTransferHandoff(
  transferId: string,
  attemptToken: string,
  opts: { fetch?: FetchFn; acceptRepricedSourceSats?: string } = {},
): Promise<ApiResult<{ handoff: { attemptId: string; invoiceBolt11: string; sourceSats: string; authorizedAt: string } }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(transferId)}/authorize-handoff`, {
    method: "POST",
    body:
      opts.acceptRepricedSourceSats === undefined
        ? { attemptToken }
        : { attemptToken, acceptRepricedSourceSats: opts.acceptRepricedSourceSats },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export async function fetchTransfer(
  transferId: string,
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ transfer: TransferRecord }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(transferId)}`, { ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

/**
 * Refresh-the-price recovery for a stale-quoted transfer (F8.12): re-read
 * the transfer for its current revision, then re-quote the SAME transfer.
 * Creates nothing (QUOTED-only, revision-checked server-side); failures pass
 * through classified by the caller. Never invents terms: the revision comes
 * from the authoritative transfer record.
 */
export async function refreshQuoteForResume(
  transferId: string,
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ transfer: TransferRecord }>> {
  const cur = await fetchTransfer(transferId, opts);
  if (!cur.ok) return cur;
  return requoteTransfer(transferId, cur.data.transfer.quote?.revision ?? 1, opts);
}

export async function fetchAttempt(
  transferId: string,
  opts: { fetch?: FetchFn } = {},
): Promise<ApiResult<{ attempt: { id: string; status: string; quoteRevision: number; satoraSwapId: string | null } | null; swap: unknown; transferStatus: string }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(transferId)}/attempt`, { ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}
