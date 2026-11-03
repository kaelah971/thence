/**
 * F4.1 — preparation orchestration unit tests (mocked I/O only).
 * No Neon, no provider, no Nimiq Pay. Covers idempotency, immutable terms,
 * quote expiry, wrong wallet/route/amount, duplicate swipe, network/session,
 * attach/authorize transitions and the zero-payment-invocation boundary.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  attachTransferSwap,
  authorizeTransferHandoff,
  buildTransferBody,
  canReuseBinding,
  classifyPreparationFailure,
  clearPending,
  createTransfer,
  displayAmountForHandoff,
  fetchAttempt,
  fetchTransfer,
  isPendingTransferResumable,
  isQuoteFresh,
  loadPending,
  newIdempotencyKey,
  prepareTransfer,
  savePending,
} from "@/ui/lib/prepare-flow";
import type { RecoveryBinding } from "@/ui/lib/recovery-vault";

const PAYEE = {
  id: "rec-1",
  destinationId: "dest-1",
  routeId: "usdc-polygon" as const,
  address: "0x0000000000000000000000000000000000000001",
  name: "Ada",
};

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const make = routes[url];
    if (!make) throw new TypeError("network down");
    void init;
    return make();
  }) as typeof fetch;
}

const transfer = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  status: "QUOTED",
  statusLabel: "Ready to pay",
  routeId: "usdc-polygon",
  asset: "USDC",
  network: "Polygon",
  destination: PAYEE.address,
  targetAmountAtomic: "5000000",
  recipientDestinationId: "dest-1",
  quote: { revision: 1 },
  quotedAt: new Date().toISOString(),
  quoteExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("transfer creation is idempotent and intent-explicit", () => {
  it("reuses the same idempotency key for the same intent (safe double-click)", () => {
    const key = newIdempotencyKey();
    const a = buildTransferBody({ payee: PAYEE, fixed: null, targetAmountAtomic: "5000000", idempotencyKey: key });
    const b = buildTransferBody({ payee: PAYEE, fixed: null, targetAmountAtomic: "5000000", idempotencyKey: key });
    expect(a).toEqual(b);
    expect(a.idempotencyKey).toBe(key);
  });

  it("generates unique keys per intent", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    expect(newIdempotencyKey().length).toBeGreaterThanOrEqual(8);
  });

  it("returns the deduplicated transfer instead of creating a second one", async () => {
    const f = mockFetch({
      "/api/transfers": json(200, { transfer: transfer(), deduplicated: true }),
    });
    const res = await createTransfer(buildTransferBody({ payee: PAYEE, fixed: null, targetAmountAtomic: "5000000", idempotencyKey: "k-12345678" }), { fetch: f });
    expect(res.ok && res.data.deduplicated).toBe(true);
  });

  it("surfaces idempotency conflicts as resume-never-duplicate", async () => {
    const f = mockFetch({
      "/api/transfers": json(409, { error: "IDEMPOTENCY_CONFLICT", message: "used" }),
    });
    const res = await createTransfer(buildTransferBody({ payee: PAYEE, fixed: null, targetAmountAtomic: "5000000", idempotencyKey: "k-12345678" }), { fetch: f });
    expect(!res.ok && res.code).toBe("IDEMPOTENCY_CONFLICT");
    const issue = classifyPreparationFailure(!res.ok ? { kind: res.kind, code: res.code } : { kind: "server", code: null });
    expect(issue.action).toBe("resume");
    expect(issue.body).toMatch(/do not resend|instead of starting over/i);
  });
});

describe("payment-request terms are immutable", () => {
  it("pins amount and route to the request snapshot", () => {
    const body = buildTransferBody({
      payee: { ...PAYEE, destinationId: null },
      fixed: { publicId: "req_abc", amountAtomic: "5000000" },
      targetAmountAtomic: "5000000",
      idempotencyKey: "k-immutable-1",
    });
    expect(body.requestPublicId).toBe("req_abc");
    expect(body.targetAmountAtomic).toBe("5000000");
    expect(body.direct).toBeUndefined();
  });

  it("rejects any amount that differs from the request snapshot", () => {
    expect(() =>
      buildTransferBody({
        payee: { ...PAYEE, destinationId: null },
        fixed: { publicId: "req_abc", amountAtomic: "5000000" },
        targetAmountAtomic: "5000001",
        idempotencyKey: "k-immutable-2",
      }),
    ).toThrow(/request amount/i);
  });

  it("uses direct destination only when no saved wallet or request is present", () => {
    const body = buildTransferBody({
      payee: { id: null, destinationId: null, routeId: "usdc-polygon", address: PAYEE.address, name: "Someone new" },
      fixed: null,
      targetAmountAtomic: "5000000",
      idempotencyKey: "k-direct-1",
    });
    expect(body.direct).toMatchObject({ asset: "USDC", network: "Polygon", address: PAYEE.address });
  });
});

describe("quote expiration blocks preparation", () => {
  it("treats past validUntil as stale", () => {
    expect(isQuoteFresh(new Date(Date.now() - 1000).toISOString())).toBe(false);
    expect(isQuoteFresh(new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(isQuoteFresh(null)).toBe(false);
  });

  it("maps QUOTE_STALE to an explicit requote action", () => {
    const issue = classifyPreparationFailure({ kind: "conflict", code: "QUOTE_STALE" });
    expect(issue.action).toBe("requote");
    expect(issue.retryable).toBe(true);
  });

  it("maps an exposure-blocked fresh intent to a local stop without an Activity detour", () => {
    const issue = classifyPreparationFailure({ kind: "http", code: "PILOT_EXPOSURE_LIMIT" });
    expect(issue).toMatchObject({
      title: "Another payment is still being checked",
      retryable: false,
      action: "abort",
    });
    expect(issue.body).toMatch(/was not prepared/i);
    expect(issue.action).not.toBe("resume");
  });

  it("maps a pilot-capped duplicate create to continue-instead-of-restart", () => {
    const issue = classifyPreparationFailure({ kind: "invalid", code: "PILOT_ATTEMPTS_EXCEEDED" });
    expect(issue.title).toBe("You already have this payment in progress");
    expect(issue.action).toBe("resume");
    expect(issue.retryable).toBe(true);
  });

  it("warns before a second payment could create exposure", () => {
    for (const code of ["PILOT_EXPOSURE_LIMIT", "PAYMENT_EXPOSURE_UNCERTAIN"]) {
      const issue = classifyPreparationFailure({ kind: "invalid", code });
      expect(issue.title).toBe("Another payment is still being checked");
      expect(issue.body).toMatch(/pay twice/i);
      expect(issue.action).toBe("abort");
      expect(issue.retryable).toBe(false);
    }
  });
});

describe("wrong wallet, route and amount never proceed", () => {
  it("rejects unknown routes at intent build time", () => {
    expect(() =>
      buildTransferBody({
        payee: { ...PAYEE, destinationId: null, routeId: "nope-nowhere" as never, address: PAYEE.address, name: "X" },
        fixed: null,
        targetAmountAtomic: "5",
        idempotencyKey: "k-bad-route",
      }),
    ).toThrow();
  });

  it("never reuses a binding when destination, amount, route or revision changed", () => {
    const binding: RecoveryBinding = {
      version: 1,
      transferId: "t-1",
      satoraSwapId: "swap-1",
      paymentHash: "0xabc",
      sourceSats: "6327",
      targetAtomic: "5000000",
      destination: PAYEE.address,
      routeId: "usdc-polygon",
      quoteRevision: 1,
      ownerUserId: "u-1",
      attemptToken: "tok",
      storedAt: new Date().toISOString(),
      verifiedAt: null,
    };
    const base = { transferId: "t-1", destination: PAYEE.address, targetAtomic: "5000000", routeId: "usdc-polygon", quoteRevision: 1, ownerUserId: "u-1" };
    expect(canReuseBinding(binding, base)).toBe(true);
    expect(canReuseBinding(binding, { ...base, destination: "0x0000000000000000000000000000000000000002" })).toBe(false);
    expect(canReuseBinding(binding, { ...base, targetAtomic: "5000001" })).toBe(false);
    expect(canReuseBinding(binding, { ...base, routeId: "usdc-arbitrum" })).toBe(false);
    expect(canReuseBinding(binding, { ...base, quoteRevision: 2 })).toBe(false);
    expect(canReuseBinding(binding, { ...base, ownerUserId: "u-2" })).toBe(false);
    expect(canReuseBinding({ ...binding, attemptToken: "" }, base)).toBe(false);
  });
});

describe("pending pointer survives reload without leaking across users", () => {
  it("round-trips and isolates owners", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    try {
      savePending({ transferId: "t-1", idempotencyKey: "k-12345678", attemptToken: "tok", ownerUserId: "u-1", routeId: "usdc-polygon", targetAmountAtomic: "5" });
      expect(loadPending("u-1")?.transferId).toBe("t-1");
      expect(loadPending("u-2")).toBeNull();
      clearPending("u-1", "t-1");
      expect(loadPending("u-1")).toBeNull();
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("keeps independent transfer pointers and clears only the requested transfer", () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    };
    const first = { transferId: "t-1", idempotencyKey: "k-first-12345678", attemptToken: "tok-1", ownerUserId: "u-1", routeId: "usdc-polygon", targetAmountAtomic: "5" };
    const second = { transferId: "t-2", idempotencyKey: "k-second-12345678", attemptToken: "tok-2", ownerUserId: "u-1", routeId: "usdc-polygon", targetAmountAtomic: "6" };
    savePending(first);
    savePending(second);
    expect(loadPending("u-1", "t-1")?.idempotencyKey).toBe(first.idempotencyKey);
    expect(loadPending("u-1", "t-2")?.idempotencyKey).toBe(second.idempotencyKey);
    expect(loadPending("u-1")?.transferId).toBe("t-2");
    clearPending("u-1", "t-1");
    expect(loadPending("u-1", "t-1")).toBeNull();
    expect(loadPending("u-1", "t-2")?.idempotencyKey).toBe(second.idempotencyKey);
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("offers resume only for known, non-terminal transfers", () => {
    for (const s of ["DRAFT", "QUOTED", "SWAP_CREATED", "AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "NEEDS_ATTENTION"]) {
      expect(isPendingTransferResumable(s), s).toBe(true);
    }
    // Terminal pointers are stale and must be cleared by the UI.
    for (const s of ["QUOTE_EXPIRED", "USER_CANCELLED", "DELIVERED", "FAILED"]) {
      expect(isPendingTransferResumable(s), s).toBe(false);
    }
    // Unknown states hide the offer without destroying anything.
    expect(isPendingTransferResumable("SOMETHING_NEW")).toBe(false);
    expect(isPendingTransferResumable("")).toBe(false);
  });

  it("derives the handoff display amount from transfer terms, never the empty calculator", () => {
    // Request-fixed amounts win verbatim.
    expect(displayAmountForHandoff({ fixedAmount: "25.5", targetAmountAtomic: "25500000", asset: "USDC", fallback: "0" })).toBe("25.5");
    // Exact atomic terms humanize (survives reload with an empty calculator).
    expect(displayAmountForHandoff({ fixedAmount: null, targetAmountAtomic: "5000000", asset: "USDC", fallback: "0" })).toBe("5");
    // Unrepresentable amounts fall back instead of fabricating.
    expect(displayAmountForHandoff({ fixedAmount: null, targetAmountAtomic: "0", asset: "USDC", fallback: "0" })).toBe("0");
    expect(displayAmountForHandoff({ fixedAmount: null, targetAmountAtomic: "abc", asset: "USDC", fallback: "0" })).toBe("0");
  });
});

describe("network, session and backend gates", () => {
  it("maps network loss to resume (never a second payment)", () => {
    const issue = classifyPreparationFailure({ kind: "network", code: null });
    expect(issue.action).toBe("resume");
  });

  it("maps 401 to re-auth and stops the flow", () => {
    const issue = classifyPreparationFailure({ kind: "unauthorized", code: null });
    expect(issue.action).toBe("reauth");
    expect(issue.retryable).toBe(false);
  });

  it("maps rate limits to retry", () => {
    expect(classifyPreparationFailure({ kind: "rate-limited", code: null }).action).toBe("retry");
  });

  it("F8.9: transient provider failures map to safe same-payment retry", () => {
    for (const [kind, code] of [
      ["conflict", "PROVIDER_MALFORMED"],
      ["conflict", "PROVIDER_TIMEOUT"],
      ["server", "PROVIDER_UNAVAILABLE"],
      ["not-found", "SWAP_NOT_FOUND"],
    ] as const) {
      const issue = classifyPreparationFailure({ kind, code });
      expect(issue.action).toBe("retry");
      expect(issue.retryable).toBe(true);
      expect(issue.title).toMatch(/safe to retry/i);
      expect(issue.body).toMatch(/do not start a new one/i);
    }
  });

  it("prepare conflict converges to resume", async () => {
    const f = mockFetch({ "/api/transfers/t-1/prepare": json(409, { error: "VERSION_CONFLICT", message: "changed" }) });
    const res = await prepareTransfer("t-1", 1, { fetch: f });
    expect(!res.ok && res.code).toBe("VERSION_CONFLICT");
    expect(classifyPreparationFailure(!res.ok ? { kind: res.kind, code: res.code } : { kind: "server", code: null }).action).toBe("resume");
  });

  it("attach conflict never replaces the bound swap", async () => {
    const f = mockFetch({ "/api/transfers/t-1/attach": json(409, { error: "SWAP_CONFLICT", message: "bound" }) });
    const res = await attachTransferSwap("t-1", { attemptToken: "tok", expectedQuoteRevision: 1, satoraSwapId: "other", recoveryAcknowledged: true }, { fetch: f });
    expect(!res.ok && res.code).toBe("SWAP_CONFLICT");
    expect(classifyPreparationFailure(!res.ok ? { kind: res.kind, code: res.code } : { kind: "server", code: null }).action).toBe("resume");
  });

  it("authorize replay converges to resume (single authorization held)", async () => {
    const f = mockFetch({ "/api/transfers/t-1/authorize-handoff": json(409, { error: "ALREADY_AUTHORIZED", message: "done" }) });
    const res = await authorizeTransferHandoff("t-1", "tok", { fetch: f });
    expect(!res.ok && res.code).toBe("ALREADY_AUTHORIZED");
    expect(classifyPreparationFailure(!res.ok ? { kind: res.kind, code: res.code } : { kind: "server", code: null }).action).toBe("resume");
  });

  it("repricing stops the flow instead of approving a larger obligation", async () => {
    const f = mockFetch({ "/api/transfers/t-1/authorize-handoff": json(409, { error: "REPRICED_NEEDS_CONFIRMATION", message: "moved" }) });
    const res = await authorizeTransferHandoff("t-1", "tok", { fetch: f });
    const issue = classifyPreparationFailure(!res.ok ? { kind: res.kind, code: res.code } : { kind: "server", code: null });
    expect(issue.action).toBe("abort");
  });

  it("resume inspects authoritative transfer state first", async () => {
    const f = mockFetch({
      "/api/transfers/t-1": json(200, { transfer: transfer({ status: "AWAITING_NIM_APPROVAL", statusLabel: "Approve in Nimiq Pay" }) }),
      "/api/transfers/t-1/attempt": json(200, { attempt: { id: "a", status: "HANDOFF_AUTHORIZED", quoteRevision: 1, satoraSwapId: "swap-1" }, swap: { sourceSats: "6327" }, transferStatus: "AWAITING_NIM_APPROVAL" }),
    });
    const t = await fetchTransfer("t-1", { fetch: f });
    const a = await fetchAttempt("t-1", { fetch: f });
    expect(t.ok && t.data.transfer.status).toBe("AWAITING_NIM_APPROVAL");
    expect(a.ok && a.data.transferStatus).toBe("AWAITING_NIM_APPROVAL");
  });
});

describe("safety boundary: no payment-provider invocations", () => {
  const sources = [
    "src/ui/lib/prepare-flow.ts",
    "src/ui/lib/recovery-vault.ts",
    "src/ui/lib/satora-browser.ts",
    "src/ui/screens/send/usePreparation.ts",
    "src/ui/screens/send/SendFlow.tsx",
  ];
  it("never calls pay, claim or refund paths", () => {
    const forbidden = ["payLightningInvoice", "refundSwap", "claimEvm", "fundSwap", "collabRefund"];
    for (const file of sources) {
      const raw = fs.readFileSync(file, "utf8");
      // Comments document the boundary; only code counts.
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const token of forbidden) {
        expect(text.includes(token), `${file} must not invoke ${token}`).toBe(false);
      }
      // No claim() invocation outside comments — except the single gated
      // wrapper in satora-browser.ts (claimStoredSwap), which only runs
      // after useSettlement evaluates the claim gate (OFF in this milestone).
      const claimCalls = text.match(/\.claim\s*\(/g) ?? [];
      if (file === "src/ui/lib/satora-browser.ts") {
        expect(claimCalls.length, `${file} must expose exactly one gated claim call`).toBe(1);
        expect(text.includes("client.claim(swapId)"), `${file} claim must use the exact SDK method`).toBe(true);
      } else {
        expect(claimCalls.length, `${file} must not invoke claim()`).toBe(0);
      }
    }
  });
});
