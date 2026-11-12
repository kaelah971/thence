/**
 * F4.5 — Nimiq Pay failure diagnostics: strict upstream allowlist → bounded reason code.
 *
 * Mocked host only: no real Nimiq Pay, no invoice is paid, no swap is created,
 * no network, no database. Error shapes mirror nimiq-pay-app@5c0485f
 * (`createRpcError` plain object { code, message, type, data } thrown across
 * birpc, wrapped by @nimiq/mini-app-sdk into NimiqProviderError).
 *
 * Invariants proven here:
 * - Every recognized message maps to exactly one bounded code; anything else
 *   is UNRECOGNIZED (classified types) or null (other types).
 * - The payment result is unchanged: INVALID_TRANSACTION / DUPLICATE_PAYMENT /
 *   TRANSACTION_OUTCOME_UNKNOWN all stay `unknown` (never cancelled, never
 *   initiated), and the host is invoked exactly once (no retry).
 * - Neither diagnostics nor the server log ever contain the raw message,
 *   invoice, hash, swap id or address; the server accepts only the enum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import {
  classifyNimiqPayFailure,
  isNimiqPayFailureReason,
  NIMIQ_PAY_FAILURE_REASONS,
  type NimiqPayFailureReason,
} from "@/lib/nimiq-pay-failure-reasons";
import { mapHostDenial, payAuthorizedInvoice, type LightningCapableProvider, type PaymentDiagnostics } from "@/ui/lib/nimiq-pay";
import { mapHostResultToServerOutcome } from "@/ui/lib/handoff-client";

const INVOICE = "lnbc13720n1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq";
const SECRET_HASH = "ab".repeat(32);
const SECRET_SWAP = "swap-7f3c-secret";

/**
 * Throws what the mini app receives: the host's plain RPC error object, wrapped
 * by @nimiq/mini-app-sdk exactly as its provider proxy does
 * (`throw NimiqProviderError.from(e) || e`). Malformed values pass through raw.
 */
function hostThrows(error: unknown, calls: string[] = []): LightningCapableProvider {
  return {
    payLightningInvoice: (async (req: { invoice: string }) => {
      calls.push(req.invoice);
      throw NimiqProviderError.from(error) ?? error;
    }) as LightningCapableProvider["payLightningInvoice"],
  };
}
const rpcError = (type: string, message: string, code = -32602, data?: unknown) => ({ code, message, type, ...(data !== undefined ? { data } : {}) });

async function run(error: unknown): Promise<{ kind: string; diag: PaymentDiagnostics; calls: string[] }> {
  const calls: string[] = [];
  let diag: PaymentDiagnostics | null = null;
  const res = await payAuthorizedInvoice(hostThrows(error, calls), INVOICE, { onDiagnostics: (d) => { diag = d; } });
  if (!diag) throw new Error("no diagnostics emitted");
  return { kind: res.kind, diag, calls };
}

// Exact upstream INVALID_TRANSACTION messages (useMiniAppHost.ts, useStringParser.ts, tx.ts, polygon-usdt.ts).
const INVALID_TRANSACTION_CASES: Array<[string, NimiqPayFailureReason]> = [
  ["Bitcoin Lightning invoice expired", "INVOICE_EXPIRED"],
  ["Bitcoin Lightning invoice expired.", "INVOICE_EXPIRED"],
  ["Invalid Bitcoin Lightning invoice: missing timestamp.", "INVOICE_INVALID"],
  ["Invalid Bitcoin Lightning invoice: missing amount.", "INVOICE_INVALID"],
  ["Invalid Bitcoin Lightning invoice. Error: Invalid checksum for lnbc1...", "INVOICE_INVALID"],
  ['Wrong network in Bitcoin Lightning invoice. Expected "bc", got "tb".', "INVOICE_WRONG_NETWORK"],
  ["Cannot create swap", "SWAP_CREATE_FAILED"],
  ["Cannot fetch existing swap", "SWAP_QUOTE_FETCH_FAILED"],
  ["Could not fetch amount for Bitcoin Lightning swap.", "SWAP_QUOTE_INVALID"],
  ["Could not prepare a NIM to Bitcoin Lightning swap", "SWAP_PREPARE_FAILED"],
  ["Could not prepare a USDT to Bitcoin Lightning swap", "SWAP_PREPARE_FAILED"],
  ["The Lightning swap quote expired; request a new invoice", "SWAP_QUOTE_EXPIRED"],
  ["Insufficient NIM balance", "INSUFFICIENT_NIM_BALANCE"],
  ["Insufficient USDT balance for payment and fee", "INSUFFICIENT_USDT_BALANCE"],
  ["Lightning swap exceeds the current limit", "SWAP_LIMIT_EXCEEDED"],
  ["USDT payments are temporarily unavailable due to maintenance. Please try again later.", "USDT_MAINTENANCE"],
  ["Polygon Lightning payment rejected", "SEND_REJECTED"],
  ["Something went wrong syncing your account", "SEND_REJECTED"],
  ["Invalid swap hash", "SEND_REJECTED"],
  ["No NIM HTLC found in swap", "SEND_REJECTED"],
  ["No USDT HTLC found in swap", "SEND_REJECTED"],
  ["Wallet changed before sending", "SEND_REJECTED"],
  ["Network ID mismatch", "SEND_REJECTED"],
];

