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
import { keccak256 } from "viem";
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
const ARBITRUM_HTLC = "0x6c38bf44a327bf36bfbeFcedc514c0fb3fec6748";
const HTLC_TOKEN = INC.satora.getSwap.wbtc_address;
const HTLC_AMOUNT = INC.satora.getSwap.evm_expected_sats;
const HTLC_REFUND_ADDRESS = INC.satora.getSwap.server_evm_address;
const HTLC_CLAIM_ADDRESS = INC.satora.getSwap.client_evm_address;
const ARBITRUM_FUND_TX = `0x${"ab".repeat(32)}`;
const ARBITRUM_BLOCK = 90_000_000n;
const ARBITRUM_BLOCK_HASH = `0x${"a1".repeat(32)}`;
const hexWord = (value: bigint | number | string) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value: string) => value.slice(2).toLowerCase().padStart(64, "0");
const addressTopic = (value: string) => `0x${addressWord(value)}`;
const swapKey = (hashLock: string, amount: bigint | number | string, token: string, refundAddress: string, claimAddress: string, timelock: bigint | number | string) =>
  keccak256(`0x${[hashLock.slice(2), hexWord(amount), addressWord(token), addressWord(refundAddress), addressWord(claimAddress), hexWord(timelock)].join("")}` as `0x${string}`);
const swapCreatedData = (over: { token?: string; amount?: bigint | number | string; refundAddress?: string; claimAddress?: string; timelock?: bigint | number | string } = {}) => {
  const token = over.token ?? HTLC_TOKEN;
  const amount = over.amount ?? HTLC_AMOUNT;
  const refundAddress = over.refundAddress ?? HTLC_REFUND_ADDRESS;
  const claimAddress = over.claimAddress ?? HTLC_CLAIM_ADDRESS;
  const timelock = over.timelock ?? LOCKTIME;
  return `0x${addressWord(token)}${hexWord(amount)}${hexWord(timelock)}${swapKey(LOCK, amount, token, refundAddress, claimAddress, timelock).slice(2)}`;
};
const ARBITRUM_FUND_DATA = swapCreatedData();

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

const input = (over: Partial<Parameters<typeof verifyHtlcFunding>[0]> = {}) => ({
  chainId: 137,
  htlcAddress: HTLC,
  hashLock: LOCK,
  fundTxHash: FUND_TX as string | null,
  expectedLocktimeSec: LOCKTIME,
  expectedTokenAddress: HTLC_TOKEN,
  expectedAmountAtomic: HTLC_AMOUNT,
  expectedRefundAddress: HTLC_REFUND_ADDRESS,
  expectedClaimAddress: HTLC_CLAIM_ADDRESS,
  ...over,
});
const arbitrumInput = (over: Partial<Parameters<typeof verifyHtlcFunding>[0]> = {}) => ({
  chainId: 42161,
  htlcAddress: ARBITRUM_HTLC,
  hashLock: LOCK,
  fundTxHash: ARBITRUM_FUND_TX,
  expectedLocktimeSec: LOCKTIME,
  expectedTokenAddress: HTLC_TOKEN,
  expectedAmountAtomic: HTLC_AMOUNT,
  expectedRefundAddress: HTLC_REFUND_ADDRESS,
  expectedClaimAddress: HTLC_CLAIM_ADDRESS,
  ...over,
});

function arbitrumChain(
  over: Partial<ChainReads> = {},
  event: { data: string; refundAddress: string; claimAddress: string } = { data: ARBITRUM_FUND_DATA, refundAddress: HTLC_REFUND_ADDRESS, claimAddress: HTLC_CLAIM_ADDRESS },
): ChainReads {
  return chain({
    getReceipt: async (_chainId, hash) =>
      hash.toLowerCase() === ARBITRUM_FUND_TX
        ? {
            status: "success" as const,
            blockNumber: ARBITRUM_BLOCK,
            blockHash: ARBITRUM_BLOCK_HASH,
            logs: [{ address: ARBITRUM_HTLC, topics: [SWAP_FUNDED_EVENT_TOPIC, LOCK, addressTopic(event.refundAddress), addressTopic(event.claimAddress)], data: event.data, logIndex: 1 }],
          }
        : null,
    getLatestBlockNumber: async () => ARBITRUM_BLOCK,
    getFinalizedBlockNumber: async () => ARBITRUM_BLOCK,
    getBlockHash: async (_chainId, blockNumber) => (blockNumber === ARBITRUM_BLOCK ? ARBITRUM_BLOCK_HASH : null),
    ...over,
  });
}

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
    setSettlementChainForTests(chain({ getLatestBlockNumber: async () => fundBlock + BigInt(CLAIM_FUNDING_MIN_CONFIRMATIONS - 1) }));
    expect((await verifyHtlcFunding(input())).verdict).toBe("VERIFIED");
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

