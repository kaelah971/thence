/**
 * F4.2 — thin typed adapter for the verified Nimiq Pay Lightning capability.
 *
 * Verified against @nimiq/mini-app-sdk 0.2.4 (dist/provider.d.ts):
 * - `payLightningInvoice(request: { invoice: string })`
 *   → `Promise<LightningPaymentResult | ErrorResponse>`
 * - `LightningPaymentResult = { hash: string; swapId: string }`
 * - `ErrorResponse = { error: { type: string; message: string } }`
 *   (legacy shape; also surfaced as thrown NimiqProviderError)
 * - `NimiqProvider.WALLET_METHODS` includes "payLightningInvoice".
 * - Doc: "Submit a self-custodial NIM or USDT to BTC Lightning payment.
 *   Success means the payment transaction was submitted."
 *
 * Rules:
 * - The authorized BOLT11 invoice is passed through byte-identical.
 *   Never reconstructed, never modified, never confused with a NIM amount.
 * - Only `cancelled` is reported when the host definitively establishes
 *   user rejection (PERMISSION_DENIED). Timeouts and interruptions are
 *   `unknown` — they do NOT prove failure.
 * - No retry lives here. One call per explicit user action; replay safety
 *   lives in useHandoff.
 */
import { NimiqProviderError, type NimiqProvider } from "@nimiq/mini-app-sdk";
import { HostUnavailableError, classifyProviderError } from "./nimiq-provider";

/** Host subset F4.2 needs. `payLightningInvoice` is optional: older hosts lack it. */
export interface LightningCapableProvider {
  payLightningInvoice: NimiqProvider["payLightningInvoice"];
}

export type HostPaymentResult =
  | { kind: "initiated"; hash: string; swapId: string }
  | { kind: "cancelled" }
  | { kind: "unknown"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "invalid"; reason: string };

/** Safe, non-secret observability for one native handoff call. */
export interface PaymentDiagnostics {
  providerErrorType: string | null;
  providerErrorCode: number | null;
  durationMs: number;
  normalizedOutcome: "cancelled" | "initiated" | "unknown";
  hasHash: boolean;
  hasSwapId: boolean;
}

/** True only when the host exposes a callable Lightning payment method. */
export function hasLightningPaymentSupport(provider: unknown): provider is LightningCapableProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    typeof (provider as Record<string, unknown>)["payLightningInvoice"] === "function"
  );
}

const INVOICE_RE = /^(lnbc|lnbcrt|lntb|lntbs)/i;

/** Validate without normalizing: the caller must supply the exact authorized string. */
export function assertAuthorizedInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0 || invoice.length > 8192) {
    throw new Error("Invalid invoice.");
  }
  if (!INVOICE_RE.test(invoice.trim())) throw new Error("Invoice is not a valid BOLT11 invoice.");
}

function isLegacyErrorResponse(value: unknown): value is { error: { type: string; message: string } } {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return typeof record["type"] === "string" && typeof record["message"] === "string";
}

function safeProviderError(error: unknown): Pick<PaymentDiagnostics, "providerErrorType" | "providerErrorCode"> {
  const providerError = NimiqProviderError.from(error);
  const type = providerError?.type;
  return {
    // Provider types are enum-like. Do not log arbitrary SDK error text or
    // data, and do not let a malformed host value become a log injection.
    providerErrorType: typeof type === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(type) ? type : null,
    providerErrorCode: typeof providerError?.code === "number" && Number.isInteger(providerError.code) ? providerError.code : null,
  };
}

function safeProviderDataPresence(error: unknown): { hasHash: boolean; hasSwapId: boolean } {
  const data = NimiqProviderError.from(error)?.data;
  if (typeof data !== "object" || data === null) return { hasHash: false, hasSwapId: false };
  const record = data as Record<string, unknown>;
  return {
    hasHash: typeof record["hash"] === "string" && record["hash"].length > 0,
    hasSwapId: typeof record["swapId"] === "string" && record["swapId"].length > 0,
  };
}

