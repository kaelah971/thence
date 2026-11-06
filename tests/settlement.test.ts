/**
 * B4.4 — read-only EVM settlement verification, receipts, cancellation safety.
 *
 * No swap creation, no funding, no claims, no broadcasts anywhere in this
 * slice. Provider reads and chain reads are faked through seams (fixtures);
 * only transfer setup uses live read-only quotes. Neon-backed integration.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { transferProofs, transfers, users } from "@/db/schema";
import { matchRefundEvent, matchSettlementTransfers, setSettlementChainForTests, SWAP_REFUNDED_EVENT_TOPIC, TRANSFER_EVENT_TOPIC } from "@/lib/settlement";
import { planReconciliation } from "@/lib/reconcile";
import type { ChainReads } from "@/lib/settlement";
import { transition } from "@/domain/transfers";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as verifyPost } from "../app/api/transfers/[id]/verify-settlement/route";
import { GET as receiptGet } from "../app/api/transfers/[id]/receipt/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b44-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const EVM_A = "0x0000000000000000000000000000000000000001";
const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const CLAIM_TX = `0x${"cc".repeat(32)}`;
/** Fixed-tx legacy: only used as a never-attributed placeholder. Real cases use claimTxFor (per-run unique). */
/** Deterministic unique claim tx per test (exercises the double-attribution guard honestly). */
function claimTxFor(tag: string): string {
  return `0x${Buffer.from(`b44-${tag}-${RUN}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}
const BLOCK_NUM = 70_000_000n;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
const ROUTES = "usdc-polygon";
const RPCS = JSON.stringify({ "137": "https://example.invalid" });

const setEnv = (key: string, value: string): string | undefined => {
  const previous = process.env[key];
  process.env[key] = value;
  return previous;
};
const restoreEnv = (key: string, previous: string | undefined): void => {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
};

function topicAddr(addr: string): string {
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
}
function transferLog(token: string, to: string, value: bigint, logIndex: number): { address: string; topics: string[]; data: string; logIndex: number } {
  return {
    address: token,
    topics: [TRANSFER_EVENT_TOPIC, topicAddr("0x00000000000000000000000000000000000000ff"), topicAddr(to)],
    data: `0x${value.toString(16).padStart(64, "0")}`,
    logIndex,
  };
}

interface ChainScript {
  receipt?: { status: "success" | "reverted"; blockNumber: bigint; blockHash: string; logs: { address: string; topics: string[]; data: string; logIndex: number }[] } | null;
  txBlock?: bigint | null;
  latest?: bigint;
  finalized?: bigint | null;
  headerHash?: string | null;
  fail?: "receipt" | "all";
  calls?: { reads: number };
}
function mockChain(script: ChainScript): ChainReads {
  const calls = (script.calls ??= { reads: 0 });
  const fail = (label: string): never => {
    throw Object.assign(new Error(`${label} outage`), { code: "CHAIN_UNAVAILABLE" });
  };
  return {
    async getTransaction() {
      calls.reads += 1;
      if (script.fail === "all") fail("tx");
      if (script.receipt) return { hash: CLAIM_TX, blockNumber: script.receipt.blockNumber };
      if (script.txBlock !== undefined) return script.txBlock === null ? { hash: CLAIM_TX, blockNumber: null } : { hash: CLAIM_TX, blockNumber: script.txBlock };
      return null;
    },
    async getReceipt() {
      calls.reads += 1;
      if (script.fail === "all" || script.fail === "receipt") fail("receipt");
      if (!script.receipt) return null;
      return { ...script.receipt, logs: script.receipt.logs.map((l) => ({ ...l })) };
    },
    async getLatestBlockNumber() {
      calls.reads += 1;
      if (script.fail === "all") fail("latest");
      return script.latest ?? BLOCK_NUM + 300n;
    },
    async getFinalizedBlockNumber() {
      calls.reads += 1;
      if (script.fail === "all") fail("finalized");
      return script.finalized === undefined ? BLOCK_NUM + 300n : script.finalized;
    },
    async getBlockHash() {
      calls.reads += 1;
      if (script.fail === "all") fail("header");
      return script.headerHash === undefined ? BLOCK_HASH : script.headerHash;
    },
  };
}

