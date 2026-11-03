/**
 * Thence backend — read-only Satora provider adapter (B3.1).
 *
 * Verified against @satora/swap 1.7.2 (lendaswap-sdk-pure 2.7.x):
 * - `getQuote({sourceChain, sourceToken, targetChain, targetToken,
 *    sourceAmount? | targetAmount?})` — either end pinnable in atomic units.
 * - BTC side: `sourceToken`/`targetToken` = "btc" on Bitcoin/Arkade/Lightning.
 * - EVM chains are CAIP-ish ids ("1", "137", "42161", …); EVM token
 *   addresses come from the provider's live `/tokens` endpoint — never
 *   invented, never hardcoded here.
 * - `QuoteResponse` numeric u64s ship as `number` (sats fit under 2^53);
 *   stringified u128 token amounts ship as `string`.
 * - The response carries NO expiry field: any validity window we report is
 *   a LOCAL estimate, never a provider guarantee (B4 revalidates).
 *
 * Custody posture (explicit): the SDK builder always materialises a signer,
 * so we build a STATELESS client with NO storage backend — the ephemeral
 * in-memory key is never persisted, never exported, and never used: this
 * module calls ONLY read-only endpoints (getTokens/getSwapPairs/
 * getNetworkFees/getQuote). No swap is created, no invoice generated.
 */
import { Client } from "@satora/swap";
import type { Chain } from "@satora/swap";
import { getEnv } from "@/lib/env";
import { isAtomicAmount } from "@/domain/money";

export const SATORA_READ_TIMEOUT_MS = 15_000;
/** Reference-data cache TTL (pairs/tokens). Quotes themselves are never cached. */
const REFERENCE_TTL_MS = 60_000;

/** Canonical EVM chain ids (public protocol constants, also the SDK `Chain` type). */
const CHAIN_IDS: Record<string, Chain> = { Ethereum: "1", Polygon: "137", Arbitrum: "42161", Base: "8453" };

export class SatoraError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SatoraError";
    this.code = code;
  }
}

let clientPromise: Promise<Client> | null = null;

/** Singleton stateless client. No storage backend: nothing is persisted. */
export function getSatoraClient(): Promise<Client> {
  if (!clientPromise) {
    const baseUrl = getEnv().THENCE_SATORA_BASE_URL.trim().replace(/\/+$/, "");
    const builder = Client.builder();
    if (baseUrl !== "") builder.withBaseUrl(baseUrl);
    clientPromise = builder.build();
  }
  return clientPromise;
}

/** Test hook: drop the singleton (isolated retry configuration). */
export function resetSatoraClientForTests(): void {
  clientPromise = null;
}

function timeoutError(label: string): SatoraError {
  return new SatoraError("PROVIDER_TIMEOUT", `${label} timed out.`);
}

/**
 * Bound a provider call; the underlying fetch may outlive us (documented).
 * Exported so timeout/recovery behavior is directly unit-testable.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ProviderToken {
  address: string;
  symbol: string;
  chain: string;
  decimals: number;
}

interface TokensCache {
  at: number;
  tokens: ProviderToken[];
}
let tokensCache: TokensCache | null = null;

export interface SwapPair {
  source: string;
  target: string;
  min_sats: number;
  max_sats: number;
}
interface PairsCache {
  at: number;
  pairs: SwapPair[];
}
let pairsCache: PairsCache | null = null;

/**
 * True when reference data is served stale: a refresh failed and the last
 * known-good snapshot is being used. A failure is NEVER cached as a
 * permanent "unsupported" verdict — staleness is flagged, not hidden.
 */
let referenceStale = false;

export function isProviderReferenceStale(): boolean {
  return referenceStale;
}

/** Test seam: override the network fetchers (null restores live behavior). */
let fetchOverrides: {
  getTokens?: () => Promise<unknown>;
  getSwapPairs?: () => Promise<unknown>;
  getSwap?: (id: string) => Promise<unknown>;
} | null = null;

export function setSatoraFetchersForTests(
  overrides: {
    getTokens?: () => Promise<unknown>;
    getSwapPairs?: () => Promise<unknown>;
    getSwap?: (id: string) => Promise<unknown>;
  } | null,
): void {
  fetchOverrides = overrides;
  if (overrides === null) referenceStale = false;
}

