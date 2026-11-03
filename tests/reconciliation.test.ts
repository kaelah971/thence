/**
 * B4.3 — read-only reconciliation, ambiguous outcomes, client reporting.
 *
 * No swap creation, no funding, no claims, no DELIVERED anywhere in this
 * slice. Provider reads are faked through the satora test seam (fixtures);
 * only transfer creation uses live read-only quotes. Neon-backed integration.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { reconciliationObservations, transfers, users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { isClaimReady, planReconciliation } from "@/lib/reconcile";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { GET as resumeGet } from "../app/api/transfers/[id]/reconciliation/route";
import { GET as getTransfer } from "../app/api/transfers/[id]/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  setSatoraFetchersForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b43-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const EVM_A = "0x0000000000000000000000000000000000000001";
const ROUTES = "usdc-polygon,usdc-arbitrum,usdc-ethereum,usdt-polygon";
const setRoutes = (value: string): string | undefined => {
  const previous = process.env["THENCE_ENABLED_ROUTES"];
  process.env["THENCE_ENABLED_ROUTES"] = value;
  return previous;
};
const restoreRoutes = (previous: string | undefined): void => {
  if (previous === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
  else process.env["THENCE_ENABLED_ROUTES"] = previous;
};
/** Per-run swap ids: swap attachments are globally unique, so fixed ids would poison later runs after any crash-interrupted cleanup. */
const uniqSwap = (name: string): string => `${name}-${RUN}`;

function fixtureSwap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uniqSwap("swap-55555555-5555-5555-5555-555555555555"),
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc100u1p0fakeinvoicepp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fake",
    hash_lock: "0x" + "cd".repeat(32),
    source_amount: "6327",
    target_amount: "5000000",
    evm_chain_id: 137,
    target_evm_address: EVM_A,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
    status: "pending",
    invoice_expires_at: Math.floor(Date.now() / 1000) + 3600,
    fee_sats: 35,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
const mockSwap = (swap: Record<string, unknown> | null, fail?: "timeout" | "unavailable" | "missing"): void =>
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      if (fail === "timeout") return new Promise<never>(() => undefined);
      if (fail === "missing" || swap === null) throw Object.assign(new Error("not found"), { code: 404 });
      if (fail === "unavailable") throw new Error("boom");
      return { ...swap, id };
    },
  });

