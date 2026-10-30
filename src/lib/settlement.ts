/**
 * Thence backend — read-only EVM settlement verification (B4.4).
 *
 * This module NEVER moves funds, signs, broadcasts, claims, or refunds.
 * It independently verifies that the provider's claimed settlement actually
 * credited the intended recipient on-chain, and only then allows DELIVERED.
 *
 * Trust model (verified against @satora/swap 1.7.2 + lendaswap-sdk-pure):
 * - Lightning→EVM flow: user pays the BOLT11 hold invoice, the server funds
 *   an HTLCErc20 lock, the user's client claims via the HTLCCoordinator
 *   (`redeemAndExecute`), which sweeps tokens to `target_evm_address`.
 * - `evm_claim_txid` is a provider ASSERTION naming the claim transaction.
 *   `clientredeemed`/`serverredeemed` (or a claim API response) prove that a
 *   claim was submitted/confirmed — they do NOT prove the destination
 *   wallet received the tokens. Only matching ERC20 Transfer events in the
 *   verified claim receipt constitute destination proof.
 * - The coordinator may emit several Transfer logs for one settlement
 *   (lock → coordinator → destination legs). All logs in the verified
 *   receipt with (token == canonical) AND (to == destination) are summed;
 *   unrelated token movements are ignored, never counted.
 */
import { and, eq } from "drizzle-orm";
import { createPublicClient, http } from "viem";
import { arbitrum, mainnet, polygon } from "viem/chains";
import type { Hex, PublicClient } from "viem";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { transferProofs, transfers, swapAttachments } from "@/db/schema";
import { transition } from "@/domain/transfers";
import type { TransferStatus } from "@/domain/transfers";
import { getProviderSwap, resolveRoute } from "@/lib/satora";
import { lockTransfer } from "@/lib/handoff";
import { getEnv } from "@/lib/env";

/** ERC20 Transfer(address,address,uint256) event topic (protocol constant). */
export const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

type Db = ReturnType<typeof getDb>;

/** Chains with settlement verification support in this slice. */
export const SETTLEMENT_CHAINS = {
  1: { name: "Ethereum", chain: mainnet, explorer: "https://etherscan.io" },
  137: { name: "Polygon", chain: polygon, explorer: "https://polygonscan.com" },
  42161: { name: "Arbitrum", chain: arbitrum, explorer: "https://arbiscan.io" },
} as const;

export type SettlementChainId = keyof typeof SETTLEMENT_CHAINS;

/** Documented default finality policy per chain (overridable via env). */
export const DEFAULT_FINALITY_POLICY: Record<number, { mode: "finalized" | "confirmations"; confirmations: number }> = {
  // Ethereum: only L1-finalized blocks count. Confirmation counts are not finality.
  1: { mode: "finalized", confirmations: 1 },
  // Polygon (Bor): no trustworthy `finalized` tag; checkpoints to Ethereum
  // land roughly every 30 minutes. 256 confirmations (~9 min at 2s/block)
  // is evidence of inclusion, documented as NOT equivalent to finality.
  137: { mode: "confirmations", confirmations: 256 },
  // Arbitrum Nitro honours the `finalized` tag as L1-finalized batches:
  // sequencer confirmations alone are soft and never sufficient here.
  42161: { mode: "finalized", confirmations: 1 },
};

/** Bounded external-call budget (mirrors the Satora read timeout). */
export const CHAIN_READ_TIMEOUT_MS = 15_000;

/** Minimal mined-transaction view (pending = blockNumber null/absent). */
export interface ChainTransaction {
  hash: string;
  blockNumber: bigint | null;
}

/** Minimal receipt view used for settlement matching. */
export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number | null;
}

export interface ChainReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  logs: ChainLog[];
}

