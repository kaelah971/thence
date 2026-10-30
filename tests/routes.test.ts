import { describe, expect, it } from "vitest";
import {
  ROUTE_IDS,
  buildRouteRegistry,
  getRoute,
  isSupportedPair,
  quoteableRoutes,
  validateRouteForQuote,
} from "@/domain/routes";

const VERIFIED = "0x0000000000000000000000000000000000000001";

describe("canonical route registry (B0)", () => {
  it("covers the PRD §11.1 routes plus provider-driven additions", () => {
    expect([...ROUTE_IDS]).toEqual([
      "usdt-polygon",
      "usdt-arbitrum",
      // B3.1: the provider lists USDC (not classic USDT) on Polygon.
      "usdc-polygon",
      "usdc-arbitrum",
      "usdc-ethereum",
      "usdc-base",
      "btc-lightning",
    ]);
  });

  it("validates supported asset/network pairs", () => {
    expect(isSupportedPair("USDT", "Polygon")).toBe(true);
    expect(isSupportedPair("USDC", "Polygon")).toBe(true); // B3.1 provider reality
    expect(isSupportedPair("USDC", "Base")).toBe(true);
    expect(isSupportedPair("BTC", "Lightning")).toBe(true);
    expect(isSupportedPair("USDT", "Base")).toBe(false); // not in matrix
    expect(isSupportedPair("ETH", "Ethereum")).toBe(false);
  });

  it("keeps routes non-quoteable without verified env tokens (no guessing)", () => {
    const routes = buildRouteRegistry({ enabledRouteIds: ["usdt-polygon"], verifiedTokens: {} });
    const route = getRoute(routes, "usdt-polygon");
    expect(route?.enabled).toBe(true);
    expect(route?.quoteable).toBe(false);
    expect(route?.targetToken).toBeNull();
    expect(validateRouteForQuote(route)).toEqual({ ok: false, issue: "TOKEN_UNVERIFIED" });
    expect(quoteableRoutes(routes)).toHaveLength(0);
  });

  it("marks an EVM route quoteable only with a verified token from env", () => {
    const routes = buildRouteRegistry({
      enabledRouteIds: ["usdt-polygon"],
      verifiedTokens: { "usdt-polygon": VERIFIED },
    });
    const route = getRoute(routes, "usdt-polygon");
    expect(route?.targetToken).toBe(VERIFIED);
    expect(validateRouteForQuote(route)).toEqual({ ok: true });
  });

  it("enables BTC Lightning without a token address", () => {
    const routes = buildRouteRegistry({ enabledRouteIds: ["btc-lightning"], verifiedTokens: {} });
    const route = getRoute(routes, "btc-lightning");
    expect(route?.targetToken).toBeNull();
    expect(validateRouteForQuote(route)).toEqual({ ok: true });
  });

  it("rejects unknown routes and disabled routes", () => {
    const routes = buildRouteRegistry({ enabledRouteIds: [], verifiedTokens: {} });
    expect(getRoute(routes, "doge-moon")).toBeNull();
    expect(validateRouteForQuote(null)).toEqual({ ok: false, issue: "UNKNOWN_ROUTE" });
    const disabled = getRoute(routes, "usdt-polygon");
    expect(validateRouteForQuote(disabled)).toEqual({ ok: false, issue: "ROUTE_DISABLED" });
  });

  it("suspended routes cannot continue to quote", () => {
    const routes = buildRouteRegistry({
      enabledRouteIds: ["btc-lightning"],
      verifiedTokens: {},
      suspendedRouteIds: ["btc-lightning"],
    });
    const route = getRoute(routes, "btc-lightning");
    expect(route?.enabled).toBe(true);
    expect(route?.quoteable).toBe(false);
    expect(validateRouteForQuote(route)).toEqual({ ok: false, issue: "ROUTE_NOT_QUOTEABLE" });
  });
});