function goodReceipt(amount = 5000000n, dest = EVM_A): NonNullable<ChainScript["receipt"]> {
  return { status: "success", blockNumber: BLOCK_NUM, blockHash: BLOCK_HASH, logs: [transferLog(USDC_POLYGON, dest, amount, 3)] };
}

function fixtureSwap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `swap-55555555-5555-5555-5555-555555555555-${RUN}`,
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc100u1p0fakeinvoicepp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fake",
    hash_lock: `0x${"cd".repeat(32)}`,
    source_amount: "6327",
    target_amount: "5000000",
    evm_chain_id: 137,
    target_evm_address: EVM_A,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC_POLYGON },
    status: "pending",
    invoice_expires_at: Math.floor(Date.now() / 1000) + 3600,
    fee_sats: 35,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
// Reference data is stubbed (canonical USDC/Polygon) so setup reconciles
// and route resolution never flake on live reference-data fetches; swap
// facts stay per-case. Live quotes are still genuinely live (B4.1).
const mockSwap = (swap: Record<string, unknown>): void =>
  setSatoraFetchersForTests({
    getTokens: async () => ({ evm_tokens: [{ token_id: USDC_POLYGON, symbol: "USDC", chain: "137", decimals: 6 }] }),
    getSwapPairs: async () => ({ pairs: [{ source: "Lightning", target: "137", min_sats: 1000, max_sats: 100_000_000 }] }),
    getSwap: async (id: string) => ({ ...swap, id }),
  });

async function claimingTransfer(
  cookie: string,
  tag: string,
  keySuffix: string,
  swapId: string,
  amount = "5000000",
  claimTx = claimTxFor("default"),
): Promise<string> {
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: amount, idempotencyKey: `k-${RUN}-${keySuffix}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...withClient(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup transfer failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const id = transfer.id;
  const quotedSourceSats = transfer.quote.sourceSats;
  const prep = await preparePost(
    postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...withClient(tag) }),
    { params: Promise.resolve({ id }) },
  );
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken?: string }).attemptToken as string;
  // Fixture mirrors the live quote so the repricing guard passes setup.
  mockSwap(fixtureSwap({ id: swapId, source_amount: quotedSourceSats }));
  try {
    const { POST: attachPost } = await import("../app/api/transfers/[id]/attach/route");
    const { POST: authorizePost } = await import("../app/api/transfers/[id]/authorize-handoff/route");
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
  mockSwap(fixtureSwap({ id: swapId, source_amount: "6327", status: "serverfunded" }));
  try {
    const r1 = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });
    if (r1.status !== 200) throw new Error(`setup reconcile#1 failed: ${r1.status}`);
  } finally {
    setSatoraFetchersForTests(null);
  }
  mockSwap(fixtureSwap({ id: swapId, source_amount: "6327", status: "clientredeemed", evm_claim_txid: claimTx }));
  try {
    const r2 = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });
    if (r2.status !== 200) throw new Error(`setup reconcile#2 failed: ${r2.status}`);
    const state = ((await r2.json()) as { reconciliation: { status: string } }).reconciliation.status;
    if (state !== "CLAIMING") throw new Error(`setup did not reach CLAIMING: ${state}`);
  } finally {
    setSatoraFetchersForTests(null);
  }
  return id;
}

const verify = (cookie: string, tag: string, id: string, body: unknown = {}) =>
  verifyPost(postJson(`http://localhost/api/transfers/${id}/verify-settlement`, body, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });

describe("reconciliation recoverability from unknown-outcome states (pure, B4.4 §9)", () => {
  it("advances delayed funding observed while reconcilable", () => {
    expect(planReconciliation("RECONCILING", "clientfunded")).toMatchObject({ action: "advance", path: ["CLIENT_FUNDED"] });
    expect(planReconciliation("RECONCILING", "serverfunded")).toMatchObject({ action: "advance", path: ["SERVER_FUNDED"] });
    expect(planReconciliation("RECONCILING", "clientredeemed")).toMatchObject({ action: "advance", path: ["CLAIMING"] });
    expect(planReconciliation("OUTCOME_UNKNOWN", "clientfunded")).toMatchObject({ action: "advance", path: ["RECONCILING", "CLIENT_FUNDED"] });
    // No regression: main-line and attention behavior unchanged.
    expect(planReconciliation("AWAITING_NIM_APPROVAL", "clientfunded")).toMatchObject({ action: "advance", path: ["LIGHTNING_HANDOFF", "CLIENT_FUNDED"] });
    expect(planReconciliation("RECONCILING", "pending")).toMatchObject({ action: "none" });
  });
});

