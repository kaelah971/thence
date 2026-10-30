/**
 * Thence backend — exact-receive quote service, primary NIM-funded route (B3.1).
 *
 * Product promise: "Recipient receives X" for a supported asset/network,
 * funded from NIM via Nimiq Pay → Lightning. This slice is READ-ONLY:
 * quoting never creates a swap, invoice, approval, transfer or payment.
 *
 * Exactness: the provider natively pins `targetAmount` (atomic units) and
 * echoes `net_target_amount`; we reject anything else. All money math uses
 * atomic-unit strings/integers (money.ts) — never floats.
 *
 * Freshness: the provider response carries no expiry, so `validUntil` is a
 * LOCAL estimate (THENCE_QUOTE_TTL_SECONDS). B4 must revalidate executable
 * terms before any handoff. A quote is never a settlement promise.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { paymentRequests, routeObservations } from "@/db/schema";
import { getEnv, parseEnabledRoutes } from "@/lib/env";
import { atomicToDecimal, isAtomicAmount, parseAtomicAmount } from "@/domain/money";
import { ROUTE_IDS, isSupportedPair, kindForRouteId, pairForRouteId } from "@/domain/routes";
import {
  SatoraError,
  getExactQuote,
  getProviderPairs,
  getProviderTokens,
  isProviderReferenceStale,
  resolveRoute,
} from "@/lib/satora";

export const quoteRequestSchema = z.object({
  routeId: z.string().min(1, "routeId is required."),
  /** Exact recipient amount in atomic units (canonical uint string). */
  targetAmountAtomic: z.string().min(1, "targetAmountAtomic is required.").max(78),
  /** Optional payment-request public id: terms are taken from its snapshot. */
  requestId: z.string().min(1).max(64).nullable().optional(),
});

export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

export interface QuoteFees {
  networkFeeSats: number;
  gaslessNetworkFeeSats: number;
  protocolFeeSats: number;
  protocolFeeRate: number;
  unit: "sats";
}

export interface QuoteResponse {
  routeId: string;
  asset: string;
  network: string;
  chainId: string;
  targetAmountAtomic: string;
  targetAmount: string;
  netTargetAmountAtomic: string;
  exact: true;
  sourceAmountSats: string;
  /** Pre-fee source amount; net = pre-fee + all sats fees, integer-exact. */
  sourceAmountPreFeeSats: string;
  sourceChain: "Lightning";
  fees: QuoteFees;
  limits: { minSats: number; maxSats: number };
  exchangeRate: string;
  exchangeRateNote: string;
  observedAt: string;
  validUntil: string;
  validityNote: string;
  availability: "available";
  settlementProven: false;
  settlementNote: string;
  warnings: string[];
}

const KNOWN_ROUTE_IDS = new Set<string>(ROUTE_IDS as readonly string[]);

function toAuthError(err: unknown): AuthError {
  if (err instanceof AuthError) return err;
  if (err instanceof SatoraError) {
    const status =
      err.code === "PROVIDER_TIMEOUT" || err.code === "PROVIDER_UNAVAILABLE" ? 503 : 400;
    return new AuthError(status, err.code, err.message);
  }
  return new AuthError(500, "QUOTE_FAILED", "Could not obtain a quote.");
}

/** Canonical decimals for registry assets (matches provider token list). */
const ASSET_DECIMALS: Record<string, number> = { USDT: 6, USDC: 6, BTC: 8 };

export function humanAmount(asset: string, atomic: string): string {
  return atomicToDecimal(atomic, ASSET_DECIMALS[asset] ?? 6);
}

/** Record a non-sensitive availability observation (diagnostics, not a promise). */
async function recordObservation(routeId: string, quote: { minSats: number; maxSats: number; networkFeeSats: number; gaslessNetworkFeeSats: number; protocolFeeSats: number }): Promise<void> {
  try {
    await getDb().insert(routeObservations).values({
      routeId,
      minAtomic: String(quote.minSats),
      maxAtomic: String(quote.maxSats),
      feeAtomic: String(quote.networkFeeSats + quote.gaslessNetworkFeeSats + quote.protocolFeeSats),
      source: "satora-quote",
    });
  } catch {
    // Diagnostics must never fail the quote itself.
  }
}

