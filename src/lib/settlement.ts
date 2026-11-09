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
import { createPublicClient, http, keccak256 } from "viem";
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
import { recordTransition } from "@/lib/transitions";

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
  // Polygon (Bor): 256 confirmations (~9 min at 2s/block) stays the code
  // default. F9.2 (2026-11-06): since Polygon's milestone finality the Bor
  // `finalized` tag trails the head by ~1-3 blocks on both production RPCs
  // (docs/POLYGON_FINALITY.md); production may opt in per chain with
  // THENCE_SETTLEMENT_FINALITY_JSON={"137":{"mode":"finalized","confirmations":1}}
  // and roll back by removing the key. Fail-closed either way.
  137: { mode: "confirmations", confirmations: 256 },
  // Arbitrum Nitro honours the `finalized` tag as L1-finalized batches:
  // sequencer confirmations alone are soft and never sufficient here.
  42161: { mode: "finalized", confirmations: 1 },
};

/**
 * HTLC contracts the verifier trusts per chain. Polygon keeps the deployed v6
 * address used by the pilot; Arbitrum uses the independently verified current
 * v7 deployment. Provider-named addresses outside this set are refused for
 * both P4 no-activity proofs and P5 refund attribution: a provider pointer to
 * another contract is never evidence about this swap.
 */
export const TRUSTED_HTLC_CONTRACTS: Readonly<Record<number, readonly string[]>> = {
  137: ["0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948"],
  42161: ["0x6c38bf44a327bf36bfbefcedc514c0fb3fec6748"],
};

const HTLC_STATE_ABI = [
  {
    type: "function",
    name: "swapState",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [
      { name: "state", type: "uint8" },
      { name: "preimage", type: "bytes32" },
    ],
  },
] as const;

/** HTLCErc20 v7 SwapState values, verified against the pinned source revision. */
export const HTLC_SWAP_STATE = {
  NONE: 0,
  ACTIVE: 1,
  REDEEMED: 2,
  REFUNDED: 3,
  REHASHED: 4,
} as const;

export type HtlcSwapStateName = keyof typeof HTLC_SWAP_STATE;

export function isTrustedHtlc(chainId: number, address: string | null | undefined): boolean {
  if (!address) return false;
  return (TRUSTED_HTLC_CONTRACTS[chainId] ?? []).includes(address.toLowerCase());
}

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
  /** P5: emitting transaction (present on eth_getLogs results; absent on receipt logs). */
  transactionHash?: string | null;
}

export interface ChainReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  logs: ChainLog[];
}

export interface HtlcSwapStateSnapshot {
  state: number;
  preimage: string;
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
  /** v7 lifecycle state at an explicitly selected block, or absent in older readers. */
  getHtlcSwapState?(chainId: number, address: string, swapKey: string, blockNumber: bigint): Promise<HtlcSwapStateSnapshot>;
  /** P4: block timestamp in unix seconds. Optional: absent means "cannot scan". */
  getBlockTimestamp?(chainId: number, blockNumber: bigint): Promise<number>;
  /**
   * P4: logs emitted by `address` whose topic[1] equals `topic1` in an
   * inclusive block range. Optional: absent means "cannot scan".
   */
  getLogsByTopic1?(chainId: number, address: string, topic1: string, fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]>;
}

/**
 * P5 fix: the race is AWAITED before `finally` clears the timer. Previously
 * the promise was returned un-awaited, so `finally` cleared the timer
 * immediately and chain reads had no timeout at all.
 */
export async function withChainTimeout<T>(promise: Promise<T>, label: string, ms = CHAIN_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
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
      const tx = await withChainTimeout(clientFor(chainId).getTransaction({ hash: hash as Hex }), "getTransaction");
      return { hash: tx.hash, blockNumber: tx.blockNumber ?? null };
    },
    async getReceipt(chainId, hash) {
      const r = await withChainTimeout(clientFor(chainId).getTransactionReceipt({ hash: hash as Hex }), "getReceipt");
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
      return withChainTimeout(clientFor(chainId).getBlockNumber(), "getBlockNumber");
    },
    async getFinalizedBlockNumber(chainId) {
      try {
        const b = await withChainTimeout(clientFor(chainId).getBlock({ blockTag: "finalized" }), "getFinalizedBlock");
        return b.number ?? null;
      } catch {
        return null;
      }
    },
    async getBlockHash(chainId, blockNumber) {
      try {
        const b = await withChainTimeout(clientFor(chainId).getBlock({ blockNumber }), "getBlock");
        return b.hash ?? null;
      } catch {
        return null;
      }
    },
    async getHtlcSwapState(chainId, address, swapKey, blockNumber) {
      const result = await withChainTimeout(
        clientFor(chainId).readContract({
          address: address as Hex,
          abi: HTLC_STATE_ABI,
          functionName: "swapState",
          args: [swapKey as Hex],
          blockNumber,
        }),
        "getHtlcSwapState",
      );
      const [state, preimage] = result as readonly [number | bigint, string];
      return { state: Number(state), preimage };
    },
    async getBlockTimestamp(chainId, blockNumber) {
      const b = await withChainTimeout(clientFor(chainId).getBlock({ blockNumber }), "getBlock");
      return Number(b.timestamp);
    },
    async getLogsByTopic1(chainId, address, topic1, fromBlock, toBlock) {
      const toHex = (n: bigint): Hex => ("0x" + n.toString(16)) as Hex;
      const raw = (await withChainTimeout(
        clientFor(chainId).request({
          method: "eth_getLogs",
          params: [{ address: address as Hex, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [null, topic1 as Hex] }],
        }),
        "getLogs",
      )) as unknown as Array<{ address: string; topics: string[]; data: string; logIndex: string | null; transactionHash?: string | null }>;
      if (!Array.isArray(raw)) throw new Error("Malformed getLogs response.");
      return raw.map((l) => ({
        address: l.address,
        topics: [...l.topics],
        data: l.data,
        logIndex: l.logIndex === null ? null : Number(BigInt(l.logIndex)),
        transactionHash: typeof l.transactionHash === "string" ? l.transactionHash : null,
      }));
    },
  };
}

