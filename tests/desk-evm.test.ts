import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deskPayoutResult, validateSignedDeskPayout } from "@/lib/desk/evm";
import { POLYGON_USDC } from "@/lib/desk/policy";
import type { DeskOrder } from "@/lib/desk/store";

const rpc = vi.hoisted(() => ({ chain: 137, finalized: 20n, blockHash: `0x${"ab".repeat(32)}`, receipt: null as unknown }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({
  getChainId: async () => rpc.chain,
  getTransactionReceipt: async () => rpc.receipt,
  getBlock: async () => ({ number: rpc.finalized, hash: rpc.blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
}) }));
vi.mock("@/lib/desk/config", () => ({ deskConfig: () => ({ rpc: "https://polygon.test" }) }));
// Published test-only key. Never funded; no network signing/broadcast occurs.
const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const recipient = "0x1111111111111111111111111111111111111111";
const order = { payout_wallet: signer.address, amount_atomic: "300000", payout_nonce: "2", payload: { recipient } } as unknown as DeskOrder;
const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 300000n] });
async function raw(overrides = {}) {
  return signer.signTransaction({ chainId: 137, type: "eip1559", to: POLYGON_USDC, value: 0n, gas: 80000n, maxFeePerGas: 100000000000n, maxPriorityFeePerGas: 1000000000n, nonce: 2, data, ...overrides });
}
afterEach(() => { rpc.chain = 137; rpc.finalized = 20n; rpc.receipt = null; });
describe("treasury payout evidence", () => {
  it("validates saved signed bytes against immutable order terms", async () => {
    const signed = await raw();
    await expect(validateSignedDeskPayout({ ...order, payout_hash: keccak256(signed) }, signed)).resolves.toBeUndefined();
  });
  it.each([{ chainId: 1 }, { nonce: 3 }, { value: 1n }, { to: recipient }, { gas: 200000n }, { data: "0x" as Hex }])("refuses changed signed payout case %#", async terms => {
    await expect(validateSignedDeskPayout(order, await raw(terms))).rejects.toThrow();
  });
  it("does not declare delivery without a finalized exact Transfer event", async () => {
    const hash = keccak256(await raw());
    const expected = { ...order, payout_hash: hash };
    expect(await deskPayoutResult(expected)).toBe("pending");
    const receipt = { transactionHash: hash, blockNumber: 21n, blockHash: rpc.blockHash, status: "success", logs: [{ address: POLYGON_USDC, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: signer.address, to: recipient } }), data: encodeAbiParameters([{ type: "uint256" }], [300000n]) }] };
    rpc.receipt = receipt;
    expect(await deskPayoutResult(expected)).toBe("pending");
    rpc.finalized = 21n;
    expect(await deskPayoutResult(expected)).toBe("delivered");
    rpc.receipt = { ...receipt, logs: [] }; expect(await deskPayoutResult(expected)).toBe("mismatch");
    rpc.receipt = { ...receipt, status: "reverted" }; expect(await deskPayoutResult(expected)).toBe("reverted");
    rpc.chain = 1; await expect(deskPayoutResult(expected)).rejects.toMatchObject({ code: "WRONG_CHAIN" });
  });
});