export async function createQuote(body: unknown): Promise<QuoteResponse> {
  const parsed = quoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AuthError(400, "BAD_BODY", parsed.error.issues[0]?.message ?? "Invalid quote request.");
  }
  const { routeId, requestId } = parsed.data;
  let { targetAmountAtomic } = parsed.data;
  if (!KNOWN_ROUTE_IDS.has(routeId)) {
    throw new AuthError(400, "UNKNOWN_ROUTE", `Route ${routeId} is not a known Thence route.`);
  }
  const env = getEnv();
  if (!parseEnabledRoutes(env.THENCE_ENABLED_ROUTES).includes(routeId)) {
    throw new AuthError(400, "ROUTE_DISABLED", `Route ${routeId} is not enabled.`);
  }
  const pair = pairForRouteId(routeId);
  if (!pair) throw new AuthError(400, "UNKNOWN_ROUTE", `Route ${routeId} is not a known Thence route.`);
  if (!isSupportedPair(pair.asset, pair.network)) {
    throw new AuthError(400, "UNSUPPORTED_ROUTE", `Route ${routeId} is not a supported asset/network pair.`);
  }
  // Optional payment-request snapshot: terms come from the immutable record.
  if (requestId !== undefined && requestId !== null) {
    const rows = await getDb().select().from(paymentRequests).where(eq(paymentRequests.publicId, requestId)).limit(1);
    const req = rows[0];
    if (!req) throw new AuthError(404, "REQUEST_NOT_FOUND", "Payment request not found.");
    if (req.cancelledAt) throw new AuthError(409, "REQUEST_CANCELLED", "Payment request was cancelled.");
    if (req.expiresAt && req.expiresAt.getTime() <= Date.now()) {
      throw new AuthError(409, "REQUEST_EXPIRED", "Payment request has expired.");
    }
    if (req.asset !== pair.asset || req.network !== pair.network) {
      throw new AuthError(400, "SNAPSHOT_MISMATCH", "Payment request terms do not match this route.");
    }
    if (targetAmountAtomic !== req.amountAtomic) {
      throw new AuthError(400, "SNAPSHOT_MISMATCH", "Quoted amount must equal the payment request amount.");
    }
    targetAmountAtomic = req.amountAtomic;
  }
  if (!isAtomicAmount(targetAmountAtomic) || parseAtomicAmount(targetAmountAtomic) === 0n) {
    throw new AuthError(400, "BAD_AMOUNT", "targetAmountAtomic must be a positive atomic integer string.");
  }
  let resolved;
  try {
    resolved = await resolveRoute(pair.asset, pair.network);
  } catch (err) {
    throw toAuthError(err);
  }
  // Atomic precision guard: the amount must fit the asset's decimals is
  // inherent to atomic strings; provider decides economic viability.
  let quote;
  try {
    quote = await getExactQuote(resolved, targetAmountAtomic);
  } catch (err) {
    throw toAuthError(err);
  }
  assertSourceBounds(quote.netSourceSats, quote.minSats, quote.maxSats);
  await recordObservation(routeId, quote);
  return buildQuoteResponse({
    routeId,
    asset: pair.asset,
    network: pair.network,
    chainId: resolved.chainId,
    targetAmountAtomic,
    quote,
    observedAt: new Date(),
    ttlSeconds: env.THENCE_QUOTE_TTL_SECONDS,
  });
}

/** Provider-side source bounds check (pure; bigint-exact, no floats). */
export function assertSourceBounds(netSourceSats: string, minSats: number, maxSats: number): void {
  const netSource = BigInt(netSourceSats);
  if (netSource < BigInt(minSats)) {
    throw new AuthError(400, "BELOW_MINIMUM", `Required source of ${netSourceSats} sats is below the route minimum of ${minSats} sats.`);
  }
  if (netSource > BigInt(maxSats)) {
    throw new AuthError(400, "ABOVE_MAXIMUM", `Required source of ${netSourceSats} sats exceeds the route maximum of ${maxSats} sats.`);
  }
}

export interface BuiltQuoteInput {
  routeId: string;
  asset: string;
  network: string;
  chainId: string;
  targetAmountAtomic: string;
  quote: {
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
  };
  observedAt: Date;
  ttlSeconds: number;
}

/** Pure quote-response constructor (unit-testable; no network, no clock). */
export function buildQuoteResponse(input: BuiltQuoteInput): QuoteResponse {
  const { routeId, asset, network, chainId, targetAmountAtomic, quote, observedAt, ttlSeconds } = input;
  const netSource = BigInt(quote.netSourceSats);
  const validUntil = new Date(observedAt.getTime() + ttlSeconds * 1000);
  const warnings: string[] = [];
  if (netSource < BigInt(quote.minSats) * 2n) {
    warnings.push("Amount is close to the route minimum; re-quote before approving.");
  }
  return {
    routeId,
    asset,
    network,
    chainId,
    targetAmountAtomic,
    targetAmount: humanAmount(asset, targetAmountAtomic),
    netTargetAmountAtomic: quote.netTargetAtomic,
    exact: true,
    sourceAmountSats: quote.netSourceSats,
    sourceAmountPreFeeSats: quote.sourceAtomicPreFee,
    sourceChain: "Lightning",
    fees: {
      networkFeeSats: quote.networkFeeSats,
      gaslessNetworkFeeSats: quote.gaslessNetworkFeeSats,
      protocolFeeSats: quote.protocolFeeSats,
      protocolFeeRate: quote.protocolFeeRate,
      unit: "sats",
    },
    limits: { minSats: quote.minSats, maxSats: quote.maxSats },
    exchangeRate: quote.exchangeRate,
    exchangeRateNote: "EVM token per BTC, as reported by the provider.",
    observedAt: observedAt.toISOString(),
    validUntil: validUntil.toISOString(),
    validityNote: `Local estimate only (TTL ${ttlSeconds}s); the provider issues no expiry and B4 revalidates before any handoff.`,
    availability: "available",
    settlementProven: false,
    settlementNote: "A quote is not a settlement promise; Delivered requires destination evidence.",
    warnings,
  };
}