describe("classifyNimiqPayFailure — strict allowlist", () => {
  it.each(INVALID_TRANSACTION_CASES)("INVALID_TRANSACTION %j → %s", (message, reason) => {
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", message)).toBe(reason);
  });

  it("recognizes the upstream de/es/fr/pt translations of i18n'd messages", () => {
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "Tausch konnte nicht erstellt werden")).toBe("SWAP_CREATE_FAILED");
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "No se puede crear el intercambio")).toBe("SWAP_CREATE_FAILED");
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "La facture Bitcoin Lightning a expiré.")).toBe("INVOICE_EXPIRED");
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "Fatura Bitcoin Lightning inválida. Error: x")).toBe("INVOICE_INVALID");
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "Hash de troca inválido")).toBe("SEND_REJECTED");
  });

  it("classifies duplicate-payment and uncertain-submission messages", () => {
    expect(classifyNimiqPayFailure("DUPLICATE_PAYMENT", "This Lightning invoice is already being paid")).toBe("DUPLICATE_IN_FLIGHT");
    expect(classifyNimiqPayFailure("DUPLICATE_PAYMENT", "This Lightning invoice was already submitted or may still be pending")).toBe("DUPLICATE_ALREADY_SUBMITTED");
    expect(classifyNimiqPayFailure("TRANSACTION_OUTCOME_UNKNOWN", "Lightning payment outcome is unknown. Do not retry this invoice.")).toBe("OUTCOME_UNKNOWN");
    expect(classifyNimiqPayFailure("TRANSACTION_OUTCOME_UNKNOWN", "USDT was submitted, but its payment record could not be updated. Do not retry this invoice.")).toBe("SUBMITTED_RECORD_NOT_SAVED");
    expect(classifyNimiqPayFailure("TRANSACTION_OUTCOME_UNKNOWN", "NIM was submitted, but its payment record could not be updated. Do not retry this invoice.")).toBe("SUBMITTED_RECORD_NOT_SAVED");
  });

  it("is exact: near-misses, case changes and cross-type messages are UNRECOGNIZED", () => {
    for (const message of [
      "cannot create swap", "Cannot create swap!", "Cannot create swap: Fastspot 500", "Insufficient balance",
      "Invalid Bitcoin Lightning invoice.", // upstream always appends " Error: ..."; the bare sentence is not on the list
      "Wrong network in Bitcoin Lightning invoice.", "Could not prepare a BTC to Bitcoin Lightning swap",
      "A brand-new wallet message from a future Nimiq Pay release",
    ]) {
      expect(classifyNimiqPayFailure("INVALID_TRANSACTION", message), message).toBe("UNRECOGNIZED");
    }
    // A valid message under the wrong type is not trusted.
    expect(classifyNimiqPayFailure("DUPLICATE_PAYMENT", "Insufficient NIM balance")).toBe("UNRECOGNIZED");
    expect(classifyNimiqPayFailure("TRANSACTION_OUTCOME_UNKNOWN", "Cannot create swap")).toBe("UNRECOGNIZED");
    // Dynamic upstream texts (sendTx e.message, remote maintenance notice) stay UNRECOGNIZED by design.
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "Wallet busy")).toBe("UNRECOGNIZED");
  });

  it("tolerates only surrounding whitespace", () => {
    expect(classifyNimiqPayFailure("INVALID_TRANSACTION", "  Cannot create swap\n")).toBe("SWAP_CREATE_FAILED");
  });

  it("handles malformed input without throwing", () => {
    for (const message of [undefined, null, 42, {}, [], "", "x".repeat(301)]) {
      expect(classifyNimiqPayFailure("INVALID_TRANSACTION", message)).toBe("UNRECOGNIZED");
    }
    expect(classifyNimiqPayFailure("Cannot create swap".padEnd(299, " "), "x")).toBeNull();
    for (const type of [undefined, null, 7, "", "invalid_transaction", "NETWORK_ERROR", "PERMISSION_DENIED", "INVALID_REQUEST", "INTERNAL_ERROR", "FUTURE_TYPE"]) {
      expect(classifyNimiqPayFailure(type, "Cannot create swap")).toBeNull();
    }
  });

  it("exposes a bounded, unique, log-safe enum", () => {
    expect(new Set(NIMIQ_PAY_FAILURE_REASONS).size).toBe(NIMIQ_PAY_FAILURE_REASONS.length);
    for (const code of NIMIQ_PAY_FAILURE_REASONS) expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,47}$/);
    expect(isNimiqPayFailureReason("SWAP_CREATE_FAILED")).toBe(true);
    expect(isNimiqPayFailureReason("Cannot create swap")).toBe(false);
  });
});

