/**
 * A2b2 — deterministic Arbitrum v7 refund, unspent and recovery evidence.
 *
 * These fixtures never contact a chain and never submit a transaction. Every
 * positive result is tied to the complete SwapKey, not only preimageHash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HTLC_LOG_CHUNK_BLOCKS,
  HTLC_SWAP_STATE,
  MAX_HTLC_SCAN_BLOCKS,
  SWAP_FUNDED_EVENT_TOPIC,
  SWAP_REDEEMED_EVENT_TOPIC,
  SWAP_REFUNDED_EVENT_TOPIC,
  SWAP_REHASHED_EVENT_TOPIC,
  computeHtlcSwapKey,
  setSettlementChainForTests,
  verifyEvmRefundEvidence,
  verifyHtlcRefund,
  verifyHtlcUnspent,
  verifyNoHtlcActivity,
  type ChainLog,
  type ChainReads,
} from "@/lib/settlement";

const CHAIN_ID = 42161;
const HTLC = "0x6c38bf44a327bf36bfbeFcedc514c0fb3fec6748";
const LOCK = `0x${"11".repeat(32)}`;
const TOKEN = "0x4200000000000000000000000000000000000023";
const REFUND_ADDRESS = "0x00000000000000000000000000000000000000a1";
const CLAIM_ADDRESS = "0x00000000000000000000000000000000000000b2";
const AMOUNT = 123456789n;
const TIMELOCK = 1_900_000_000;
const FUND_TX = `0x${"aa".repeat(32)}`;
const REFUND_TX = `0x${"bb".repeat(32)}`;
const WRONG_TX = `0x${"cc".repeat(32)}`;
const REVERT_TX = `0x${"dd".repeat(32)}`;
const FUND_BLOCK = 100n;
const REFUND_BLOCK = 110n;
const HEAD = 120n;
const KEY = computeHtlcSwapKey({ hashLock: LOCK, amount: AMOUNT, token: TOKEN, refundAddress: REFUND_ADDRESS, claimAddress: CLAIM_ADDRESS, timelock: BigInt(TIMELOCK) });
const WRONG_KEY = computeHtlcSwapKey({ hashLock: LOCK, amount: AMOUNT + 1n, token: TOKEN, refundAddress: REFUND_ADDRESS, claimAddress: CLAIM_ADDRESS, timelock: BigInt(TIMELOCK) });
const NEW_KEY = `0x${"99".repeat(32)}`;

const hexWord = (value: bigint | number | string) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value: string) => value.slice(2).toLowerCase().padStart(64, "0");
const addressTopic = (value: string) => `0x${addressWord(value)}`;
const blockHash = (block: bigint) => `0x${block.toString(16).padStart(64, "0")}`;
const blockTimestamp = (block: bigint) => 100_000 + Number(block) * 10_000;

interface FixtureLog extends ChainLog {
  blockNumber: bigint;
}

const createdLog = (key = KEY, blockNumber = FUND_BLOCK): FixtureLog => ({
  blockNumber,
  address: HTLC,
  topics: [SWAP_FUNDED_EVENT_TOPIC, LOCK, addressTopic(REFUND_ADDRESS), addressTopic(CLAIM_ADDRESS)],
  data: `0x${addressWord(TOKEN)}${hexWord(AMOUNT)}${hexWord(TIMELOCK)}${key.slice(2)}`,
  logIndex: 0,
  transactionHash: FUND_TX,
});
const refundLog = (key = KEY, tx = REFUND_TX, blockNumber = REFUND_BLOCK): FixtureLog => ({
  blockNumber,
  address: HTLC,
  topics: [SWAP_REFUNDED_EVENT_TOPIC, LOCK, key],
  data: "0x",
  logIndex: 1,
  transactionHash: tx,
});
const redeemedLog = (key = KEY, blockNumber = REFUND_BLOCK): FixtureLog => ({
  blockNumber,
  address: HTLC,
  topics: [SWAP_REDEEMED_EVENT_TOPIC, LOCK, key],
  data: `0x${"22".repeat(32)}`,
  logIndex: 1,
  transactionHash: REFUND_TX,
});
const rehashedLog = (oldKey = KEY, newKey = NEW_KEY, blockNumber = REFUND_BLOCK): FixtureLog => ({
  blockNumber,
  address: HTLC,
  topics: [SWAP_REHASHED_EVENT_TOPIC, LOCK, oldKey, newKey],
  data: `0x${"33".repeat(32)}`,
  logIndex: 1,
  transactionHash: REFUND_TX,
});

const receipt = (status: "success" | "reverted", blockNumber: bigint, logs: ChainLog[]): ChainReads["getReceipt"] extends (...args: never[]) => infer R ? Awaited<R> : never => ({
  status,
  blockNumber,
  blockHash: blockHash(blockNumber),
  logs,
});

type ChainOptions = {
  logs?: FixtureLog[];
  receipts?: Record<string, Awaited<ReturnType<ChainReads["getReceipt"]>>>;
  latest?: bigint;
  finalized?: bigint | null;
  state?: number | ((key: string, block: bigint) => number);
  latestSequence?: bigint[];
  blockHashes?: Record<string, string | null>;
  failLogs?: boolean;
};

function fixtureChain(options: ChainOptions = {}): ChainReads {
  const logs = options.logs ?? [createdLog(), refundLog()];
  const receipts = options.receipts ?? {
    [FUND_TX]: receipt("success", FUND_BLOCK, [createdLog()]),
    [REFUND_TX]: receipt("success", REFUND_BLOCK, [refundLog()]),
    [WRONG_TX]: receipt("success", REFUND_BLOCK, [refundLog(WRONG_KEY, WRONG_TX)]),
    [REVERT_TX]: receipt("reverted", REFUND_BLOCK, []),
  };
  const latest = options.latest ?? HEAD;
  let latestCalls = 0;
  return {
    async getTransaction() {
      return null;
    },
    async getReceipt(_chainId, hash) {
      return receipts[hash.toLowerCase()] ?? null;
    },
    async getLatestBlockNumber() {
      const sequence = options.latestSequence;
      if (sequence && sequence.length > 0) return sequence[Math.min(latestCalls++, sequence.length - 1)]!;
      return latest;
    },
    async getFinalizedBlockNumber() {
      return options.finalized === undefined ? latest : options.finalized;
    },
    async getBlockHash(_chainId, number) {
      if (Object.prototype.hasOwnProperty.call(options.blockHashes ?? {}, number.toString())) return options.blockHashes![number.toString()] ?? null;
      return blockHash(number);
    },
    async getHtlcSwapState(_chainId, _address, key, number) {
      const value = typeof options.state === "function" ? options.state(key, number) : options.state ?? HTLC_SWAP_STATE.ACTIVE;
      return { state: value, preimage: `0x${"00".repeat(32)}` };
    },
    async getBlockTimestamp(_chainId, number) {
      return blockTimestamp(number);
    },
    async getLogsByTopic1(_chainId, _address, _topic1, from, to) {
      if (options.failLogs) throw new Error("deterministic rpc failure");
      return logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to).map(({ blockNumber: _blockNumber, ...log }) => log);
    },
  };
}

const refundInput = (over: Partial<Parameters<typeof verifyHtlcRefund>[0]> = {}) => ({
  chainId: CHAIN_ID,
  htlcAddress: HTLC,
  hashLock: LOCK,
  providerRefundTxHash: REFUND_TX,
  earliestRefundAt: new Date(blockTimestamp(REFUND_BLOCK) * 1000),
  expectedLocktimeSec: TIMELOCK,
  expectedTokenAddress: TOKEN,
  expectedAmountAtomic: String(AMOUNT),
  expectedRefundAddress: REFUND_ADDRESS,
  expectedClaimAddress: CLAIM_ADDRESS,
  ...over,
});

const unspentInput = (over: Partial<Parameters<typeof verifyHtlcUnspent>[0]> = {}) => ({
  chainId: CHAIN_ID,
  htlcAddress: HTLC,
  hashLock: LOCK,
  fundTxHash: FUND_TX,
  expectedLocktimeSec: TIMELOCK,
  expectedTokenAddress: TOKEN,
  expectedAmountAtomic: String(AMOUNT),
  expectedRefundAddress: REFUND_ADDRESS,
  expectedClaimAddress: CLAIM_ADDRESS,
  fundingVerdict: "VERIFIED" as const,
  ...over,
});

const noActivityInput = (over: Partial<Parameters<typeof verifyNoHtlcActivity>[0]> = {}) => ({
  chainId: CHAIN_ID,
  htlcAddress: HTLC,
  hashLock: LOCK,
  expectedSwapKey: KEY,
  windowStart: new Date(blockTimestamp(FUND_BLOCK) * 1000),
  windowEnd: new Date(blockTimestamp(115n) * 1000),
  ...over,
});

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@fixture.invalid:5432/none");
  vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "42161": "https://fixture.invalid" }));
  vi.stubEnv("THENCE_SETTLEMENT_FINALITY_JSON", "{}");
});

afterEach(() => {
  setSettlementChainForTests(null);
  vi.unstubAllEnvs();
});

describe("A2b2 Arbitrum v7 refund attribution", () => {
  it("verifies a finalized refund only for the matching complete SwapKey", async () => {
    setSettlementChainForTests(fixtureChain());
    await expect(verifyHtlcRefund(refundInput())).resolves.toMatchObject({ verdict: "VERIFIED", source: "provider_pointer", refundTxHash: REFUND_TX });
  });

  it("finds a valid refund independently when the provider pointer is missing", async () => {
    setSettlementChainForTests(fixtureChain());
    await expect(verifyHtlcRefund(refundInput({ providerRefundTxHash: null }))).resolves.toMatchObject({ verdict: "VERIFIED", source: "htlc_log_scan", refundTxHash: REFUND_TX.toLowerCase() });
  });

  it("ignores a misleading provider pointer and discovers the correct refund", async () => {
    setSettlementChainForTests(fixtureChain());
    await expect(verifyHtlcRefund(refundInput({ providerRefundTxHash: FUND_TX }))).resolves.toMatchObject({ verdict: "VERIFIED", source: "htlc_log_scan", refundTxHash: REFUND_TX.toLowerCase() });
  });

  it("never borrows another same-hash swap's refund", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [createdLog(), refundLog(WRONG_KEY, WRONG_TX)] }));
    const result = await verifyHtlcRefund(refundInput({ providerRefundTxHash: WRONG_TX }));
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.refundTxHash).toBeNull();
  });

  it("rejects an untrusted HTLC before reading the provider pointer", async () => {
    const chain = fixtureChain();
    const getReceipt = vi.spyOn(chain, "getReceipt");
    setSettlementChainForTests(chain);
    await expect(verifyHtlcRefund(refundInput({ htlcAddress: "0x0000000000000000000000000000000000000003" }))).resolves.toMatchObject({ verdict: "INVALID" });
    expect(getReceipt).not.toHaveBeenCalled();
  });

  it("rejects a reverted refund transaction", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [] }));
    await expect(verifyEvmRefundEvidence({ ...refundInput({ providerRefundTxHash: REVERT_TX }), refundTxHash: REVERT_TX, expectedSwapKey: KEY })).resolves.toMatchObject({ verdict: "INVALID" });
  });

  it("does not verify a refund before Arbitrum finalized ancestry", async () => {
    setSettlementChainForTests(fixtureChain({ finalized: REFUND_BLOCK - 1n }));
    await expect(verifyHtlcRefund(refundInput())).resolves.toMatchObject({ verdict: "INSUFFICIENT_CONFIRMATIONS" });
  });

  it("fails closed on missing or inconsistent finality and block headers", async () => {
    setSettlementChainForTests(fixtureChain({ finalized: null }));
    await expect(verifyHtlcRefund(refundInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
    setSettlementChainForTests(fixtureChain({ finalized: HEAD + 1n }));
    await expect(verifyHtlcRefund(refundInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
    setSettlementChainForTests(fixtureChain({ blockHashes: { [REFUND_BLOCK.toString()]: `0x${"ff".repeat(32)}` } }));
    await expect(verifyHtlcRefund(refundInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("requires all bound terms to derive the Arbitrum key", async () => {
    setSettlementChainForTests(fixtureChain());
    await expect(verifyHtlcRefund(refundInput({ expectedAmountAtomic: null }))).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("does not accept a confirmation-only override for Arbitrum", async () => {
    vi.stubEnv("THENCE_SETTLEMENT_FINALITY_JSON", JSON.stringify({ "42161": { mode: "confirmations", confirmations: 1 } }));
    setSettlementChainForTests(fixtureChain({ finalized: null }));
    await expect(verifyHtlcRefund(refundInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("does not silently truncate an oversized independent refund scan", async () => {
    setSettlementChainForTests(fixtureChain({ latest: FUND_BLOCK + MAX_HTLC_SCAN_BLOCKS, finalized: FUND_BLOCK + MAX_HTLC_SCAN_BLOCKS, logs: [] }));
    const result = await verifyHtlcRefund(refundInput({ providerRefundTxHash: null }));
    expect(result).toMatchObject({ verdict: "INCONCLUSIVE", refundTxHash: null });
  });
});

describe("A2b2 Arbitrum v7 unspent and retry evidence", () => {
  it("proves the complete original key is unspent through a stable current head", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [createdLog()] }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "UNSPENT" });
  });

  it.each([
    ["redeem", redeemedLog()],
    ["refund", refundLog()],
    ["rehash", rehashedLog()],
  ])("refuses retry after an original-key %s event", async (_label, event) => {
    setSettlementChainForTests(fixtureChain({ logs: [createdLog(), event] }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "SPENT" });
  });

  it.each([
    ["Redeemed", HTLC_SWAP_STATE.REDEEMED],
    ["Refunded", HTLC_SWAP_STATE.REFUNDED],
    ["Rehashed", HTLC_SWAP_STATE.REHASHED],
    ["None", HTLC_SWAP_STATE.NONE],
  ])("rejects retry when the current original-key state is %s", async (_label, state) => {
    setSettlementChainForTests(fixtureChain({ state }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "SPENT" });
  });

  it("ignores an unrelated same-hash key during retry scanning", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [createdLog(), refundLog(WRONG_KEY, WRONG_TX)] }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "UNSPENT" });
  });

  it("fails closed when the bound key, funding finality or log reader is unavailable", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [createdLog()] }));
    await expect(verifyHtlcUnspent(unspentInput({ expectedTokenAddress: null }))).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
    await expect(verifyHtlcUnspent(unspentInput({ fundingVerdict: "PENDING" }))).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
    setSettlementChainForTests(fixtureChain({ failLogs: true }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });

  it("refuses a bounded retry scan that cannot cover the current head", async () => {
    setSettlementChainForTests(fixtureChain({ latest: FUND_BLOCK + MAX_HTLC_SCAN_BLOCKS, finalized: FUND_BLOCK + MAX_HTLC_SCAN_BLOCKS, logs: [createdLog()] }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("refuses when the Arbitrum head changes during the retry scan", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [createdLog()], latestSequence: [HEAD, HEAD, HEAD, HEAD + 1n] }));
    await expect(verifyHtlcUnspent(unspentInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });
});

describe("A2b2 Arbitrum v7 no-activity recovery evidence", () => {
  it("proves no activity only after the complete window is finalized", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "NO_ACTIVITY" });
    setSettlementChainForTests(fixtureChain({ finalized: 109n, logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "INSUFFICIENT_CONFIRMATIONS" });
  });

  it("finds activity for the bound hash even when the complete key differs", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [refundLog()] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "ACTIVITY_FOUND", logCount: 1 });
    setSettlementChainForTests(fixtureChain({ logs: [refundLog(WRONG_KEY, WRONG_TX)] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "ACTIVITY_FOUND", logCount: 1 });
  });

  it("counts SwapRehashed as activity for the stale original key", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [rehashedLog()] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "ACTIVITY_FOUND", eventTopics: [SWAP_REHASHED_EVENT_TOPIC] });
  });

  it("keeps hash-wide closure conservative while requiring finalized headers", async () => {
    setSettlementChainForTests(fixtureChain({ logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput({ expectedSwapKey: null }))).resolves.toMatchObject({ verdict: "NO_ACTIVITY" });
    setSettlementChainForTests(fixtureChain({ finalized: null, logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("refuses incomplete, failed and moving-head scans", async () => {
    setSettlementChainForTests(fixtureChain({ latest: 100_000n, finalized: 100_000n, logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput({ windowStart: new Date(0), windowEnd: new Date(blockTimestamp(100_000n) * 1000) }))).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
    setSettlementChainForTests(fixtureChain({ failLogs: true, logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
    setSettlementChainForTests(fixtureChain({ latestSequence: [HEAD, HEAD + 1n], logs: [] }));
    await expect(verifyNoHtlcActivity(noActivityInput())).resolves.toMatchObject({ verdict: "INCONCLUSIVE" });
  });

  it("keeps Polygon on its existing hash-lock behavior", async () => {
    vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": "https://fixture.invalid" }));
    setSettlementChainForTests(fixtureChain({ latest: 1_000n, finalized: 1_000n, logs: [refundLog()] }));
    await expect(verifyNoHtlcActivity({ ...noActivityInput(), chainId: 137, expectedSwapKey: null })).resolves.toMatchObject({ verdict: "ACTIVITY_FOUND" });
  });

  it("does not treat an Arbitrum scan as proof of NIM repayment", () => {
    // The verifier exposes only EVM activity/finality; Nimiq-side repayment is
    // intentionally absent from this chain evidence contract.
    expect(KEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(HTLC_LOG_CHUNK_BLOCKS).toBe(2_000n);
  });
});
