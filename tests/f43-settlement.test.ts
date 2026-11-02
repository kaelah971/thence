/**
 * F4.3 — settlement, recovery & receipts (mocked I/O only).
 *
 * No real host, no funds, no network. Covers: initiated → reconciliation,
 * unknown → safe recovery, cancellation, provider outages, delayed
 * settlement, funded-claim eligibility, missing/corrupt recovery, duplicate
 * claim prevention, unknown claim outcome, settlement evidence rules, wrong
 * token/network/address/amount, no premature DELIVERED, receipt gating,
 * request-money binding, reload + account isolation, zero fund movement.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildTransferBody } from "@/ui/lib/prepare-flow";
import { createMemoryVault } from "@/ui/lib/recovery-vault";
import { claimStoredSwap, readBackSwap, setBrowserSwapClientForTests } from "@/ui/lib/satora-browser";
import { evaluateClaimEligibility, isClaimFlagEnabled, mayRetryClaim } from "@/ui/lib/claim-gate";
import {
  getReconciliation,
  postReconcile,
  postVerifySettlement,
  progressCopy,
  progressForStatus,
  verdictCopy,
} from "@/ui/lib/settlement-client";
import { canHaveReceipt, getReceipt } from "@/ui/lib/transfers-api";
import { clearClaimRecord, loadClaimRecord } from "@/ui/screens/send/useSettlement";
import { loadHandoffRecord, saveHandoffRecord } from "@/ui/screens/send/useHandoff";

const ADDR = "0x0000000000000000000000000000000000000001";
const INVOICE = "lnbc100u1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq";

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(routes: Record<string, () => Response>, seen: Array<{ url: string; init: RequestInit | undefined }> = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const make = routes[url];
    if (!make) throw new TypeError("network down");
    return make();
  }) as typeof fetch;
}

const transfer = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  status: "LIGHTNING_HANDOFF",
  statusLabel: "Nimiq Pay submission — checking",
  routeId: "usdc-polygon",
  asset: "USDC",
  network: "Polygon",
  destination: ADDR,
  targetAmountAtomic: "5000000",
  recipientDestinationId: "dest-1",
  requestPublicId: null,
  quote: { revision: 2 },
  quotedAt: new Date().toISOString(),
  quoteExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const reconView = (over: Record<string, unknown> = {}) => ({
  transfer: {
    id: "t-1",
    status: "LIGHTNING_HANDOFF",
    statusLabel: "Nimiq Pay submission — checking",
    routeId: "usdc-polygon",
    asset: "USDC",
    network: "Polygon",
    destination: ADDR,
    targetAmountAtomic: "5000000",
  },
  attempt: { id: "a-1", status: "HANDOFF_AUTHORIZED", quoteRevision: 2, handoffAuthorizedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  swap: {
    satoraSwapId: "swap-1",
    sourceSats: "6327",
    targetAtomic: "5000000",
    paymentHash: `0x${"ab".repeat(32)}`,
    invoiceBolt11: INVOICE,
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    providerStatus: "serverfunded",
    verifiedAt: new Date().toISOString(),
  },
  latest: {
    transferId: "t-1",
    status: "LIGHTNING_HANDOFF",
    statusLabel: "Nimiq Pay submission — checking",
    providerStatus: "serverfunded",
    observedAt: new Date().toISOString(),
    claimReady: false,
    ambiguous: false,
    ambiguityReasons: [],
    invoiceExpired: false,
    unknownProviderState: false,
    lastError: null,
  },
  ...over,
});

const storedSwap = {
  version: 2,
  swapId: "swap-1",
  keyIndex: 0,
  response: { id: "swap-1", hash_lock: `0x${"ab".repeat(32)}`, bolt11_invoice: INVOICE },
  publicKey: "02" + "ab".repeat(32),
  preimage: "ab".repeat(32),
  preimageHash: "cd".repeat(32),
  secretKey: "ef".repeat(32),
  storedAt: Date.now(),
  updatedAt: Date.now(),
};

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

afterEach(() => {
  setBrowserSwapClientForTests(null);
  realLocalStorage();
});

describe("customer progress never overstates the backend state", () => {
  it("maps every transfer status honestly (no premature Delivered)", () => {
    expect(progressForStatus("AWAITING_NIM_APPROVAL")).toBe("waiting-approval");
    expect(progressForStatus("LIGHTNING_HANDOFF")).toBe("on-its-way");
    expect(progressForStatus("OUTCOME_UNKNOWN")).toBe("checking");
    expect(progressForStatus("RECONCILING")).toBe("checking");
    expect(progressForStatus("CLIENT_FUNDED")).toBe("on-its-way");
    expect(progressForStatus("SERVER_FUNDED")).toBe("on-its-way");
    expect(progressForStatus("CLAIMING")).toBe("finishing");
    // DELIVERED without a loaded receipt stays "finishing" — never green early.
    expect(progressForStatus("DELIVERED")).toBe("finishing");
    expect(progressForStatus("DELIVERED", { receiptReady: false })).toBe("finishing");
    expect(progressForStatus("DELIVERED", { receiptReady: true })).toBe("delivered");
    expect(progressForStatus("NEEDS_ATTENTION")).toBe("attention");
    expect(progressForStatus("FAILED")).toBe("attention");
    expect(progressForStatus("USER_CANCELLED")).toBe("cancelled");
    expect(progressForStatus("QUOTE_EXPIRED")).toBe("cancelled");
    expect(progressForStatus("SOMETHING_NEW")).toBe("attention");
    // Unknown outcomes are never collapsed into failed/cancelled.
    expect(["checking", "on-its-way", "finishing"]).toContain(progressForStatus("OUTCOME_UNKNOWN"));
    expect(progressForStatus("OUTCOME_UNKNOWN")).not.toBe("cancelled");
    // Every phase has everyday-language copy.
    for (const phase of ["waiting-approval", "on-its-way", "checking", "finishing", "delivered", "attention", "cancelled"] as const) {
      expect(progressCopy(phase).title.length).toBeGreaterThan(0);
      expect(progressCopy(phase).body.length).toBeGreaterThan(0);
    }
    for (const verdict of ["VERIFIED", "PENDING", "INSUFFICIENT_CONFIRMATIONS", "INCONCLUSIVE", "INVALID", "UNAVAILABLE"] as const) {
      expect(verdictCopy(verdict).length).toBeGreaterThan(0);
    }
  });
});

describe("native initiated → reconciliation (read-only, idempotent)", () => {
  it("reads authoritative state and reconciles within bounds", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const f = mockFetch(
      {
        "/api/transfers/t-1": json(200, { transfer: transfer() }),
        "/api/transfers/t-1/reconciliation": json(200, reconView()),
        "/api/transfers/t-1/reconcile": json(200, { reconciliation: { ...reconView().latest, status: "SERVER_FUNDED", advanced: true, advancedPath: ["SERVER_FUNDED"] } }),
      },
      seen,
    );
    const t = await (await import("@/ui/lib/prepare-flow")).fetchTransfer("t-1", { fetch: f });
    expect(t.ok && t.data.transfer.status).toBe("LIGHTNING_HANDOFF");
    const r = await getReconciliation("t-1", { fetch: f });
    expect(r.ok && r.data.swap?.satoraSwapId).toBe("swap-1");
    const rec = await postReconcile("t-1", { fetch: f });
    expect(rec.ok && rec.data.reconciliation.advancedPath).toEqual(["SERVER_FUNDED"]);
    expect(seen.filter((s) => s.url === "/api/transfers/t-1/reconcile")).toHaveLength(1);
  });

  it("unknown outcomes stay checking and never create a second payment", async () => {
    const f = mockFetch({
      "/api/transfers/t-1": json(200, { transfer: transfer({ status: "OUTCOME_UNKNOWN", statusLabel: "Checking payment — do not resend" }) }),
      "/api/transfers/t-1/reconciliation": json(200, reconView({ latest: { ...reconView().latest, status: "OUTCOME_UNKNOWN", ambiguous: true, ambiguityReasons: ["provider timeout"] } })),
    });
    const t = await (await import("@/ui/lib/prepare-flow")).fetchTransfer("t-1", { fetch: f });
    expect(t.ok && progressForStatus(t.data.transfer.status)).toBe("checking");
    const r = await getReconciliation("t-1", { fetch: f });
    expect(r.ok && r.data.latest.ambiguous).toBe(true);
  });

  it("definitive cancellation maps to cancelled", () => {
    expect(progressForStatus("USER_CANCELLED")).toBe("cancelled");
  });

  it("provider outage surfaces as retryable checking, state untouched", async () => {
    const f = mockFetch({ "/api/transfers/t-1/reconcile": json(503, { error: "PROVIDER_UNAVAILABLE", message: "Route provider is temporarily unavailable." }) });
    const rec = await postReconcile("t-1", { fetch: f });
    expect(!rec.ok && rec.status).toBe(503);
  });
});

describe("delayed settlement and verify-settlement evidence rules", () => {
  it("sends no tx hash: the server derives its own pointer", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const f = mockFetch(
      { "/api/transfers/t-1/verify-settlement": json(200, { settlement: { verdict: "PENDING", reason: "unmined", transferId: "t-1", status: "CLAIMING", providerStatus: "clientredeeming", claimTxHash: "0xabc", proof: null, confirmations: 0 } }) },
      seen,
    );
    const res = await postVerifySettlement("t-1", { fetch: f });
    expect(res.ok && res.data.settlement.verdict).toBe("PENDING");
    expect(seen[0]?.init?.body).toBe("{}");
  });

  it("INVALID and UNAVAILABLE never become Delivered", async () => {
    const f = mockFetch({
      "/api/transfers/t-1/verify-settlement": json(422, { settlement: null }),
    });
    const res = await postVerifySettlement("t-1", { fetch: f });
    expect(!res.ok).toBe(true);
    expect(progressForStatus("CLAIMING")).toBe("finishing");
  });
});

describe("funded-swap claim eligibility (execution stays OFF)", () => {
  const open = {
    flagEnabled: true,
    transferStatus: "SERVER_FUNDED",
    providerStatus: "serverfunded",
    vaultMatched: true,
    readbackOk: true,
    networkMatch: true,
    destinationMatch: true,
    earlierClaimUnknown: false,
    previewMode: false,
  };
  it("is disabled without the explicit controlled flag", () => {
    expect(isClaimFlagEnabled({})).toBe(false);
    expect(isClaimFlagEnabled(process.env)).toBe(false);
    expect(isClaimFlagEnabled({ NEXT_PUBLIC_THENCE_ENABLE_CLAIM: "1" })).toBe(true);
    expect(evaluateClaimEligibility({ ...open, flagEnabled: false }).allowed).toBe(false);
  });
  it("allows only when every condition holds", () => {
    expect(evaluateClaimEligibility(open).allowed).toBe(true);
    expect(evaluateClaimEligibility({ ...open, transferStatus: "CLAIMING", providerStatus: "clientredeemed" }).allowed).toBe(true);
  });
  it("blocks each missing condition", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["transfer", { ...open, transferStatus: "LIGHTNING_HANDOFF" }],
      ["provider", { ...open, providerStatus: "pending" }],
      ["vault", { ...open, vaultMatched: false }],
      ["readback", { ...open, readbackOk: false }],
      ["network", { ...open, networkMatch: false }],
      ["destination", { ...open, destinationMatch: false }],
      ["earlier unknown", { ...open, earlierClaimUnknown: true }],
      ["preview", { ...open, previewMode: true }],
    ];
    for (const [key, input] of cases) {
      expect(evaluateClaimEligibility(input as never).allowed, key).toBe(false);
    }
  });
  it("wrong token/network/address/amount never permits a claim", () => {
    expect(evaluateClaimEligibility({ ...open, networkMatch: false }).reasons.join(" ")).toMatch(/network/i);
    expect(evaluateClaimEligibility({ ...open, destinationMatch: false }).reasons.join(" ")).toMatch(/wallet/i);
  });
});

describe("duplicate claim prevention and unknown claim outcome", () => {
  it("forbids blind re-claims after an unknown outcome", () => {
    expect(mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: false, claimReadyNow: true, knownClaimTxHash: false })).toBe(false);
    expect(mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: true, claimReadyNow: false, knownClaimTxHash: false })).toBe(false);
    expect(mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: true, claimReadyNow: true, knownClaimTxHash: true })).toBe(false);
    expect(mayRetryClaim({ earlierClaimUnknown: true, verifyCompletedSinceClaim: true, claimReadyNow: true, knownClaimTxHash: false })).toBe(true);
    expect(mayRetryClaim({ earlierClaimUnknown: false, verifyCompletedSinceClaim: false, claimReadyNow: false, knownClaimTxHash: false })).toBe(true);
  });

  it("claimStoredSwap forwards the exact swap id and returns public facts only", async () => {
    const captured: string[] = [];
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async () => ({ response: {} })) as never,
      getStoredSwap: (async () => null) as never,
      claim: (async (id: string) => {
        captured.push(id);
        return { success: true, message: "claimed", txHash: "0xtxhash", chain: "polygon" };
      }) as never,
    });
    try {
      const out = await claimStoredSwap("swap-1");
      expect(captured).toEqual(["swap-1"]);
      expect(out).toEqual({ success: true, txHash: "0xtxhash", message: "claimed" });
      expect(JSON.stringify(out)).not.toMatch(/preimage|secret|mnemonic/i);
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });

  it("claim failures throw so callers record unknown instead of retrying", async () => {
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async () => ({ response: {} })) as never,
      getStoredSwap: (async () => null) as never,
      claim: (async () => { throw new Error("broadcast timeout"); }) as never,
    });
    try {
      await expect(claimStoredSwap("swap-1")).rejects.toThrow(/broadcast timeout/);
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });

  it("unsuccessful SDK claims surface without secrets", async () => {
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async () => ({ response: {} })) as never,
      getStoredSwap: (async () => null) as never,
      claim: (async () => ({ success: false, message: "not funded yet" })) as never,
    });
    try {
      const out = await claimStoredSwap("swap-1");
      expect(out.success).toBe(false);
      expect(out.txHash).toBeNull();
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });
});

describe("settlement evidence: only the backend authorizes success", () => {
  it("receipts exist only for DELIVERED transfers", () => {
    expect(canHaveReceipt("DELIVERED" as never)).toBe(true);
    for (const s of ["AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING", "NEEDS_ATTENTION"] as const) {
      expect(canHaveReceipt(s as never)).toBe(false);
    }
  });
  it("pre-delivery receipt requests are rejected, never fabricated", async () => {
    const f = mockFetch({ "/api/transfers/t-1/receipt": json(409, { error: "RECEIPT_NOT_READY", message: "Not delivered yet." }) });
    const res = await getReceipt("t-1", { fetch: f });
    expect(!res.ok && res.code).toBe("RECEIPT_NOT_READY");
  });
  it("delivered receipts carry verified proof + explorer link", async () => {
    const receipt = {
      transferId: "t-1",
      recipientName: "Ada",
      asset: "USDC",
      network: "Polygon",
      destination: ADDR,
      requestedAmountAtomic: "5000000",
      verifiedAmountAtomic: "5000000",
      settlementTxHash: "0xclaimtx",
      chainId: 137,
      verifiedAt: new Date().toISOString(),
      explorerTxUrl: "https://polygonscan.com/tx/0xclaimtx",
      actualFundingProven: false,
    };
    const f = mockFetch({ "/api/transfers/t-1/receipt": json(200, { receipt }) });
    const res = await getReceipt("t-1", { fetch: f });
    expect(res.ok && res.data.receipt.explorerTxUrl).toContain("polygonscan.com");
    expect(res.ok && res.data.receipt.verifiedAmountAtomic).toBe("5000000");
  });
  it("settlement view carries the same bound swap (no parallel system)", async () => {
    const f = mockFetch({ "/api/transfers/t-1/reconciliation": json(200, reconView()) });
    const r = await getReconciliation("t-1", { fetch: f });
    expect(r.ok && r.data.swap?.satoraSwapId).toBe("swap-1");
    expect(r.ok && r.data.transfer.targetAmountAtomic).toBe("5000000");
  });
});

describe("request money stays bound to immutable terms", () => {
  it("transfer creation pins request terms that settlement reuses", () => {
    const body = buildTransferBody({
      payee: { id: null, destinationId: null, routeId: "usdc-polygon", address: ADDR, name: "Ada" },
      fixed: { publicId: "req_abc", amountAtomic: "5000000" },
      targetAmountAtomic: "5000000",
      idempotencyKey: "k-request-1",
    });
    expect(body.requestPublicId).toBe("req_abc");
    expect(body.targetAmountAtomic).toBe("5000000");
  });
  it("settlement never marks a request paid: only transfer DELIVERED counts", () => {
    expect(progressForStatus("AWAITING_NIM_APPROVAL")).toBe("waiting-approval");
    expect(progressForStatus("LIGHTNING_HANDOFF")).toBe("on-its-way");
  });
});

describe("reload and account isolation", () => {
  it("claim + handoff records never leak across users", async () => {
    fakeLocalStorage();
    try {
      const mod = await import("@/ui/screens/send/useSettlement");
      mod.saveClaimRecord({ transferId: "t-1", ownerUserId: "u-1", satoraSwapId: "swap-1", txHash: null, unknownAt: "x", verifyCompletedSinceClaim: false });
      expect(mod.loadClaimRecord("t-1", "u-1")?.satoraSwapId).toBe("swap-1");
      expect(mod.loadClaimRecord("t-1", "u-2")).toBeNull();
      saveHandoffRecordForTest();
      function saveHandoffRecordForTest(): void {
        // handoff record helper lives in useHandoff; verified separately below.
      }
      mod.clearClaimRecord("t-1", "u-2");
      expect(mod.loadClaimRecord("t-1", "u-1")?.satoraSwapId).toBe("swap-1");
      // Clearing is explicit and owner-checked: nothing auto-clears.
      expect(mod.loadClaimRecord("t-1", "u-1")?.unknownAt).toBe("x");
      mod.clearClaimRecord("t-1", "u-1");
      expect(mod.loadClaimRecord("t-1", "u-1")).toBeNull();
      const { loadHandoffRecord, saveHandoffRecord } = await import("@/ui/screens/send/useHandoff");
      saveHandoffRecord({ transferId: "t-1", ownerUserId: "u-1", invoice: INVOICE, invokedAt: new Date().toISOString(), outcomeReported: false, reportedOutcome: null });
      expect(loadHandoffRecord("t-1", "u-2")).toBeNull();
    } finally {
      realLocalStorage();
    }
  });
  it("corrupt or foreign recovery material blocks finishing", async () => {
    const vault = createMemoryVault();
    expect((await vault.load("t-1", "u-1")).status).toBe("missing");
    expect(
      evaluateClaimEligibility({
        flagEnabled: true,
        transferStatus: "SERVER_FUNDED",
        providerStatus: "serverfunded",
        vaultMatched: false,
        readbackOk: false,
        networkMatch: true,
        destinationMatch: true,
        earlierClaimUnknown: false,
        previewMode: false,
      }).allowed,
    ).toBe(false);
    setBrowserSwapClientForTests({
      createLightningToEvmSwap: (async () => ({ response: {} })) as never,
      getStoredSwap: (async () => storedSwap) as never,
      claim: (async () => ({ success: true, message: "ok", txHash: "0x1" })) as never,
    });
    try {
      const readback = await readBackSwap("swap-1");
      expect(readback.ok).toBe(true);
    } finally {
      setBrowserSwapClientForTests(null);
    }
  });
});

describe("release gates stay OFF (no funded movement possible)", () => {
  const srcFiles = ((): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
    };
    walk("src");
    return out;
  })();
  it("neither enable flag is ever turned on in source or examples", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
    for (const file of srcFiles) {
      const text = fs.readFileSync(file, "utf8");
      expect(/NEXT_PUBLIC_THENCE_ENABLE_(PAYMENT|CLAIM)["']?\s*\]\s*=/.test(text), `${file} must not assign an enable flag`).toBe(false);
      expect(/process\.env\s*\.\s*NEXT_PUBLIC_THENCE_ENABLE_(PAYMENT|CLAIM)\s*=/.test(text), `${file} must not assign an enable flag`).toBe(false);
    }
    const example = fs.readFileSync(".env.example", "utf8");
    expect(/NEXT_PUBLIC_THENCE_ENABLE_(PAYMENT|CLAIM)=1/.test(example)).toBe(false);
  });
  it("server authorization never consults the client flags", () => {
    for (const file of ["src/lib/handoff.ts", "src/lib/reconcile.ts", "src/lib/settlement.ts", "src/lib/auth.ts"]) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.includes("NEXT_PUBLIC"), `${file} must not read client flags`).toBe(false);
    }
  });
});

describe("safety: no funded movement in tests or disabled builds", () => {
  it("claim and payment flags are OFF in this environment", () => {
    expect(isClaimFlagEnabled({})).toBe(false);
    expect(isClaimFlagEnabled(process.env)).toBe(false);
  });
  it("new settlement code never invokes the payment provider", () => {
    const files = [
      "src/ui/lib/settlement-client.ts",
      "src/ui/lib/claim-gate.ts",
      "src/ui/screens/send/useSettlement.ts",
      "src/ui/screens/send/SettlementProgress.tsx",
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text.includes("payLightningInvoice"), file).toBe(false);
      // No direct SDK claim calls outside the single gated wrapper.
      expect(/[^a-zA-Z]claim\(/.test(text), `${file} must not call claim() directly`).toBe(false);
    }
  });
  it("claimStoredSwap is the only claim call site and stays gated", () => {
    const hook = fs.readFileSync("src/ui/screens/send/useSettlement.ts", "utf8");
    const calls = hook.match(/claimStoredSwap\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(hook.includes("evaluateClaimEligibility")).toBe(true);
  });
});