describe("settlement log matcher (pure, no I/O)", () => {
  it("sums matching legs and ignores unrelated movements", () => {
    const logs = [
      transferLog(USDC_POLYGON, EVM_A, 3_000_000n, 3),
      transferLog(USDC_POLYGON, EVM_A, 2_000_000n, 5),
      transferLog(USDC_POLYGON, "0x0000000000000000000000000000000000000002", 9_000_000n, 6),
      transferLog("0x0000000000000000000000000000000000000009", EVM_A, 5_000_000n, 7),
    ];
    const m = matchSettlementTransfers(logs, USDC_POLYGON, EVM_A, 5_000_000n);
    expect(m.matched).toBe(true);
    expect(m.totalAtomic).toBe(5_000_000n);
    expect(m.logIndexes).toEqual([3, 5]);
  });
  it("is case-insensitive and rejects shortfalls, ghosts and malformed logs", () => {
    const logs = [transferLog(USDC_POLYGON.toUpperCase(), EVM_A.toUpperCase(), 4_999_999n, 1)];
    const short = matchSettlementTransfers(logs, USDC_POLYGON, EVM_A, 5_000_000n);
    expect(short.matched).toBe(false);
    expect(short.totalAtomic).toBe(4_999_999n);
    expect(matchSettlementTransfers([], USDC_POLYGON, EVM_A, 5_000_000n)).toMatchObject({ matched: false, totalAtomic: 0n });
    expect(
      matchSettlementTransfers(
        [{ address: USDC_POLYGON, topics: [TRANSFER_EVENT_TOPIC, topicAddr(EVM_A), topicAddr(EVM_A)], data: "not-hex", logIndex: 0 }],
        USDC_POLYGON,
        EVM_A,
        1n,
      ).matched,
    ).toBe(false);
    expect(
      matchSettlementTransfers(
        [{ address: USDC_POLYGON, topics: ["0xdead"], data: "0x01", logIndex: 0 }],
        USDC_POLYGON,
        EVM_A,
        1n,
      ).matched,
    ).toBe(false);
  });
});

describe("refund log matcher (pure, no I/O)", () => {
  it("requires the exact HTLC, hash lock and refund event", () => {
    const htlc = "0x0000000000000000000000000000000000000002";
    const lock = `0x${"ab".repeat(32)}`;
    const event = {
      address: htlc,
      topics: [SWAP_REFUNDED_EVENT_TOPIC, lock, `0x${"01".repeat(32)}`],
      data: "0x",
      logIndex: 4,
    };
    expect(matchRefundEvent([event], htlc, lock)).toMatchObject({ matched: true, logIndexes: [4] });
    expect(matchRefundEvent([event], htlc, `0x${"cd".repeat(32)}`).matched).toBe(false);
    expect(matchRefundEvent([{ ...event, address: "0x0000000000000000000000000000000000000003" }], htlc, lock).matched).toBe(false);
  });
});

