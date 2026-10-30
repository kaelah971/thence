/**
 * Thence backend — canonical settlement route types (B0).
 *
 * Source: PRD §11 (route registry). Supported asset/network pairs only.
 * Provider contract addresses are ENVIRONMENT-SPECIFIC and VERIFIED —
 * they are never guessed, never hard-coded, and never committed here.
 * A route is `quoteable` only when: enabled AND token verified (for EVM
 * routes) AND not temporarily suspended. Otherwise it must not continue
 * to quote/handoff.
 */

export const SUPPORTED_ASSETS = ["USDT", "USDC", "BTC"] as const;
export type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

export const SUPPORTED_NETWORKS = [
  "Polygon",
  "Arbitrum",
  "Ethereum",
  "Base",
  "Lightning",
] as const;
export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

export const ROUTE_KINDS = ["satora-direct", "satora-cctp", "nimiq-lightning"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Canonical route identifiers. */
export const ROUTE_IDS = [
  "usdt-polygon",
  "usdt-arbitrum",
  "usdc-polygon",
  "usdc-arbitrum",
  "usdc-ethereum",
  "usdc-base",
  "btc-lightning",
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export interface SettlementRoute {
  id: RouteId;
  asset: SupportedAsset;
  network: SupportedNetwork;
  kind: RouteKind;
  /** EVM target token contract — ONLY from verified env config, never guessed. Null for Lightning. */
  targetToken: `0x${string}` | null;
  enabled: boolean;
  quoteable: boolean;
  /** Atomic-unit bounds as canonical uint strings (see domain/money.ts). Null = unbounded. */
  minAtomic: string | null;
  maxAtomic: string | null;
}

/** Static route identity table — amounts/availability are dynamic, tokens come from env. */
const ROUTE_IDENTITY: Record<RouteId, { asset: SupportedAsset; network: SupportedNetwork; kind: RouteKind; needsToken: boolean }> = {
  "usdt-polygon": { asset: "USDT", network: "Polygon", kind: "satora-direct", needsToken: true },
  "usdt-arbitrum": { asset: "USDT", network: "Arbitrum", kind: "satora-direct", needsToken: true },
  /* B3.1: the provider lists USDC (not classic USDT) on Polygon — the
     canonical registry follows provider reality, not the PRD draft. */
  "usdc-polygon": { asset: "USDC", network: "Polygon", kind: "satora-direct", needsToken: true },
  "usdc-arbitrum": { asset: "USDC", network: "Arbitrum", kind: "satora-direct", needsToken: true },
  "usdc-ethereum": { asset: "USDC", network: "Ethereum", kind: "satora-direct", needsToken: true },
  "usdc-base": { asset: "USDC", network: "Base", kind: "satora-cctp", needsToken: true },
  "btc-lightning": { asset: "BTC", network: "Lightning", kind: "nimiq-lightning", needsToken: false },
};

export interface RouteRegistryInput {
  enabledRouteIds: string[];
  /** Verified token addresses keyed by route id (from env). Absent = unverified. */
  verifiedTokens: Record<string, string>;
  suspendedRouteIds?: string[];
  minAtomic?: Record<string, string>;
  maxAtomic?: Record<string, string>;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build the canonical registry. Unknown ids in `enabledRouteIds` are ignored
 * (never invented as routes). A route is quoteable only when enabled, not
 * suspended, and — for EVM routes — carrying a verified token address.
 */
export function buildRouteRegistry(input: RouteRegistryInput): SettlementRoute[] {
  const enabled = new Set(input.enabledRouteIds.map((s) => s.trim()).filter(Boolean));
  const suspended = new Set((input.suspendedRouteIds ?? []).map((s) => s.trim()).filter(Boolean));
  return (Object.keys(ROUTE_IDENTITY) as RouteId[]).map((id) => {
    const identity = ROUTE_IDENTITY[id];
    const isEnabled = enabled.has(id);
    const isSuspended = suspended.has(id);
    let targetToken: `0x${string}` | null = null;
    if (identity.needsToken) {
      const candidate = input.verifiedTokens[id];
      if (typeof candidate === "string" && EVM_ADDRESS_RE.test(candidate)) {
        targetToken = candidate as `0x${string}`;
      }
    }
    const tokenOk = identity.needsToken ? targetToken !== null : true;
    const minAtomic = input.minAtomic?.[id] ?? null;
    const maxAtomic = input.maxAtomic?.[id] ?? null;
    return {
      id,
      asset: identity.asset,
      network: identity.network,
      kind: identity.kind,
      targetToken,
      enabled: isEnabled,
      quoteable: isEnabled && !isSuspended && tokenOk,
      minAtomic,
      maxAtomic,
    };
  });
}

/** Find one route by id, or null for unknown ids. */
export function getRoute(routes: SettlementRoute[], id: string): SettlementRoute | null {
  return routes.find((r) => r.id === id) ?? null;
}

/** Canonical asset/network pair for a route id, or null for unknown ids. */
export function pairForRouteId(id: string): { asset: SupportedAsset; network: SupportedNetwork } | null {
  const identity = (ROUTE_IDENTITY as Record<string, { asset: SupportedAsset; network: SupportedNetwork }>)[id];
  return identity ? { asset: identity.asset, network: identity.network } : null;
}

/** Canonical route kind for a route id, or null for unknown ids. */
export function kindForRouteId(id: string): RouteKind | null {
  const identity = (ROUTE_IDENTITY as Record<string, { kind: RouteKind }>)[id];
  return identity?.kind ?? null;
}

/** Canonical route id for a supported asset/network pair, or null. */
export function routeIdForPair(asset: string, network: string): RouteId | null {
  for (const [id, identity] of Object.entries(ROUTE_IDENTITY) as Array<[RouteId, { asset: string; network: string }]>) {
    if (identity.asset === asset && identity.network === network) return id;
  }
  return null;
}

/** Validate an asset/network pair against the canonical matrix. */
export function isSupportedPair(asset: string, network: string): boolean {
  return (Object.values(ROUTE_IDENTITY) as { asset: string; network: string }[]).some(
    (r) => r.asset === asset && r.network === network,
  );
}

/** Routes that may proceed to quoting. */
export function quoteableRoutes(routes: SettlementRoute[]): SettlementRoute[] {
  return routes.filter((r) => r.quoteable);
}

export type RouteValidationIssue =
  | "UNKNOWN_ROUTE"
  | "ROUTE_DISABLED"
  | "ROUTE_NOT_QUOTEABLE"
  | "TOKEN_UNVERIFIED";

export function validateRouteForQuote(route: SettlementRoute | null): { ok: true } | { ok: false; issue: RouteValidationIssue } {
  if (!route) return { ok: false, issue: "UNKNOWN_ROUTE" };
  if (!route.enabled) return { ok: false, issue: "ROUTE_DISABLED" };
  if (!route.quoteable) {
    const identity = ROUTE_IDENTITY[route.id];
    if (identity.needsToken && route.targetToken === null) {
      return { ok: false, issue: "TOKEN_UNVERIFIED" };
    }
    return { ok: false, issue: "ROUTE_NOT_QUOTEABLE" };
  }
  return { ok: true };
}
