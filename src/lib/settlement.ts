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
/** HTLC refund event: SwapRefunded(bytes32 indexed preimageHash, bytes32 indexed key). */
export const SWAP_REFUNDED_EVENT_TOPIC =
  "0xdb5ade4effa253aae9bef95994b76da3fe75eb0d634e715ec4261c6fd55c06f1" as const;

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
  /** P4: block timestamp in unix seconds. Optional: absent means "cannot scan". */
  getBlockTimestamp?(chainId: number, blockNumber: bigint): Promise<number>;
  /**
   * P4: logs emitted by `address` whose topic[1] equals `topic1` in an
   * inclusive block range. Optional: absent means "cannot scan".
   */
  getLogsByTopic1?(chainId: number, address: string, topic1: string, fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]>;
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
    async getBlockTimestamp(chainId, blockNumber) {
      const b = await withTimeout(clientFor(chainId).getBlock({ blockNumber }), "getBlock");
      return Number(b.timestamp);
    },
    async getLogsByTopic1(chainId, address, topic1, fromBlock, toBlock) {
      const toHex = (n: bigint): Hex => ("0x" + n.toString(16)) as Hex;
      const raw = (await withTimeout(
        clientFor(chainId).request({
          method: "eth_getLogs",
          params: [{ address: address as Hex, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [null, topic1 as Hex] }],
        }),
        "getLogs",
      )) as unknown as Array<{ address: string; topics: string[]; data: string; logIndex: string | null }>;
      if (!Array.isArray(raw)) throw new Error("Malformed getLogs response.");
      return raw.map((l) => ({
        address: l.address,
        topics: [...l.topics],
        data: l.data,
        logIndex: l.logIndex === null ? null : Number(BigInt(l.logIndex)),
      }));
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

export interface RefundLogMatch {
  matched: boolean;
  logIndexes: number[];
}

/**
 * Pure HTLC refund matcher. A refund is attributable only when the provider's
 * transaction receipt emitted SwapRefunded from the exact bound HTLC and the
 * exact swap hash lock. Provider status and a transaction pointer alone never
 * count as refund proof.
 */
export function matchRefundEvent(logs: ChainLog[], htlcAddress: string, hashLock: string): RefundLogMatch {
  const htlc = htlcAddress.toLowerCase();
  const lock = hashLock.toLowerCase();
  const indexes: number[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== htlc) continue;
    if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== SWAP_REFUNDED_EVENT_TOPIC) continue;
    if (log.topics[1]?.toLowerCase() !== lock) continue;
    if (typeof log.logIndex === "number") indexes.push(log.logIndex);
  }
  indexes.sort((a, b) => a - b);
  return { matched: indexes.length > 0, logIndexes: indexes };
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

/* ------------------------------------------------------------------ */
/* P4 — independent proof that an HTLC never moved for a hash lock      */
/* ------------------------------------------------------------------ */

/** eth_getLogs chunk size (public RPCs commonly cap ranges near 2–5k blocks). */
export const HTLC_LOG_CHUNK_BLOCKS = 2_000n;
/** Hard bound on one scan, so a request can never fan out unboundedly. */
export const MAX_HTLC_SCAN_BLOCKS = 40_000n;

export type HtlcActivityVerdict =
  | "NO_ACTIVITY"
  | "ACTIVITY_FOUND"
  | "INSUFFICIENT_CONFIRMATIONS"
  | "INCONCLUSIVE"
  | "UNAVAILABLE";

export interface HtlcActivityResult {
  verdict: HtlcActivityVerdict;
  reason: string;
  fromBlock: string | null;
  toBlock: string | null;
  latestBlock: string | null;
  logCount: number;
  /** topic[0] of each matching log (event signatures only; no data). */
  eventTopics: string[];
}

type TimestampReader = (chainId: number, blockNumber: bigint) => Promise<number>;

/** Last block whose timestamp is <= ts (binary search; read-only). */
async function blockAtOrBefore(getTs: TimestampReader, chainId: number, ts: number, latest: bigint): Promise<bigint | null> {
  if ((await getTs(chainId, latest)) <= ts) return latest;
  let lo = 0n;
  let hi = latest; // invariant: ts(hi) > ts
  if ((await getTs(chainId, lo)) > ts) return null;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await getTs(chainId, mid)) <= ts) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Prove that the bound HTLC contract emitted NO event for `hashLock` in the
 * window [windowStart, windowEnd]. Read-only. Any doubt is not "no activity":
 * missing chain capabilities, an unbounded range, unreadable chunks or a
 * window end without the chain's finality depth all return non-NO_ACTIVITY.
 *
 * Absence is proven per HTLC address and hash lock (topic[1] of every
 * HTLCErc20 v6 lifecycle event: fund, redeem, refund).
 */
