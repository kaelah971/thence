/**
 * Live exact-receive quotes (POST /api/quotes, src/lib/quotes.ts).
 *
 * Money honesty rules for every screen that uses this:
 * - The quote prices the Lightning payment (in sats) that delivers the exact
 *   amount. Sats are NOT the person's NIM debit and are never labelled NIM.
 * - There is no NIM↔token rate here; the NIM amount is shown by Nimiq Pay.
 * - `validUntil` is a local freshness window. Past it, the price is stale and
 *   must not be shown as current.
 * - Quoting creates nothing: no transfer, no invoice, no payment.
 */
import { atomicToDecimal } from "@/domain/money";
import { apiRequest, type ApiFailureKind, type ApiOptions, type ApiResult } from "./api";
import { groupOperand, toAtomic, type AmountIssue } from "./calculator";
import type { Availability } from "./routes-api";

export interface QuoteInput {
  routeId: string;
  /** Exact amount the recipient receives, in the token's smallest unit. */
  targetAmountAtomic: string;
  /** Payment-request public id: the server enforces the immutable terms. */
  requestId?: string | null;
}

export interface ApiQuote {
  routeId: string;
  asset: string;
  network: string;
  /** Canonical EVM chain id (server-provided, string). */
  chainId?: string | null;
  targetAmountAtomic: string;
  targetAmount: string;
  netTargetAmountAtomic: string;
  exact: true;
  sourceAmountSats: string;
  sourceAmountPreFeeSats: string;
  sourceChain: "Lightning";
  fees: { networkFeeSats: number; gaslessNetworkFeeSats: number; protocolFeeSats: number; protocolFeeRate: number; unit: "sats" };
  limits: { minSats: number; maxSats: number };
  observedAt: string;
  validUntil: string;
  availability: "available";
  settlementProven: false;
  warnings: string[];
}

type Opts = Pick<ApiOptions, "signal" | "fetch">;

export function requestQuote(input: QuoteInput, opts: Opts = {}): Promise<ApiResult<{ quote: ApiQuote }>> {
  const body: Record<string, string> = { routeId: input.routeId, targetAmountAtomic: input.targetAmountAtomic };
  if (input.requestId) body["requestId"] = input.requestId;
  return apiRequest<{ quote: ApiQuote }>("/api/quotes", { ...opts, method: "POST", body });
}

/** Identity of a quote request. Any change (person, wallet, amount, currency) is a new quote. */
export function quoteKey(input: QuoteInput, payTo: string): string {
  return JSON.stringify([input.routeId, input.targetAmountAtomic, input.requestId ?? null, payTo.trim().toLowerCase()]);
}

/* ---------- amount → quote input ---------- */

export type AmountBlock = "empty" | "zero" | "negative" | "divide-by-zero" | "too-large" | "precision" | "unavailable" | "checking" | "unknown";

/**
 * Decide whether an entered amount may be priced, and convert it exactly.
 * `tokenDecimals` is the verified precision from the live catalogue (null
 * when the route isn't payable). Nothing is rounded here: an amount that
 * can't be represented exactly is blocked as "precision".
 */
export function checkSendAmount(input: {
  value: string | null;
  issue: AmountIssue | null;
  availability: Availability | "loading";
  tokenDecimals: number | null;
}): { ok: true; atomic: string } | { ok: false; block: AmountBlock } {
  if (input.issue) return { ok: false, block: input.issue };
  if (input.availability === "loading") return { ok: false, block: "checking" };
  if (input.availability === "unknown") return { ok: false, block: "unknown" };
  if (input.availability !== "available" || input.tokenDecimals === null) return { ok: false, block: "unavailable" };
  const atomic = input.value ? toAtomic(input.value, input.tokenDecimals) : null;
  return atomic ? { ok: true, atomic } : { ok: false, block: "precision" };
}

/* ---------- freshness ---------- */

export interface Freshness {
  expired: boolean;
  secondsLeft: number;
  /** "4:05" */
  countdown: string;
}

export function quoteFreshness(validUntil: string, now: number): Freshness {
  const until = Date.parse(validUntil);
  const secondsLeft = Number.isFinite(until) ? Math.max(0, Math.floor((until - now) / 1000)) : 0;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  return { expired: secondsLeft <= 0, secondsLeft, countdown: `${minutes}:${seconds}` };
}

/* ---------- state ---------- */

export type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: ApiQuote; freshness: Freshness }
  | { status: "expired"; quote: ApiQuote }
  | { status: "error"; problem: QuoteProblem };

export interface SettledQuote {
  key: string;
  result: ApiResult<{ quote: ApiQuote }>;
}

/**
 * Pure state resolution. A settled response only counts when it belongs to
 * the CURRENT request key, so a slow answer for an earlier amount, person or
 * wallet can never be shown as the price for the latest selection.
 */