describe("payAuthorizedInvoice — reason diagnostics never change the outcome", () => {
  it.each(INVALID_TRANSACTION_CASES)("INVALID_TRANSACTION %j stays unknown with reason %s", async (message, reason) => {
    const { kind, diag, calls } = await run(rpcError("INVALID_TRANSACTION", message));
    expect(kind).toBe("unknown");
    expect(calls).toEqual([INVOICE]); // exactly one host call, no retry
    expect(diag).toMatchObject({ providerErrorType: "INVALID_TRANSACTION", providerErrorCode: -32602, providerReason: reason, normalizedOutcome: "unknown", hasHash: false, hasSwapId: false });
    expect(JSON.stringify(diag)).not.toContain(message);
  });

  it("reproduces the 821ae86c shape (INVALID_TRANSACTION, no hash/swap) as unknown + a reason code", async () => {
    const { kind, diag } = await run(new NimiqProviderError("INVALID_TRANSACTION", "Cannot create swap", -32602));
    expect(kind).toBe("unknown");
    expect(mapHostResultToServerOutcome({ kind: "unknown", reason: "x" })).toBe("unknown");
    expect(diag).toEqual({
      providerErrorType: "INVALID_TRANSACTION",
      providerErrorCode: -32602,
      providerReason: "SWAP_CREATE_FAILED",
      durationMs: expect.any(Number),
      normalizedOutcome: "unknown",
      hasHash: false,
      hasSwapId: false,
    });
  });

  it("keeps INVALID_TRANSACTION out of cancellation (no automatic cancel)", () => {
    expect(mapHostDenial(new NimiqProviderError("INVALID_TRANSACTION", "Insufficient NIM balance", -32602)).kind).toBe("unknown");
    expect(mapHostDenial(rpcError("INVALID_TRANSACTION", "Bitcoin Lightning invoice expired")).kind).toBe("unknown");
  });

  it("duplicate payment: unknown, reason code, hash/swap presence only", async () => {
    const { kind, diag } = await run(rpcError("DUPLICATE_PAYMENT", "This Lightning invoice was already submitted or may still be pending", -32602, { hash: SECRET_HASH, swapId: SECRET_SWAP }));
    expect(kind).toBe("unknown");
    expect(diag).toMatchObject({ providerErrorType: "DUPLICATE_PAYMENT", providerReason: "DUPLICATE_ALREADY_SUBMITTED", hasHash: true, hasSwapId: true });
    expect(JSON.stringify(diag)).not.toMatch(new RegExp(`${SECRET_HASH}|${SECRET_SWAP}|already submitted`));
    const inFlight = await run(rpcError("DUPLICATE_PAYMENT", "This Lightning invoice is already being paid"));
    expect(inFlight.kind).toBe("unknown");
    expect(inFlight.diag.providerReason).toBe("DUPLICATE_IN_FLIGHT");
  });

  it("uncertain submission: unknown, reason code, never initiated even with a hash", async () => {
    const { kind, diag } = await run(rpcError("TRANSACTION_OUTCOME_UNKNOWN", "USDT was submitted, but its payment record could not be updated. Do not retry this invoice.", -32001, { hash: SECRET_HASH, swapId: SECRET_SWAP }));
    expect(kind).toBe("unknown");
    expect(diag).toMatchObject({ providerErrorType: "TRANSACTION_OUTCOME_UNKNOWN", providerReason: "SUBMITTED_RECORD_NOT_SAVED", hasHash: true, hasSwapId: true });
    expect(JSON.stringify(diag)).not.toContain(SECRET_HASH);
  });

  it("legacy resolved { error } responses are classified the same way", async () => {
    let diag: PaymentDiagnostics | null = null;
    const legacy: LightningCapableProvider = { payLightningInvoice: (async () => ({ error: { type: "INVALID_TRANSACTION", message: "Lightning swap exceeds the current limit" } })) as unknown as LightningCapableProvider["payLightningInvoice"] };
    const res = await payAuthorizedInvoice(legacy, INVOICE, { onDiagnostics: (d) => { diag = d; } });
    expect(res.kind).toBe("unknown");
    expect(diag!.providerReason).toBe("SWAP_LIMIT_EXCEEDED");
  });

  it("malformed host errors never throw and never leak", async () => {
    for (const bad of [
      "Cannot create swap", // bare string thrown
      { code: -32602 }, // no message, no type
      { code: -32602, message: 12345 },
      { type: 123, message: "Cannot create swap" },
      { code: -32602, message: `Cannot create swap ${INVOICE}`, type: "INVALID_TRANSACTION" },
      null,
    ]) {
      const { kind, diag, calls } = await run(bad);
      expect(kind).not.toBe("initiated");
      expect(kind).not.toBe("cancelled");
      expect(calls).toHaveLength(1);
      expect(diag.providerReason === null || diag.providerReason === "UNRECOGNIZED").toBe(true);
      expect(JSON.stringify(diag)).not.toMatch(/lnbc|Cannot create swap/);
    }
  });

  it("unknown future wallet responses: new type → null reason; new message → UNRECOGNIZED; both stay unknown", async () => {
    const futureType = await run(rpcError("LIGHTNING_ROUTE_UNAVAILABLE", "No route to destination", -32099));
    expect(futureType.kind).toBe("unknown");
    expect(futureType.diag).toMatchObject({ providerErrorType: "LIGHTNING_ROUTE_UNAVAILABLE", providerReason: null });
    const futureMessage = await run(rpcError("INVALID_TRANSACTION", "Fastspot rejected the invoice: amount below 2000 sats"));
    expect(futureMessage.kind).toBe("unknown");
    expect(futureMessage.diag.providerReason).toBe("UNRECOGNIZED");
    expect(JSON.stringify(futureMessage.diag)).not.toMatch(/Fastspot|2000/);
  });

  it("success and user rejection carry no reason", async () => {
    let diag: PaymentDiagnostics | null = null;
    const ok: LightningCapableProvider = { payLightningInvoice: (async () => ({ hash: SECRET_HASH, swapId: SECRET_SWAP })) as LightningCapableProvider["payLightningInvoice"] };
    expect((await payAuthorizedInvoice(ok, INVOICE, { onDiagnostics: (d) => { diag = d; } })).kind).toBe("initiated");
    expect(diag!.providerReason).toBeNull();
    const denied = await run(rpcError("PERMISSION_DENIED", "User rejected the request", 4001));
    expect(denied.kind).toBe("cancelled");
    expect(denied.diag.providerReason).toBeNull();
  });
});

