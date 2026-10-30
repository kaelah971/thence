import { ROUTE_IDS, pairForRouteId, type RouteId, type SupportedAsset, type SupportedNetwork } from "@/domain/routes";

export interface AssetMeta {
  code: SupportedAsset;
  name: string;
  /** Decimal places a person may enter in the amount sheet. */
  entryDecimals: number;
  /** On-chain precision (matches backend ASSET_DECIMALS). */
  chainDecimals: number;
}

export const ASSET_META: Record<SupportedAsset, AssetMeta> = {
  USDC: { code: "USDC", name: "USD Coin", entryDecimals: 2, chainDecimals: 6 },
  USDT: { code: "USDT", name: "Tether USD", entryDecimals: 2, chainDecimals: 6 },
  BTC: { code: "BTC", name: "Bitcoin", entryDecimals: 8, chainDecimals: 8 },
};

export interface Destination {
  routeId: RouteId;
  asset: SupportedAsset;
  network: SupportedNetwork;
  /** "USDC · Polygon" */
  label: string;
  /** "USDC on Polygon" */
  sentence: string;
}

export function destinationFor(routeId: RouteId): Destination {
  const pair = pairForRouteId(routeId);
  if (!pair) throw new Error(`Unknown route ${routeId}`);
  return {
    routeId,
    asset: pair.asset,
    network: pair.network,
    label: `${pair.asset} · ${pair.network}`,
    sentence: `${pair.asset} on ${pair.network}`,
  };
}

/**
 * Every destination the backend registry knows about. Whether one can be
 * paid right now comes only from GET /api/routes/public (routes-api.ts).
 */
export const DESTINATIONS: readonly Destination[] = ROUTE_IDS.map(destinationFor);

export const DEFAULT_DESTINATION: RouteId = "usdc-polygon";

export function isEvmNetwork(network: SupportedNetwork): boolean {
  return network !== "Lightning";
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Nimiq user-friendly address: "NQ" + 2 check digits + 32 base32 chars, often spaced in groups of 4. */
const NIMIQ_ADDRESS_RE = /^NQ\d{2}(\s?[0-9A-Z]{4}){8}$/i;

export function looksLikeNimiqAddress(value: string): boolean {
  return NIMIQ_ADDRESS_RE.test(value.trim());
}

/** Light client-side shape check only. The backend remains the authority. */
export function destinationAddressIssue(network: SupportedNetwork, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter the address they gave you.";
  if (isEvmNetwork(network) && looksLikeNimiqAddress(trimmed)) {
    return `That's a Nimiq address. ${network} needs a wallet address that starts with 0x.`;
  }
  if (isEvmNetwork(network) && !EVM_ADDRESS_RE.test(trimmed)) {
    return `That doesn't look like a ${network} address. It should start with 0x and be 42 characters long.`;
  }
  return null;
}

export function maskAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