export function resolveQuoteState(currentKey: string | null, settled: SettledQuote | null, now: number, expected?: { routeId: string; targetAmountAtomic: string }): QuoteState {
  if (!currentKey) return { status: "idle" };
  if (!settled || settled.key !== currentKey) return { status: "loading" };
  const { result } = settled;
  if (!result.ok) {
    if (result.kind === "aborted") return { status: "loading" };
    return { status: "error", problem: quoteProblem(result) };
  }
  const quote = result.data.quote;
  // Defence in depth: the server already rejects inexact quotes.
  if (expected && (quote.routeId !== expected.routeId || quote.netTargetAmountAtomic !== expected.targetAmountAtomic)) {
    return { status: "error", problem: quoteProblem({ kind: "server", code: "INEXACT_QUOTE" }) };
  }
  const freshness = quoteFreshness(quote.validUntil, now);
  return freshness.expired ? { status: "expired", quote } : { status: "ready", quote, freshness };
}

/* ---------- problems in everyday language ---------- */

export type QuoteProblemKind = "below-minimum" | "above-maximum" | "unavailable" | "provider" | "request" | "session" | "busy" | "invalid";

export interface QuoteProblem {
  kind: QuoteProblemKind;
  title: string;
  body: string;
  /** Refreshing the same price check may succeed. */
  retryable: boolean;
  /** The fix is a different amount. */
  changeAmount: boolean;
}

const UNAVAILABLE = new Set(["ROUTE_DISABLED", "ROUTE_NOT_QUOTEABLE", "UNSUPPORTED_ROUTE", "UNKNOWN_ROUTE"]);
const REQUEST = new Set(["REQUEST_EXPIRED", "REQUEST_CANCELLED", "REQUEST_NOT_FOUND", "REQUEST_NOT_ACTIVE", "SNAPSHOT_MISMATCH"]);

export function quoteProblem(failure: { kind: ApiFailureKind; code: string | null }): QuoteProblem {
  const { kind, code } = failure;
  const make = (k: QuoteProblemKind, title: string, body: string, retryable = false, changeAmount = false): QuoteProblem => ({ kind: k, title, body, retryable, changeAmount });
  if (code === "BELOW_MINIMUM") return make("below-minimum", "That amount is too small", "It's below the smallest payment that can be delivered right now. Try a larger amount.", false, true);
  if (code === "ABOVE_MAXIMUM") return make("above-maximum", "That amount is too large", "It's above the largest payment that can be delivered right now. Try a smaller amount.", false, true);
  if (code && UNAVAILABLE.has(code)) return make("unavailable", "Not available right now", "This currency can't be paid at the moment. Choose another wallet or try again later.");
  if (code && REQUEST.has(code)) return make("request", "This request can't be paid", "It may have expired or been cancelled. Ask for a new link.");
  if (code === "BAD_AMOUNT" || code === "BAD_BODY") return make("invalid", "Check the amount", "That amount can't be priced. Change it and try again.", false, true);
  if (kind === "unauthorized") return make("session", "Your session has ended", "Sign in again to check the price.");
  if (kind === "rate-limited") return make("busy", "Too many price checks", "Wait a moment, then refresh the price.", true);
  return make("provider", "Couldn't get a price right now", "Nothing was sent. Try again in a moment.", true);
}

/* ---------- display ---------- */

export function formatSats(sats: string | number): string {
  return `${groupOperand(String(sats))} sats`;
}

export function totalFeeSats(quote: Pick<ApiQuote, "fees">): number {
  return quote.fees.networkFeeSats + quote.fees.gaslessNetworkFeeSats + quote.fees.protocolFeeSats;
}

const WARNING_COPY: Array<[RegExp, string]> = [[/close to the route minimum/i, "This is close to the smallest amount that can be sent, so the price may move before you approve."]];

/** Provider/backend warnings rewritten in plain language; unknown ones get a safe generic line. */
export function quoteWarnings(quote: Pick<ApiQuote, "warnings">): string[] {
  return quote.warnings.map((w) => WARNING_COPY.find(([re]) => re.test(w))?.[1] ?? "The price may change before you approve.");
}

export interface QuoteRow {
  label: string;
  value: string;
  sub?: string;
}

/**
 * Review rows for a live quote. Every sats value is labelled as Lightning
 * sats; the NIM row never carries a number because no NIM price exists here.
 */
export function quoteRows(quote: ApiQuote, displayDecimals: number, tokenDecimals: number): QuoteRow[] {
  const receive = atomicToDecimal(quote.netTargetAmountAtomic, tokenDecimals);
  const [intPart = "0", frac = ""] = receive.split(".");
  const shown = `${groupOperand(intPart)}${displayDecimals > 0 || frac ? `.${frac.padEnd(displayDecimals, "0")}` : ""}`;
  const fee = totalFeeSats(quote);
  return [
    { label: "They receive", value: `${shown} ${quote.asset}`, sub: "Exact amount" },
    { label: "Lightning needed", value: formatSats(quote.sourceAmountSats), sub: fee > 0 ? `Includes ${formatSats(fee)} in fees` : "No added fees" },
    { label: "Your NIM cost", value: "Shown by Nimiq Pay", sub: "Before you approve" },
  ];
}