let chainOverrides: ChainReads | null = null;

/** Test seam: deterministic mock chain reads (null restores live behavior). */
export function setSettlementChainForTests(overrides: ChainReads | null): void {
  chainOverrides = overrides;
}

/**
 * P5: every chain read — live or injected — is bounded by the timeout, so a
 * hung RPC can never stall verification (callers map timeouts to UNAVAILABLE).
 */
function bounded(chain: ChainReads): ChainReads {
  const t = <T,>(p: Promise<T>, label: string) => withChainTimeout(p, label);
  return {
    getTransaction: (c, h) => t(chain.getTransaction(c, h), "getTransaction"),
    getReceipt: (c, h) => t(chain.getReceipt(c, h), "getReceipt"),
    getLatestBlockNumber: (c) => t(chain.getLatestBlockNumber(c), "getBlockNumber"),
    getFinalizedBlockNumber: (c) => t(chain.getFinalizedBlockNumber(c), "getFinalizedBlock"),
    getBlockHash: (c, n) => t(chain.getBlockHash(c, n), "getBlock"),
    ...(chain.getHtlcSwapState ? { getHtlcSwapState: (c: number, a: string, k: string, n: bigint) => t(chain.getHtlcSwapState!(c, a, k, n), "getHtlcSwapState") } : {}),
    ...(chain.getBlockTimestamp ? { getBlockTimestamp: (c: number, n: bigint) => t(chain.getBlockTimestamp!(c, n), "getBlock") } : {}),
    ...(chain.getLogsByTopic1 ? { getLogsByTopic1: (c: number, a: string, l: string, f: bigint, e: bigint) => t(chain.getLogsByTopic1!(c, a, l, f, e), "getLogs") } : {}),
  };
}

function reads(): ChainReads {
  return bounded(chainOverrides ?? liveReads());
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
  /** Sanitized cause when verdict is UNAVAILABLE (operator diagnostics; never an RPC URL or key). */
  failure?: ChainScanFailure;
}

/** Which chain read failed during an HTLC scan, and how (no URLs, keys or payloads). */
export interface ChainScanFailure {
  op: string;
  kind: "timeout" | "http" | "rpc" | "other";
  httpStatus: number | null;
  rpcCode: number | null;
  detail: string;
}

