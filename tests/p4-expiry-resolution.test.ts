/**
 * P4 — evidence-gated terminal resolution, end to end against the ISOLATED
 * test database (anchor-proven; never production).
 *
 * Each scenario builds an authorized payment through the real routes
 * (create → prepare → attach → authorize, live read-only quotes, mocked
 * provider), reports an unknown outcome so it sits in RECONCILING exactly
 * like eddaa6de, then ages the bound swap's timestamps in the TEST database
 * and calls the real POST /api/transfers/:id/close-expired route.
 *
 * Provider reads come from the Satora test seam; chain reads from a
 * synthetic Polygon (2 s blocks, head = now) whose HTLC logs each scenario
 * controls. No payment, swap, invoice, claim or refund is created anywhere.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  handoffAttempts,
  reconciliationObservations,
  swapAttachments,
  transferProofs,
  transferTransitions,
  transfers,
  users,
} from "@/db/schema";
import { assertFundingExposure, getPilotConfig } from "@/lib/pilot";
import { resetSatoraCachesForTests, setSatoraFetchersForTests } from "@/lib/satora";
import { computeHtlcSwapKey, SWAP_REFUNDED_EVENT_TOPIC, setSettlementChainForTests, type ChainLog, type ChainReads } from "@/lib/settlement";
import { TRUSTED_HTLC_CONTRACTS } from "@/lib/expiry-resolution";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as closePost } from "../app/api/transfers/[id]/close-expired/route";

const HTLC = TRUSTED_HTLC_CONTRACTS[137]![0]!;
const ARBITRUM_HTLC = TRUSTED_HTLC_CONTRACTS[42161]![0]!;
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const EVM_A = "0x0000000000000000000000000000000000000001";
const FUND_TOPIC = "0x127ba86dffa89675eb78a2ca7203c29f865789ebec607b9424ed9f8d3d533e9f";
const ROUTES = "usdc-polygon";
const polygonToken = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const word = (value: bigint | number | string) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value: string) => value.slice(2).toLowerCase().padStart(64, "0");
const createdUserIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `p4-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

/* ---------------- synthetic, controllable Polygon ---------------- */
const HEAD = 100_000_000n;
const nowSec = () => Math.floor(Date.now() / 1000);
let chainLogs: (lock: string) => ChainLog[] = () => [];
let chainDown = false;
function syntheticChain(): ChainReads {
  return {
    async getTransaction() { return null; },
    async getReceipt() { return null; },
    async getLatestBlockNumber() { if (chainDown) throw new Error("down"); return HEAD; },
    async getFinalizedBlockNumber() { return HEAD - 300n; },
    async getBlockHash(_c, n) { if (chainDown) throw new Error("down"); return `0x${n.toString(16).padStart(64, "0")}`; },
    async getBlockTimestamp(_c, n) { if (chainDown) throw new Error("down"); return nowSec() - Number(HEAD - n) * 2; },
    async getLogsByTopic1(_c, address, topic1) {
      if (chainDown) throw new Error("down");
      return chainLogs(topic1).map((l) => ({ ...l, address }));
    },
  };
}

/* ---------------- provider fixture (mirrors eddaa6de's shape) ---------------- */
let swapOverrides: Record<string, unknown> = {};
function swapFor(
  id: string,
  hashLock: string,
  sourceSats: string,
  options: { chainId?: number; htlcAddress?: string; tokenAddress?: string } = {},
): Record<string, unknown> {
  const chainId = options.chainId ?? 137;
  const tokenAddress = options.tokenAddress ?? "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
  return {
    id,
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc-test-redacted",
    hash_lock: hashLock,
    source_amount: sourceSats,
    target_amount: "300000",
    evm_chain_id: chainId,
    evm_htlc_address: options.htlcAddress ?? HTLC,
    target_evm_address: EVM_A,
    target_token: { chain: String(chainId), decimals: 6, name: "USD Coin", symbol: "USDC", token_id: tokenAddress },
    status: "pending",
    invoice_expires_at: Math.floor(Date.now() / 1000) + 3600,
    evm_fund_txid: null,
    evm_claim_txid: null,
    fee_sats: 6,
    created_at: new Date().toISOString(),
  };
}
const swaps = new Map<string, Record<string, unknown>>();
function installProvider(): void {
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      const s = swaps.get(id);
      if (!s) throw Object.assign(new Error("not found"), { code: 404 });
      return { ...s, ...swapOverrides, id };
    },
  });
}

