/**
 * Arbitrum runs two authentic Satora HTLCErc20 deployments: v7 (current) and
 * v6 (legacy, still used for some swaps). The first live Arbitrum payment
 * (2026-11-15, swap e2eb54fd…) was funded on v6 and refused FUNDING_INVALID
 * because only v7 was trusted. Deterministic fixtures; no chain contact.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SWAP_FUNDED_EVENT_TOPIC,
  TRUSTED_HTLC_CONTRACTS,
  computeHtlcSwapKey,
  isTrustedHtlc,
  setSettlementChainForTests,
  verifyHtlcFunding,
  type ChainLog,
  type ChainReads,
} from "@/lib/settlement";

const V7 = "0x6c38bf44a327bf36bfbefcedc514c0fb3fec6748";
const V6 = "0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948";
const UNKNOWN = "0x0000000000000000000000000000000000000bad";
const LOCK = `0x${"d0".repeat(32)}`;
// Live shape: the HTLC holds an 18-decimal BTC-side token, not USDC.
const TOKEN = "0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40";
const REFUND = "0x00000000000000000000000000000000000000a1";
const CLAIM = "0x00000000000000000000000000000000000000b2";
const AMOUNT = 4652143737254n;
const TIMELOCK = 1794768886;
const FUND_TX = `0x${"3e".repeat(32)}`;
const FUND_BLOCK = 1_000n;
const HEAD = 4_000n;

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const hash = (b: bigint) => `0x${b.toString(16).padStart(64, "0")}`;
const KEY = computeHtlcSwapKey({ hashLock: LOCK, amount: AMOUNT, token: TOKEN, refundAddress: REFUND, claimAddress: CLAIM, timelock: BigInt(TIMELOCK) });

function fundLog(htlc: string): ChainLog {
  return {
    address: htlc,
    topics: [SWAP_FUNDED_EVENT_TOPIC, LOCK, `0x${addrWord(REFUND)}`, `0x${addrWord(CLAIM)}`],
    data: `0x${addrWord(TOKEN)}${word(AMOUNT)}${word(TIMELOCK)}${KEY.slice(2)}`,
    logIndex: 0,
    transactionHash: FUND_TX,
  };
}

function chain(htlc: string, finalized: bigint | null = HEAD): ChainReads {
  return {
    async getTransaction() { return null; },
    async getReceipt() { return { status: "success", blockNumber: FUND_BLOCK, blockHash: hash(FUND_BLOCK), logs: [fundLog(htlc)] }; },
    async getLatestBlockNumber() { return HEAD; },
    async getFinalizedBlockNumber() { return finalized; },
    async getBlockHash(_c, n) { return hash(n); },
  };
}

const input = (htlc: string, chainId = 42161) => ({
  chainId,
  htlcAddress: htlc,
  hashLock: LOCK,
  fundTxHash: FUND_TX,
  expectedLocktimeSec: TIMELOCK,
  expectedTokenAddress: TOKEN,
  expectedAmountAtomic: AMOUNT.toString(),
  expectedRefundAddress: REFUND,
  expectedClaimAddress: CLAIM,
});

let savedRpcs: string | undefined;
beforeEach(() => {
  savedRpcs = process.env["THENCE_EVM_RPCS_JSON"];
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://polygon.example", "42161": "https://arbitrum.example" });
});
afterEach(() => {
  setSettlementChainForTests(null);
  if (savedRpcs === undefined) delete process.env["THENCE_EVM_RPCS_JSON"];
  else process.env["THENCE_EVM_RPCS_JSON"] = savedRpcs;
});

describe("Arbitrum HTLC trust list: authentic v6 and v7 only", () => {
  it("trusts exactly the two documented Arbitrum deployments and keeps Polygon unchanged", () => {
    expect([...TRUSTED_HTLC_CONTRACTS[42161]!].sort()).toEqual([V6, V7].sort());
    expect(TRUSTED_HTLC_CONTRACTS[137]).toEqual([V6]);
    expect(isTrustedHtlc(42161, V6.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isTrustedHtlc(42161, V7)).toBe(true);
    // Chain-specific identity: an address trusted on one chain is not trusted elsewhere by implication.
    expect(isTrustedHtlc(137, V7)).toBe(false);
    expect(isTrustedHtlc(1, V6)).toBe(false);
    expect(isTrustedHtlc(42161, UNKNOWN)).toBe(false);
  });

  it("verifies the live v6 funding shape once finalized (was FUNDING_INVALID)", async () => {
    setSettlementChainForTests(chain(V6));
    await expect(verifyHtlcFunding(input(V6))).resolves.toMatchObject({ verdict: "VERIFIED" });
  });

  it("keeps v6 funding PENDING until L1 finality covers it", async () => {
    setSettlementChainForTests(chain(V6, FUND_BLOCK - 1n));
    await expect(verifyHtlcFunding(input(V6))).resolves.toMatchObject({ verdict: "PENDING" });
  });

  it("still verifies v7 funding", async () => {
    setSettlementChainForTests(chain(V7));
    await expect(verifyHtlcFunding(input(V7))).resolves.toMatchObject({ verdict: "VERIFIED" });
  });

  it("refuses an unknown contract even with a perfect fund event", async () => {
    setSettlementChainForTests(chain(UNKNOWN));
    await expect(verifyHtlcFunding(input(UNKNOWN))).resolves.toMatchObject({ verdict: "INVALID", reason: expect.stringMatching(/outside the pinned trust list/) });
  });

  it("refuses a v6 fund event whose SwapKey or terms differ", async () => {
    setSettlementChainForTests(chain(V6));
    await expect(verifyHtlcFunding({ ...input(V6), expectedAmountAtomic: (AMOUNT + 1n).toString() })).resolves.toMatchObject({ verdict: "INVALID" });
    await expect(verifyHtlcFunding({ ...input(V6), expectedClaimAddress: REFUND })).resolves.toMatchObject({ verdict: "INVALID" });
  });

  it("refuses when the event came from the other trusted contract than the provider named", async () => {
    setSettlementChainForTests(chain(V7));
    await expect(verifyHtlcFunding(input(V6))).resolves.toMatchObject({ verdict: "INVALID" });
  });
});