export type RouteStatus =
  | "live"
  | "disabled"
  | "unsupported"
  | "unavailable-token"
  | "unavailable-provider"
  | "unknown"
  | "host-dependent";

export interface PublicRouteInfo {
  id: string;
  asset: string;
  network: string;
  kind: string;
  enabled: boolean;
  supported: boolean;
  quoteable: boolean;
  /** Machine-readable classification (B3.2 route matrix). */
  status: RouteStatus;
  availabilityReason: string;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  tokenAddress: string | null;
  chainId: string | null;
  limitsSats: { min: number; max: number } | null;
  lastObservedAt: string | null;
}

/** Public route catalogue with live availability (no secrets, no private config). */
export async function listPublicRoutes(): Promise<{ routes: PublicRouteInfo[]; providerFresh: boolean }> {
  const env = getEnv();
  const enabled = new Set(parseEnabledRoutes(env.THENCE_ENABLED_ROUTES));
  let tokens: Awaited<ReturnType<typeof getProviderTokens>> = [];
  let pairs: Awaited<ReturnType<typeof getProviderPairs>> = [];
  let providerOk = true;
  try {
    [tokens, pairs] = await Promise.all([getProviderTokens(), getProviderPairs()]);
  } catch {
    providerOk = false;
  }
  // Stale-serving fallback inside the adapter may still yield data; surfaced honestly.
  const providerFresh = providerOk && !isProviderReferenceStale();
  const db = getDb();
  const routes: PublicRouteInfo[] = [];
  for (const id of ROUTE_IDS) {
    const pair = pairForRouteId(id);
    const isEnabled = enabled.has(id);
    const supported = pair !== null && isSupportedPair(pair.asset, pair.network);
    let quoteable = false;
    let status: RouteStatus = "disabled";
    let reason = "Route is disabled.";
    let tokenSymbol: string | null = null;
    let tokenDecimals: number | null = null;
    let tokenAddress: string | null = null;
    let chainId: string | null = null;
    let limits: { min: number; max: number } | null = null;
    if (id === "btc-lightning") {
      // Nimiq-native route: approved/funded inside Nimiq Pay, never a Satora EVM quote.
      status = "host-dependent";
      reason = "Nimiq Pay native route; not a Satora EVM quote.";
    } else if (pair && isEnabled && supported) {
      if (!providerOk) {
        status = "unknown";
        reason = "Provider temporarily unavailable.";
      } else {
        try {
          const resolved = await resolveRoute(pair.asset, pair.network);
          quoteable = true;
          status = "live";
          reason = "Available for quoting; settlement not proven.";
          tokenSymbol = pair.asset;
          tokenDecimals = resolved.tokenDecimals;
          tokenAddress = resolved.tokenAddress;
          chainId = resolved.chainId;
          limits = { min: resolved.minSats, max: resolved.maxSats };
        } catch (err) {
          if (err instanceof SatoraError && err.code === "ROUTE_NOT_QUOTEABLE") {
            status = "unavailable-token";
          } else {
            status = "unknown";
          }
          reason = err instanceof Error ? err.message : "Not currently quoteable.";
        }
      }
    } else if (pair && supported && !isEnabled) {
      status = "disabled";
      reason = "Route is disabled.";
    } else if (!supported) {
      status = "unsupported";
      reason = "Unsupported asset/network pair.";
    }
    let lastObservedAt: string | null = null;
    try {
      const obs = await db
        .select({ observedAt: routeObservations.observedAt })
        .from(routeObservations)
        .where(and(eq(routeObservations.routeId, id)))
        .orderBy(desc(routeObservations.observedAt))
        .limit(1);
      lastObservedAt = obs[0]?.observedAt?.toISOString() ?? null;
    } catch {
      lastObservedAt = null;
    }
    routes.push({
      id,
      asset: pair?.asset ?? "",
      network: pair?.network ?? "",
      kind: kindForRouteId(id) ?? "unknown",
      enabled: isEnabled,
      supported,
      quoteable,
      status,
      availabilityReason: reason,
      tokenSymbol,
      tokenDecimals,
      tokenAddress,
      chainId,
      limitsSats: limits,
      lastObservedAt,
    });
  }
  return { routes, providerFresh };
}
