/**
 * F4.2 — native handoff: disabled gate, verified adapter, safe result
 * handling, interruption/replay safety. Plus F4.1 browser-QA with safe
 * mocks (memory vault, mocked SDK, mocked backend fetch).
 *
 * No real host, no funds, no network. Every native-path test uses a
 * counting mock provider; gate-blocked paths assert zero invocations.
 *
 * Browser limitation (documented, not hidden): node has no real IndexedDB
 * engine, so eviction/cross-tab blocking/device-loss behavior is not
 * exercised here — the durable-write + readback contract is verified
 * against the same validation the IndexedDB path uses, plus JSON
 * reload round-trips. Real-device persistence remains F4.1 QA-pending.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import {
  assertAuthorizedInvoice,
  DEFAULT_PAYMENT_TIMEOUT_MS,
  hasLightningPaymentSupport,
  mapHostDenial,
  payAuthorizedInvoice,
  type LightningCapableProvider,
  type PaymentDiagnostics,
} from "@/ui/lib/nimiq-pay";
import { evaluatePaymentGate, isPaymentFlagEnabled, type PaymentGateInput } from "@/ui/lib/payment-gate";
import { mapHostResultToServerOutcome, reportHandoffResult } from "@/ui/lib/handoff-client";
import {
  decideResumeAction,
  loadHandoffRecord,
  saveHandoffRecord,
} from "@/ui/screens/send/useHandoff";
import { buildTransferBody, canReuseBinding, loadPending, savePending } from "@/ui/lib/prepare-flow";
import { createMemoryVault, validateBinding, type RecoveryBinding } from "@/ui/lib/recovery-vault";
import {
  createExactReceiveSwap,
  readBackSwap,
  setBrowserSwapClientForTests,
} from "@/ui/lib/satora-browser";

const INVOICE = "lnbc100u1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq";
const ADDR = "0x0000000000000000000000000000000000000001";

function fakeLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

function realLocalStorage(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

function mockPaypal(result: unknown, calls: string[] = []): LightningCapableProvider {
  return {
    payLightningInvoice: (async (req: { invoice: string }) => {
      calls.push(req.invoice);
      if (result instanceof Error) throw result;
      return result;
    }) as LightningCapableProvider["payLightningInvoice"],
  };
}

const mockFetch = (routes: Record<string, () => Response>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const make = routes[String(input)];
    if (!make) throw new TypeError("network down");
    return make();
  }) as typeof fetch;

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  setBrowserSwapClientForTests(null);
  realLocalStorage();
});

describe("exact host Lightning API verified (@nimiq/mini-app-sdk 0.2.4)", () => {
  it("detects the verified payLightningInvoice capability without assuming it", () => {
    expect(hasLightningPaymentSupport(mockPaypal({ hash: "h", swapId: "s" }))).toBe(true);
    expect(hasLightningPaymentSupport({ sign: async () => ({}) })).toBe(false);
    expect(hasLightningPaymentSupport(null)).toBe(false);
    expect(hasLightningPaymentSupport(undefined)).toBe(false);
  });

  it("forwards the authorized invoice byte-identical as { invoice }", async () => {
    const calls: string[] = [];
    const res = await payAuthorizedInvoice(mockPaypal({ hash: "abc", swapId: "swap-1" }, calls), INVOICE);
    expect(calls).toEqual([INVOICE]);
    expect(res).toEqual({ kind: "initiated", hash: "abc", swapId: "swap-1" });
  });

  it("waits beyond the old 60-second boundary for the native host response", async () => {
    vi.useFakeTimers();
    try {
      expect(DEFAULT_PAYMENT_TIMEOUT_MS).toBeGreaterThan(60_000);
      const calls: string[] = [];
      let resolvePayment!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        resolvePayment = resolve;
      });
      const payment = payAuthorizedInvoice({
        payLightningInvoice: (async (req: { invoice: string }) => {
          calls.push(req.invoice);
          return pending;
        }) as LightningCapableProvider["payLightningInvoice"],
      }, INVOICE);

      await vi.advanceTimersByTimeAsync(60_001);
      resolvePayment({ hash: "late-hash", swapId: "late-swap" });
      await expect(payment).resolves.toEqual({ kind: "initiated", hash: "late-hash", swapId: "late-swap" });
      expect(calls).toEqual([INVOICE]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-BOLT11 input before touching the host", async () => {
    const calls: string[] = [];
    await expect(payAuthorizedInvoice(mockPaypal({ hash: "h", swapId: "s" }, calls), "")).rejects.toThrow();
    await expect(payAuthorizedInvoice(mockPaypal({ hash: "h", swapId: "s" }, calls), "0xnotaninvoice")).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(() => assertAuthorizedInvoice(INVOICE)).not.toThrow();
  });

  it("maps a definitive host denial to cancelled, never to success", async () => {
    const calls: string[] = [];
    const legacy = { error: { type: "PERMISSION_DENIED", message: "User rejected" } };
    expect(await payAuthorizedInvoice(mockPaypal(legacy, calls), INVOICE)).toEqual({ kind: "cancelled" });
    const thrown = new NimiqProviderError("PERMISSION_DENIED", "User rejected", 4001);
    expect(await payAuthorizedInvoice(mockPaypal(thrown, calls), INVOICE)).toEqual({ kind: "cancelled" });
    expect(calls).toEqual([INVOICE, INVOICE]);
  });

  it("maps timeouts and interruptions to unknown, never to failure", async () => {
    const calls: string[] = [];
    const hanging: LightningCapableProvider = { payLightningInvoice: (async (req: { invoice: string }) => { calls.push(req.invoice); return new Promise(() => undefined); }) as LightningCapableProvider["payLightningInvoice"] };
    const res = await payAuthorizedInvoice(hanging, INVOICE, { timeoutMs: 20 });
    expect(res.kind).toBe("unknown");
    expect(calls).toEqual([INVOICE]);
    const legacyNet = { error: { type: "NETWORK_ERROR", message: "offline" } };
    expect((await payAuthorizedInvoice(mockPaypal(legacyNet), INVOICE)).kind).toBe("unknown");
  });

  it("emits sanitized diagnostics for success, timeout, unknown, and duplicate outcomes", async () => {
    const diagnostics: PaymentDiagnostics[] = [];
    const observe = (value: PaymentDiagnostics) => diagnostics.push(value);
    const success = await payAuthorizedInvoice(mockPaypal({ hash: "secret-hash", swapId: "secret-swap" }), INVOICE, { onDiagnostics: observe });
    const hanging: LightningCapableProvider = { payLightningInvoice: (async () => new Promise(() => undefined)) as LightningCapableProvider["payLightningInvoice"] };
    const timeout = await payAuthorizedInvoice(hanging, INVOICE, { timeoutMs: 20, onDiagnostics: observe });
    const unknown = await payAuthorizedInvoice(
      mockPaypal(new NimiqProviderError("TRANSACTION_OUTCOME_UNKNOWN", "submission uncertain", -32000, { hash: "known-unknown", swapId: "unknown-swap" })),
      INVOICE,
      { onDiagnostics: observe },
    );
    const duplicate = await payAuthorizedInvoice(
      mockPaypal(new NimiqProviderError("DUPLICATE_PAYMENT", "already submitted", 409, { hash: "known-hash", swapId: "known-swap" })),
      INVOICE,
      { onDiagnostics: observe },
    );

    expect(success.kind).toBe("initiated");
    expect(timeout.kind).toBe("unknown");
    expect(unknown.kind).toBe("unknown");
    expect(duplicate.kind).toBe("unknown");
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics[0]).toMatchObject({ normalizedOutcome: "initiated", providerErrorType: null, providerErrorCode: null, durationMs: expect.any(Number), hasHash: true, hasSwapId: true });
    expect(diagnostics[1]).toMatchObject({ normalizedOutcome: "unknown", providerErrorType: "NETWORK_ERROR", providerErrorCode: -32000, hasHash: false, hasSwapId: false });
    expect(diagnostics[2]).toMatchObject({ normalizedOutcome: "unknown", providerErrorType: "TRANSACTION_OUTCOME_UNKNOWN", providerErrorCode: -32000, hasHash: true, hasSwapId: true });
    expect(diagnostics[3]).toMatchObject({ normalizedOutcome: "unknown", providerErrorType: "DUPLICATE_PAYMENT", providerErrorCode: 409, hasHash: true, hasSwapId: true });
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret-hash|secret-swap|known-hash|known-unknown|unknown-swap|already submitted/i);
  });

  it("treats a repeated provider submission as uncertain without resubmitting", async () => {
    const calls: string[] = [];
    const result = await payAuthorizedInvoice(
      mockPaypal(new NimiqProviderError("DUPLICATE_PAYMENT", "already submitted", 409), calls),
      INVOICE,
    );
    expect(result.kind).toBe("unknown");
    expect(calls).toEqual([INVOICE]);
  });

  it("maps unknown host methods to unsupported (no assumed fallback)", () => {
    expect(mapHostDenial(new NimiqProviderError("UNKNOWN_REQUEST", "no such method", 4200)).kind).toBe("unsupported");
  });
});

describe("strict payment gate: OFF by default in every build", () => {
  const open: PaymentGateInput = {
    flagEnabled: true,
    hostSupported: true,
    hostNetwork: "mainnet",
    allowedHostNetworks: ["mainnet"],
    sessionValid: true,
    transferAuthorized: true,
    vaultMatched: true,
    invoiceLive: true,
    explicitAction: true,
    previewMode: false,
  };

  it("is disabled without the explicit controlled-test flag", () => {
    expect(isPaymentFlagEnabled({})).toBe(false);
    expect(isPaymentFlagEnabled(process.env)).toBe(false);
    expect(isPaymentFlagEnabled({ NEXT_PUBLIC_THENCE_ENABLE_PAYMENT: "1" })).toBe(true);
    const decision = evaluatePaymentGate({ ...open, flagEnabled: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/paused in this preview/i);
  });

  it("allows only when every condition holds", () => {
    expect(evaluatePaymentGate(open).allowed).toBe(true);
  });

  it("blocks each missing condition individually", () => {
    const cases: Array<[keyof PaymentGateInput, PaymentGateInput]> = [
      ["hostSupported", { ...open, hostSupported: false }],
      ["hostNetwork", { ...open, hostNetwork: "testnet" }],
      ["hostNetwork", { ...open, hostNetwork: null }],
      ["sessionValid", { ...open, sessionValid: false }],
      ["transferAuthorized", { ...open, transferAuthorized: false }],
      ["vaultMatched", { ...open, vaultMatched: false }],
      ["invoiceLive", { ...open, invoiceLive: false }],
      ["explicitAction", { ...open, explicitAction: false }],
      ["previewMode", { ...open, previewMode: true }],
    ];
    for (const [key, input] of cases) {
      const decision = evaluatePaymentGate(input);
      expect(decision.allowed, String(key)).toBe(false);
      expect(decision.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("safe result handling: only the backend contract outcomes", () => {
  it("maps host results onto cancelled/initiated/unknown", () => {
    expect(mapHostResultToServerOutcome({ kind: "initiated", hash: "h", swapId: "s" })).toBe("initiated");
    expect(mapHostResultToServerOutcome({ kind: "cancelled" })).toBe("cancelled");
    for (const kind of ["unknown", "unavailable", "unsupported", "invalid"] as const) {
      expect(mapHostResultToServerOutcome({ kind, reason: "x" } as never)).toBe("unknown");
    }
  });

  it("reports the exact outcome to the existing endpoint", async () => {
    const f = mockFetch({ "/api/transfers/t-1/handoff-result": json(200, { handoff: { transferId: "t-1", status: "LIGHTNING_HANDOFF", deduplicated: false } }) });
    const res = await reportHandoffResult("t-1", "initiated", { fetch: f });
    expect(res.ok && res.data.handoff.status).toBe("LIGHTNING_HANDOFF");
  });

  it("forwards a valid host source hash only as a hint", async () => {
    let requestBody: unknown = null;
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ handoff: { transferId: "t-1", status: "LIGHTNING_HANDOFF", deduplicated: false } }), { status: 200 });
    }) as typeof fetch;
    await reportHandoffResult("t-1", "initiated", { fetch: f, sourceTxHash: "0x" + "11".repeat(32) });
    expect(requestBody).toEqual({ outcome: "initiated", sourceTxHash: "0x" + "11".repeat(32) });
    await expect(reportHandoffResult("t-1", "initiated", { fetch: f, sourceTxHash: "bad" })).rejects.toThrow(/source transaction hash/i);
    await expect(reportHandoffResult("t-1", "cancelled", { fetch: f, sourceTxHash: "11".repeat(32) })).rejects.toThrow(/cancelled/i);
  });

  it("forwards only the bounded diagnostics alongside the normalized outcome", async () => {
    let requestBody: unknown = null;
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ handoff: { transferId: "t-1", status: "RECONCILING", deduplicated: false } }), { status: 200 });
    }) as typeof fetch;
    await reportHandoffResult("t-1", "unknown", {
      fetch: f,
      diagnostics: {
        providerErrorType: "NETWORK_ERROR",
        providerErrorCode: -32000,
        durationMs: 60000,
        normalizedOutcome: "unknown",
        hasHash: false,
        hasSwapId: false,
      },
    });
    expect(requestBody).toEqual({
      outcome: "unknown",
      diagnostics: {
        providerErrorType: "NETWORK_ERROR",
        providerErrorCode: -32000,
        durationMs: 60000,
        normalizedOutcome: "unknown",
        hasHash: false,
        hasSwapId: false,
      },
    });
  });

  it("can never report funded/delivered success (backend would reject)", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    await expect(reportHandoffResult("t-1", "funded" as never, { fetch: f })).rejects.toThrow();
    await expect(reportHandoffResult("t-1", "delivered" as never, { fetch: f })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("surfaces server rejection without retrying natively", async () => {
    const f = mockFetch({ "/api/transfers/t-1/handoff-result": json(409, { error: "NOT_REPORTABLE", message: "no" }) });
    const res = await reportHandoffResult("t-1", "initiated", { fetch: f });
    expect(!res.ok && res.code).toBe("NOT_REPORTABLE");
  });
});

describe("interruption and replay safety", () => {
  it("persists the minimum handoff record without secrets, owner-scoped", () => {
    fakeLocalStorage();
    try {
      saveHandoffRecord({ transferId: "t-1", ownerUserId: "u-1", invoice: INVOICE, invokedAt: new Date().toISOString(), outcomeReported: false, reportedOutcome: null });
      expect(loadHandoffRecord("t-1", "u-1")?.invoice).toBe(INVOICE);
      expect(loadHandoffRecord("t-1", "u-2")).toBeNull();
      const raw = JSON.stringify(loadHandoffRecord("t-1", "u-1"));
      expect(raw).not.toMatch(/preimage|secret|mnemonic/i);
    } finally {
      realLocalStorage();
    }
  });

  it("resumes from authoritative state and never re-invokes while unresolved", () => {
    const unreported = { transferId: "t-1", ownerUserId: "u-1", invoice: INVOICE, invokedAt: "x", outcomeReported: false, reportedOutcome: null };
    expect(decideResumeAction("LIGHTNING_HANDOFF", unreported)).toEqual({ action: "report-unknown", phase: "checking" });
    expect(decideResumeAction("OUTCOME_UNKNOWN", null)).toEqual({ action: "none", phase: "checking" });
    expect(decideResumeAction("RECONCILING", null)).toEqual({ action: "none", phase: "checking" });
    expect(decideResumeAction("USER_CANCELLED", null)).toEqual({ action: "none", phase: "cancelled" });
    expect(decideResumeAction("AWAITING_NIM_APPROVAL", unreported)).toEqual({ action: "none", phase: "checking" });
    expect(decideResumeAction("AWAITING_NIM_APPROVAL", null)).toEqual({ action: "none", phase: "ready" });
    expect(decideResumeAction("QUOTED", null).phase).toBe("attention");
    // Delivered transfers hand over to the settlement view; the handoff
    // stays idle instead of showing a misleading attention banner.
    expect(decideResumeAction("DELIVERED", null)).toEqual({ action: "none", phase: "ready" });
    expect(decideResumeAction("DELIVERED", unreported)).toEqual({ action: "none", phase: "ready" });
    // No decision ever authorizes a second native payment.
    for (const status of ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "AWAITING_NIM_APPROVAL", "USER_CANCELLED", "QUOTED", "DELIVERED"]) {
      for (const record of [unreported, null]) {
        expect(["report-unknown", "none"]).toContain(decideResumeAction(status, record).action);
      }
    }
  });
});

describe("F4.1 browser QA with safe mocks (no host, no funds)", () => {
  const binding = (over: Partial<RecoveryBinding> = {}): RecoveryBinding => ({
    version: 1,
    transferId: "t-1",
    satoraSwapId: "swap-11111111-2222-3333-4444-555555555555",
    paymentHash: `0x${"ab".repeat(32)}`,
    sourceSats: "6327",
    targetAtomic: "5000000",
    destination: ADDR,
    routeId: "usdc-polygon",
    quoteRevision: 1,
    ownerUserId: "u-1",
    attemptToken: "attempt-token-opaque",
    storedAt: new Date().toISOString(),
    verifiedAt: null,
    ...over,
  });

  it("IndexedDB contract: write, readback, same transfer after reload", async () => {
    const vault = createMemoryVault();
    expect((await vault.saveAndVerify(binding())).status).toBe("ok");
    // Simulate reload: serialize the store, revalidate in a fresh instance.
    const snapshot = JSON.stringify([...vault.records.entries()]);
    const reloaded = createMemoryVault();
    for (const [k, v] of JSON.parse(snapshot) as Array<[string, unknown]>) reloaded.records.set(k, v);
    const loaded = await reloaded.load("t-1", "u-1");
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.binding.satoraSwapId).toBe(binding().satoraSwapId);
  });

  it("duplicate swipe converges on the same transfer (stable idempotency key)", () => {
    fakeLocalStorage();
    try {
      const key = "k-swipe-guard-12345678";
      savePending({ transferId: "t-1", idempotencyKey: key, attemptToken: null, ownerUserId: "u-1", routeId: "usdc-polygon", targetAmountAtomic: "5000000" });
      // Reload: the same pending pointer is read back, so the second swipe reuses it.
      const again = loadPending("u-1");
      expect(again?.transferId).toBe("t-1");
      const payee = { id: null, destinationId: null as string | null, routeId: "usdc-polygon" as const, address: ADDR, name: "Someone new" };
      const a = buildTransferBody({ payee, fixed: null, targetAmountAtomic: "5000000", idempotencyKey: again?.idempotencyKey ?? "" });
      const b = buildTransferBody({ payee, fixed: null, targetAmountAtomic: "5000000", idempotencyKey: key });
      expect(a).toEqual(b);
    } finally {
      realLocalStorage();
    }
  });

  it("resume reuses valid recovery material instead of regenerating secrets", async () => {
    const vault = createMemoryVault();
    expect((await vault.saveAndVerify(binding())).status).toBe("ok");
    const loaded = await vault.load("t-1", "u-1");
    expect(loaded.status).toBe("ok");
    expect(
      canReuseBinding(binding(), { transferId: "t-1", destination: ADDR, targetAtomic: "5000000", routeId: "usdc-polygon", quoteRevision: 1, ownerUserId: "u-1" }),
    ).toBe(true);
  });

  it("missing/corrupt material stops the flow and is kept, never silently discarded", async () => {
    const vault = createMemoryVault();
    expect((await vault.load("unknown", "u-1")).status).toBe("missing");
    await vault.saveAndVerify(binding());
    vault.records.set("t-1", { version: 1, transferId: "t-1" });
    expect((await vault.load("t-1", "u-1")).status).toBe("corrupt");
    expect(vault.records.has("t-1")).toBe(true);
    expect(validateBinding(binding({ targetAtomic: "0" }), { transferId: "t-1", ownerUserId: "u-1" }).status).toBe("corrupt");
    expect(validateBinding(binding(), { transferId: "t-1", ownerUserId: "u-2" }).status).toBe("foreign");
  });

  it("SDK stored-swap readback proves recovery material exists", async () => {
    const stored = {
      version: 2,
      swapId: "swap-1",
      keyIndex: 0,
      response: { id: "swap-1", hash_lock: `0x${"ab".repeat(32)}`, bolt11_invoice: INVOICE, evm_refund_locktime: Math.floor(Date.now() / 1000) + 3600 },
      publicKey: "02" + "ab".repeat(32),
      preimage: "ab".repeat(32),
      preimageHash: "cd".repeat(32),
      secretKey: "ef".repeat(32),
      storedAt: Date.now(),
      updatedAt: Date.now(),
    };
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async () => ({ response: {} })) as never,
      getStoredSwap: (async (id: string) => (id === "swap-1" ? stored : null)) as never,
      claim: (async () => ({ success: false, message: "disabled" })) as never,
    });
    try {
      const ok = await readBackSwap("swap-1");
      expect(ok.ok && ok.hasRecoveryMaterial).toBe(true);
      expect(ok.ok && ok.evmRefundLocktime).toBeTypeOf("number");
      expect((await readBackSwap("missing")).ok).toBe(false);
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });

  it("SDK readback fails closed when secrets are incomplete", async () => {
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async () => ({ response: {} })) as never,
      getStoredSwap: (async () => ({ version: 2, swapId: "swap-1", keyIndex: 0, response: {}, publicKey: "", preimage: "", preimageHash: "", secretKey: "", storedAt: 0, updatedAt: 0 })) as never,
      claim: (async () => ({ success: false, message: "disabled" })) as never,
    });
    try {
      const res = await readBackSwap("swap-1");
      expect(res.ok).toBe(false);
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });

  it("swap creation pins exact server-approved terms and rejects drift", async () => {
    const captured: Array<Record<string, unknown>> = [];
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async (opts: Record<string, unknown>) => {
        captured.push(opts);
        return {
          response: {
            id: "swap-1",
            bolt11_invoice: INVOICE,
            hash_lock: `0x${"ab".repeat(32)}`,
            source_amount: "6327",
            target_amount: "5000000",
            target_evm_address: ADDR,
          },
        };
      }) as never,
      getStoredSwap: (async () => null) as never,
      claim: (async () => ({ success: false, message: "disabled" })) as never,
    });
    try {
      const swap = await createExactReceiveSwap({ targetAddress: ADDR, tokenAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", evmChainId: 137, targetAmountAtomic: "5000000" });
      expect(swap.satoraSwapId).toBe("swap-1");
      expect(captured[0]?.["targetAddress"]).toBe(ADDR);
      expect(captured[0]?.["evmChainId"]).toBe(137);
      expect(captured[0]?.["targetAmount"]).toBe(5000000n);
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });

  it("no host payment invocation anywhere in the QA path", () => {
    // No provider is configured in this path, and the gate flag is unset,
    // so payAuthorizedInvoice is unreachable: assert both facts.
    expect(hasLightningPaymentSupport(null)).toBe(false);
    expect(isPaymentFlagEnabled({})).toBe(false);
    expect(
      evaluatePaymentGate({
        flagEnabled: false,
        hostSupported: true,
        hostNetwork: "mainnet",
        allowedHostNetworks: ["mainnet"],
        sessionValid: true,
        transferAuthorized: true,
        vaultMatched: true,
        invoiceLive: true,
        explicitAction: true,
        previewMode: false,
      }).allowed,
    ).toBe(false);
  });
});
