import { arbitrum, base, polygon } from "viem/chains";
import { DeskError, ARBITRUM_USDC, BASE_USDC, POLYGON_USDC } from "./policy";
import { deskConfig } from "./config";

/**
 * Chains the treasury desk can pay out on. Both are paid by the same signer
 * wallet; only the RPC, native USDC contract and gas asset differ.
 */
export type DeskChain = "polygon" | "arbitrum" | "base";

export interface DeskChainConfig {
  name: DeskChain;
  label: string;
  chainId: 137 | 42161 | 8453;
  usdc: `0x${string}`;
  rpc: string;
  chain: typeof polygon | typeof arbitrum | typeof base;
  /** Native asset symbol, for messages only. */
  gasSymbol: "POL" | "ETH";
  /** Refuse new quotes below this gas balance; a payout must be broadcastable. */
  gasFloor: bigint;
  /**
   * How old a `finalized` block may be. Polygon finalizes in seconds; Arbitrum's
   * finalized tag follows Ethereum's checkpoint and routinely lags 15-20 min, so
   * a 5-minute rule would reject a perfectly healthy node.
   */
  finalityLagMs: number;
}

export const DESK_CHAINS: DeskChain[] = ["polygon", "arbitrum", "base"];

export function isDeskChain(value: unknown): value is DeskChain {
  return value === "polygon" || value === "arbitrum" || value === "base";
}

export function deskChainConfig(name: DeskChain): DeskChainConfig {
  if (name === "base") {
    const rpc = process.env["THENCE_DESK_BASE_RPC"] ?? "";
    if (!/^https:\/\//.test(rpc)) throw new DeskError("DESK_NOT_CONFIGURED", "The Base payout RPC is not configured.", 503);
    // Base is an L2: a transfer costs ~0.000005 ETH, so 0.00005 allows several
    // payouts without refusing a wallet that can clearly pay.
    return { name, label: "Base", chainId: 8453, usdc: BASE_USDC, rpc, chain: base, gasSymbol: "ETH", gasFloor: 50_000_000_000_000n, finalityLagMs: 3_600_000 };
  }
  if (name === "arbitrum") {
    const rpc = process.env["THENCE_DESK_ARBITRUM_RPC"] ?? "";
    if (!/^https:\/\//.test(rpc)) throw new DeskError("DESK_NOT_CONFIGURED", "The Arbitrum payout RPC is not configured.", 503);
    // An ERC20 transfer costs ~0.00002 ETH on Arbitrum; 0.0001 allows a few
    // payouts without letting an empty wallet queue work it cannot broadcast.
    return { name, label: "Arbitrum", chainId: 42161, usdc: ARBITRUM_USDC, rpc, chain: arbitrum, gasSymbol: "ETH", gasFloor: 100_000_000_000_000n, finalityLagMs: 3_600_000 };
  }
  // Polygon reuses the validated desk config so there is one source of truth.
  const rpc = deskConfig().rpc;
  if (!/^https:\/\//.test(rpc)) throw new DeskError("DESK_NOT_CONFIGURED", "The Polygon payout RPC is not configured.", 503);
  return { name, label: "Polygon", chainId: 137, usdc: POLYGON_USDC, rpc, chain: polygon, gasSymbol: "POL", gasFloor: 50_000_000_000_000_000n, finalityLagMs: 300_000 };
}