describe("A2a Arbitrum One HTLC funding finality", () => {
  beforeEach(() => {
    vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": "https://fixture.invalid", "42161": "https://fixture.invalid" }));
    setSettlementChainForTests(arbitrumChain());
  });

  it("verifies the independently pinned v7 HTLC only after the block is finalized", async () => {
    const result = await verifyHtlcFunding(arbitrumInput());
    expect(result).toMatchObject({ verdict: "VERIFIED", confirmations: 1 });
  });

  it("does not copy Polygon's 32-confirmation rule onto Arbitrum", async () => {
    setSettlementChainForTests(arbitrumChain({ getLatestBlockNumber: async () => ARBITRUM_BLOCK, getFinalizedBlockNumber: async () => ARBITRUM_BLOCK }));
    expect((await verifyHtlcFunding(arbitrumInput())).verdict).toBe("VERIFIED");
  });

  it("rejects a finalized same-hash event with unrelated HTLC terms", async () => {
    const cases: Array<{ token?: string; amount?: bigint | number | string; refundAddress?: string; claimAddress?: string }> = [
      { token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
      { amount: BigInt(HTLC_AMOUNT) + 1n },
      { claimAddress: "0x0000000000000000000000000000000000000bad" },
    ];
    for (const terms of cases) {
      const event = {
        data: swapCreatedData(terms),
        refundAddress: terms.refundAddress ?? HTLC_REFUND_ADDRESS,
        claimAddress: terms.claimAddress ?? HTLC_CLAIM_ADDRESS,
      };
      setSettlementChainForTests(arbitrumChain({}, event));
      expect(await verifyHtlcFunding(arbitrumInput())).toMatchObject({ verdict: "INVALID" });
    }
  });

  it("uses the locked WBTC terms, not the final native-USDC route terms", async () => {
    expect(HTLC_TOKEN.toLowerCase()).not.toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(await verifyHtlcFunding(arbitrumInput())).toMatchObject({ verdict: "VERIFIED" });
  });

  it("does not guess when the provider omits HTLC identity terms", async () => {
    expect(await verifyHtlcFunding(arbitrumInput({ expectedTokenAddress: null, expectedAmountAtomic: null, expectedRefundAddress: null, expectedClaimAddress: null }))).toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("fails closed when finalized ancestry is unavailable, stale, or inconsistent", async () => {
    setSettlementChainForTests(arbitrumChain({ getFinalizedBlockNumber: async () => null }));
    expect((await verifyHtlcFunding(arbitrumInput())).verdict).toBe("INCONCLUSIVE");

    setSettlementChainForTests(arbitrumChain({ getLatestBlockNumber: async () => ARBITRUM_BLOCK + 10n, getFinalizedBlockNumber: async () => ARBITRUM_BLOCK - 1n }));
    expect((await verifyHtlcFunding(arbitrumInput())).verdict).toBe("PENDING");

    setSettlementChainForTests(arbitrumChain({ getFinalizedBlockNumber: async () => ARBITRUM_BLOCK + 1n }));
    expect((await verifyHtlcFunding(arbitrumInput())).verdict).toBe("INCONCLUSIVE");
  });

  it("does not allow a confirmation-only override or an RPC failure to authorize a claim", async () => {
    vi.stubEnv("THENCE_SETTLEMENT_FINALITY_JSON", JSON.stringify({ "42161": { mode: "confirmations", confirmations: 1 } }));
    setSettlementChainForTests(arbitrumChain({ getFinalizedBlockNumber: async () => null }));
    expect((await verifyHtlcFunding(arbitrumInput())).verdict).toBe("INCONCLUSIVE");

    setSettlementChainForTests(arbitrumChain({ getFinalizedBlockNumber: async () => { throw new Error("finality rpc 502"); } }));
    expect((await verifyHtlcFunding(arbitrumInput())).verdict).toBe("UNAVAILABLE");
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