/**
 * Build an eddaa6de-like payment: authorized, unknown outcome → RECONCILING,
 * bound swap aged so its invoice expired 2 h ago (test DB only).
 */
async function stuckReconciling(
  tag: string,
  options: { routeId?: string; network?: string; chainId?: number; htlcAddress?: string; tokenAddress?: string } = {},
): Promise<{ id: string; userId: string; cookie: string; hashLock: string }> {
  const routeId = options.routeId ?? "usdc-polygon";
  const network = options.network ?? "Polygon";
  const { userId, cookie } = await loginAs(client(`login-${tag}`), (id) => createdUserIds.push(id));
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId, targetAmountAtomic: "300000", idempotencyKey: `p4-${RUN}-${tag}`, direct: { asset: "USDC", network, address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  const swapId = `p4-swap-${RUN}-${tag}`;
  const hashLock = `0x${Buffer.from(`${RUN}-${tag}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  swaps.set(swapId, swapFor(swapId, hashLock, transfer.quote.sourceSats, options));
  swapOverrides = {};
  installProvider();
  const attached = await attachPost(
    postJson(`http://localhost/api/transfers/${transfer.id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...client(tag) }),
    params(transfer.id),
  );
  if (attached.status !== 201) throw new Error(`setup attach failed: ${attached.status} ${JSON.stringify(await attached.json())}`);
  const authed = await authorizePost(postJson(`http://localhost/api/transfers/${transfer.id}/authorize-handoff`, { attemptToken: token }, { cookie, ...client(tag) }), params(transfer.id));
  if (authed.status !== 200) throw new Error(`setup authorize failed: ${authed.status}`);
  const unknown = await reportPost(postJson(`http://localhost/api/transfers/${transfer.id}/handoff-result`, { outcome: "unknown" }, { cookie, ...client(tag) }), params(transfer.id));
  if (unknown.status !== 200) throw new Error(`setup unknown failed: ${unknown.status}`);
  // Age the bound swap in the TEST database: bound 3 h ago, invoice expired 2 h ago.
  const boundAt = new Date(Date.now() - 3 * 3600_000);
  const expiredAt = new Date(Date.now() - 2 * 3600_000);
  await getDb().update(swapAttachments).set({ createdAt: boundAt, invoiceExpiresAt: expiredAt }).where(eq(swapAttachments.transferId, transfer.id));
  // The provider now reports Satora's terminal "expired" with no EVM txs.
  swaps.set(swapId, { ...swaps.get(swapId)!, status: "expired", invoice_expires_at: Math.floor(expiredAt.getTime() / 1000) });
  return { id: transfer.id, userId, cookie, hashLock };
}

async function close(id: string, cookie: string, tag: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await closePost(postJson(`http://localhost/api/transfers/${id}/close-expired`, {}, { cookie, ...client(tag) }), params(id));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const statusOf = async (id: string) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.s;
const terminalRows = async (id: string) =>
  getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, id), eq(transferTransitions.terminal, true)));
const unarmed = getPilotConfig({ NODE_ENV: "test" });

let previousRoutes: string | undefined;
let previousRpcs: string | undefined;
beforeEach(() => {
  previousRoutes = process.env["THENCE_ENABLED_ROUTES"];
  previousRpcs = process.env["THENCE_EVM_RPCS_JSON"];
  process.env["THENCE_ENABLED_ROUTES"] = ROUTES;
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://example.invalid" });
  chainLogs = () => [];
  chainDown = false;
  swapOverrides = {};
  setSettlementChainForTests(syntheticChain());
  installProvider();
  return () => {
    if (previousRoutes === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
    else process.env["THENCE_ENABLED_ROUTES"] = previousRoutes;
    if (previousRpcs === undefined) delete process.env["THENCE_EVM_RPCS_JSON"];
    else process.env["THENCE_EVM_RPCS_JSON"] = previousRpcs;
  };
});

describe.skipIf(!LIVE)("P4 close-expired (isolated test database)", () => {
  it("closes a proven expired-unfunded RECONCILING payment, audits it, and releases exposure only after commit", async () => {
    const { id, userId, cookie, hashLock } = await stuckReconciling("happy");
    expect(await statusOf(id)).toBe("RECONCILING");
    // Before: the stuck payment occupies the owner's single exposure slot.
    await expect(assertFundingExposure(userId, "300000", unarmed)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });
    const attemptsBefore = await getDb().select().from(handoffAttempts).where(eq(handoffAttempts.transferId, id));
    const attachBefore = await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, id));
    const proofsBefore = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id));
    const obsBefore = await getDb().select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, id));

    const res = await close(id, cookie, "happy");
    expect(res.status).toBe(200);
    expect(res.body["resolution"]).toMatchObject({ transferId: id, status: "EXPIRED_UNFUNDED", deduplicated: false });
    expect(await statusOf(id)).toBe("EXPIRED_UNFUNDED");

    const audit = await terminalRows(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ fromStatus: "RECONCILING", toStatus: "EXPIRED_UNFUNDED", actor: "owner", actorUserId: userId, reasonCode: "EXPIRED_UNFUNDED_VERIFIED" });
    const ev = audit[0]!.evidence as Record<string, Record<string, unknown>>;
    expect(ev["provider"]).toMatchObject({ status: "expired", evmFundTxid: null, evmClaimTxid: null, identityMatch: true });
    expect(ev["chain"]).toMatchObject({ chainId: 137, htlcAddress: HTLC, hashLock: hashLock.toLowerCase(), verdict: "NO_ACTIVITY" });
    expect(ev["nimiq"]).toEqual({ nimiqFundingRecorded: false, refundProof: "NOT_OBSERVABLE_BY_THENCE" });
    expect(JSON.stringify(ev)).not.toMatch(/lnbc|preimage|secret|mnemonic/i);

    // Other financial records are preserved untouched; one observation appended.
    expect(await getDb().select().from(handoffAttempts).where(eq(handoffAttempts.transferId, id))).toEqual(attemptsBefore);
    expect(await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, id))).toEqual(attachBefore);
    expect(await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id))).toEqual(proofsBefore);
    expect((await getDb().select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, id))).length).toBe(obsBefore.length + 1);

    // After commit: capacity released.
    await expect(assertFundingExposure(userId, "300000", unarmed)).resolves.toBeUndefined();

    // Idempotent repeat: deduplicated, still exactly one terminal audit row.
    const again = await close(id, cookie, "happy");
    expect(again.status).toBe(200);
    expect(again.body["resolution"]).toMatchObject({ status: "EXPIRED_UNFUNDED", deduplicated: true });
    expect(await terminalRows(id)).toHaveLength(1);
    // Reconciliation afterwards cannot move a terminal transfer.
    const rec = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...client("happy") }), params(id));
    expect(rec.status).toBe(200);
    expect(await statusOf(id)).toBe("EXPIRED_UNFUNDED");
  });

  it("is safe under concurrent requests: exactly one transition and one terminal audit row", async () => {
    const { id, cookie } = await stuckReconciling("race");
    const results = await Promise.all([close(id, cookie, "race"), close(id, cookie, "race"), close(id, cookie, "race")]);
    for (const r of results) expect(r.status).toBe(200);
    const dedup = results.map((r) => (r.body["resolution"] as { deduplicated: boolean }).deduplicated);
    expect(dedup.filter((d) => d === false)).toHaveLength(1);
    expect(await statusOf(id)).toBe("EXPIRED_UNFUNDED");
    expect(await terminalRows(id)).toHaveLength(1);
  });

  it("refuses when the chain shows HTLC activity for the hash lock (provider said expired)", async () => {
    const { id, userId, cookie } = await stuckReconciling("chainfund");
    chainLogs = (lock) => [{ address: HTLC, topics: [FUND_TOPIC, lock], data: "0x", logIndex: 7 }];
    const res = await close(id, cookie, "chainfund");
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("CHAIN_ACTIVITY_FOUND");
    expect(String(res.body["message"])).not.toMatch(/HTLC|hash|RPC/);
    expect(await statusOf(id)).toBe("RECONCILING");
    expect(await terminalRows(id)).toHaveLength(0);
    await expect(assertFundingExposure(userId, "300000", unarmed)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });
  });

  it("refuses an Arbitrum same-hash SwapCreated event with different terms at the expiry decision boundary", async () => {
    const priorRoutes = process.env["THENCE_ENABLED_ROUTES"];
    const priorTokens = process.env["THENCE_ROUTE_TOKENS_JSON"];
    const priorRpcs = process.env["THENCE_EVM_RPCS_JSON"];
    const { id, userId, cookie, hashLock } = await stuckReconciling("arb-same-hash");
    try {
      process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon,usdc-arbitrum";
      process.env["THENCE_ROUTE_TOKENS_JSON"] = JSON.stringify({ "usdc-polygon": polygonToken, "usdc-arbitrum": ARBITRUM_USDC });
      process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://example.invalid", "42161": "https://example.invalid" });
      await getDb().update(transfers).set({ routeId: "usdc-arbitrum", targetNetwork: "Arbitrum" }).where(eq(transfers.id, id));
      swapOverrides = {
        status: "expired",
        evm_chain_id: 42161,
        evm_htlc_address: ARBITRUM_HTLC,
        target_token: { chain: "42161", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: ARBITRUM_USDC },
      };
      resetSatoraCachesForTests();
      setSatoraFetchersForTests({
        getTokens: async () => ({ evm_tokens: [
          { token_id: polygonToken, symbol: "USDC", chain: "137", decimals: 6 },
          { token_id: ARBITRUM_USDC, symbol: "USDC", chain: "42161", decimals: 6 },
        ] }),
        getSwapPairs: async () => ({ pairs: [
          { source: "Lightning", target: "137", min_sats: 1, max_sats: 20_000_000 },
          { source: "Lightning", target: "42161", min_sats: 1, max_sats: 20_000_000 },
        ] }),
        getSwap: async (swapId: string) => ({ ...swaps.get(swapId), ...swapOverrides, id: swapId }),
      });
      const differentKey = computeHtlcSwapKey({
        hashLock,
        amount: 300001n,
        token: "0x4200000000000000000000000000000000000023",
        refundAddress: "0x00000000000000000000000000000000000000a1",
        claimAddress: EVM_A,
        timelock: 1_900_000_000n,
      });
      chainLogs = (lock) => [{
        address: ARBITRUM_HTLC,
        topics: [
          FUND_TOPIC,
          lock,
          `0x${addressWord("0x00000000000000000000000000000000000000a1")}`,
          `0x${addressWord(EVM_A)}`,
        ],
        data: `0x${addressWord("0x4200000000000000000000000000000000000023")}${word(300001n)}${word(1_900_000_000n)}${differentKey.slice(2)}`,
        logIndex: 7,
      }];

      const res = await close(id, cookie, "arb-same-hash");
      expect(res.status).toBe(409);
      expect(res.body["error"]).toBe("CHAIN_ACTIVITY_FOUND");
      expect(await statusOf(id)).toBe("RECONCILING");
      expect(await terminalRows(id)).toHaveLength(0);
      await expect(assertFundingExposure(userId, "300000", unarmed)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });
    } finally {
      setSatoraFetchersForTests(null);
      resetSatoraCachesForTests();
      if (priorRoutes === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
      else process.env["THENCE_ENABLED_ROUTES"] = priorRoutes;
      if (priorTokens === undefined) delete process.env["THENCE_ROUTE_TOKENS_JSON"];
      else process.env["THENCE_ROUTE_TOKENS_JSON"] = priorTokens;
      if (priorRpcs === undefined) delete process.env["THENCE_EVM_RPCS_JSON"];
      else process.env["THENCE_EVM_RPCS_JSON"] = priorRpcs;
    }
  });

  it("refuses on recorded Nimiq-side funding (cannot prove the NIM came back)", async () => {
    const { id, cookie } = await stuckReconciling("nim");
    await getDb().update(transferProofs).set({ nimiqTxHash: "nim-test-hash" }).where(eq(transferProofs.transferId, id));
    const res = await close(id, cookie, "nim");
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("NIM_FUNDING_RECORDED");
    expect(await statusOf(id)).toBe("RECONCILING");
  });

  it("refuses on provider funding evidence, earlier movement, recent expiry, or an unreadable chain", async () => {
    const { id, cookie } = await stuckReconciling("provider");
    swapOverrides = { status: "expired", evm_fund_txid: `0x${"12".repeat(32)}` };
    expect((await close(id, cookie, "provider")).body["error"]).toBe("PROVIDER_REPORTS_EVM_TX");
    swapOverrides = { status: "clientfunded" };
    expect((await close(id, cookie, "provider")).body["error"]).toBe("PROVIDER_NOT_EXPIRED");
    swapOverrides = { status: "expired", evm_htlc_address: "0x" + "11".repeat(20) };
    expect((await close(id, cookie, "provider")).body["error"]).toBe("HTLC_UNTRUSTED");
    swapOverrides = {};
    chainDown = true;
    const down = await close(id, cookie, "provider");
    expect(down.status).toBe(503);
    expect(down.body["error"]).toBe("CHAIN_UNAVAILABLE");
    chainDown = false;
    await getDb().update(swapAttachments).set({ invoiceExpiresAt: new Date(Date.now() - 2 * 60_000) }).where(eq(swapAttachments.transferId, id));
    expect((await close(id, cookie, "provider")).body["error"]).toBe("INVOICE_NOT_SETTLED");
    await getDb().update(swapAttachments).set({ invoiceExpiresAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(swapAttachments.transferId, id));
    const swapId = (await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, id)))[0]!.satoraSwapId;
    await getDb().insert(reconciliationObservations).values({ transferId: id, satoraSwapId: swapId, providerStatus: "clientfundingseen", kind: "observation" });
    expect((await close(id, cookie, "provider")).body["error"]).toBe("LOCAL_MOVEMENT_RECORDED");
    expect(await statusOf(id)).toBe("RECONCILING");
    expect(await terminalRows(id)).toHaveLength(0);
  });

  it("refuses when provider verification fails: provider down, swap unknown, or a drifted swap identity", async () => {
    const { id, userId, cookie } = await stuckReconciling("provider-verify");
    setSatoraFetchersForTests({ getSwap: async () => { throw new Error("provider down"); } });
    const down = await close(id, cookie, "provider-verify");
    expect(down.status).toBe(503);
    expect(down.body["error"]).toBe("PROVIDER_UNAVAILABLE");
    setSatoraFetchersForTests({ getSwap: async () => { throw Object.assign(new Error("not found"), { code: 404 }); } });
    expect((await close(id, cookie, "provider-verify")).body["error"]).toBe("PROVIDER_IDENTITY_MISMATCH");
    installProvider();
    for (const drift of [
      { target_amount: "300001" },
      { target_evm_address: "0x0000000000000000000000000000000000000002" },
      { hash_lock: `0x${"ee".repeat(32)}` },
      { direction: "evm_to_lightning" },
    ]) {
      swapOverrides = { status: "expired", ...drift };
      const res = await close(id, cookie, "provider-verify");
      expect(res.status).toBe(409);
      expect(res.body["error"]).toBe("PROVIDER_IDENTITY_MISMATCH");
    }
    expect(await statusOf(id)).toBe("RECONCILING");
    expect(await terminalRows(id)).toHaveLength(0);
    await expect(assertFundingExposure(userId, "300000", unarmed)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });
  });

  it("status change and audit row are atomic: a failed audit write keeps the payment open and exposed", async () => {
    const { id, userId, cookie } = await stuckReconciling("atomic");
    // Occupy the terminal-once slot so the resolver's audit insert must fail.
    await getDb().insert(transferTransitions).values({
      transferId: id, fromStatus: "RECONCILING", toStatus: "REFUNDED", actor: "operator", actorUserId: null,
      reasonCode: "TEST_BLOCKER", evidence: {}, terminal: true,
    });
    const res = await close(id, cookie, "atomic");
    expect(res.status).toBe(500);
    expect(await statusOf(id)).toBe("RECONCILING");
    await expect(assertFundingExposure(userId, "300000", unarmed)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });
  });

  it("is owner-scoped: another user cannot close or even see the payment", async () => {
    const { id } = await stuckReconciling("scope");
    const other = await loginAs(client("scope-other"), (uid) => createdUserIds.push(uid));
    expect((await close(id, other.cookie, "scope-other")).status).toBe(404);
    expect(await statusOf(id)).toBe("RECONCILING");
  });

  it("the reconciler's own provider-evidence advances are audited in the same transaction", async () => {
    const { id, cookie } = await stuckReconciling("audit-recon");
    process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://example.invalid" });
    swapOverrides = { status: "serverfunded", evm_fund_txid: `0x${"34".repeat(32)}` };
    const rec = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...client("audit-recon") }), params(id));
    expect(rec.status).toBe(200);
    expect(await statusOf(id)).toBe("SERVER_FUNDED");
    // P5: setup steps (attach, authorize, unknown report) are owner-audited; this asserts the reconciler's hop.
    const rows = (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, id))).filter((r) => r.actor === "reconciler");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStatus: "RECONCILING", toStatus: "SERVER_FUNDED", actor: "reconciler", reasonCode: "PROVIDER_SERVERFUNDED", terminal: false });
    void SWAP_REFUNDED_EVENT_TOPIC;
  });
});