/** Live provider token catalogue (authoritative token configuration). */
export async function getProviderTokens(): Promise<ProviderToken[]> {
  if (tokensCache && Date.now() - tokensCache.at < REFERENCE_TTL_MS) return tokensCache.tokens;
  let raw: unknown;
  try {
    if (fetchOverrides?.getTokens) raw = await fetchOverrides.getTokens();
    else {
      const client = await getSatoraClient();
      raw = await withTimeout(client.getTokens(), SATORA_READ_TIMEOUT_MS, "getTokens");
    }
  } catch (err) {
    // Serve last-known-good as explicitly stale; never persist a failure.
    if (tokensCache) {
      referenceStale = true;
      return tokensCache.tokens;
    }
    throw err instanceof SatoraError ? err : new SatoraError("PROVIDER_UNAVAILABLE", "Route provider is temporarily unavailable.");
  }
  referenceStale = false;
  const evm = (raw as { evm_tokens?: unknown }).evm_tokens;
  if (!Array.isArray(evm)) throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned an unexpected token catalogue.");
  const tokens: ProviderToken[] = [];
  for (const t of evm as Array<Record<string, unknown>>) {
    if (typeof t["token_id"] !== "string" || typeof t["symbol"] !== "string" || typeof t["chain"] !== "string" || typeof t["decimals"] !== "number") {
      throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned an unexpected token entry.");
    }
    tokens.push({ address: t["token_id"], symbol: t["symbol"], chain: t["chain"], decimals: t["decimals"] });
  }
  tokensCache = { at: Date.now(), tokens };
  return tokens;
}

/** Live provider swap pairs (per-pair sats limits). */
export async function getProviderPairs(): Promise<SwapPair[]> {
  if (pairsCache && Date.now() - pairsCache.at < REFERENCE_TTL_MS) return pairsCache.pairs;
  let raw: unknown;
  try {
    if (fetchOverrides?.getSwapPairs) raw = await fetchOverrides.getSwapPairs();
    else {
      const client = await getSatoraClient();
      raw = await withTimeout(client.getSwapPairs(), SATORA_READ_TIMEOUT_MS, "getSwapPairs");
    }
  } catch (err) {
    if (pairsCache) {
      referenceStale = true;
      return pairsCache.pairs;
    }
    throw err instanceof SatoraError ? err : new SatoraError("PROVIDER_UNAVAILABLE", "Route provider is temporarily unavailable.");
  }
  referenceStale = false;
  const pairs = (raw as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs)) throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned unexpected swap pairs.");
  const out: SwapPair[] = [];
  for (const p of pairs as Array<Record<string, unknown>>) {
    if (typeof p["source"] !== "string" || typeof p["target"] !== "string" || typeof p["min_sats"] !== "number" || typeof p["max_sats"] !== "number") {
      throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned an unexpected pair entry.");
    }
    out.push({ source: p["source"], target: p["target"], min_sats: p["min_sats"], max_sats: p["max_sats"] });
  }
  pairsCache = { at: Date.now(), pairs: out };
  return out;
}

export interface ResolvedRoute {
  asset: string;
  network: string;
  chainId: Chain;
  tokenAddress: string;
  tokenDecimals: number;
  minSats: number;
  maxSats: number;
}

/**
 * Pure token/pair resolution against a GIVEN catalogue snapshot.
 * Identity is contract + chain, never bare ticker: USDT0 ≠ classic USDT.
 * Throws SatoraError(ROUTE_NOT_QUOTEABLE) when the snapshot lacks the pair
 * — including classic USDT on Polygon, which is absent from the catalogue
 * (only USDT0/USDC are listed on 137; verified live, never assumed).
 * Unit-testable: disappearance/reappearance is just snapshot diffing.
 */
export function resolveRouteWith(
  tokens: ProviderToken[],
  pairs: SwapPair[],
  asset: string,
  network: string,
): ResolvedRoute {
  const chainId = CHAIN_IDS[network];
  if (!chainId) throw new SatoraError("UNSUPPORTED_ROUTE", `Network ${network} has no EVM chain mapping.`);
  const match = tokens.find((t) => t.symbol === asset && t.chain === chainId);
  if (!match) {
    throw new SatoraError("ROUTE_NOT_QUOTEABLE", `${asset} on ${network} is not offered by the route provider right now.`);
  }
  const pair = pairs.find((p) => p.source === "Lightning" && p.target === chainId);
  if (!pair) {
    throw new SatoraError("ROUTE_NOT_QUOTEABLE", `Lightning to ${network} is not offered by the route provider right now.`);
  }
  return {
    asset,
    network,
    chainId,
    tokenAddress: match.address,
    tokenDecimals: match.decimals,
    minSats: pair.min_sats,
    maxSats: pair.max_sats,
  };
}

/** Resolve a canonical (asset, network) pair against LIVE provider config. */
export async function resolveRoute(asset: string, network: string): Promise<ResolvedRoute> {
  const tokens = await getProviderTokens();
  const pairs = await getProviderPairs();
  return resolveRouteWith(tokens, pairs, asset, network);
}

