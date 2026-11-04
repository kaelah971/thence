/**
 * P5 — independent Polygon refund verification and financial-state
 * consistency (database-free, network-free).
 *
 * Refund cases replay the REAL, redacted 2026-11-02 evidence of 077770a1
 * (tests/fixtures/incidents-2026-11-02.json): its pinned HTLC, hash lock,
 * fund and refund receipts, and the HTLC log scan captured from a public
 * Polygon RPC over blocks 96632000–96636000. The fixture chain answers only
 * inside that captured range (outside it throws → UNAVAILABLE) and maps block
 * numbers to time with the linear fit of the two captured block timestamps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/incidents-2026-11-02.json";
import {
  CHAIN_READ_TIMEOUT_MS,
  TRUSTED_HTLC_CONTRACTS,
  isTrustedHtlc,
  setSettlementChainForTests,
  verifyHtlcRefund,
  type ChainLog,
  type ChainReads,
} from "@/lib/settlement";
import { TRUSTED_HTLC_CONTRACTS as P4_TRUSTED } from "@/lib/expiry-resolution";
import { checkTransferConsistency, orderTransitions, type ConsistencySnapshot } from "@/lib/consistency";
import { USER_FACING_LABEL } from "@/domain/transfers";
import { EXPIRED_UNFUNDED_BODY, REFUNDED_BODY, progressCopy } from "@/ui/lib/settlement-client";

const INC = fixture.incident_077770a1;
const STALE = fixture.stale_eddaa6de;
const HTLC = INC.satora.getSwap.evm_htlc_address;
const LOCK = INC.attachment.payment_hash;
const FUND_TX = INC.satora.getSwap.evm_fund_txid as string;
const REFUND_TX = INC.satora.getSwap.evm_claim_txid as string;
const LOCKTIME = new Date(INC.satora.getSwap.evm_refund_locktime * 1000);
const SCAN = INC.polygonHtlcScan;

type RawReceipt = (typeof INC.polygon.receipts)[keyof typeof INC.polygon.receipts];
const receipts = INC.polygon.receipts as Record<string, RawReceipt>;
const blocks = INC.polygon.blocks as Record<string, { number: string; hash: string; timestamp: string }>;
const anchor = blocks[receipts[FUND_TX]!.blockNumber]!;
const ts = (n: bigint) => Number(anchor.timestamp) + Math.floor((Number(n) - Number(anchor.number)) * 1.5);

/** Real receipts + real HTLC scan; latest block = end of the captured scan. */
function realChain(over: Partial<ChainReads> = {}): ChainReads & { logCalls: number } {
  const state = { logCalls: 0 };
  const chain: ChainReads = {
    async getTransaction(_c, hash) {
      const r = receipts[hash.toLowerCase()];
      return r ? { hash, blockNumber: BigInt(r.blockNumber) } : null;
    },
    async getReceipt(_c, hash) {
      const r = receipts[hash.toLowerCase()];
      return r
        ? { status: r.status as "success", blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) }
        : null;
    },
    async getLatestBlockNumber() {
      return BigInt(SCAN.toBlock);
    },
    async getFinalizedBlockNumber() {
      return BigInt(SCAN.toBlock) - 300n;
    },
    async getBlockHash(_c, n) {
      return blocks[n.toString()]?.hash ?? null;
    },
    async getBlockTimestamp(_c, n) {
      return ts(n);
    },
    async getLogsByTopic1(_c, address, topic1, from, to): Promise<ChainLog[]> {
      state.logCalls++;
      if (from < BigInt(SCAN.fromBlock) || to > BigInt(SCAN.toBlock)) throw new Error("outside captured evidence");
      if (topic1.toLowerCase() !== SCAN.hashLock.toLowerCase()) return [];
      return SCAN.logs
        .filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to)
        .map((l) => ({ address, topics: [l.topic0, topic1, "0x" + "00".repeat(32)], data: "0x", logIndex: l.logIndex, transactionHash: l.transactionHash }));
    },
    ...over,
  };
  return Object.assign(chain, { get logCalls() { return state.logCalls; } });
}

