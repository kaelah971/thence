"use client";

import { ROUTE_IDS, type RouteId } from "@/domain/routes";
import { apiRequest, type ApiOptions, type ApiResult } from "./api";
import { useApiResource } from "./resource";

/** Shape of GET /api/routes/public (src/lib/quotes.ts `PublicRouteInfo`). */
export interface ApiPublicRoute {
  id: string;
  asset: string;
  network: string;
  enabled: boolean;
  supported: boolean;
  quoteable: boolean;
  status: "live" | "disabled" | "unsupported" | "unavailable-token" | "unavailable-provider" | "unknown" | "host-dependent";
  /** Verified token precision from the live provider catalogue (null unless live). */
  tokenDecimals?: number | null;
  /** Verified ERC-20 contract address (server-provided, never invented client-side). */
  tokenAddress?: string | null;
  /** Canonical EVM chain id as a string ("137", …). */
  chainId?: string | null;
}

/** Verified ERC-20 contract address for a payable route, or null when not live. */
export function tokenAddressFor(routeId: RouteId, catalogue: RouteCatalogue | null): string | null {
  const route = catalogue?.routes.find((r) => r.id === routeId);
  const address = route?.tokenAddress;
  return typeof address === "string" && address.length > 0 ? address : null;
}

/** Numeric EVM chain id for a payable route, or null when not live/unknown. */
export function evmChainIdFor(routeId: RouteId, catalogue: RouteCatalogue | null): number | null {
  const route = catalogue?.routes.find((r) => r.id === routeId);
  const raw = route?.chainId;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Verified token decimals for a payable route, or null when the route isn't live. */
export function tokenDecimalsFor(routeId: RouteId, catalogue: RouteCatalogue | null): number | null {
  if (availabilityFor(routeId, catalogue).availability !== "available") return null;
  const decimals = catalogue?.routes.find((r) => r.id === routeId)?.tokenDecimals;
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : null;
}

export interface RouteCatalogue {
  routes: ApiPublicRoute[];
  providerFresh: boolean;
}

export type Availability = "available" | "host-dependent" | "unavailable" | "unknown";

export interface RouteAvailability {
  availability: Availability;
  /** Plain-language note for the picker. */
  note: string | null;
}

export function fetchRouteCatalogue(opts: Pick<ApiOptions, "signal" | "fetch"> = {}): Promise<ApiResult<RouteCatalogue>> {
  return apiRequest<RouteCatalogue>("/api/routes/public", opts);
}

/**
 * Availability comes only from the server. A route can be supported in the
 * registry and still not be payable; failure to load means "unknown",
 * never "available".
 */
export function availabilityFor(routeId: RouteId, catalogue: RouteCatalogue | null): RouteAvailability {
  const route = catalogue?.routes.find((r) => r.id === routeId);
  if (!catalogue || !route) return { availability: "unknown", note: "Availability can't be checked right now" };
  if (route.status === "host-dependent") return { availability: "host-dependent", note: "Depends on Nimiq Pay" };
  if (route.status === "live" && route.quoteable && route.enabled && route.supported) {
    return { availability: "available", note: catalogue.providerFresh ? null : "Availability may be out of date" };
  }
  if (route.status === "unknown") return { availability: "unknown", note: "Availability can't be checked right now" };
  return { availability: "unavailable", note: "Not available right now" };
}

const ORDER: Record<Availability, number> = { available: 0, "host-dependent": 1, unknown: 2, unavailable: 3 };

export function sortByAvailability(routeIds: readonly RouteId[], catalogue: RouteCatalogue | null): RouteId[] {
  return [...routeIds].sort((a, b) => ORDER[availabilityFor(a, catalogue).availability] - ORDER[availabilityFor(b, catalogue).availability]);
}

export type CatalogueState =
  | { status: "loading" }
  | { status: "ready"; catalogue: RouteCatalogue }
  | { status: "error"; retry: () => void };

/** Public catalogue (no session needed). */
export function useRouteCatalogue(): CatalogueState {
  const resource = useApiResource<RouteCatalogue>("routes-public", (signal) => fetchRouteCatalogue({ signal }));
  if (resource.status === "ready") return { status: "ready", catalogue: resource.data };
  if (resource.status === "error") return { status: "error", retry: resource.retry };
  return { status: "loading" };
}

export const ALL_ROUTES: readonly RouteId[] = ROUTE_IDS;