export interface ExactQuote {
  requestedAtomic: string;
  netTargetAtomic: string;
  netSourceSats: string;
  sourceAtomicPreFee: string;
  exchangeRate: string;
  networkFeeSats: number;
  gaslessNetworkFeeSats: number;
  protocolFeeSats: number;
  protocolFeeRate: number;
  minSats: number;
  maxSats: number;
}

function assertAtomicString(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAtomicAmount(value)) {
    throw new SatoraError("PROVIDER_MALFORMED", `Route provider returned an invalid ${label}.`);
  }
  return value;
}

function assertSatsNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new SatoraError("PROVIDER_MALFORMED", `Route provider returned an invalid ${label}.`);
  }
  return value;
}

/**
 * Native exact-output quote: pin `targetAmount` (atomic bigint) and read back
 * `net_target_amount`. Throws when the provider does not honour exact output.
 * Creates nothing: read-only endpoint, no swap, no invoice.
 */
export async function getExactQuote(resolved: ResolvedRoute, targetAtomic: string): Promise<ExactQuote> {
  const client = await getSatoraClient();
  let raw: unknown;
  try {
    raw = await withTimeout(
      client.getQuote({
        sourceChain: "Lightning",
        sourceToken: "btc",
        targetChain: resolved.chainId,
        targetToken: resolved.tokenAddress,
        targetAmount: BigInt(targetAtomic),
      }),
      SATORA_READ_TIMEOUT_MS,
      "getQuote",
    );
  } catch (err) {
    throw err instanceof SatoraError ? err : new SatoraError("PROVIDER_UNAVAILABLE", "Route provider is temporarily unavailable.");
  }
  const q = raw as Record<string, unknown>;
  const netTarget = assertAtomicString(q["net_target_amount"], "net_target_amount");
  if (netTarget !== targetAtomic) {
    throw new SatoraError("INEXACT_QUOTE", "Provider did not honour the exact destination amount.");
  }
  const netSource = assertAtomicString(q["net_source_amount"], "net_source_amount");
  const sourcePreFee = assertAtomicString(q["source_amount"], "source_amount");
  const targetEcho = assertAtomicString(q["target_amount"], "target_amount");
  if (targetEcho !== targetAtomic) {
    throw new SatoraError("INEXACT_QUOTE", "Provider echo of the target amount differs.");
  }
  const networkFee = assertSatsNumber(q["network_fee"], "network_fee");
  const gaslessFee = assertSatsNumber(q["gasless_network_fee"], "gasless_network_fee");
  const protocolFee = assertSatsNumber(q["protocol_fee"], "protocol_fee");
  const rate = q["protocol_fee_rate"];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
    throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned an invalid protocol_fee_rate.");
  }
  const exchangeRate = q["exchange_rate"];
  if (typeof exchangeRate !== "string" || exchangeRate.length === 0) {
    throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned an invalid exchange_rate.");
  }
  const minSats = assertSatsNumber(q["min_amount"], "min_amount");
  const maxSats = assertSatsNumber(q["max_amount"], "max_amount");
  return {
    requestedAtomic: targetAtomic,
    netTargetAtomic: netTarget,
    netSourceSats: netSource,
    sourceAtomicPreFee: sourcePreFee,
    exchangeRate,
    networkFeeSats: networkFee,
    gaslessNetworkFeeSats: gaslessFee,
    protocolFeeSats: protocolFee,
    protocolFeeRate: rate,
    minSats,
    maxSats,
  };
}

/**
 * Verified provider swap facts (safe subset of GetSwapResponse).
 * Never carries secrets: no preimage, mnemonic, or private material exists
 * in this shape — only public identifiers and amounts.
 */
export interface VerifiedSwapFacts {
  satoraSwapId: string;
  direction: string;
  bolt11Invoice: string;
  paymentHash: string;
  sourceSats: string;
  targetAtomic: string;
  evmChainId: number;
  targetAddress: string;
  targetTokenAddress: string;
  targetTokenChainId: number;
  status: string;
  invoiceExpiresAt: Date | null;
  feeSats: number;
  /** Non-secret on-chain identifiers echoed by the provider, when present. */
  evmHtlcAddress: string | null;
  evmFundTxid: string | null;
  evmClaimTxid: string | null;
  /**
   * P2: Satora `evm_refund_locktime` (unix seconds) — the Polygon claim
   * deadline, fixed at swap CREATION. Null when the provider omits it or it
   * is not a positive safe integer. Plausibility is checked by callers
   * against the bind time (src/domain/claim-deadline.ts).
   */
  evmRefundLocktime: number | null;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
    throw new SatoraError("PROVIDER_MALFORMED", `Route provider returned an invalid ${label}.`);
  }
  return value;
}