/** Strip anything that could carry a credential: URLs and long opaque tokens (hex values kept). */
export function sanitizeChainDetail(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/[A-Za-z0-9_-]{24,}/g, (m) => (/^0x[0-9a-fA-F]+$/.test(m) ? m : "<redacted>"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Classify a chain-read error without leaking the RPC endpoint. viem errors
 * embed the full request URL (which may contain an API key) in `message`,
 * `url` and `details`; only status codes and a sanitized short reason survive.
 */
export function describeChainError(err: unknown, op: string): ChainScanFailure {
  let httpStatus: number | null = null;
  let rpcCode: number | null = null;
  let timeout = false;
  const reasons: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 6; depth++) {
    const e = cur as { name?: unknown; status?: unknown; code?: unknown; shortMessage?: unknown; details?: unknown; message?: unknown; cause?: unknown };
    if (httpStatus === null && typeof e.status === "number") httpStatus = e.status;
    if (rpcCode === null && typeof e.code === "number") rpcCode = e.code;
    if (e.name === "TimeoutError" || (typeof e.message === "string" && /timed out/i.test(e.message))) timeout = true;
    const text =
      typeof e.details === "string" && e.details
        ? e.details
        : typeof e.shortMessage === "string"
          ? e.shortMessage
          : typeof e.message === "string"
            ? (e.message.split("\n")[0] ?? "")
            : "";
    if (text) reasons.push(text);
    cur = e.cause;
  }
  const kind: ChainScanFailure["kind"] = timeout ? "timeout" : httpStatus !== null ? "http" : rpcCode !== null ? "rpc" : "other";
  return { op, kind, httpStatus, rpcCode, detail: sanitizeChainDetail([...new Set(reasons)].join(" | ")) };
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
  // Operator diagnostics only: which read is in flight if something throws.
  let op = "getBlockNumber";
  try {
    const latest = await chain.getLatestBlockNumber(input.chainId);
    const startTs = Math.floor(input.windowStart.getTime() / 1000);
    const endTs = Math.ceil(input.windowEnd.getTime() / 1000);
    op = "blockSearch(windowStart)";
    const fromBlock = await blockAtOrBefore(getTs, input.chainId, startTs, latest);
    if (fromBlock === null) return { ...base, verdict: "INCONCLUSIVE", reason: "Scan window starts before chain history." };
    op = "blockSearch(windowEnd)";
    const endBefore = await blockAtOrBefore(getTs, input.chainId, endTs, latest);
    if (endBefore === null) return { ...base, verdict: "INCONCLUSIVE", reason: "Scan window end is not resolvable." };
    // Cover the whole window: include the first block at/after windowEnd.
    const toBlock = endBefore < latest ? endBefore + 1n : latest;
    const span = { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), latestBlock: latest.toString() };
    op = "getBlock(windowEnd)";
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
      op = `getLogs(${(e - s + 1n).toString()} blocks)`;
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
  } catch (err) {
    // Verdict unchanged: any failed read is UNAVAILABLE, never "no activity".
    // Only a sanitized cause is added and logged so operators can act on it.
    const failure = describeChainError(err, op);
    console.warn(`thence-chain-scan ${JSON.stringify({ verdict: "UNAVAILABLE", chainId: input.chainId, ...failure })}`);
    return { ...base, verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable.", failure };
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
const U256_WORD_RE = /^[0-9a-fA-F]{64}$/;

function abiWord(value: string): string {
  return value.replace(/^0x/, "").padStart(64, "0");
}

export function computeHtlcSwapKey(input: {
  hashLock: string;
  amount: bigint;
  token: string;
  refundAddress: string;
  claimAddress: string;
  timelock: bigint;
}): string {
  return keccak256(`0x${[
    abiWord(input.hashLock),
    input.amount.toString(16).padStart(64, "0"),
    abiWord(input.token),
    abiWord(input.refundAddress),
    abiWord(input.claimAddress),
    input.timelock.toString(16).padStart(64, "0"),
  ].join("")}` as `0x${string}`);
}

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
      // F9.2: finalized above the node's own head is inconsistent evidence.
      if (finalized > latest) return { verdict: "INCONCLUSIVE", reason: "RPC finality evidence is inconsistent (finalized above head); refusing to decide.", confirmations: null };
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

/** HTLCErc20 SwapCreated fund event topic (verified against the deployed ABI and the real 2026-11-02 fund receipt). */
export const SWAP_FUNDED_EVENT_TOPIC =
  "0x127ba86dffa89675eb78a2ca7203c29f865789ebec607b9424ed9f8d3d533e9f" as const;
/**
 * P3: confirmations the fund tx needs before the owner may reveal the
 * preimage. Polygon reorgs this deep are not expected; the margin protects
 * against releasing the preimage for a lock that later disappears. Small on
 * purpose: every minute spent here is taken from the claim window.
 */
export const CLAIM_FUNDING_MIN_CONFIRMATIONS = 32;

export type HtlcFundingVerdict = "VERIFIED" | "PENDING" | "INVALID" | "INCONCLUSIVE" | "UNAVAILABLE";

export interface HtlcFundingResult {
  verdict: HtlcFundingVerdict;
  reason: string;
  confirmations: number | null;
}

/**
 * P3 — the pinned HTLC really holds THIS swap's lock with THIS deadline.
 *
 * Read-only. Requires the provider-named fund transaction to be mined,
 * successful, reorg-consistent and final enough for its chain, and to contain
 * the pinned HTLC's fund event with the complete bound SwapKey identity:
 * hash lock, refund address, claim address, locked token, amount and timelock.
 * The target route token/amount are deliberately not used here: Satora's
 * Lightning→EVM flow locks WBTC and redeemAndExecute swaps it to the target.
 * Polygon keeps its exact 32-confirmation policy; Arbitrum requires finalized
 * ancestry. Anything else is not VERIFIED, and a claim is not authorized.
 */
export async function verifyHtlcFunding(input: {
  chainId: number;
  htlcAddress: string | null;
  hashLock: string;
  fundTxHash: string | null;
  expectedLocktimeSec: number;
  /** Actual token locked in the HTLC, not the final route token. */
  expectedTokenAddress: string | null | undefined;
  expectedAmountAtomic: string | null | undefined;
  expectedRefundAddress: string | null | undefined;
  expectedClaimAddress: string | null | undefined;
}): Promise<HtlcFundingResult> {
  if (input.chainId !== 137 && input.chainId !== 42161) {
    return { verdict: "INCONCLUSIVE", reason: "Funding verification is enabled only for Polygon and Arbitrum in this pilot.", confirmations: null };
  }
  if (!isTrustedHtlc(input.chainId, input.htlcAddress)) return { verdict: "INVALID", reason: "Provider names an HTLC contract outside the pinned trust list.", confirmations: null };
  if (!HASH_LOCK_RE.test(input.hashLock)) return { verdict: "INVALID", reason: "Bound swap has no valid hash lock.", confirmations: null };
  if (!input.fundTxHash || !TX_HASH_RE.test(input.fundTxHash)) return { verdict: "PENDING", reason: "The provider has not reported a funding transaction yet.", confirmations: null };
  if (
    !input.expectedTokenAddress || !EVM_ADDRESS_RE.test(input.expectedTokenAddress) ||
    !input.expectedAmountAtomic || !/^[0-9]+$/.test(input.expectedAmountAtomic) ||
    !input.expectedRefundAddress || !EVM_ADDRESS_RE.test(input.expectedRefundAddress) ||
    !input.expectedClaimAddress || !EVM_ADDRESS_RE.test(input.expectedClaimAddress)
  ) {
    return { verdict: "INCONCLUSIVE", reason: "Expected HTLC identity terms are unavailable; refusing to guess.", confirmations: null };
  }
  let expectedAmount: bigint;
  try {
    expectedAmount = BigInt(input.expectedAmountAtomic);
  } catch {
    return { verdict: "INCONCLUSIVE", reason: "Expected HTLC amount is malformed; refusing to guess.", confirmations: null };
  }
  if (expectedAmount <= 0n) return { verdict: "INCONCLUSIVE", reason: "Expected HTLC amount is invalid; refusing to guess.", confirmations: null };
  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  if (!rpcs[String(input.chainId)]) return { verdict: "INCONCLUSIVE", reason: "No trusted RPC is configured for this chain; refusing to guess.", confirmations: null };
  const chain = reads();
  const htlc = input.htlcAddress!.toLowerCase();
  try {
    const receipt = await chain.getReceipt(input.chainId, input.fundTxHash);
    if (!receipt) return { verdict: "PENDING", reason: "Funding transaction is not yet mined.", confirmations: 0 };
    if (receipt.status === "reverted") return { verdict: "INVALID", reason: "Funding transaction reverted on-chain.", confirmations: null };
    const fund = receipt.logs.find(
      (l) => l.address.toLowerCase() === htlc && l.topics[0]?.toLowerCase() === SWAP_FUNDED_EVENT_TOPIC && l.topics[1]?.toLowerCase() === input.hashLock.toLowerCase(),
    );
    if (!fund) return { verdict: "INVALID", reason: "Funding receipt has no fund event for this hash lock on the pinned HTLC.", confirmations: null };
    const words = fund.data.startsWith("0x") ? fund.data.slice(2) : fund.data;
    if (words.length !== 256 || !/^[0-9a-fA-F]+$/.test(words) || fund.topics.length < 4 || !fund.topics[2] || !fund.topics[3] || !U256_WORD_RE.test(fund.topics[2].replace(/^0x/, "")) || !U256_WORD_RE.test(fund.topics[3].replace(/^0x/, ""))) {
      return { verdict: "INVALID", reason: "Funding receipt has a malformed SwapCreated identity.", confirmations: null };
    }
    const tokenWord = words.slice(0, 64);
    const amountWord = words.slice(64, 128);
    const lockWord = words.slice(128, 192);
    const keyWord = words.slice(192, 256);
    const token = `0x${tokenWord.slice(24)}`;
    const refundAddress = `0x${fund.topics[2].replace(/^0x/, "").slice(-40)}`;
    const claimAddress = `0x${fund.topics[3].replace(/^0x/, "").slice(-40)}`;
    const amount = BigInt(`0x${amountWord}`);
    const timelock = BigInt(`0x${lockWord}`);
    if (timelock !== BigInt(input.expectedLocktimeSec)) {
      return { verdict: "INVALID", reason: "On-chain HTLC deadline differs from the bound claim deadline.", confirmations: null };
    }
    if (
      token.toLowerCase() !== input.expectedTokenAddress.toLowerCase() ||
      amount !== expectedAmount ||
      refundAddress.toLowerCase() !== input.expectedRefundAddress.toLowerCase() ||
      claimAddress.toLowerCase() !== input.expectedClaimAddress.toLowerCase()
    ) {
      return { verdict: "INVALID", reason: "On-chain SwapCreated terms do not match the bound HTLC identity.", confirmations: null };
    }
    const expectedKey = computeHtlcSwapKey({
      hashLock: input.hashLock,
      amount: expectedAmount,
      token: input.expectedTokenAddress,
      refundAddress: input.expectedRefundAddress,
      claimAddress: input.expectedClaimAddress,
      timelock,
    });
    if (`0x${keyWord}`.toLowerCase() !== expectedKey.toLowerCase()) {
      return { verdict: "INVALID", reason: "On-chain SwapCreated key does not match the bound HTLC terms.", confirmations: null };
    }
    const atHeight = await chain.getBlockHash(input.chainId, receipt.blockNumber);
    if (!atHeight) return { verdict: "INCONCLUSIVE", reason: "Chain header evidence is unavailable; refusing to decide.", confirmations: null };
    if (atHeight.toLowerCase() !== receipt.blockHash.toLowerCase()) return { verdict: "INCONCLUSIVE", reason: "Block hash changed at the funding height; possible reorg.", confirmations: null };
    const latest = await chain.getLatestBlockNumber(input.chainId);
    const confirmations = Math.max(0, Number(latest) - Number(receipt.blockNumber) + 1);
    if (input.chainId === 42161) {
      // Arbitrum sequencer confirmations are soft finality. Do not let a
      // confirmation-count override weaken this funding gate: only the RPC's
      // L1-anchored `finalized` block is sufficient to authorize a claim.
      const finalized = await chain.getFinalizedBlockNumber(input.chainId);
      if (finalized === null) {
        return { verdict: "INCONCLUSIVE", reason: "RPC cannot provide Arbitrum finalized-block evidence; refusing to decide.", confirmations: null };
      }
      if (finalized > latest) {
        return { verdict: "INCONCLUSIVE", reason: "RPC finality evidence is inconsistent (finalized above head); refusing to decide.", confirmations: null };
      }
      if (receipt.blockNumber > finalized) {
        return { verdict: "PENDING", reason: "Arbitrum funding is confirmed but not yet covered by finalized ancestry.", confirmations };
      }
      return { verdict: "VERIFIED", reason: "The pinned Arbitrum HTLC holds this swap's lock with the bound deadline in finalized ancestry.", confirmations };
    }
    // Preserve Polygon's existing exact 32-confirmation policy.
    if (confirmations < CLAIM_FUNDING_MIN_CONFIRMATIONS) {
      return { verdict: "PENDING", reason: `Funding has ${confirmations} confirmations; ${CLAIM_FUNDING_MIN_CONFIRMATIONS} are required before finishing.`, confirmations };
    }
    return { verdict: "VERIFIED", reason: "The pinned HTLC holds this swap's lock with the bound deadline.", confirmations };
  } catch {
    return { verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable.", confirmations: null };
  }
}

export type HtlcLifecycleVerdict = "ACTIVE" | "REJECTED" | "INCONCLUSIVE" | "UNAVAILABLE";

export interface HtlcLifecycleResult {
  verdict: HtlcLifecycleVerdict;
  reason: string;
  finalizedState?: HtlcSwapStateName;
  latestState?: HtlcSwapStateName;
}

export interface HtlcLifecycleInput {
  chainId: number;
  htlcAddress: string | null;
  hashLock: string;
  expectedLocktimeSec: number;
  expectedTokenAddress: string | null | undefined;
  expectedAmountAtomic: string | null | undefined;
  expectedRefundAddress: string | null | undefined;
  expectedClaimAddress: string | null | undefined;
  fundingVerdict: HtlcFundingVerdict;
}

function htlcStateName(value: number): HtlcSwapStateName | null {
  switch (value) {
    case HTLC_SWAP_STATE.NONE:
      return "NONE";
    case HTLC_SWAP_STATE.ACTIVE:
      return "ACTIVE";
    case HTLC_SWAP_STATE.REDEEMED:
      return "REDEEMED";
    case HTLC_SWAP_STATE.REFUNDED:
      return "REFUNDED";
    case HTLC_SWAP_STATE.REHASHED:
      return "REHASHED";
    default:
      return null;
  }
}

/**
 * A2b1 — verify that the original Arbitrum v7 key is still active.
 *
 * Funding finality alone is insufficient: v7 can move the lock from the old
 * key to a new key without another SwapCreated event. The old key is read at
 * both finalized state and a stable current head. A terminal current-head
 * state rejects the claim; missing, inconsistent, or stale chain evidence
 * defers it. This intentionally never follows a rehashed key.
 */
export async function verifyHtlcLifecycle(input: HtlcLifecycleInput): Promise<HtlcLifecycleResult> {
  if (input.chainId !== 42161) return { verdict: "ACTIVE", reason: "The Arbitrum lifecycle gate does not apply to this chain." };
  if (input.fundingVerdict !== "VERIFIED") return { verdict: "INCONCLUSIVE", reason: "The bound Arbitrum funding is not independently finalized." };
  if (!isTrustedHtlc(input.chainId, input.htlcAddress)) return { verdict: "REJECTED", reason: "Provider names an HTLC contract outside the pinned Arbitrum trust list." };
  if (
    !HASH_LOCK_RE.test(input.hashLock) ||
    !Number.isSafeInteger(input.expectedLocktimeSec) ||
    input.expectedLocktimeSec <= 0 ||
    !input.expectedTokenAddress || !EVM_ADDRESS_RE.test(input.expectedTokenAddress) ||
    !input.expectedAmountAtomic || !/^[0-9]+$/.test(input.expectedAmountAtomic) ||
    !input.expectedRefundAddress || !EVM_ADDRESS_RE.test(input.expectedRefundAddress) ||
    !input.expectedClaimAddress || !EVM_ADDRESS_RE.test(input.expectedClaimAddress)
  ) {
    return { verdict: "INCONCLUSIVE", reason: "Complete bound HTLC identity terms are unavailable; refusing to guess." };
  }
  let amount: bigint;
  try {
    amount = BigInt(input.expectedAmountAtomic);
  } catch {
    return { verdict: "INCONCLUSIVE", reason: "Bound HTLC amount is malformed; refusing to guess." };
  }
  if (amount <= 0n) return { verdict: "INCONCLUSIVE", reason: "Bound HTLC amount is invalid; refusing to guess." };

  const chain = reads();
  if (!chain.getHtlcSwapState) return { verdict: "INCONCLUSIVE", reason: "RPC cannot read the pinned Arbitrum HTLC lifecycle state; refusing to decide." };
  const key = computeHtlcSwapKey({
    hashLock: input.hashLock,
    amount,
    token: input.expectedTokenAddress,
    refundAddress: input.expectedRefundAddress,
    claimAddress: input.expectedClaimAddress,
    timelock: BigInt(input.expectedLocktimeSec),
  });

  try {
    const finalizedBlock = await chain.getFinalizedBlockNumber(input.chainId);
    const initialHead = await chain.getLatestBlockNumber(input.chainId);
    if (finalizedBlock === null) return { verdict: "INCONCLUSIVE", reason: "RPC cannot provide Arbitrum finalized-block evidence; refusing to decide." };
    if (finalizedBlock > initialHead) return { verdict: "INCONCLUSIVE", reason: "RPC finality evidence is inconsistent (finalized above head); refusing to decide." };
    if (!(await chain.getBlockHash(input.chainId, finalizedBlock))) return { verdict: "INCONCLUSIVE", reason: "Finalized Arbitrum header evidence is unavailable; refusing to decide." };

    const finalized = await chain.getHtlcSwapState(input.chainId, input.htlcAddress!, key, finalizedBlock);
    let head = initialHead;
    let latest = await chain.getHtlcSwapState(input.chainId, input.htlcAddress!, key, head);
    const observedHead = await chain.getLatestBlockNumber(input.chainId);
    if (observedHead < head) return { verdict: "INCONCLUSIVE", reason: "Arbitrum head moved backwards during lifecycle verification; refusing to decide." };
    if (observedHead > head) {
      head = observedHead;
      latest = await chain.getHtlcSwapState(input.chainId, input.htlcAddress!, key, head);
      const stableHead = await chain.getLatestBlockNumber(input.chainId);
      if (stableHead !== head) return { verdict: "INCONCLUSIVE", reason: "Arbitrum head changed during lifecycle verification; retry required." };
    }
    if (!(await chain.getBlockHash(input.chainId, head))) return { verdict: "INCONCLUSIVE", reason: "Current Arbitrum head evidence is unavailable; refusing to decide." };

    const finalizedState = htlcStateName(finalized.state);
    const latestState = htlcStateName(latest.state);
    if (!finalizedState || !latestState) return { verdict: "INCONCLUSIVE", reason: "Arbitrum returned an unknown HTLC lifecycle state; refusing to decide." };
    if (latestState !== "ACTIVE") {
      return { verdict: "REJECTED", reason: `The original Arbitrum HTLC key is ${latestState} at the current chain head.`, finalizedState, latestState };
    }
    if (finalizedState !== "ACTIVE") {
      return { verdict: "INCONCLUSIVE", reason: `Arbitrum lifecycle state is inconsistent: finalized state is ${finalizedState}, current state is ACTIVE.`, finalizedState, latestState };
    }
    return { verdict: "ACTIVE", reason: "The complete bound Arbitrum HTLC key is Active at finalized state and the current chain head.", finalizedState, latestState };
  } catch {
    return { verdict: "UNAVAILABLE", reason: "Arbitrum lifecycle chain data is temporarily unavailable." };
  }
}

export type HtlcSpendVerdict = "UNSPENT" | "SPENT" | "INCONCLUSIVE" | "UNAVAILABLE";

/**
 * P7 — authoritative "the earlier claim did not execute" evidence for a retry.
 *
 * After an unknown claim outcome the provider's view (still `serverfunded`, no
 * claim tx) is only an assertion. This reads the pinned HTLC's own log for
 * this hash lock from the funding block to the chain head: UNSPENT only when
 * the funding event is the ONLY event (no redeem, no refund) across a fully
 * scanned, bounded range. Anything else — another event, an unreadable chunk,
 * a range beyond the scan bound, a missing funding receipt — is not UNSPENT,
 * and a retry is refused.
 */
export async function verifyHtlcUnspent(input: {
  chainId: number;
  htlcAddress: string | null;
  hashLock: string;
  fundTxHash: string | null;
}): Promise<{ verdict: HtlcSpendVerdict; reason: string }> {
  if (input.chainId !== 137 || !isTrustedHtlc(input.chainId, input.htlcAddress) || !HASH_LOCK_RE.test(input.hashLock)) {
    return { verdict: "INCONCLUSIVE", reason: "No pinned Polygon HTLC to check." };
  }
  if (!input.fundTxHash || !TX_HASH_RE.test(input.fundTxHash)) return { verdict: "INCONCLUSIVE", reason: "No funding transaction to scan from." };
  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  if (!rpcs[String(input.chainId)]) return { verdict: "INCONCLUSIVE", reason: "No trusted RPC is configured for this chain." };
  const chain = reads();
  if (!chain.getLogsByTopic1) return { verdict: "INCONCLUSIVE", reason: "Chain reader cannot scan HTLC logs." };
  const htlc = input.htlcAddress!.toLowerCase();
  const lock = input.hashLock.toLowerCase();
  try {
    const receipt = await chain.getReceipt(input.chainId, input.fundTxHash);
    if (!receipt || receipt.status !== "success") return { verdict: "INCONCLUSIVE", reason: "Funding receipt is unavailable." };
    const latest = await chain.getLatestBlockNumber(input.chainId);
    if (latest - receipt.blockNumber + 1n > MAX_HTLC_SCAN_BLOCKS) return { verdict: "INCONCLUSIVE", reason: "Scan range exceeds the bound." };
    for (let s = receipt.blockNumber; s <= latest; s += HTLC_LOG_CHUNK_BLOCKS) {
      const e = s + HTLC_LOG_CHUNK_BLOCKS - 1n > latest ? latest : s + HTLC_LOG_CHUNK_BLOCKS - 1n;
      const logs = await chain.getLogsByTopic1(input.chainId, htlc, lock, s, e);
      for (const log of logs) {
        if (log.address.toLowerCase() !== htlc || log.topics[1]?.toLowerCase() !== lock) continue;
        if (log.topics[0]?.toLowerCase() === SWAP_FUNDED_EVENT_TOPIC) continue;
        return { verdict: "SPENT", reason: "The HTLC already emitted a redeem or refund event for this lock." };
      }
    }
    return { verdict: "UNSPENT", reason: "Only the funding event exists for this lock on the pinned HTLC." };
  } catch {
    return { verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable." };
  }
}

/** P5: the refund scan starts this long before the earliest possible refund (clock skew margin). */
export const REFUND_SCAN_LEAD_MS = 5 * 60_000;

export interface HtlcRefundResult extends RefundVerificationResult {
  /** The refund transaction that was independently verified (or examined), when one was found. */
  refundTxHash: string | null;
  /** Where the refund transaction came from: Satora's pointer, or Thence's own HTLC log scan. */
  source: "provider_pointer" | "htlc_log_scan" | null;
}

/**
 * P5 — independent Polygon HTLC refund verification.
 *
 * A Polygon refund is real only when the pinned (trusted) HTLC contract
 * emitted SwapRefunded for this swap's hash lock in a finalized, reorg-checked
 * receipt. Satora's tx pointer (empirically reported in `evm_claim_txid`) is
 * only a hint: when it is missing or does not contain that event, the HTLC's
 * own logs are scanned for the refund, and the transaction found there is
 * verified the same way. Says NOTHING about the Nimiq side: Thence cannot see
 * Nimiq Pay's NIM HTLC, so a verified Polygon refund is never a NIM refund.
 */
export async function verifyHtlcRefund(input: {
  chainId: number;
  htlcAddress: string | null;
  hashLock: string;
  providerRefundTxHash: string | null;
  /** Earliest time a refund could exist on-chain (the EVM refund locktime, else the bind time). */
  earliestRefundAt: Date;
}): Promise<HtlcRefundResult> {
  const none = { refundTxHash: null, source: null } as const;
  if (input.chainId !== 137) {
    return { ...none, verdict: "INCONCLUSIVE", reason: "Refund verification is enabled only for Polygon in this pilot.", confirmations: null };
  }
  if (!isTrustedHtlc(input.chainId, input.htlcAddress)) {
    return { ...none, verdict: "INVALID", reason: "Provider names an HTLC contract outside the pinned trust list.", confirmations: null };
  }
  if (!HASH_LOCK_RE.test(input.hashLock)) {
    return { ...none, verdict: "INVALID", reason: "Bound swap has no valid hash lock.", confirmations: null };
  }
  const htlc = input.htlcAddress!.toLowerCase();
  const pointer = input.providerRefundTxHash && TX_HASH_RE.test(input.providerRefundTxHash) ? input.providerRefundTxHash : null;
  if (pointer) {
    const viaPointer = await verifyEvmRefundEvidence({ chainId: input.chainId, refundTxHash: pointer, htlcAddress: htlc, hashLock: input.hashLock });
    // Anything but INVALID (verified, still confirming, chain unavailable) is
    // the answer. INVALID means the pointer is not this swap's refund: fall
    // back to the HTLC's own event log rather than trusting or rejecting it.
    if (viaPointer.verdict !== "INVALID") return { ...viaPointer, refundTxHash: pointer, source: "provider_pointer" };
  }

  const rpcs = getEnv().THENCE_EVM_RPCS_JSON as Record<string, string>;
  if (!rpcs[String(input.chainId)]) {
    return { ...none, verdict: "INCONCLUSIVE", reason: "No trusted RPC is configured for this chain; refusing to guess.", confirmations: null };
  }
  const chain = reads();
  if (!chain.getBlockTimestamp || !chain.getLogsByTopic1) {
    return { ...none, verdict: "INCONCLUSIVE", reason: "Chain reader cannot scan HTLC logs.", confirmations: null };
  }
  const getTs: TimestampReader = chain.getBlockTimestamp.bind(chain);
  const getLogs = chain.getLogsByTopic1.bind(chain);
  const found = new Set<string>();
  let truncated = false;
  try {
    const latest = await chain.getLatestBlockNumber(input.chainId);
    const startTs = Math.floor((input.earliestRefundAt.getTime() - REFUND_SCAN_LEAD_MS) / 1000);
    const fromBlock = await blockAtOrBefore(getTs, input.chainId, startTs, latest);
    if (fromBlock === null) {
      return { ...none, verdict: "INCONCLUSIVE", reason: "Refund scan window starts before chain history.", confirmations: null };
    }
    let toBlock = latest;
    if (toBlock - fromBlock + 1n > MAX_HTLC_SCAN_BLOCKS) {
      toBlock = fromBlock + MAX_HTLC_SCAN_BLOCKS - 1n;
      truncated = true;
    }
    for (let s = fromBlock; s <= toBlock; s += HTLC_LOG_CHUNK_BLOCKS) {
      const e = s + HTLC_LOG_CHUNK_BLOCKS - 1n > toBlock ? toBlock : s + HTLC_LOG_CHUNK_BLOCKS - 1n;
      const logs = await getLogs(input.chainId, htlc, input.hashLock, s, e);
      for (const log of logs) {
        // Defensive re-filter: never trust the RPC's own filtering for a match.
        if (log.address.toLowerCase() !== htlc) continue;
        if (log.topics[0]?.toLowerCase() !== SWAP_REFUNDED_EVENT_TOPIC) continue;
        if (log.topics[1]?.toLowerCase() !== input.hashLock.toLowerCase()) continue;
        if (log.transactionHash && TX_HASH_RE.test(log.transactionHash)) found.add(log.transactionHash.toLowerCase());
      }
    }
  } catch {
    return { ...none, verdict: "UNAVAILABLE", reason: "Chain data is temporarily unavailable.", confirmations: null };
  }
  if (found.size > 1) {
    return { ...none, verdict: "INCONCLUSIVE", reason: "More than one refund event names this hash lock; refusing to choose.", confirmations: null };
  }
  const [txHash] = [...found];
  if (!txHash) {
    return {
      ...none,
      verdict: "INCONCLUSIVE",
      reason: truncated
        ? "No refund event found in the bounded scan window."
        : "No refund event for this hash lock on the HTLC yet.",
      confirmations: null,
    };
  }
  const viaScan = await verifyEvmRefundEvidence({ chainId: input.chainId, refundTxHash: txHash, htlcAddress: htlc, hashLock: input.hashLock });
  return { ...viaScan, refundTxHash: txHash, source: "htlc_log_scan" };
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
  return verifySettlementCore(transferId, { kind: "owner", ownerUserId: userId });
}

export interface SettlementActor {
  /** "owner" = session request; "system" = server reconciler (P3: browser closed). */
  kind: "owner" | "system";
  ownerUserId: string | null;
}

/**
 * P3: the one settlement verifier, shared by the owner route and the server
 * reconciler, so a claimed payment reaches DELIVERED (with proof) even when
 * no browser is open. Read-only on chain; the only write is the proof +
 * DELIVERED commit under the transfer lock.
 */
export async function verifySettlementCore(transferId: string, actor: SettlementActor): Promise<SettlementResult> {
  const scope = actor.ownerUserId ? and(eq(transfers.id, transferId), eq(transfers.ownerUserId, actor.ownerUserId)) : eq(transfers.id, transferId);
  const db = getDb();
  const base = await db
    .select()
    .from(transfers)
    .where(scope)
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
      // F9.2: a finalized height above the node's own head is inconsistent
      // (stale or broken RPC) and is never taken as finality evidence.
      const latestForFinality = await chain.getLatestBlockNumber(chainId);
      if (finalized > latestForFinality) {
        return {
          verdict: "INCONCLUSIVE",
          reason: "RPC finality evidence is inconsistent (finalized above head); refusing to decide.",
          transferId,
          status: current,
          providerStatus: facts.status,
          claimTxHash: claimTx,
          proof: null,
          confirmations: null,
        };
      }
      confirmations = receipt.blockNumber <= finalized ? Number(latestForFinality) - Number(receipt.blockNumber) + 1 : 0;
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
      .where(scope)
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
    // P5 audit: same transaction as the proof row and the status write, so a
    // DELIVERED transfer always carries both (or neither, on rollback).
    await recordTransition(tx, {
      transferId: fresh.id,
      from: freshStatus,
      to: next,
      actor: actor.kind === "system" ? "reconciler" : "owner",
      actorUserId: actor.ownerUserId,
      reasonCode: "SETTLEMENT_VERIFIED",
      evidence: {
        providerStatus: facts.status,
        chainId,
        claimTxHash: claimTx,
        blockNumber: receipt.blockNumber.toString(),
        logIndexes: match.logIndexes,
        verifiedAmountAtomic: match.totalAtomic.toString(),
        finalityLevel,
      },
    });
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