describe("server contract — schema accepts only the enum; log carries only the code", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("@/lib/auth"); vi.doUnmock("@/lib/rate-limit"); vi.doUnmock("@/lib/env"); vi.doUnmock("@/lib/reconcile"); });

  const base = { providerErrorType: "INVALID_TRANSACTION", providerErrorCode: -32602, durationMs: 7262, normalizedOutcome: "unknown", hasHash: false, hasSwapId: false };

  it("handoffOutcomeSchema: enum, null and absent accepted; free text and extra keys rejected", async () => {
    const { handoffOutcomeSchema } = await import("@/lib/reconcile");
    expect(handoffOutcomeSchema.safeParse({ outcome: "unknown", diagnostics: { ...base, providerReason: "SWAP_CREATE_FAILED" } }).success).toBe(true);
    expect(handoffOutcomeSchema.safeParse({ outcome: "unknown", diagnostics: { ...base, providerReason: null } }).success).toBe(true);
    expect(handoffOutcomeSchema.safeParse({ outcome: "unknown", diagnostics: base }).success).toBe(true); // older clients
    for (const providerReason of ["Cannot create swap", "swap_create_failed", "SWAP_CREATE_FAILED ", 7, `X${"Y".repeat(80)}`]) {
      expect(handoffOutcomeSchema.safeParse({ outcome: "unknown", diagnostics: { ...base, providerReason } }).success, String(providerReason)).toBe(false);
    }
    expect(handoffOutcomeSchema.safeParse({ outcome: "unknown", diagnostics: { ...base, providerReason: "SWAP_CREATE_FAILED", providerMessage: "Cannot create swap" } }).success).toBe(false);
  });

  async function postToRoute(body: unknown): Promise<{ status: number; logs: string[]; reported: unknown[] }> {
    const reported: unknown[] = [];
    vi.doMock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), assertSafeOrigin: () => undefined, requireSession: async () => ({ userId: "u-1" }) }));
    vi.doMock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), checkRateLimit: async () => ({ allowed: true }) }));
    vi.doMock("@/lib/env", async (orig) => ({ ...(await orig<typeof import("@/lib/env")>()), getEnv: () => ({ THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE: 30 }) }));
    vi.doMock("@/lib/reconcile", async (orig) => ({
      ...(await orig<typeof import("@/lib/reconcile")>()),
      // State machine untouched by this slice; stubbed so no database is needed.
      reportHandoffOutcome: async (_u: string, id: string, b: unknown) => { reported.push(b); return { transferId: id, status: "RECONCILING", deduplicated: false }; },
    }));
    const logs: string[] = [];
    for (const level of ["info", "warn", "log", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const { POST } = await import("../app/api/transfers/[id]/handoff-result/route");
    const res = await POST(new Request("http://localhost/api/transfers/t-1/handoff-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "t-1" }) });
    return { status: res.status, logs, reported };
  }

  it("logs provider_reason as the bare code and still reports unknown → RECONCILING", async () => {
    const { status, logs, reported } = await postToRoute({ outcome: "unknown", diagnostics: { ...base, providerReason: "SWAP_CREATE_FAILED" } });
    expect(status).toBe(200);
    expect(reported).toHaveLength(1);
    const line = logs.find((l) => l.startsWith("thence handoff-diagnostics:"));
    expect(line).toBe("thence handoff-diagnostics: outcome:unknown provider_type:INVALID_TRANSACTION provider_code:-32602 provider_reason:SWAP_CREATE_FAILED duration_ms:7262 hash:0 swap:0");
    expect(logs).toContain("thence handoff-result: closed:RECONCILING");
  });

  it("older clients without providerReason log provider_reason:none", async () => {
    const { logs } = await postToRoute({ outcome: "unknown", diagnostics: base });
    expect(logs.find((l) => l.startsWith("thence handoff-diagnostics:"))).toContain("provider_reason:none");
  });

  it("free-text reasons never reach the log", async () => {
    const { logs } = await postToRoute({ outcome: "unknown", diagnostics: { ...base, providerReason: "Cannot create swap lnbc1secret" } });
    expect(logs.join("\n")).not.toMatch(/Cannot create swap|lnbc1secret/);
    expect(logs.some((l) => l.startsWith("thence handoff-diagnostics:"))).toBe(false);
  });
});