function normalizedOutcome(result: HostPaymentResult): PaymentDiagnostics["normalizedOutcome"] {
  return result.kind === "cancelled" ? "cancelled" : result.kind === "initiated" ? "initiated" : "unknown";
}

/** Map a definitive host denial onto cancellation; everything else stays uncertain. */
export function mapHostDenial(error: unknown): HostPaymentResult {
  const failure = classifyProviderError(error);
  switch (failure) {
    case "rejected":
      return { kind: "cancelled" };
    case "unavailable":
      return { kind: "unavailable", reason: error instanceof Error ? error.message : "Nimiq Pay is not available here." };
    case "unsupported":
      return { kind: "unsupported", reason: "This version of Nimiq Pay can't pay Lightning invoices." };
    case "invalid":
      return { kind: "invalid", reason: "Nimiq Pay rejected the payment request." };
    case "network":
      return { kind: "unknown", reason: "The payment response was interrupted. Checking payment — do not resend." };
    default:
      return { kind: "unknown", reason: "The payment outcome is unknown. Checking payment — do not resend." };
  }
}

/**
 * Invoke the host Lightning payment exactly once with the authorized invoice.
 * The invoice string is forwarded byte-identical (`{ invoice }` — the only
 * documented argument shape). Never retries; callers handle replay safety.
 */
export async function payAuthorizedInvoice(
  provider: LightningCapableProvider,
  invoice: string,
  opts: { timeoutMs?: number; onDiagnostics?: (diagnostics: PaymentDiagnostics) => void } = {},
): Promise<HostPaymentResult> {
  assertAuthorizedInvoice(invoice);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let emitted = false;
  const finish = (
    result: HostPaymentResult,
    error: unknown = null,
    presence: { hasHash?: boolean; hasSwapId?: boolean } = {},
  ): HostPaymentResult => {
    if (!emitted) {
      emitted = true;
      const providerError = error === null ? { providerErrorType: null, providerErrorCode: null } : safeProviderError(error);
      const providerDataPresence = error === null ? { hasHash: false, hasSwapId: false } : safeProviderDataPresence(error);
      try {
        opts.onDiagnostics?.({
          ...providerError,
          durationMs: Math.max(0, Date.now() - startedAt),
          normalizedOutcome: normalizedOutcome(result),
          hasHash: presence.hasHash === true || providerDataPresence.hasHash,
          hasSwapId: presence.hasSwapId === true || providerDataPresence.hasSwapId,
        });
      } catch {
        // Diagnostics must never affect the payment result or recovery path.
      }
    }
    return result;
  };
  try {
    const attempt = (provider.payLightningInvoice as (request: { invoice: string }) => Promise<unknown>)({ invoice });
    const result = await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NimiqProviderError("NETWORK_ERROR", "Payment response timed out.", -32000)), timeoutMs);
      }),
    ]);
    if (isLegacyErrorResponse(result)) {
      // Legacy hosts resolve with `{ error }` instead of throwing.
      const error = NimiqProviderError.fromLegacyResponse(result) ?? new Error(result.error.message);
      return finish(mapHostDenial(error), error);
    }
    const record = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
    const hasHash = typeof record["hash"] === "string";
    const hasSwapId = typeof record["swapId"] === "string";
    if (hasHash && hasSwapId) {
      return finish({ kind: "initiated", hash: record["hash"] as string, swapId: record["swapId"] as string }, null, { hasHash, hasSwapId });
    }
    return finish({ kind: "unknown", reason: "Nimiq Pay returned an unexpected response. Checking payment — do not resend." }, null, { hasHash, hasSwapId });
  } catch (error) {
    if (error instanceof HostUnavailableError) return finish({ kind: "unavailable", reason: error.message }, error);
    return finish(mapHostDenial(error), error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