/** Read-only chain access. The implementation performs NO writes, ever. */
export interface ChainReads {
  getTransaction(chainId: number, hash: string): Promise<ChainTransaction | null>;
  getReceipt(chainId: number, hash: string): Promise<ChainReceipt | null>;
  getLatestBlockNumber(chainId: number): Promise<bigint>;
  /** L1-anchored finalized block, or null when the RPC cannot provide it. */
  getFinalizedBlockNumber(chainId: number): Promise<bigint | null>;
  /** Block hash at a height (reorg detection); null when unavailable. */
  getBlockHash(chainId: number, blockNumber: bigint): Promise<string | null>;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), CHAIN_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const clientCache = new Map<number, PublicClient>();

function liveReads(): ChainReads {
  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  const clientFor = (chainId: number): PublicClient => {
    const known =
      chainId === 1 ? SETTLEMENT_CHAINS[1] : chainId === 137 ? SETTLEMENT_CHAINS[137] : chainId === 42161 ? SETTLEMENT_CHAINS[42161] : undefined;
    if (!known) throw new Error(`Unsupported settlement chain ${chainId}.`);
    const url = rpcs[String(chainId)];
    if (!url) throw new Error(`No trusted RPC configured for chain ${chainId}.`);
    let client = clientCache.get(chainId);
    if (!client) {
      client = createPublicClient({ chain: known.chain, transport: http(url, { timeout: CHAIN_READ_TIMEOUT_MS }) });
      clientCache.set(chainId, client);
    }
    return client;
  };
  return {
    async getTransaction(chainId, hash) {
      const tx = await withTimeout(clientFor(chainId).getTransaction({ hash: hash as Hex }), "getTransaction");
      return { hash: tx.hash, blockNumber: tx.blockNumber ?? null };
    },
    async getReceipt(chainId, hash) {
      const r = await withTimeout(clientFor(chainId).getTransactionReceipt({ hash: hash as Hex }), "getReceipt");
      return {
        status: r.status === "success" ? "success" : "reverted",
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        logs: r.logs.map((l) => ({
          address: l.address,
          topics: [...l.topics] as string[],
          data: l.data,
          logIndex: typeof l.logIndex === "number" ? l.logIndex : null,
        })),
      };
    },
    async getLatestBlockNumber(chainId) {
      return withTimeout(clientFor(chainId).getBlockNumber(), "getBlockNumber");
    },
    async getFinalizedBlockNumber(chainId) {
      try {
        const b = await withTimeout(clientFor(chainId).getBlock({ blockTag: "finalized" }), "getFinalizedBlock");
        return b.number ?? null;
      } catch {
        return null;
      }
    },
    async getBlockHash(chainId, blockNumber) {
      try {
        const b = await withTimeout(clientFor(chainId).getBlock({ blockNumber }), "getBlock");
        return b.hash ?? null;
      } catch {
        return null;
      }
    },
  };
}

let chainOverrides: ChainReads | null = null;

/** Test seam: deterministic mock chain reads (null restores live behavior). */
export function setSettlementChainForTests(overrides: ChainReads | null): void {
  chainOverrides = overrides;
}

function reads(): ChainReads {
  return chainOverrides ?? liveReads();
}

/** Test seam: drop cached viem clients (isolated RPC configuration). */
export function resetSettlementClientsForTests(): void {
  clientCache.clear();
}

export interface LogMatch {
  matched: boolean;
  totalAtomic: bigint;
  logIndexes: number[];
}

/**
 * Pure ERC20 settlement matcher. Sums every Transfer log in the receipt
 * where the emitting token is the canonical contract AND the recipient is
 * the transfer destination. Unrelated movements are ignored, never counted.
 * Multi-leg coordinator settlements are supported by summation; `from` is
 * deliberately NOT filtered (HTLC/coordinator legs vary by deployment).
 */
export function matchSettlementTransfers(
  logs: ChainLog[],
  tokenContract: string,
  destination: string,
  requiredAtomic: bigint,
): LogMatch {
  const token = tokenContract.toLowerCase();
  const dest = destination.toLowerCase();
  let total = 0n;
  const indexes: number[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== token) continue;
    if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC) continue;
    const to = `0x${log.topics[2]?.slice(-40) ?? ""}`.toLowerCase();
    if (to !== dest) continue;
    let value = 0n;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    total += value;
    if (typeof log.logIndex === "number") indexes.push(log.logIndex);
  }
  indexes.sort((a, b) => a - b);
  return { matched: total >= requiredAtomic && total > 0n, totalAtomic: total, logIndexes: indexes };
}