export async function verifyNoHtlcActivity(input: {
  chainId: number;
  htlcAddress: string | null;
  hashLock: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<HtlcActivityResult> {
  const base = { fromBlock: null, toBlock: null, latestBlock: null, logCount: 0, eventTopics: [] as string[] };
  if (input.chainId !== 137) return { ...base, verdict: "INCONCLUSIVE", reason: "HTLC scans are enabled only for Polygon in this pilot." };
  if (!input.htlcAddress || !EVM_ADDRESS_RE.test(input.htlcAddress) || !HASH_LOCK_RE.test(input.hashLock)) {
    return { ...base, verdict: "INCONCLUSIVE", reason: "Missing a valid HTLC address or hash lock to scan." };
  }
  if (!(input.windowEnd.getTime() > input.windowStart.getTime())) {
    return { ...base, verdict: "INCONCLUSIVE", reason: "Scan window is empty." };
  }
  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  if (!rpcs[String(input.chainId)]) {
    return { ...base, verdict: "INCONCLUSIVE", reason: "No trusted RPC is configured for this chain; refusing to guess." };
  }
  const chain = reads();
  if (!chain.getBlockTimestamp || !chain.getLogsByTopic1) {
    return { ...base, verdict: "INCONCLUSIVE", reason: "Chain reader cannot scan HTLC logs." };
  }
  const getTs: TimestampReader = chain.getBlockTimestamp.bind(chain);
  const getLogs = chain.getLogsByTopic1.bind(chain);
  try {
    const latest = await chain.getLatestBlockNumber(input.chainId);
    const startTs = Math.floor(input.windowStart.getTime() / 1000);
    const endTs = Math.ceil(input.windowEnd.getTime() / 1000);
    const fromBlock = await blockAtOrBefore(getTs, input.chainId, startTs, latest);
    if (fromBlock === null) return { ...base, verdict: "INCONCLUSIVE", reason: "Scan window starts before chain history." };
    const endBefore = await blockAtOrBefore(getTs, input.chainId, endTs, latest);
    if (endBefore === null) return { ...base, verdict: "INCONCLUSIVE", reason: "Scan window end is not resolvable." };
    // Cover the whole window: include the first block at/after windowEnd.
    const toBlock = endBefore < latest ? endBefore + 1n : latest;
    const span = { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), latestBlock: latest.toString() };
    if ((await getTs(input.chainId, toBlock)) < endTs) {
      return { ...base, ...span, verdict: "INSUFFICIENT_CONFIRMATIONS", reason: "The chain has not yet reached the end of the scan window." };
    }
    const policy = DEFAULT_FINALITY_POLICY[input.chainId]!;
    if (latest - toBlock + 1n < BigInt(policy.confirmations)) {
      return { ...base, ...span, verdict: "INSUFFICIENT_CONFIRMATIONS", reason: "Scan window end does not yet have the required confirmations." };
    }
    if (toBlock - fromBlock + 1n > MAX_HTLC_SCAN_BLOCKS) {
      return { ...base, ...span, verdict: "INCONCLUSIVE", reason: "Scan window exceeds the bounded block range." };
    }
    const htlc = input.htlcAddress.toLowerCase();
    const lock = input.hashLock.toLowerCase();
    const matches: ChainLog[] = [];
    for (let s = fromBlock; s <= toBlock; s += HTLC_LOG_CHUNK_BLOCKS) {
      const e = s + HTLC_LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : s + HTLC_LOG_CHUNK_BLOCKS - 1n;
      const logs = await getLogs(input.chainId, input.htlcAddress, input.hashLock, s, e);
      for (const log of logs) {
        // Defensive re-filter: never trust the RPC's own filtering for a match.
        if (log.address.toLowerCase() === htlc && log.topics[1]?.toLowerCase() === lock) matches.push(log);
      }
    }
    if (matches.length > 0) {
      return {
        ...span,
        verdict: "ACTIVITY_FOUND",
        reason: "The HTLC emitted events for this hash lock; the swap was funded on-chain.",
        logCount: matches.length,
        eventTopics: matches.map((l) => (l.topics[0] ?? "").toLowerCase()),
      };
    }
    return { ...span, verdict: "NO_ACTIVITY", reason: "No HTLC event for this hash lock in the finalized scan window.", logCount: 0, eventTopics: [] };
  } catch {
    return { ...base, verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable." };
  }
}

export type RefundVerificationVerdict =
  | "VERIFIED"
  | "PENDING"
  | "INSUFFICIENT_CONFIRMATIONS"
  | "INCONCLUSIVE"
  | "INVALID"
  | "UNAVAILABLE";

export interface RefundVerificationResult {
  verdict: RefundVerificationVerdict;
  reason: string;
  confirmations: number | null;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_LOCK_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Independently verify a provider-reported EVM refund. This is read-only and
 * deliberately narrower than settlement verification: it proves the exact
 * bound HTLC emitted SwapRefunded for the exact hash lock, then applies the
 * same reorg and finality policy before callers may release exposure.
 */
export async function verifyEvmRefundEvidence(input: {
  chainId: number;
  refundTxHash: string;
  htlcAddress: string | null;
  hashLock: string;
}): Promise<RefundVerificationResult> {
  if (input.chainId !== 137) {
    return { verdict: "INCONCLUSIVE", reason: "Refund verification is enabled only for Polygon in this pilot.", confirmations: null };
  }
  if (!TX_HASH_RE.test(input.refundTxHash) || !input.htlcAddress || !EVM_ADDRESS_RE.test(input.htlcAddress) || !HASH_LOCK_RE.test(input.hashLock)) {
    return { verdict: "INVALID", reason: "Provider refund evidence is missing a valid transaction, HTLC, or hash-lock identity.", confirmations: null };
  }
  const htlcAddress = input.htlcAddress;
  if (!(input.chainId in SETTLEMENT_CHAINS)) {
    return { verdict: "INCONCLUSIVE", reason: `Chain ${input.chainId} is not supported for refund verification.`, confirmations: null };
  }
  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  if (!rpcs[String(input.chainId)]) {
    return { verdict: "INCONCLUSIVE", reason: `No trusted RPC is configured for chain ${input.chainId}; refusing to guess.`, confirmations: null };
  }

  const chain = reads();
  let receipt: ChainReceipt | null;
  try {
    receipt = await chain.getReceipt(input.chainId, input.refundTxHash);
  } catch {
    return { verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable.", confirmations: null };
  }
  if (!receipt) {
    return { verdict: "PENDING", reason: "Refund transaction is not yet mined.", confirmations: 0 };
  }
  if (receipt.status === "reverted") {
    return { verdict: "INVALID", reason: "Refund transaction reverted on-chain.", confirmations: null };
  }
  const match = matchRefundEvent(receipt.logs, htlcAddress, input.hashLock);
  if (!match.matched) {
    return { verdict: "INVALID", reason: "Refund receipt does not contain a matching SwapRefunded event for this HTLC.", confirmations: null };
  }

  try {
    const atHeight = await chain.getBlockHash(input.chainId, receipt.blockNumber);
    if (!atHeight) return { verdict: "INCONCLUSIVE", reason: "Chain header evidence is unavailable; refusing to decide.", confirmations: null };
    if (atHeight.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return { verdict: "INCONCLUSIVE", reason: "Block hash changed at the refund height; possible reorg.", confirmations: null };
    }
  } catch {
    return { verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable.", confirmations: null };
  }

  const overrides = getEnv().THENCE_SETTLEMENT_FINALITY_JSON as Record<string, { mode: string; confirmations: number }>;
  const policy = overrides[String(input.chainId)] ?? DEFAULT_FINALITY_POLICY[input.chainId]!;
  try {
    if (policy.mode === "finalized") {
      const finalized = await chain.getFinalizedBlockNumber(input.chainId);
      if (finalized === null) return { verdict: "INCONCLUSIVE", reason: "RPC cannot provide finalized-block evidence; refusing to decide.", confirmations: null };
      const latest = await chain.getLatestBlockNumber(input.chainId);
      const confirmations = Math.max(0, Number(latest) - Number(receipt.blockNumber) + 1);
      if (receipt.blockNumber > finalized) {
        return { verdict: "INSUFFICIENT_CONFIRMATIONS", reason: "Refund is confirmed but not yet covered by finalized ancestry.", confirmations };
      }
      return { verdict: "VERIFIED", reason: "Polygon refund independently verified on-chain.", confirmations };
    }
    const latest = await chain.getLatestBlockNumber(input.chainId);
    const confirmations = Math.max(0, Number(latest) - Number(receipt.blockNumber) + 1);
    if (confirmations < policy.confirmations) {
      return { verdict: "INSUFFICIENT_CONFIRMATIONS", reason: `Refund has ${confirmations} confirmations; policy requires ${policy.confirmations}.`, confirmations };
    }
    return { verdict: "VERIFIED", reason: "Polygon refund independently verified on-chain.", confirmations };
  } catch {
    return { verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable.", confirmations: null };
  }
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
    if (current === "USER_CANCELLED" || current === "QUOTE_EXPIRED" || current === "FAILED" || current === "NEEDS_ATTENTION" || current === "EXPIRED_UNFUNDED") {
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