const input = (over: Partial<Parameters<typeof verifyHtlcRefund>[0]> = {}) => ({
  chainId: 137,
  htlcAddress: HTLC,
  hashLock: LOCK,
  providerRefundTxHash: REFUND_TX as string | null,
  earliestRefundAt: LOCKTIME,
  ...over,
});

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@fixture.invalid:5432/none");
  vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": "https://fixture.invalid" }));
});
afterEach(() => {
  setSettlementChainForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("P5 independent Polygon refund verification (real 077770a1 evidence)", () => {
  it("one HTLC trust list serves P4 and P5, and the real HTLC is on it", () => {
    expect(P4_TRUSTED).toBe(TRUSTED_HTLC_CONTRACTS);
    expect(isTrustedHtlc(137, HTLC)).toBe(true);
    expect(isTrustedHtlc(137, "0x0000000000000000000000000000000000000002")).toBe(false);
    expect(isTrustedHtlc(1, HTLC)).toBe(false);
  });

  it("Satora's pointer (the real refund tx in evm_claim_txid) verifies without a log scan", async () => {
    const chain = realChain();
    setSettlementChainForTests(chain);
    const r = await verifyHtlcRefund(input());
    expect(r).toMatchObject({ verdict: "VERIFIED", source: "provider_pointer", refundTxHash: REFUND_TX });
    expect(chain.logCalls).toBe(0);
  });

  it("missing pointer: the refund is found in the HTLC's own logs and that tx is verified", async () => {
    setSettlementChainForTests(realChain());
    const r = await verifyHtlcRefund(input({ providerRefundTxHash: null }));
    expect(r).toMatchObject({ verdict: "VERIFIED", source: "htlc_log_scan", refundTxHash: REFUND_TX.toLowerCase() });
  });

  it("wrong pointer (the real FUND tx): never accepted, the scan finds the real refund instead", async () => {
    setSettlementChainForTests(realChain());
    const r = await verifyHtlcRefund(input({ providerRefundTxHash: FUND_TX }));
    expect(r).toMatchObject({ verdict: "VERIFIED", source: "htlc_log_scan", refundTxHash: REFUND_TX.toLowerCase() });
    expect(r.refundTxHash).not.toBe(FUND_TX.toLowerCase());
  });

  it("an HTLC outside the pinned list is refused before any chain read, even with a real refund pointer", async () => {
    const chain = realChain({ getReceipt: vi.fn(async () => { throw new Error("must not be read"); }) });
    setSettlementChainForTests(chain);
    const r = await verifyHtlcRefund(input({ htlcAddress: "0x0000000000000000000000000000000000000003" }));
    expect(r).toMatchObject({ verdict: "INVALID", refundTxHash: null });
    expect(chain.getReceipt).not.toHaveBeenCalled();
  });

  it("another swap's hash lock (eddaa6de) never borrows 077770a1's refund", async () => {
    setSettlementChainForTests(realChain());
    const r = await verifyHtlcRefund(input({ hashLock: STALE.attachment.payment_hash, providerRefundTxHash: REFUND_TX }));
    expect(r.verdict).not.toBe("VERIFIED");
    expect(r).toMatchObject({ verdict: "INCONCLUSIVE", source: null });
  });

  it("an RPC that ignores the topic filter cannot make another lock's refund count (defensive re-filter)", async () => {
    const leaky = realChain();
    const base = leaky.getLogsByTopic1!;
    setSettlementChainForTests({ ...leaky, getLogsByTopic1: (c, a, _t, f, e) => base(c, a, SCAN.hashLock, f, e) });
    const r = await verifyHtlcRefund(input({ hashLock: STALE.attachment.payment_hash, providerRefundTxHash: null }));
    expect(r).toMatchObject({ verdict: "INCONCLUSIVE", refundTxHash: null });
  });

  it("two distinct refund transactions for one lock: refuses to choose", async () => {
    const real = realChain();
    setSettlementChainForTests({
      ...real,
      async getLogsByTopic1(c, a, t, f, e) {
        const logs = await real.getLogsByTopic1!(c, a, t, f, e);
        const refund = logs.find((l) => l.transactionHash === REFUND_TX);
        return refund ? [...logs, { ...refund, transactionHash: "0x" + "77".repeat(32), logIndex: 1 }] : logs;
      },
    });
    const r = await verifyHtlcRefund(input({ providerRefundTxHash: null }));
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("failed RPC during the scan is UNAVAILABLE, never a negative or positive verdict", async () => {
    setSettlementChainForTests(realChain({ getLogsByTopic1: async () => { throw new Error("rpc 502"); } }));
    expect((await verifyHtlcRefund(input({ providerRefundTxHash: null }))).verdict).toBe("UNAVAILABLE");
  });

  it("a hung log scan times out to UNAVAILABLE instead of stalling reconciliation", async () => {
    vi.useFakeTimers();
    setSettlementChainForTests(realChain({ getLogsByTopic1: () => new Promise<never>(() => undefined) }));
    const pending = verifyHtlcRefund(input({ providerRefundTxHash: null }));
    await vi.advanceTimersByTimeAsync(CHAIN_READ_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });

  it("a refund too recent for the finality policy stays INSUFFICIENT_CONFIRMATIONS", async () => {
    const refundBlock = BigInt(receipts[REFUND_TX]!.blockNumber);
    setSettlementChainForTests(realChain({ getLatestBlockNumber: async () => refundBlock + 10n }));
    expect((await verifyHtlcRefund(input())).verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
  });
});

describe("P5 refund wording keeps the Polygon and Nimiq sides separate", () => {
  it("REFUNDED never claims the NIM came back", () => {
    for (const text of [USER_FACING_LABEL.REFUNDED, progressCopy("refunded").title, progressCopy("refunded").body]) {
      expect(text).not.toMatch(/^Payment refunded/i);
      expect(text).not.toMatch(/(your )?NIM (was|has been|is) (refunded|returned)/i);
    }
    expect(USER_FACING_LABEL.REFUNDED).toMatch(/not delivered/i);
    expect(USER_FACING_LABEL.REFUNDED).toMatch(/polygon/i);
    expect(REFUNDED_BODY).toMatch(/not a refund of your NIM/i);
    expect(REFUNDED_BODY).toMatch(/can't see inside Nimiq Pay/i);
    // Same Nimiq-side honesty as the expired-unfunded case.
    expect(EXPIRED_UNFUNDED_BODY).toMatch(/can't see inside Nimiq Pay/i);
  });
});

/* ------------------------- consistency checker ------------------------- */

let seq = 0;
const at0 = Date.parse("2026-11-04T10:00:00.000Z");
function hop(from: string, to: string, over: Partial<ConsistencySnapshot["transitions"][number]> = {}): ConsistencySnapshot["transitions"][number] {
  return {
    id: `t${seq}`,
    transferId: "x",
    fromStatus: from,
    toStatus: to,
    actor: "owner",
    actorUserId: null,
    reasonCode: "TEST",
    evidence: {},
    terminal: ["QUOTE_EXPIRED", "USER_CANCELLED", "REFUNDED", "DELIVERED", "FAILED", "EXPIRED_UNFUNDED"].includes(to),
    createdAt: new Date(at0 + seq++ * 1000),
    ...over,
  };
}
const proof = { evidenceSource: "evm_erc20_transfer", chainId: 137, evmTxHash: "0x" + "ab".repeat(32), tokenContract: "0xt", recipient: "0xr", verifiedAmountAtomic: "300000", blockNumber: 1, blockHash: "0xb", finalityLevel: "confirmations-256", verifiedAt: new Date() } as unknown as ConsistencySnapshot["proof"];
const snap = (status: string, over: Partial<ConsistencySnapshot> = {}): ConsistencySnapshot => ({
  transfer: { id: "x", status },
  attachment: { satoraSwapId: "s" },
  proof: null,
  attempts: [{ status: "HANDOFF_AUTHORIZED" }],
  transitions: [],
  ...over,
});
const codes = (s: ConsistencySnapshot, strict = true) => checkTransferConsistency(s, { requireAudit: strict }).map((v) => v.code);
const AUTH_PATH = () => [hop("QUOTED", "SWAP_CREATED"), hop("SWAP_CREATED", "AWAITING_NIM_APPROVAL")];

describe("P5 financial-state consistency checker (pure)", () => {
  it("a fully audited DELIVERED transfer with a complete proof is consistent", () => {
    const transitions = [...AUTH_PATH(), hop("AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF"), hop("LIGHTNING_HANDOFF", "CLIENT_FUNDED"), hop("CLIENT_FUNDED", "SERVER_FUNDED"), hop("SERVER_FUNDED", "DELIVERED")];
    expect(codes(snap("DELIVERED", { proof, transitions }))).toEqual([]);
  });

  it("DELIVERED without a proof, and a proof without DELIVERED, are both flagged", () => {
    expect(codes(snap("DELIVERED"), false)).toContain("DELIVERED_WITHOUT_PROOF");
    expect(codes(snap("DELIVERED", { proof: { ...proof!, blockHash: null } }), false)).toContain("DELIVERED_WITHOUT_PROOF");
    expect(codes(snap("CLAIMING", { proof }), false)).toContain("PROOF_WITHOUT_DELIVERY");
    // The attach-time mirror row (swap id + hash only) is not a settlement proof.
    expect(codes(snap("SWAP_CREATED", { proof: { ...proof!, evidenceSource: null, verifiedAt: null } as never, attempts: [] }), false)).toEqual([]);
  });

  it("post-bind and post-authorization statuses need their durable records", () => {
    expect(codes(snap("SWAP_CREATED", { attachment: null, attempts: [] }), false)).toEqual(["BOUND_STATUS_WITHOUT_SWAP"]);
    expect(codes(snap("SERVER_FUNDED", { attempts: [{ status: "SWAP_ATTACHED" }] }), false)).toEqual(["HANDOFF_WITHOUT_AUTHORIZATION"]);
  });

  it("REFUNDED requires an audited, independently verified Polygon refund", () => {
    const unverified = [...AUTH_PATH(), hop("AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF"), hop("LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN"), hop("OUTCOME_UNKNOWN", "RECONCILING"), hop("RECONCILING", "REFUNDED")];
    expect(codes(snap("REFUNDED", { transitions: unverified }))).toEqual(["REFUNDED_WITHOUT_VERIFIED_REFUND"]);
    const verified = unverified.map((t) => (t.toStatus === "REFUNDED" ? { ...t, evidence: { refundVerified: true, refundScope: "polygon_htlc" } } : t));
    expect(codes(snap("REFUNDED", { transitions: verified }))).toEqual([]);
  });

  it("audit gaps, illegal hops, a stale tail and a second terminal row are flagged", () => {
    expect(codes(snap("AWAITING_NIM_APPROVAL"))).toEqual(["AUDIT_MISSING"]);
    expect(codes(snap("AWAITING_NIM_APPROVAL"), false)).toEqual([]); // legacy pre-P5 rows are allowed without strictness
    expect(codes(snap("AWAITING_NIM_APPROVAL", { transitions: [hop("QUOTED", "SWAP_CREATED")] }))).toEqual(["AUDIT_TAIL_MISMATCH"]);
    expect(codes(snap("AWAITING_NIM_APPROVAL", { transitions: [hop("QUOTED", "SWAP_CREATED"), hop("AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF")], transfer: { id: "x", status: "LIGHTNING_HANDOFF" } }))).toContain("AUDIT_CHAIN_BROKEN");
    expect(codes(snap("DELIVERED", { proof, transitions: [...AUTH_PATH(), hop("AWAITING_NIM_APPROVAL", "DELIVERED")] }))).toContain("AUDIT_ILLEGAL_HOP");
    const twice = [hop("QUOTED", "USER_CANCELLED"), hop("QUOTED", "USER_CANCELLED")];
    expect(codes(snap("USER_CANCELLED", { attachment: null, attempts: [], transitions: twice }))).toContain("AUDIT_MULTIPLE_TERMINAL");
  });

  it("orders same-timestamp hops of one path by linkage (pre-P5 rows shared NOW())", () => {
    const t = new Date(at0);
    const rows = [hop("OUTCOME_UNKNOWN", "RECONCILING", { createdAt: t }), hop("AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF", { createdAt: t }), hop("LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", { createdAt: t })];
    expect(orderTransitions(rows).map((r) => r.toStatus)).toEqual(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]);
    const prior = [hop("QUOTED", "SWAP_CREATED", { createdAt: new Date(at0 - 2000) }), hop("SWAP_CREATED", "AWAITING_NIM_APPROVAL", { createdAt: new Date(at0 - 1000) })];
    expect(codes(snap("RECONCILING", { transitions: [...rows, ...prior] }))).toEqual([]);
  });
});