describe.skipIf(!LIVE)(
  "settlement verification (mocked provider + chain)",
  () => {
  it("verifies full settlement, persists proof, and serves an immutable receipt", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const { cookie } = await login("settle-ok");
      // Per-run claim tx: the double-attribution guard correctly rejects
      // re-attribution, so a fixed tx would poison later runs after any
      // crash-interrupted cleanup (same class as fixed swap ids).
      const okTx = claimTxFor("ok");
      const id = await claimingTransfer(cookie, "settle-ok", "s1", `swap-b44-ok-${RUN}`, "5000000", okTx);
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: okTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt() }));
      try {
        const res = await verify(cookie, "settle-ok", id);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { settlement: { verdict: string; status: string; proof: Record<string, unknown>; confirmations: number } };
        expect(body.settlement.verdict).toBe("VERIFIED");
        expect(body.settlement.status).toBe("DELIVERED");
        expect(body.settlement.proof["claimTxHash"]).toBe(okTx);
        expect(body.settlement.proof["verifiedAmountAtomic"]).toBe("5000000");
        expect(body.settlement.proof["blockHash"]).toBe(BLOCK_HASH);
        expect(body.settlement.proof["explorerTxUrl"]).toContain(okTx);
        const rows = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id));
        expect(rows.length).toBe(1);
        expect(JSON.stringify(rows[0])).not.toMatch(/mnemonic|preimage|privateKey|private_key|secret/i);
        // Idempotent re-verification returns the stored proof, same receipt twice.
        const again = await verify(cookie, "settle-ok", id);
        expect(((await again.json()) as { settlement: { verdict: string } }).settlement.verdict).toBe("VERIFIED");
        const r1 = await receiptGet(new Request(`http://localhost/api/transfers/${id}/receipt`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
        const r2 = await receiptGet(new Request(`http://localhost/api/transfers/${id}/receipt`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
        expect(r1.status).toBe(200);
        expect(await r1.json()).toEqual(await r2.json());
        const receipt = ((await (await receiptGet(new Request(`http://localhost/api/transfers/${id}/receipt`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as { receipt: Record<string, unknown> }).receipt;
        expect(receipt["transferId"]).toBe(id);
        expect(receipt["destination"]).toBe(EVM_A);
        expect(receipt["requestedAmountAtomic"]).toBe("5000000");
        expect(receipt["verifiedAmountAtomic"]).toBe("5000000");
        expect(receipt["settlementTxHash"]).toBe(okTx);
        expect(receipt["actualFundingProven"]).toBe(false);
        expect(receipt["quotedSourceSatsEstimate"]).not.toBeNull();
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });

  it("rejects wrong recipient, token, chain, shortfall, reverts and empty receipts", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const cases: { name: string; receipt: NonNullable<ChainScript["receipt"]> | null; swap: Record<string, unknown>; reason: RegExp }[] = [
        { name: "wrong-recipient", receipt: goodReceipt(5000000n, "0x0000000000000000000000000000000000000002"), swap: {}, reason: /no Transfer event/i },
        { name: "wrong-token", receipt: { ...goodReceipt(), logs: [transferLog("0x0000000000000000000000000000000000000009", EVM_A, 5000000n, 0)] }, swap: {}, reason: /no Transfer event/i },
        { name: "wrong-chain", receipt: goodReceipt(), swap: { evm_chain_id: 1 }, reason: /different chain/i },
        { name: "shortfall", receipt: goodReceipt(4999999n), swap: {}, reason: /below the requested/i },
        { name: "reverted", receipt: { ...goodReceipt(), status: "reverted" }, swap: {}, reason: /reverted/i },
        { name: "empty", receipt: { ...goodReceipt(), logs: [] }, swap: {}, reason: /no Transfer event/i },
      ];
      let n = 0;
      for (const c of cases) {
        const caseNumber = n++;
        const { cookie } = await login(`settle-bad-${caseNumber}`);
        const caseTx = claimTxFor(`bad-${caseNumber}-${c.name}`);
        const id = await claimingTransfer(cookie, "settle-bad", `bad-${caseNumber}`, `swap-b44-${c.name}-${RUN}`, "5000000", caseTx);
        mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: caseTx, ...c.swap }));
        setSettlementChainForTests(mockChain({ receipt: c.receipt }));
        try {
          const res = await verify(cookie, "settle-bad", id);
          expect(res.status).toBe(422);
          const body = (await res.json()) as { settlement: { verdict: string; reason: string; status: string } };
          expect(body.settlement.verdict).toBe("INVALID");
          expect(body.settlement.reason).toMatch(c.reason);
          expect(body.settlement.status).toBe("CLAIMING");
          expect((await getDb().select().from(transfers).where(eq(transfers.id, id)))[0]?.status).toBe("CLAIMING");
        } finally {
          setSatoraFetchersForTests(null);
          setSettlementChainForTests(null);
        }
      }
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });

  it("ignores forged client-supplied tx hashes", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const { cookie } = await login("settle-forge");
      const forgeTx = claimTxFor("forge");
      const id = await claimingTransfer(cookie, "settle-forge", "fg1", `swap-b44-forge-${RUN}`, "5000000", forgeTx);
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: forgeTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt() }));
      try {
        const res = await verify(cookie, "settle-forge", id, { txHash: `0x${"ee".repeat(32)}`, destinationTxHash: `0x${"ee".repeat(32)}` });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { settlement: { verdict: string; proof: { claimTxHash: string } } };
        expect(body.settlement.verdict).toBe("VERIFIED");
        expect(body.settlement.proof.claimTxHash).toBe(forgeTx);
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });

  it("reports pending, inconclusive and unavailable without state change", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const { cookie } = await login("settle-pending");
      const pendTx = claimTxFor("pending");
      // Pending: claim tx not yet mined.
      const id = await claimingTransfer(cookie, "settle-pending", "pd1", `swap-b44-pend-${RUN}`, "5000000", pendTx);
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: pendTx }));
      setSettlementChainForTests(mockChain({ receipt: null, txBlock: null }));
      try {
        const res = await verify(cookie, "settle-pending", id);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { settlement: { verdict: string } }).settlement.verdict).toBe("PENDING");
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      // Inconclusive: provider claim status without chain proof.
      mockSwap(fixtureSwap({ status: "clientredeemed" }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt() }));
      try {
        const res = await verify(cookie, "settle-pending", id);
        expect(((await res.json()) as { settlement: { verdict: string } }).settlement.verdict).toBe("INCONCLUSIVE");
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      // Insufficient finality.
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: pendTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt(), latest: BLOCK_NUM + 5n }));
      try {
        const res = await verify(cookie, "settle-pending", id);
        const body = (await res.json()) as { settlement: { verdict: string; confirmations: number } };
        expect(body.settlement.verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
        expect(body.settlement.confirmations).toBe(6);
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      // Reorg: header hash changed at the settlement height.
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: pendTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt(), headerHash: `0x${"ff".repeat(32)}` }));
      try {
        const res = await verify(cookie, "settle-pending", id);
        expect(((await res.json()) as { settlement: { verdict: string } }).settlement.verdict).toBe("INCONCLUSIVE");
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      // RPC outage: 503, transfer untouched, no proof row.
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: pendTx }));
      const calls = { reads: 0 };
      setSettlementChainForTests(mockChain({ receipt: goodReceipt(), fail: "all", calls }));
      try {
        const res = await verify(cookie, "settle-pending", id);
        expect(res.status).toBe(503);
        expect(calls.reads).toBeGreaterThan(0);
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      expect((await getDb().select().from(transfers).where(eq(transfers.id, id)))[0]?.status).toBe("CLAIMING");
      // No verified settlement was persisted (only the attach-time skeleton row).
      const proofRows = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id));
      expect(proofRows.every((r) => r.evmTxHash === null && r.verifiedAt === null)).toBe(true);
      // Receipt not ready before delivery.
      const rec = await receiptGet(new Request(`http://localhost/api/transfers/${id}/receipt`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
      expect(rec.status).toBe(409);
      expect(((await rec.json()) as { error: string }).error).toBe("RECEIPT_NOT_READY");
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });

  it("F9.2: Polygon finalized-mode override is fail-closed on stale/inconsistent RPCs and rolls back to 256 confirmations", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    const prevFinality = setEnv("THENCE_SETTLEMENT_FINALITY_JSON", JSON.stringify({ "137": { mode: "finalized", confirmations: 1 } }));
    const verdictWith = async (cookie: string, id: string, tx: string, script: ChainScript) => {
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: tx }));
      setSettlementChainForTests(mockChain(script));
      try {
        const res = await verify(cookie, "settle-fin", id);
        return { status: res.status, body: (await res.json()) as { settlement?: { verdict: string; status: string; proof: Record<string, unknown> | null } } };
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
    };
    try {
      const { cookie } = await login("settle-fin");
      const tx = claimTxFor("fin");
      const id = await claimingTransfer(cookie, "settle-fin", "f1", `swap-b44-fin-${RUN}`, "5000000", tx);
      // RPC can't provide finality evidence: undecided, never delivered.
      expect((await verdictWith(cookie, id, tx, { receipt: goodReceipt(), latest: BLOCK_NUM + 4n, finalized: null })).body.settlement?.verdict).toBe("INCONCLUSIVE");
      // Stale/lagging finality (claim block not yet finalized): not yet.
      expect((await verdictWith(cookie, id, tx, { receipt: goodReceipt(), latest: BLOCK_NUM + 4n, finalized: BLOCK_NUM - 1n })).body.settlement?.verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
      // Inconsistent RPC: finalized above its own head → refused as evidence.
      expect((await verdictWith(cookie, id, tx, { receipt: goodReceipt(), latest: BLOCK_NUM + 4n, finalized: BLOCK_NUM + 50n })).body.settlement?.verdict).toBe("INCONCLUSIVE");
      // Reorg: the block at the claim height changed, even though "finalized" covers it.
      expect((await verdictWith(cookie, id, tx, { receipt: goodReceipt(), latest: BLOCK_NUM + 4n, finalized: BLOCK_NUM + 2n, headerHash: `0x${"ee".repeat(32)}` })).body.settlement?.verdict).toBe("INCONCLUSIVE");
      // RPC outage: 503, nothing written.
      expect((await verdictWith(cookie, id, tx, { receipt: goodReceipt(), fail: "all" })).status).toBe(503);
      expect((await getDb().select().from(transfers).where(eq(transfers.id, id)))[0]?.status).toBe("CLAIMING");

      // Rollback: remove the override → the 256-confirmation default applies again
      // to the same evidence (claim only 5 blocks deep) → not yet delivered.
      restoreEnv("THENCE_SETTLEMENT_FINALITY_JSON", prevFinality);
      expect((await verdictWith(cookie, id, tx, { receipt: goodReceipt(), latest: BLOCK_NUM + 4n, finalized: BLOCK_NUM + 2n })).body.settlement?.verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
      setEnv("THENCE_SETTLEMENT_FINALITY_JSON", JSON.stringify({ "137": { mode: "finalized", confirmations: 1 } }));

      // Finalized covers the claim block (~2-3 blocks behind head, as observed on
      // mainnet): delivered seconds after the claim, proof says "finalized".
      const ok = await verdictWith(cookie, id, tx, { receipt: goodReceipt(), latest: BLOCK_NUM + 4n, finalized: BLOCK_NUM + 2n });
      expect(ok.body.settlement?.verdict).toBe("VERIFIED");
      expect(ok.body.settlement?.status).toBe("DELIVERED");
      const rows = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id));
      expect(rows.find((r) => r.verifiedAt !== null)?.finalityLevel).toBe("finalized");
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
      restoreEnv("THENCE_SETTLEMENT_FINALITY_JSON", prevFinality);
    }
  });

  it("serializes concurrent verification into one proof and blocks double attribution", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const { cookie } = await login("settle-race");
      const raceTx = claimTxFor("race");
      const id = await claimingTransfer(cookie, "settle-race", "rc1", `swap-b44-race-${RUN}`, "5000000", raceTx);
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: raceTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt() }));
      try {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            verify(cookie, `settle-race-${i}`, id).then(async (r) => ({
              status: r.status,
              verdict: ((await r.json()) as { settlement: { verdict: string } }).settlement.verdict,
            })),
          ),
        );
        expect(results.every((r) => r.status === 200 && r.verdict === "VERIFIED")).toBe(true);
        expect((await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id))).length).toBe(1);
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      // A second transfer cannot claim the same on-chain event.
      const id2 = await claimingTransfer(cookie, "settle-race", "rc2", `swap-b44-race2-${RUN}`, "5000000", claimTxFor("race2"));
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: raceTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt() }));
      try {
        const res = await verify(cookie, "settle-race", id2);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe("DOUBLE_ATTRIBUTION");
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });

  it("enforces owner-only access and never delivers via client assertion", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const { cookie } = await login("settle-guard");
      const guardTx = claimTxFor("guard");
      const id = await claimingTransfer(cookie, "settle-guard", "gd1", `swap-b44-guard-${RUN}`, "5000000", guardTx);
      const bob = await login("settle-guard-bob");
      mockSwap(fixtureSwap({ status: "clientredeemed", evm_claim_txid: guardTx }));
      setSettlementChainForTests(mockChain({ receipt: goodReceipt() }));
      try {
        expect((await verify(bob.cookie, "settle-guard-bob", id)).status).toBe(404);
        const rec = await receiptGet(new Request(`http://localhost/api/transfers/${id}/receipt`, { headers: { cookie: bob.cookie } }), { params: Promise.resolve({ id }) });
        expect(rec.status).toBe(404);
        // Client-forged DELIVERED is rejected outright.
        expect(() => transition("CLAIMING", "DELIVERED")).toThrow();
        const forged = await reportPost(
          postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "delivered" }, { cookie, ...withClient("settle-guard") }),
          { params: Promise.resolve({ id }) },
        );
        expect(forged.status).toBe(400);
        expect((await getDb().select().from(transfers).where(eq(transfers.id, id)))[0]?.status).toBe("CLAIMING");
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });

  it("keeps cancel-reported authorized transfers recoverable on delayed funding", async () => {
    const prevRoutes = setEnv("THENCE_ENABLED_ROUTES", ROUTES);
    const prevRpcs = setEnv("THENCE_EVM_RPCS_JSON", RPCS);
    try {
      const { cookie } = await login("settle-cancel");
      // Build an authorized (AWAITING) transfer with a bound swap.
      const created = await createTransfer(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "5000000", idempotencyKey: `k-${RUN}-cx`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...withClient("settle-cancel") }),
      );
      expect(created.status).toBe(201);
      const createdBody = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
      const tid = createdBody.id;
      const prep = await preparePost(
        postJson(`http://localhost/api/transfers/${tid}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...withClient("settle-cancel") }),
        { params: Promise.resolve({ id: tid }) },
      );
      const token = ((await prep.json()) as { attemptToken?: string }).attemptToken as string;
      const swapId = `swap-b44-cancel-${RUN}`;
      const { POST: attachPost } = await import("../app/api/transfers/[id]/attach/route");
      const { POST: authorizePost } = await import("../app/api/transfers/[id]/authorize-handoff/route");
      mockSwap(fixtureSwap({ id: swapId, source_amount: createdBody.quote.sourceSats }));
      try {
        expect((await attachPost(postJson(`http://localhost/api/transfers/${tid}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...withClient("settle-cancel") }), { params: Promise.resolve({ id: tid }) })).status).toBe(201);
        expect((await authorizePost(postJson(`http://localhost/api/transfers/${tid}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("settle-cancel") }), { params: Promise.resolve({ id: tid }) })).status).toBe(200);
      } finally {
        setSatoraFetchersForTests(null);
      }
      // Cancel report while provider shows pending: must NOT go terminal.
      mockSwap(fixtureSwap({ id: swapId, status: "pending" }));
      try {
        const cancelled = await reportPost(
          postJson(`http://localhost/api/transfers/${tid}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient("settle-cancel") }),
          { params: Promise.resolve({ id: tid }) },
        );
        expect(cancelled.status).toBe(200);
        expect(((await cancelled.json()) as { handoff: { status: string } }).handoff.status).toBe("RECONCILING");
      } finally {
        setSatoraFetchersForTests(null);
      }
      // Delayed funding is still observed and recoverable.
      mockSwap(fixtureSwap({ id: swapId, status: "clientfunded" }));
      try {
        const res = await reconcilePost(postJson(`http://localhost/api/transfers/${tid}/reconcile`, {}, { cookie, ...withClient("settle-cancel") }), { params: Promise.resolve({ id: tid }) });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { reconciliation: { status: string } }).reconciliation.status).toBe("CLIENT_FUNDED");
      } finally {
        setSatoraFetchersForTests(null);
      }
      // The transfer itself recovered (never terminally cancelled, never delivered).
      expect((await getDb().select().from(transfers).where(eq(transfers.id, tid)))[0]?.status).toBe("CLIENT_FUNDED");
    } finally {
      restoreEnv("THENCE_ENABLED_ROUTES", prevRoutes);
      restoreEnv("THENCE_EVM_RPCS_JSON", prevRpcs);
    }
  });
  },
  300_000,
);
