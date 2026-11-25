import { createPublicClient, createWalletClient, decodeFunctionData, decodeEventLog, encodeFunctionData, erc20Abi, http, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deskChainConfig, type DeskChain } from "./chains";
import { assertPayout, DeskError } from "./policy";
import type { DeskOrder } from "./store";

export function deskEvm(chain: DeskChain) {
  const { rpc, chain: viemChain } = deskChainConfig(chain);
  return createPublicClient({ chain: viemChain, transport: http(rpc, { timeout: 8000, retryCount: 0 }) });
}
/** Fail before requesting customer NIM when the operator cannot sign its payout. */
export function assertDeskSigner(payoutWallet: string) {
  const key = process.env["THENCE_DESK_POLYGON_PRIVATE_KEY"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new DeskError("SIGNER_NOT_CONFIGURED", "Payout signer is not configured.", 503);
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== payoutWallet.toLowerCase()) throw new DeskError("SIGNER_MISMATCH", "Payout signer does not match the dedicated wallet.", 503);
  return account;
}
export async function deskBalances(chain: DeskChain, wallet: string) {
  const config = deskChainConfig(chain), client = deskEvm(chain);
  if (await client.getChainId() !== config.chainId) throw new DeskError("WRONG_CHAIN", `${config.label} RPC returned a different chain.`, 503);
  const block = await client.getBlock({ blockTag: "finalized" });
  if (Date.now() - Number(block.timestamp) * 1000 > config.finalityLagMs) throw new DeskError("STALE_CHAIN", `${config.label} finality is unavailable.`, 503);
  const [usdc, gas, usdcLive] = await Promise.all([
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet as `0x${string}`], blockNumber: block.number }),
    client.getBalance({ address: wallet as `0x${string}`, blockNumber: block.number }),
    // Latest (unfinalized) balance: a deposit that arrived minutes ago is
    // real but not yet spendable, and the error must say so.
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet as `0x${string}`] }).catch(() => 0n),
  ]);
  if (gas < config.gasFloor) throw new DeskError("GAS_LOW", `The treasury needs ${config.gasSymbol} on ${config.label} before it can pay out.`, 503);
  return { usdc, gas, usdcLive: usdcLive > usdc ? usdcLive : usdc, blockNumber: block.number };
}
export async function validateSignedDeskPayout(order: DeskOrder, raw: Hex) {
  const tx = parseTransaction(raw), decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data ?? "0x" });
  if (decoded.functionName !== "transfer" || tx.type !== "eip1559" || tx.gas === undefined || tx.gas > 150000n || (tx.maxFeePerGas ?? 0n) > 1_000_000_000_000n) throw new DeskError("PAYOUT_MISMATCH", "Invalid saved payout.", 503);
  const [recipient, amount] = decoded.args;
  const chain = deskChainConfig(order.payload.chain);
  assertPayout({ chainId: tx.chainId ?? 0, to: tx.to ?? "", value: tx.value ?? 0n, nonce: tx.nonce ?? -1, recipient, amount },
    { chainId: chain.chainId, to: chain.usdc, value: 0n, nonce: Number(order.payout_nonce), recipient: order.payload.recipient, amount: BigInt(order.amount_atomic) });
  if ((await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toLowerCase() !== order.payout_wallet.toLowerCase() || (order.payout_hash && keccak256(raw) !== order.payout_hash)) throw new DeskError("PAYOUT_MISMATCH", "Invalid payout signer.", 503);
}
export async function signDeskPayout(order: DeskOrder, nonce: number) {
  const account = assertDeskSigner(order.payout_wallet);
  const chain = deskChainConfig(order.payload.chain), client = deskEvm(order.payload.chain);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [order.payload.recipient, BigInt(order.amount_atomic)] });
  const gas = await client.estimateGas({ account, to: chain.usdc, data, value: 0n });
  const fees = await client.estimateFeesPerGas();
  if (gas > 100000n || fees.maxFeePerGas > 1_000_000_000_000n) throw new DeskError("GAS_HIGH", "Delivery is waiting for affordable gas.", 503);
  const wallet = createWalletClient({ account, chain: chain.chain, transport: http(chain.rpc) });
  const raw = await wallet.signTransaction({ chain: chain.chain, type: "eip1559", to: chain.usdc, value: 0n, data, nonce, gas: gas * 120n / 100n, ...fees });
  await validateSignedDeskPayout({ ...order, payout_nonce: String(nonce) }, raw);
  return { raw, hash: keccak256(raw) };
}
/** Receipt evidence must be finalized; success also requires the exact USDC Transfer log. */
export interface DeskPayoutEvidence {
  outcome: "pending" | "delivered" | "reverted" | "mismatch";
  blockNumber?: number;
  blockHash?: string;
  logIndexes?: number[];
}
/**
 * Finality-checked payout receipt. The evidence fields exist only for a
 * delivered payout and are what the public proof records.
 */
export async function deskPayoutEvidence(order: DeskOrder): Promise<DeskPayoutEvidence> {
  if (!order.payout_hash) return { outcome: "pending" };
  const chain = deskChainConfig(order.payload.chain), client = deskEvm(order.payload.chain);
  if (await client.getChainId() !== chain.chainId) throw new DeskError("WRONG_CHAIN", `Invalid ${chain.label} network.`, 503);
  const receipt = await client.getTransactionReceipt({ hash: order.payout_hash }).catch(() => null);
  if (!receipt) return { outcome: "pending" };
  const block = await client.getBlock({ blockTag: "finalized" });
  if (Date.now() - Number(block.timestamp) * 1000 > chain.finalityLagMs) throw new DeskError("STALE_CHAIN", `${chain.label} finality is unavailable.`, 503);
  if (receipt.blockNumber > block.number) return { outcome: "pending" };
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash) return { outcome: "pending" };
  if (receipt.status === "reverted") return { outcome: "reverted" };
  const matched = receipt.logs.filter(log => {
    if (log.address.toLowerCase() !== chain.usdc.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" && event.args.from.toLowerCase() === order.payout_wallet.toLowerCase() && event.args.to.toLowerCase() === order.payload.recipient.toLowerCase() && event.args.value === BigInt(order.amount_atomic);
    } catch { return false; }
  });
  if (matched.length === 0) return { outcome: "mismatch" };
  return {
    outcome: "delivered",
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    logIndexes: matched.map(log => log.logIndex ?? 0),
  };
}
export async function deskPayoutResult(order: DeskOrder): Promise<"pending" | "delivered" | "reverted" | "mismatch"> {
  return (await deskPayoutEvidence(order)).outcome;
}
