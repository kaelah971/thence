import { createPublicClient, createWalletClient, decodeFunctionData, decodeEventLog, encodeFunctionData, erc20Abi, http, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { deskConfig } from "./config";
import { assertPayout, DeskError, POLYGON_USDC } from "./policy";
import type { DeskOrder } from "./store";

export function deskEvm() {
  const { rpc } = deskConfig();
  return createPublicClient({ chain: polygon, transport: http(rpc, { timeout: 8000, retryCount: 0 }) });
}
/** Fail before requesting customer NIM when the operator cannot sign its payout. */
export function assertDeskSigner(payoutWallet: string) {
  const key = process.env["THENCE_DESK_POLYGON_PRIVATE_KEY"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new DeskError("SIGNER_NOT_CONFIGURED", "Payout signer is not configured.", 503);
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== payoutWallet.toLowerCase()) throw new DeskError("SIGNER_MISMATCH", "Payout signer does not match the dedicated wallet.", 503);
  return account;
}
export async function deskBalances() {
  const config = deskConfig(), client = deskEvm();
  if (await client.getChainId() !== 137) throw new DeskError("WRONG_CHAIN", "Polygon RPC returned a different chain.", 503);
  const block = await client.getBlock({ blockTag: "finalized" });
  if (Date.now() - Number(block.timestamp) * 1000 > 300_000) throw new DeskError("STALE_CHAIN", "Polygon finality is unavailable.", 503);
  const [usdc, pol] = await Promise.all([
    client.readContract({ address: POLYGON_USDC, abi: erc20Abi, functionName: "balanceOf", args: [config.polygonAddress], blockNumber: block.number }),
    client.getBalance({ address: config.polygonAddress, blockNumber: block.number }),
  ]);
  if (pol < 50_000_000_000_000_000n) throw new DeskError("GAS_LOW", "The payment wallet needs network gas.", 503);
  return { usdc, pol, blockNumber: block.number };
}
export async function validateSignedDeskPayout(order: DeskOrder, raw: Hex) {
  const tx = parseTransaction(raw), decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data ?? "0x" });
  if (decoded.functionName !== "transfer" || tx.type !== "eip1559" || tx.gas === undefined || tx.gas > 150000n || (tx.maxFeePerGas ?? 0n) > 1_000_000_000_000n) throw new DeskError("PAYOUT_MISMATCH", "Invalid saved payout.", 503);
  const [recipient, amount] = decoded.args;
  assertPayout({ chainId: tx.chainId ?? 0, to: tx.to ?? "", value: tx.value ?? 0n, nonce: tx.nonce ?? -1, recipient, amount },
    { chainId: 137, to: POLYGON_USDC, value: 0n, nonce: Number(order.payout_nonce), recipient: order.payload.recipient, amount: BigInt(order.amount_atomic) });
  if ((await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toLowerCase() !== order.payout_wallet.toLowerCase() || (order.payout_hash && keccak256(raw) !== order.payout_hash)) throw new DeskError("PAYOUT_MISMATCH", "Invalid payout signer.", 503);
}
export async function signDeskPayout(order: DeskOrder, nonce: number) {
  const account = assertDeskSigner(order.payout_wallet);
  const config = deskConfig(), client = deskEvm();
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [order.payload.recipient, BigInt(order.amount_atomic)] });
  const gas = await client.estimateGas({ account, to: POLYGON_USDC, data, value: 0n });
  const fees = await client.estimateFeesPerGas();
  if (gas > 100000n || fees.maxFeePerGas > 1_000_000_000_000n) throw new DeskError("GAS_HIGH", "Delivery is waiting for affordable gas.", 503);
  const wallet = createWalletClient({ account, chain: polygon, transport: http(config.rpc) });
  const raw = await wallet.signTransaction({ chain: polygon, type: "eip1559", to: POLYGON_USDC, value: 0n, data, nonce, gas: gas * 120n / 100n, ...fees });
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
  const client = deskEvm();
  if (await client.getChainId() !== 137) throw new DeskError("WRONG_CHAIN", "Invalid Polygon network.", 503);
  const receipt = await client.getTransactionReceipt({ hash: order.payout_hash }).catch(() => null);
  if (!receipt) return { outcome: "pending" };
  const block = await client.getBlock({ blockTag: "finalized" });
  if (Date.now() - Number(block.timestamp) * 1000 > 300000) throw new DeskError("STALE_CHAIN", "Polygon finality is unavailable.", 503);
  if (receipt.blockNumber > block.number) return { outcome: "pending" };
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash) return { outcome: "pending" };
  if (receipt.status === "reverted") return { outcome: "reverted" };
  const matched = receipt.logs.filter(log => {
    if (log.address.toLowerCase() !== POLYGON_USDC.toLowerCase()) return false;
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
