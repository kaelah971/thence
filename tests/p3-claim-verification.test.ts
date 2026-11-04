/**
 * P3 — pre-claim verification (database-free, network-free).
 *
 * verifyHtlcFunding is replayed on the REAL 2026-11-02 fund receipt of
 * 077770a1 (tests/fixtures/incidents-2026-11-02.json): the pinned HTLC's fund
 * event carries topic[1] = the swap's hash lock and, in data word 2, the
 * timelock 0x6ae90ada = 1793657562 = Satora's evm_refund_locktime. Every
 * deviation must stop a claim before the preimage could be revealed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/incidents-2026-11-02.json";
import {
  CHAIN_READ_TIMEOUT_MS,
  CLAIM_FUNDING_MIN_CONFIRMATIONS,
  SWAP_FUNDED_EVENT_TOPIC,
  setSettlementChainForTests,
  verifyHtlcFunding,
  type ChainReads,
} from "@/lib/settlement";
import { claimIdentityProblem } from "@/lib/claim-intent";
import type { VerifiedSwapFacts } from "@/lib/satora";

const INC = fixture.incident_077770a1;
const STALE = fixture.stale_eddaa6de;
const HTLC = INC.satora.getSwap.evm_htlc_address;
const LOCK = INC.attachment.payment_hash;
const FUND_TX = INC.satora.getSwap.evm_fund_txid as string;
const REFUND_TX = INC.satora.getSwap.evm_claim_txid as string;
const LOCKTIME = INC.satora.getSwap.evm_refund_locktime;

type RawReceipt = (typeof INC.polygon.receipts)[keyof typeof INC.polygon.receipts];
const receipts = INC.polygon.receipts as Record<string, RawReceipt>;
const blocks = INC.polygon.blocks as Record<string, { hash: string }>;
const fundBlock = BigInt(receipts[FUND_TX]!.blockNumber);

function chain(over: Partial<ChainReads> = {}): ChainReads {
  return {
    async getTransaction() {
      return null;
    },
    async getReceipt(_c, hash) {
      const r = receipts[hash.toLowerCase()];
      return r ? { status: r.status as "success", blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) } : null;
    },
    async getLatestBlockNumber() {
      return BigInt(fixture._meta.polygonLatestBlockAtCapture);
    },
    async getFinalizedBlockNumber() {
      return null;
    },
    async getBlockHash(_c, n) {
      return blocks[n.toString()]?.hash ?? null;
    },
    ...over,
  };
}

const input = (over: Partial<Parameters<typeof verifyHtlcFunding>[0]> = {}) => ({ chainId: 137, htlcAddress: HTLC, hashLock: LOCK, fundTxHash: FUND_TX as string | null, expectedLocktimeSec: LOCKTIME, ...over });

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@fixture.invalid:5432/none");
  vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": "https://fixture.invalid" }));
  setSettlementChainForTests(chain());
});
afterEach(() => {
  setSettlementChainForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("P3 on-chain HTLC funding verification (real 077770a1 fund receipt)", () => {
  it("the real fund event names the pinned HTLC, this hash lock and the bound deadline", async () => {
    const fund = receipts[FUND_TX]!.logs.find((l) => l.topics[0] === SWAP_FUNDED_EVENT_TOPIC)!;
    expect(fund.address.toLowerCase()).toBe(HTLC.toLowerCase());
    expect(fund.topics[1]).toBe(LOCK);
    expect(Number(BigInt("0x" + fund.data.slice(2).slice(128, 192)))).toBe(LOCKTIME);
    expect(await verifyHtlcFunding(input())).toMatchObject({ verdict: "VERIFIED" });
  });

  it("a different deadline, hash lock or HTLC is INVALID", async () => {
    expect((await verifyHtlcFunding(input({ expectedLocktimeSec: LOCKTIME + 60 }))).verdict).toBe("INVALID");
    expect((await verifyHtlcFunding(input({ hashLock: STALE.attachment.payment_hash }))).verdict).toBe("INVALID");
    expect((await verifyHtlcFunding(input({ htlcAddress: "0x0000000000000000000000000000000000000003" }))).verdict).toBe("INVALID");
    // The refund receipt is not a funding receipt.
    expect((await verifyHtlcFunding(input({ fundTxHash: REFUND_TX }))).verdict).toBe("INVALID");
  });

  it("no funding pointer, unmined, too few confirmations or a reorg never verify", async () => {
    expect((await verifyHtlcFunding(input({ fundTxHash: null }))).verdict).toBe("PENDING");
    setSettlementChainForTests(chain({ getReceipt: async () => null }));
    expect((await verifyHtlcFunding(input())).verdict).toBe("PENDING");
    setSettlementChainForTests(chain({ getLatestBlockNumber: async () => fundBlock + BigInt(CLAIM_FUNDING_MIN_CONFIRMATIONS - 2) }));
    expect((await verifyHtlcFunding(input())).verdict).toBe("PENDING");
    setSettlementChainForTests(chain({ getBlockHash: async () => `0x${"99".repeat(32)}` }));
    expect((await verifyHtlcFunding(input())).verdict).toBe("INCONCLUSIVE");
  });

  it("RPC failure or a hung RPC is UNAVAILABLE (bounded), never VERIFIED", async () => {
    setSettlementChainForTests(chain({ getReceipt: async () => { throw new Error("rpc 502"); } }));
    expect((await verifyHtlcFunding(input())).verdict).toBe("UNAVAILABLE");
    vi.useFakeTimers();
    setSettlementChainForTests(chain({ getReceipt: () => new Promise<never>(() => undefined) }));
    const pending = verifyHtlcFunding(input());
    await vi.advanceTimersByTimeAsync(CHAIN_READ_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });
});

describe("P3 claim identity (pure)", () => {
  const facts = (over: Partial<VerifiedSwapFacts> = {}): VerifiedSwapFacts =>
    ({
      satoraSwapId: INC.attachment.satora_swap_id,
      direction: "lightning_to_evm",
      paymentHash: LOCK,
      targetAtomic: INC.transfer.target_amount_atomic,
      targetAddress: INC.transfer.destination,
      evmRefundLocktime: LOCKTIME,
      ...over,
    }) as VerifiedSwapFacts;
  const transfer = { targetAmountAtomic: INC.transfer.target_amount_atomic, destination: INC.transfer.destination };
  const attachment = { satoraSwapId: INC.attachment.satora_swap_id, paymentHash: LOCK, evmRefundLocktime: new Date(LOCKTIME * 1000) };

  it("the real bound swap matches itself", () => {
    expect(claimIdentityProblem(transfer, attachment, facts(), true)).toBeNull();
  });

  it("every identity fact a claim depends on is checked", () => {
    expect(claimIdentityProblem(transfer, attachment, facts({ satoraSwapId: "other" }), true)).toMatch(/different swap/);
    expect(claimIdentityProblem(transfer, attachment, facts({ paymentHash: STALE.attachment.payment_hash }), true)).toMatch(/Payment hash/);
    expect(claimIdentityProblem(transfer, attachment, facts({ targetAtomic: "299999" }), true)).toMatch(/Amount/);
    expect(claimIdentityProblem(transfer, attachment, facts({ targetAddress: "0x0000000000000000000000000000000000000bad" }), true)).toMatch(/Destination/);
    expect(claimIdentityProblem(transfer, attachment, facts(), false)).toMatch(/Chain or token/);
    expect(claimIdentityProblem(transfer, attachment, facts({ evmRefundLocktime: LOCKTIME + 1 }), true)).toMatch(/deadline/);
    expect(claimIdentityProblem(transfer, { ...attachment, evmRefundLocktime: null }, facts(), true)).toMatch(/deadline/);
    expect(claimIdentityProblem(transfer, attachment, facts({ direction: "evm_to_lightning" as never }), true)).toMatch(/Lightning to Polygon/);
  });
});