export type SettlementVerdict =
  | "VERIFIED"
  | "PENDING"
  | "INSUFFICIENT_CONFIRMATIONS"
  | "INCONCLUSIVE"
  | "INVALID"
  | "UNAVAILABLE";

export interface SettlementProofView {
  transferId: string;
  chainId: number;
  chainName: string;
  tokenContract: string;
  recipient: string;
  verifiedAmountAtomic: string;
  claimTxHash: string;
  blockNumber: string;
  blockHash: string;
  logIndexes: number[];
  finalityLevel: string;
  verifiedAt: string;
  satoraSwapId: string;
  explorerTxUrl: string;
}

export interface SettlementResult {
  verdict: SettlementVerdict;
  reason: string;
  transferId: string;
  status: TransferStatus;
  providerStatus: string;
  claimTxHash: string | null;
  proof: SettlementProofView | null;
  confirmations: number | null;
}

const CLAIM_PROGRESS = new Set(["clientredeeming", "clientredeemed", "serverredeemed"]);

function toProofView(
  transferId: string,
  satoraSwapId: string,
  row: typeof transferProofs.$inferSelect,
): SettlementProofView | null {
  if (
    row.chainId === null ||
    !row.evmTxHash ||
    !row.tokenContract ||
    !row.recipient ||
    !row.verifiedAmountAtomic ||
    row.blockNumber === null ||
    !row.blockHash ||
    !row.finalityLevel ||
    !row.verifiedAt
  ) {
    return null;
  }
  const known = (SETTLEMENT_CHAINS as Record<number, { name: string; explorer: string } | undefined>)[row.chainId];
  return {
    transferId,
    chainId: row.chainId,
    chainName: known?.name ?? `chain-${row.chainId}`,
    tokenContract: row.tokenContract,
    recipient: row.recipient,
    verifiedAmountAtomic: row.verifiedAmountAtomic,
    claimTxHash: row.evmTxHash,
    blockNumber: String(row.blockNumber),
    blockHash: row.blockHash,
    logIndexes: parseLogIndexes(row.logIndexes),
    finalityLevel: row.finalityLevel,
    verifiedAt: row.verifiedAt.toISOString(),
    satoraSwapId,
    explorerTxUrl: known ? `${known.explorer}/tx/${row.evmTxHash}` : "",
  };
}