/**
 * Read-only provider swap lookup (GET /swap/:id equivalent via the SDK).
 * Used to verify client-attached swaps; never creates anything.
 * Throws SatoraError(SWAP_NOT_FOUND) when the provider has no such swap.
 */
export async function getProviderSwap(swapId: string): Promise<VerifiedSwapFacts> {
  if (typeof swapId !== "string" || swapId.length === 0 || swapId.length > 128) {
    throw new SatoraError("SWAP_NOT_FOUND", "Provider has no such swap.");
  }
  let raw: unknown;
  try {
    const pending = fetchOverrides?.getSwap ? fetchOverrides.getSwap(swapId) : (async () => { const client = await getSatoraClient(); return client.getSwap(swapId); })();
    raw = await withTimeout(pending, SATORA_READ_TIMEOUT_MS, "getSwap");
  } catch (err) {
    if (err instanceof SatoraError) throw err;
    // Providers commonly signal unknown ids with HTTP 404.
    if ((err as { code?: unknown }).code === 404) throw new SatoraError("SWAP_NOT_FOUND", "Provider has no such swap.");
    throw new SatoraError("PROVIDER_UNAVAILABLE", "Route provider is temporarily unavailable.");
  }
  const s = raw as Record<string, unknown>;
  if (typeof s["id"] !== "string" || typeof s["bolt11_invoice"] !== "string") {
    throw new SatoraError("SWAP_NOT_FOUND", "Provider has no such swap.");
  }
  const targetToken = s["target_token"] as Record<string, unknown> | undefined;
  // Provider schema (lendaswap OpenAPI TokenInfo): { chain, decimals, name,
  // symbol, token_id } — there are NO address/chain_id fields. Token identity
  // is token_id ("btc" or the 0x contract address) + chain ("137", …).
  // Reading address/chain_id here rejected EVERY swap as malformed (P0).
  // The numeric chain id also echoes at response level; prefer it.
  const tokenId = typeof targetToken?.["token_id"] === "string" ? (targetToken["token_id"] as string) : null;
  const tokenAddress = tokenId !== null && tokenId !== "btc" && tokenId.length > 0 ? tokenId : null;
  const tokenChainId = typeof s["evm_chain_id"] === "number" ? (s["evm_chain_id"] as number) : null;
  if (!tokenAddress || tokenChainId === null) {
    throw new SatoraError("PROVIDER_MALFORMED", "Route provider returned a swap without token identity.");
  }
  let invoiceExpiresAt: Date | null = null;
  const rawExpiry = s["invoice_expires_at"];
  if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry) && rawExpiry > 0) {
    invoiceExpiresAt = new Date(rawExpiry * 1000);
  }
  const readTxid = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
  return {
    satoraSwapId: s["id"] as string,
    direction: typeof s["direction"] === "string" ? (s["direction"] as string) : "",
    bolt11Invoice: s["bolt11_invoice"] as string,
    paymentHash: assertNonEmptyString(s["hash_lock"], "hash_lock"),
    sourceSats: assertAtomicString(s["source_amount"], "source_amount"),
    targetAtomic: assertAtomicString(s["target_amount"], "target_amount"),
    evmChainId: assertSatsNumber(s["evm_chain_id"], "evm_chain_id"),
    targetAddress: assertNonEmptyString(s["target_evm_address"], "target_evm_address"),
    targetTokenAddress: tokenAddress,
    targetTokenChainId: tokenChainId,
    status: typeof s["status"] === "string" ? (s["status"] as string) : "",
    invoiceExpiresAt,
    feeSats: typeof s["fee_sats"] === "number" && Number.isFinite(s["fee_sats"]) ? (s["fee_sats"] as number) : 0,
    evmHtlcAddress: readTxid(s["evm_htlc_address"] ?? s["evmHtlcAddress"]),
    evmFundTxid: readTxid(s["evm_fund_txid"] ?? s["evmFundTxid"]),
    evmClaimTxid: readTxid(s["evm_claim_txid"] ?? s["evmClaimTxid"]),
    evmRefundLocktime: (() => {
      const raw = s["evm_refund_locktime"];
      return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
    })(),
  };
}

/** Test hook: clear reference-data caches. */
export function resetSatoraCachesForTests(): void {
  tokensCache = null;
  pairsCache = null;
  referenceStale = false;
}

/** Test hook: backdate caches so the next read exercises the refresh path. */
export function expireSatoraCachesForTests(): void {
  if (tokensCache) tokensCache = { at: 0, tokens: tokensCache.tokens };
  if (pairsCache) pairsCache = { at: 0, pairs: pairsCache.pairs };
}