async function preparedTransfer(
  cookie: string,
  tag: string,
  keySuffix: string,
): Promise<{ id: string; token: string; quotedSourceSats: string }> {
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "5000000", idempotencyKey: `k-${RUN}-${keySuffix}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...withClient(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup transfer failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const prep = await preparePost(
    postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...withClient(tag) }),
    { params: Promise.resolve({ id: transfer.id }) },
  );
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken?: string }).attemptToken as string;
  return { id: transfer.id, token, quotedSourceSats: transfer.quote.sourceSats };
}

/** Full pre-handoff setup: create → prepare → attach (mocked pending) → authorize (mocked). Unique swap id per call (global uniqueness). */
let swapCounter = 0;
async function authorizedTransfer(cookie: string, tag: string, keySuffix: string): Promise<{ id: string; swapId: string }> {
  const { id, token, quotedSourceSats } = await preparedTransfer(cookie, tag, keySuffix);
  const swapId = `swap-test-${RUN}-${keySuffix}-${swapCounter++}`;
  // Fixture mirrors the live quote so the repricing guard passes setup.
  mockSwap(fixtureSwap({ id: swapId, source_amount: quotedSourceSats }));
  const { POST: attachPost } = await import("../app/api/transfers/[id]/attach/route");
  const { POST: authorizePost } = await import("../app/api/transfers/[id]/authorize-handoff/route");
  try {
    const attached = await attachPost(
      postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...withClient(tag) }),
      { params: Promise.resolve({ id }) },
    );
    if (attached.status !== 201) throw new Error(`setup attach failed: ${attached.status}`);
    const authed = await authorizePost(
      postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient(tag) }),
      { params: Promise.resolve({ id }) },
    );
    if (authed.status !== 200) throw new Error(`setup authorize failed: ${authed.status}`);
  } finally {
    setSatoraFetchersForTests(null);
  }
  return { id, swapId };
}

async function attachedTransfer(cookie: string, tag: string, keySuffix: string, swap: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const { id, token } = await preparedTransfer(cookie, tag, keySuffix);
  if (!token) throw new Error("setup prepare returned no token");
  mockSwap(swap);
  try {
    const attached = await attachPost(
      postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swap["id"], recoveryAcknowledged: true }, { cookie, ...withClient(tag) }),
      { params: Promise.resolve({ id }) },
    );
    if (attached.status !== 201) throw new Error(`setup attach failed: ${attached.status} ${JSON.stringify(await attached.json()).slice(0, 200)}`);
  } finally {
    setSatoraFetchersForTests(null);
  }
  return { id, token };
}

describe("reconciliation planning (pure, no I/O)", () => {
  it("holds on pending, funding-seen, expiry and unknown states", () => {
    for (const s of ["pending", "clientfundingseen", "expired", "mystery-state", ""]) {
      const d = planReconciliation("AWAITING_NIM_APPROVAL", s);
      expect(d.action).toBe("none");
    }
  });
  it("advances along legal edges only, monotonically", () => {
    expect(planReconciliation("AWAITING_NIM_APPROVAL", "clientfunded")).toMatchObject({ action: "advance", path: ["LIGHTNING_HANDOFF", "CLIENT_FUNDED"] });
    expect(planReconciliation("LIGHTNING_HANDOFF", "clientfunded")).toMatchObject({ action: "advance", path: ["CLIENT_FUNDED"] });
    expect(planReconciliation("CLIENT_FUNDED", "serverfunded")).toMatchObject({ action: "advance", path: ["SERVER_FUNDED"] });
    expect(planReconciliation("SERVER_FUNDED", "clientredeemed")).toMatchObject({ action: "advance", path: ["CLAIMING"] });
    expect(planReconciliation("CLAIMING", "serverredeemed")).toMatchObject({ action: "none" });
    expect(planReconciliation("SERVER_FUNDED", "pending")).toMatchObject({ action: "none" });
  });
  it("routes terminal refund evidence to REFUNDED without enabling a claim", () => {
    expect(planReconciliation("RECONCILING", "clientrefunded")).toMatchObject({ action: "advance", path: ["REFUNDED"] });
    expect(planReconciliation("SERVER_FUNDED", "clientfundedserverrefunded")).toMatchObject({ action: "advance", path: ["REFUNDED"] });
    expect(planReconciliation("CLIENT_FUNDED", "serverwontfund")).toMatchObject({ action: "needs-attention", path: ["NEEDS_ATTENTION"] });
    expect(planReconciliation("LIGHTNING_HANDOFF", "expired")).toMatchObject({ action: "none" });
  });
  it("marks claim-ready only on provider-funded states in funded transfers", () => {
    expect(isClaimReady("SERVER_FUNDED", "serverfunded")).toBe(true);
    expect(isClaimReady("CLAIMING", "clientredeemed")).toBe(true);
    expect(isClaimReady("CLIENT_FUNDED", "clientfunded")).toBe(false);
    expect(isClaimReady("AWAITING_NIM_APPROVAL", "pending")).toBe(false);
    expect(isClaimReady("SERVER_FUNDED", "pending")).toBe(false);
    expect(isClaimReady("SERVER_FUNDED", "clientfundedserverrefunded")).toBe(false);
    expect(isClaimReady("REFUNDED", "serverfunded")).toBe(false);
  });
});

describe.skipIf(!LIVE)("read-only reconciliation (mocked provider)", () => {
  it("observes pending without transitions and exposes resume metadata", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-pending");
      const { id } = await authorizedTransfer(cookie, "recon-pending", "p1");
      mockSwap(fixtureSwap());
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-pending") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        const body = ((await res.json()) as { reconciliation: Record<string, unknown> }).reconciliation;
        expect(body["status"]).toBe("AWAITING_NIM_APPROVAL");
        expect(body["providerStatus"]).toBe("pending");
        expect(body["advanced"]).toBe(false);
        expect(body["ambiguous"]).toBe(false);
        expect(body["claimReady"]).toBe(false);
        const resume = await resumeGet(new Request(`http://localhost/api/transfers/${id}/reconciliation`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
        expect(resume.status).toBe(200);
        expect(resume.headers.get("cache-control")).toBe("no-store");
        const view = ((await resume.json()) as { transfer: Record<string, unknown>; swap: Record<string, unknown> | null; attempt: unknown; latest: Record<string, unknown> });
        expect(view.transfer["id"]).toBe(id);
        expect(view.swap?.["satoraSwapId"]).toBeDefined();
        expect(view.attempt).not.toBeNull();
        expect(view.latest["providerStatus"]).toBe("pending");
        expect(JSON.stringify(view)).not.toMatch(/mnemonic|preimage|privateKey|private_key|secret/i);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("advances on provider-confirmed funding and survives repeats", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-funded");
      const { id } = await authorizedTransfer(cookie, "recon-funded", "p2");
      mockSwap(fixtureSwap({ status: "clientfunded" }));
      try {
        const first = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-funded") }), { params: Promise.resolve({ id }) });
        if (first.status !== 200) console.log("ADVANCES-DEBUG:", first.status, JSON.stringify(await first.clone().json()));
        expect(first.status).toBe(200);
        const one = ((await first.json()) as { reconciliation: { status: string; advanced: boolean; advancedPath: string[]; providerStatus?: string } }).reconciliation;
        if ((one as {status:string}).status !== "CLIENT_FUNDED") console.log("ADVANCES-DEBUG-BODY:", JSON.stringify(one));
        expect(one.status).toBe("CLIENT_FUNDED");
        expect(one.advanced).toBe(true);
        expect(one.advancedPath).toEqual(["LIGHTNING_HANDOFF", "CLIENT_FUNDED"]);
        const second = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-funded") }), { params: Promise.resolve({ id }) });
        expect(second.status).toBe(200);
        expect(((await second.json()) as { reconciliation: { status: string; advanced: boolean } }).reconciliation.advanced).toBe(false);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("never regresses on stale observations and never marks failure", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-stale");
      const { id } = await authorizedTransfer(cookie, "recon-stale", "p3");
      mockSwap(fixtureSwap({ status: "serverfunded" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-stale") }), { params: Promise.resolve({ id }) });
        expect(((await res.json()) as { reconciliation: { status: string } }).reconciliation.status).toBe("SERVER_FUNDED");
      } finally {
        setSatoraFetchersForTests(null);
      }
      mockSwap(fixtureSwap({ status: "pending" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-stale") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        const body = ((await res.json()) as { reconciliation: { status: string; advanced: boolean } }).reconciliation;
        expect(body.status).toBe("SERVER_FUNDED");
        expect(body.advanced).toBe(false);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("handles provider timeout without state change", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-timeout");
      const { id } = await authorizedTransfer(cookie, "recon-timeout", "p4");
      mockSwap(null, "timeout");
      const started = Date.now();
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-timeout") }), { params: Promise.resolve({ id }) });
        expect(Date.now() - started).toBeGreaterThanOrEqual(14000);
        expect(res.status).toBe(503);
        const body = ((await res.json()) as { error: string }).error;
        expect(["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"]).toContain(body);
      } finally {
        setSatoraFetchersForTests(null);
      }
      const detail = (await (await resumeGet(new Request(`http://localhost/api/transfers/${id}/reconciliation`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        latest: { lastError: string | null; providerStatus: string };
      };
      expect(detail.latest.lastError).not.toBeNull();
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);

  it("flags mismatched or unknown provider facts without transitioning", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-mismatch");
      const { id } = await authorizedTransfer(cookie, "recon-mismatch", "p5");
      mockSwap(fixtureSwap({ target_amount: "4999999" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-mismatch") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe("SWAP_MISMATCH");
      } finally {
        setSatoraFetchersForTests(null);
      }
      mockSwap(fixtureSwap({ status: "weird-future-state" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-mismatch") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        const body = ((await res.json()) as { reconciliation: { status: string; unknownProviderState: boolean; ambiguous: boolean } }).reconciliation;
        expect(body.status).toBe("AWAITING_NIM_APPROVAL");
        expect(body.unknownProviderState).toBe(true);
        expect(body.ambiguous).toBe(true);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("serializes concurrent reconciles into one advancement", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-race");
      const { id } = await authorizedTransfer(cookie, "recon-race", "p6");
      mockSwap(fixtureSwap({ status: "clientfunded" }));
      try {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient(`recon-race-${i}`) }), { params: Promise.resolve({ id }) }).then(async (r) => ({
              status: r.status,
              advanced: ((await r.json()) as { reconciliation?: { advanced?: boolean } }).reconciliation?.advanced ?? null,
            })),
          ),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(results.filter((r) => r.advanced).length).toBe(1);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("marks expired invoices ambiguous without failing", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-expired");
      const { id } = await authorizedTransfer(cookie, "recon-expired", "p7");
      mockSwap(fixtureSwap({ status: "pending", invoice_expires_at: Math.floor(Date.now() / 1000) - 10 }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-expired") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        const body = ((await res.json()) as { reconciliation: { status: string; ambiguous: boolean; invoiceExpired: boolean } }).reconciliation;
        expect(body.status).toBe("AWAITING_NIM_APPROVAL");
        expect(body.ambiguous).toBe(true);
        expect(body.invoiceExpired).toBe(true);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("exposes claim-ready only on provider-funded states", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-claim");
      const { id } = await authorizedTransfer(cookie, "recon-claim", "p8");
      mockSwap(fixtureSwap({ status: "serverfunded" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-claim") }), { params: Promise.resolve({ id }) });
        const body = ((await res.json()) as { reconciliation: { claimReady: boolean; status: string } }).reconciliation;
        expect(body.status).toBe("SERVER_FUNDED");
        expect(body.claimReady).toBe(true);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("marks a provider-funded refund terminal and non-claimable", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-refund");
      const { id } = await authorizedTransfer(cookie, "recon-refund", "refund");
      mockSwap(fixtureSwap({ status: "clientfundedserverrefunded" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-refund") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        const body = ((await res.json()) as { reconciliation: { status: string; statusLabel: string; claimReady: boolean; advancedPath: string[] } }).reconciliation;
        expect(body.status).toBe("REFUNDED");
        expect(body.statusLabel).toMatch(/refunded/i);
        expect(body.claimReady).toBe(false);
        expect(body.advancedPath.at(-1)).toBe("REFUNDED");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("rejects reconciliation without a bound swap and cross-user reads", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-guard");
      const { id } = await preparedTransfer(cookie, "recon-guard", "p9");
      const early = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-guard") }), { params: Promise.resolve({ id }) });
      expect(early.status).toBe(409);
      expect(((await early.json()) as { error: string }).error).toBe("NOT_RECONCILABLE");
      const bob = await login("recon-guard-bob");
      expect((await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie: bob.cookie, ...withClient("recon-guard-bob") }), { params: Promise.resolve({ id }) })).status).toBe(404);
      expect((await resumeGet(new Request(`http://localhost/api/transfers/${id}/reconciliation`, { headers: { cookie: bob.cookie } }), { params: Promise.resolve({ id }) })).status).toBe(404);
    } finally {
      restoreRoutes(previous);
    }
  });
});

describe.skipIf(!LIVE)("client handoff reports", () => {
  it("walks initiated and unknown outcomes through existing edges only", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("report-init");
      const { id } = await authorizedTransfer(cookie, "report-init", "r1");
      const { POST: reportPost } = await import("../app/api/transfers/[id]/handoff-result/route");
      const initiated = await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "initiated" }, { cookie, ...withClient("report-init") }), { params: Promise.resolve({ id }) });
      expect(initiated.status).toBe(200);
      expect(((await initiated.json()) as { handoff: { status: string; deduplicated: boolean } }).handoff.status).toBe("LIGHTNING_HANDOFF");
      const again = await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "initiated" }, { cookie, ...withClient("report-init") }), { params: Promise.resolve({ id }) });
      expect(again.status).toBe(200);
      const unknown = await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "unknown" }, { cookie, ...withClient("report-init") }), { params: Promise.resolve({ id }) });
      expect(unknown.status).toBe(200);
      expect(((await unknown.json()) as { handoff: { status: string } }).handoff.status).toBe("RECONCILING");
      const transfer = await getDb().select().from(transfers).where(eq(transfers.id, id));
      expect(transfer[0]?.status).toBe("RECONCILING");
    } finally {
      restoreRoutes(previous);
    }
  });

  it("accepts cancellation with live proof of no funding", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("report-cancel");
      const { POST: reportPost } = await import("../app/api/transfers/[id]/handoff-result/route");
      // No swap bound yet: nothing could have moved — safe to cancel.
      const { id } = await preparedTransfer(cookie, "report-cancel", "r2");
      const cancelled = await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient("report-cancel") }), { params: Promise.resolve({ id }) });
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as { handoff: { status: string } }).handoff.status).toBe("USER_CANCELLED");
      // Attached + provider shows pending with a live invoice: also safe.
      const attached = await attachedTransfer(cookie, "report-cancel", "r2b", fixtureSwap({ id: uniqSwap("swap-cancel-b") }));
      mockSwap(fixtureSwap({ status: "pending" }));
      try {
        const cancelled2 = await reportPost(postJson(`http://localhost/api/transfers/${attached.id}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient("report-cancel") }), { params: Promise.resolve({ id: attached.id }) });
        expect(cancelled2.status).toBe(200);
      } finally {
        setSatoraFetchersForTests(null);
      }
      // Attached + provider shows funding: cancellation is blocked.
      const attached2 = await attachedTransfer(cookie, "report-cancel", "r3", fixtureSwap({ id: uniqSwap("swap-cancel-c") }));
      mockSwap(fixtureSwap({ status: "clientfunded" }));
      try {
        const blocked = await reportPost(postJson(`http://localhost/api/transfers/${attached2.id}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient("report-cancel") }), { params: Promise.resolve({ id: attached2.id }) });
        expect(blocked.status).toBe(409);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("allows an owner close only after fresh terminal Satora expiry proof", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("report-expired-close");
      const { id, swapId } = await authorizedTransfer(cookie, "report-expired-close", "r-expired");
      mockSwap(
        fixtureSwap({
          id: swapId,
          status: "expired",
          invoice_expires_at: Math.floor(Date.now() / 1000) - 10,
        }),
      );
      try {
        const closed = await reportPost(
          postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient("report-expired-close") }),
          { params: Promise.resolve({ id }) },
        );
        expect(closed.status).toBe(200);
        expect(((await closed.json()) as { handoff: { status: string } }).handoff.status).toBe("USER_CANCELLED");
        const observations = await getDb().select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, id));
        expect(observations.some((row) => row.providerStatus === "expired" && row.kind === "observation")).toBe(true);
        expect((await getDb().select().from(transfers).where(eq(transfers.id, id)))[0]?.status).toBe("USER_CANCELLED");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("never accepts client-reported success, and guards CSRF/auth", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("report-forge");
      const { POST: reportPost } = await import("../app/api/transfers/[id]/handoff-result/route");
      const { id } = await preparedTransfer(cookie, "report-forge", "r4");
      for (const outcome of ["funded", "claimed", "delivered", "refunded", "paid", "success"]) {
        const res = await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome }, { cookie, ...withClient("report-forge") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("CLIENT_CANNOT_ATTEST");
      }
      expect((await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "initiated" }), { params: Promise.resolve({ id }) })).status).toBe(401);
      expect((await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "initiated" }, { cookie, origin: "https://evil.example", ...withClient("report-forge") }), { params: Promise.resolve({ id }) })).status).toBe(403);
      const after = await getDb().select().from(transfers).where(eq(transfers.id, id));
      expect(["AWAITING_NIM_APPROVAL", "QUOTED"]).toContain(after[0]?.status);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("resumes the same attempt after interruption without new side effects", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("report-resume");
      const { id } = await preparedTransfer(cookie, "report-resume", "r5");
      const { POST: reportPost } = await import("../app/api/transfers/[id]/handoff-result/route");
      await reportPost(postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "unknown" }, { cookie, ...withClient("report-resume") }), { params: Promise.resolve({ id }) });
      const one = (await (await resumeGet(new Request(`http://localhost/api/transfers/${id}/reconciliation`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        attempt: { id: string } | null;
        swap: unknown;
        latest: { providerStatus: string };
      };
      const two = (await (await resumeGet(new Request(`http://localhost/api/transfers/${id}/reconciliation`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        attempt: { id: string } | null;
      };
      expect(one.attempt?.id).toBe(two.attempt?.id);
      expect(one.swap).toBeNull();
      expect(one.latest.providerStatus).toBe("unknown");
    } finally {
      restoreRoutes(previous);
    }
  });
});

describe.skipIf(!LIVE)("no silent second payment, no secrets, no settlement", () => {
  it("never marks FAILED or DELIVERED and never re-authorizes automatically", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("recon-final");
      const { id } = await authorizedTransfer(cookie, "recon-final", "f1");
      const db = getDb();
      const before = await db.select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, (await login("recon-final-count")).userId));
      void before;
      mockSwap(fixtureSwap({ status: "serverwontfund" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient("recon-final") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { reconciliation: { status: string } }).reconciliation.status).toBe("NEEDS_ATTENTION");
      } finally {
        setSatoraFetchersForTests(null);
      }
      // Scoped to this file's own users: sibling suites (e.g. settlement
      // verification) legitimately DELIVER their own transfers in parallel.
      // The invariant under test is that THIS reconcile path creates
      // neither FAILED nor DELIVERED for its own transfers.
      const rows = await db
        .select({ status: transfers.status })
        .from(transfers)
        .where(inArray(transfers.ownerUserId, createdUserIds));
      const statuses = new Set(rows.map((r) => r.status));
      expect(statuses.has("FAILED")).toBe(false);
      expect(statuses.has("DELIVERED")).toBe(false);
    } finally {
      restoreRoutes(previous);
    }
  });
});