function parseLogIndexes(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Read-only settlement verification. Derives the bound swap and the
 * provider's claim transaction from existing records — a client-supplied
 * tx hash is never accepted (callers must not pass one through).
 */
export async function verifySettlement(userId: string, transferId: string): Promise<SettlementResult> {
  const db = getDb();
  const base = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
    .limit(1);
  const transfer = base[0];
  if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  const current = transfer.status as TransferStatus;

  const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
  const attachment = bound[0];
  if (!attachment) throw new AuthError(409, "NOT_VERIFIABLE", "No bound swap to verify.");

  const existingProof = await db.select().from(transferProofs).where(eq(transferProofs.transferId, transfer.id)).limit(1);
  const stored = existingProof[0];

  // Idempotent replay: an already-delivered transfer returns its proof.
  if (current === "DELIVERED") {
    const view = stored ? toProofView(transfer.id, attachment.satoraSwapId, stored) : null;
    if (!view) {
      return {
        verdict: "INCONCLUSIVE",
        reason: "Transfer is marked delivered without structured settlement evidence.",
        transferId,
        status: current,
        providerStatus: "unknown",
        claimTxHash: null,
        proof: null,
        confirmations: null,
      };
    }
    return {
      verdict: "VERIFIED",
      reason: "Already verified.",
      transferId,
      status: current,
      providerStatus: "unknown",
      claimTxHash: view.claimTxHash,
      proof: view,
      confirmations: null,
    };
  }

  // DELIVERED is reachable only from funded/claiming states with evidence.
  if (current !== "CLAIMING" && current !== "SERVER_FUNDED") {
    if (current === "USER_CANCELLED" || current === "QUOTE_EXPIRED" || current === "FAILED" || current === "NEEDS_ATTENTION") {
      throw new AuthError(409, "NOT_VERIFIABLE", "Transfer is in a terminal or attention state; settlement cannot be verified.");
    }
    return {
      verdict: "PENDING",
      reason: "Transfer has not reached a settlement-verifiable state.",
      transferId,
      status: current,
      providerStatus: "unknown",
      claimTxHash: null,
      proof: null,
      confirmations: null,
    };
  }

  // Refresh provider facts (bounded read); the claim tx is a provider
  // assertion until independently verified below.
  let facts;
  try {
    facts = await getProviderSwap(attachment.satoraSwapId);
  } catch (err) {
    const code = err instanceof Error && (err as { code?: string }).code ? String((err as { code?: unknown }).code) : "PROVIDER_UNAVAILABLE";
    if (code === "SWAP_NOT_FOUND" || code === "PROVIDER_MALFORMED") {
      return {
        verdict: "INCONCLUSIVE",
        reason: "Provider swap could not be read.",
        transferId,
        status: current,
        providerStatus: "unknown",
        claimTxHash: null,
        proof: null,
        confirmations: null,
      };
    }
    throw new AuthError(503, code, "Route provider or chain is temporarily unavailable.");
  }

  const claimTx = facts.evmClaimTxid && facts.evmClaimTxid.length > 0 ? facts.evmClaimTxid : null;
  if (!claimTx || !CLAIM_PROGRESS.has(facts.status)) {
    return {
      verdict: "INCONCLUSIVE",
      reason: "Provider has not reported a verifiable claim transaction yet.",
      transferId,
      status: current,
      providerStatus: facts.status || "unknown",
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }

  // Canonical route identity (never client-supplied).
  let tokenContract: string;
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    if (String(resolved.chainId) !== String(facts.evmChainId)) {
      return {
        verdict: "INVALID",
        reason: "Provider claim references a different chain than the transfer route.",
        transferId,
        status: current,
        providerStatus: facts.status,
        claimTxHash: claimTx,
        proof: null,
        confirmations: null,
      };
    }
    tokenContract = resolved.tokenAddress;
  } catch {
    throw new AuthError(503, "PROVIDER_UNAVAILABLE", "Route configuration is temporarily unavailable.");
  }

  const chainId = facts.evmChainId;
  if (!(chainId in SETTLEMENT_CHAINS)) {
    return {
      verdict: "INCONCLUSIVE",
      reason: `Chain ${chainId} is not supported for settlement verification in this slice.`,
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }
  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  if (!rpcs[String(chainId)]) {
    return {
      verdict: "INCONCLUSIVE",
      reason: `No trusted RPC is configured for chain ${chainId}; refusing to guess.`,
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }

  let required: bigint;
  try {
    required = BigInt(transfer.targetAmountAtomic);
  } catch {
    return {
      verdict: "INVALID",
      reason: "Transfer amount is not a valid atomic integer.",
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }

  // Bounded chain reads. Any outage is UNAVAILABLE, never a negative verdict.
  const chain = reads();
  let receipt: ChainReceipt | null;
  try {
    receipt = await chain.getReceipt(chainId, claimTx);
  } catch {
    throw new AuthError(503, "CHAIN_UNAVAILABLE", "Chain data is temporarily unavailable.");
  }
  if (!receipt) {
    try {
      const tx = await chain.getTransaction(chainId, claimTx);
      if (!tx || tx.blockNumber === null) {
        return {
          verdict: "PENDING",
          reason: "Claim transaction is not yet mined.",
          transferId,
          status: current,
          providerStatus: facts.status,
          claimTxHash: claimTx,
          proof: null,
          confirmations: 0,
        };
      }
    } catch {
      throw new AuthError(503, "CHAIN_UNAVAILABLE", "Chain data is temporarily unavailable.");
    }
    return {
      verdict: "PENDING",
      reason: "Claim receipt is not yet available.",
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: 0,
    };
  }
  if (receipt.status === "reverted") {
    return {
      verdict: "INVALID",
      reason: "Claim transaction reverted on-chain.",
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }

  const match = matchSettlementTransfers(receipt.logs, tokenContract, transfer.destination, required);
  if (match.totalAtomic <= 0n) {
    return {
      verdict: "INVALID",
      reason: "Claim receipt contains no Transfer event crediting the destination.",
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }
  if (!match.matched) {
    return {
      verdict: "INVALID",
      reason: "Verified recipient output is below the requested atomic amount.",
      transferId,
      status: current,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: null,
      confirmations: null,
    };
  }

  // Reorg guard: the block at the receipt height must still carry the
  // receipt's block hash. A mismatch (or unreadable header) is ambiguous —
  // stay nonterminal, never deliver.
  try {
    const atHeight = await chain.getBlockHash(chainId, receipt.blockNumber);
    if (!atHeight) {
      return {
        verdict: "INCONCLUSIVE",
        reason: "Chain header evidence is unavailable; refusing to decide.",
        transferId,
        status: current,
        providerStatus: facts.status,
        claimTxHash: claimTx,
        proof: null,
        confirmations: null,
      };
    }
    if (atHeight.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return {
        verdict: "INCONCLUSIVE",
        reason: "Block hash changed at the settlement height; possible reorg.",
        transferId,
        status: current,
        providerStatus: facts.status,
        claimTxHash: claimTx,
        proof: null,
        confirmations: null,
      };
    }
  } catch {
    throw new AuthError(503, "CHAIN_UNAVAILABLE", "Chain data is temporarily unavailable.");
  }

  // Finality policy (fail-closed).
  const overrides = getEnv().THENCE_SETTLEMENT_FINALITY_JSON as Record<string, { mode: string; confirmations: number }>;
  const policy = overrides[String(chainId)] ?? DEFAULT_FINALITY_POLICY[chainId]!;
  let finalityLevel: string | null = null;
  let confirmations: number | null = null;
  try {
    if (policy.mode === "finalized") {
      const finalized = await chain.getFinalizedBlockNumber(chainId);
      if (finalized === null) {
        return {
          verdict: "INCONCLUSIVE",
          reason: "RPC cannot provide finalized-block evidence; refusing to decide.",
          transferId,
          status: current,
          providerStatus: facts.status,
          claimTxHash: claimTx,
          proof: null,
          confirmations: null,
        };
      }
      confirmations = receipt.blockNumber <= finalized ? Number(await chain.getLatestBlockNumber(chainId)) - Number(receipt.blockNumber) + 1 : 0;
      if (receipt.blockNumber > finalized) {
        return {
          verdict: "INSUFFICIENT_CONFIRMATIONS",
          reason: "Settlement is confirmed but not yet covered by finalized ancestry.",
          transferId,
          status: current,
          providerStatus: facts.status,
          claimTxHash: claimTx,
          proof: null,
          confirmations: Math.max(0, confirmations),
        };
      }
      finalityLevel = "finalized";
    } else {
      const latest = await chain.getLatestBlockNumber(chainId);
      const seen = Number(latest) - Number(receipt.blockNumber) + 1;
      confirmations = Math.max(0, seen);
      if (seen < policy.confirmations) {
        return {
          verdict: "INSUFFICIENT_CONFIRMATIONS",
          reason: `Settlement has ${seen} confirmations; policy requires ${policy.confirmations}.`,
          transferId,
          status: current,
          providerStatus: facts.status,
          claimTxHash: claimTx,
          proof: null,
          confirmations,
        };
      }
      finalityLevel = `confirmations-${policy.confirmations}`;
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(503, "CHAIN_UNAVAILABLE", "Chain data is temporarily unavailable.");
  }

  // Commit: compare-and-set under the transfer advisory lock. Concurrent
  // verifications converge on the single stored proof.
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const rows = await tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId)))
      .limit(1);
    const fresh = rows[0];
    if (!fresh) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    const freshStatus = fresh.status as TransferStatus;
    if (freshStatus === "DELIVERED") {
      const prior = await tx.select().from(transferProofs).where(eq(transferProofs.transferId, fresh.id)).limit(1);
      const view = prior[0] ? toProofView(fresh.id, attachment.satoraSwapId, prior[0]) : null;
      return {
        verdict: "VERIFIED",
        reason: "Already verified.",
        transferId,
        status: freshStatus,
        providerStatus: facts.status,
        claimTxHash: claimTx,
        proof: view,
        confirmations,
      } satisfies SettlementResult;
    }
    if (freshStatus !== "CLAIMING" && freshStatus !== "SERVER_FUNDED") {
      throw new AuthError(409, "NOT_VERIFIABLE", "Transfer left a verifiable state before commit.");
    }
    // Double-attribution guard: one on-chain event, one transfer.
    const clash = await tx
      .select({ transferId: transferProofs.transferId })
      .from(transferProofs)
      .where(and(eq(transferProofs.chainId, chainId), eq(transferProofs.evmTxHash, claimTx)))
      .limit(1);
    if (clash.length > 0 && clash[0]?.transferId !== fresh.id) {
      throw new AuthError(409, "DOUBLE_ATTRIBUTION", "This on-chain settlement is already attributed to another transfer.");
    }
    const verifiedAt = new Date();
    await tx
      .insert(transferProofs)
      .values({
        transferId: fresh.id,
        satoraSwapId: attachment.satoraSwapId,
        lightningHash: facts.paymentHash,
        evmTxHash: claimTx,
        evidenceSource: "evm_erc20_transfer",
        chainId,
        tokenContract: tokenContract.toLowerCase(),
        recipient: transfer.destination.toLowerCase(),
        verifiedAmountAtomic: match.totalAtomic.toString(),
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash.toLowerCase(),
        logIndexes: JSON.stringify(match.logIndexes),
        finalityLevel,
        verifiedAt,
      })
      .onConflictDoUpdate({
        target: transferProofs.transferId,
        set: {
          satoraSwapId: attachment.satoraSwapId,
          lightningHash: facts.paymentHash,
          evmTxHash: claimTx,
          evidenceSource: "evm_erc20_transfer",
          chainId,
          tokenContract: tokenContract.toLowerCase(),
          recipient: transfer.destination.toLowerCase(),
          verifiedAmountAtomic: match.totalAtomic.toString(),
          blockNumber: Number(receipt.blockNumber),
          blockHash: receipt.blockHash.toLowerCase(),
          logIndexes: JSON.stringify(match.logIndexes),
          finalityLevel,
          verifiedAt,
        },
      });
    const next = transition(freshStatus, "DELIVERED", {
      evidence: { destinationTxHash: claimTx, amountVerified: true },
    });
    await tx.update(transfers).set({ status: next, updatedAt: new Date() }).where(eq(transfers.id, fresh.id));
    const saved = await tx.select().from(transferProofs).where(eq(transferProofs.transferId, fresh.id)).limit(1);
    return {
      verdict: "VERIFIED",
      reason: "Destination settlement independently verified on-chain.",
      transferId,
      status: next,
      providerStatus: facts.status,
      claimTxHash: claimTx,
      proof: saved[0] ? toProofView(fresh.id, attachment.satoraSwapId, saved[0]) : null,
      confirmations,
    } satisfies SettlementResult;
  });
}

/** Explorer link for a verified claim transaction (static registry, safe). */
export function explorerTxUrl(chainId: number, txHash: string): string {
  const known = (SETTLEMENT_CHAINS as Record<number, { explorer: string } | undefined>)[chainId];
  return known ? `${known.explorer}/tx/${txHash}` : "";
}
