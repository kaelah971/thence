/**
 * B3.2 — multi-route availability, catalogue freshness, and the Home
 * estimate contract (plus live exact quotes for every currently offered
 * EVM route). Read-only throughout: no swap, invoice, approval or payment.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { transfers, users } from "@/db/schema";
import { getSendValueEstimate } from "@/domain/estimates";
import {
  SatoraError,
  expireSatoraCachesForTests,
  getExactQuote,
  getProviderPairs,
  getProviderTokens,
  isProviderReferenceStale,
  resolveRoute,
  resolveRouteWith,
  resetSatoraCachesForTests,
  setSatoraFetchersForTests,
  withTimeout,
  type ProviderToken,
  type SwapPair,
} from "@/lib/satora";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as quotePost } from "../app/api/quotes/route";
import { GET as routesGet } from "../app/api/routes/public/route";
import { POST as createRequest } from "../app/api/requests/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b32-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const ALL_ROUTES = "usdc-polygon,usdc-arbitrum,usdc-ethereum,usdt-polygon,usdt-arbitrum,usdc-base";

/** Fixture catalogue mirroring the live provider shape (subset). */
const FIXTURE_TOKENS: ProviderToken[] = [
  { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC", chain: "137", decimals: 6 },
  { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT0", chain: "137", decimals: 6 },
  { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb4", symbol: "USDC", chain: "1", decimals: 6 },
];
const FIXTURE_PAIRS: SwapPair[] = [
  { source: "Lightning", target: "137", min_sats: 356, max_sats: 20000000 },
  { source: "Lightning", target: "1", min_sats: 10000, max_sats: 20000000 },
];

describe("provider timeout behavior (pure)", () => {
  it("rejects hung provider calls with PROVIDER_TIMEOUT", async () => {
    const hanging = new Promise<never>(() => undefined);
    await expect(withTimeout(hanging, 20, "test-op")).rejects.toMatchObject({
      name: "SatoraError",
      code: "PROVIDER_TIMEOUT",
    });
  });

  it("passes through fast resolutions (recovery is stateless)", async () => {
    await expect(withTimeout(Promise.resolve("ok-live"), 1000, "test-op")).resolves.toBe("ok-live");
  });
});

describe("token/chain resolution (pure fixtures)", () => {
  it("resolves USDC/Polygon to its exact contract and limits", () => {
    const resolved = resolveRouteWith(FIXTURE_TOKENS, FIXTURE_PAIRS, "USDC", "Polygon");
    expect(resolved).toMatchObject({
      chainId: "137",
      tokenAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      tokenDecimals: 6,
      minSats: 356,
      maxSats: 20000000,
    });
  });

  it("separates USDT from USDT0: classic USDT/Polygon is unavailable", () => {
    // USDT0/137 IS present — and must never satisfy a USDT request.
    expect(() => resolveRouteWith(FIXTURE_TOKENS, FIXTURE_PAIRS, "USDT", "Polygon")).toThrowError(/not offered/);
    try {
      resolveRouteWith(FIXTURE_TOKENS, FIXTURE_PAIRS, "USDT", "Polygon");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as SatoraError).code).toBe("ROUTE_NOT_QUOTEABLE");
    }
    // USDT0 resolves only as itself.
    expect(resolveRouteWith(FIXTURE_TOKENS, FIXTURE_PAIRS, "USDT0", "Polygon").tokenAddress).toBe(
      "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    );
  });

  it("treats disappearance and reappearance as data, not code changes", () => {
    const without = FIXTURE_TOKENS.filter((t) => !(t.symbol === "USDC" && t.chain === "137"));
    expect(() => resolveRouteWith(without, FIXTURE_PAIRS, "USDC", "Polygon")).toThrowError(/not offered/);
    expect(resolveRouteWith(FIXTURE_TOKENS, FIXTURE_PAIRS, "USDC", "Polygon").tokenAddress).toContain("0x3c49");
    const noPair = FIXTURE_PAIRS.filter((p) => p.target !== "1");
    expect(() => resolveRouteWith(FIXTURE_TOKENS, noPair, "USDC", "Ethereum")).toThrowError(/not offered/);
  });

  it("rejects unknown networks without guessing chain ids", () => {
    expect(() => resolveRouteWith(FIXTURE_TOKENS, FIXTURE_PAIRS, "USDC", "Solana")).toThrowError(/no EVM chain mapping/);
  });
});

describe("Home estimate contract (pure, safe by default)", () => {
  it("returns unavailable, never an invented price", () => {
    const est = getSendValueEstimate({ routeId: "usdc-polygon", nimBalanceAtomic: "100000" });
    expect(est.status).toBe("unavailable");
    if (est.status === "unavailable") {
      expect(est.reason).toBe("no-nim-pricing-source");
      expect(est.message).toMatch(/not NIM/i);
      expect(JSON.stringify(est)).not.toMatch(/exchangeRate|rate/i);
    }
  });
});

describe.skipIf(!LIVE)("stale-serving fallback (test seam)", () => {
  it("serves last-known-good data flagged stale when refresh fails", async () => {
    await getProviderTokens(); // prime the real caches
    await getProviderPairs();
    expireSatoraCachesForTests();
    setSatoraFetchersForTests({
      getTokens: () => Promise.reject(new Error("simulated outage")),
      getSwapPairs: () => Promise.reject(new Error("simulated outage")),
    });
    try {
      const tokens = await getProviderTokens();
      expect(tokens.length).toBeGreaterThan(0);
      expect(isProviderReferenceStale()).toBe(true);
      const pairs = await getProviderPairs();
      expect(pairs.length).toBeGreaterThan(0);
    } finally {
      setSatoraFetchersForTests(null);
      resetSatoraCachesForTests();
    }
    expect(isProviderReferenceStale()).toBe(false);
  });

  it("reports unknown (not permanently unsupported) with no cache at all", async () => {
    resetSatoraCachesForTests();
    setSatoraFetchersForTests({
      getTokens: () => Promise.reject(new Error("simulated outage")),
      getSwapPairs: () => Promise.reject(new Error("simulated outage")),
    });
    try {
      await expect(getProviderTokens()).rejects.toThrow();
    } finally {
      setSatoraFetchersForTests(null);
      resetSatoraCachesForTests();
    }
  });
});

describe.skipIf(!LIVE)("live multi-route exact quotes (read-only)", () => {
  const setRoutes = (value: string): string | undefined => {
    const previous = process.env["THENCE_ENABLED_ROUTES"];
    process.env["THENCE_ENABLED_ROUTES"] = value;
    return previous;
  };
  const restoreRoutes = (previous: string | undefined): void => {
    if (previous === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
    else process.env["THENCE_ENABLED_ROUTES"] = previous;
  };

  it("quotes USDC/Ethereum exact with L1 fee units", async () => {
    const previous = setRoutes(ALL_ROUTES);
    try {
      const { cookie, userId } = await login("eth");
      // Scoped to this test's own user: sibling suites create their own
      // transfers in parallel; the invariant is that THIS read-only quote
      // creates none.
      const before = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));
      const res = await quotePost(
        postJson("http://localhost/api/quotes", { routeId: "usdc-ethereum", targetAmountAtomic: "10000000" }, { cookie, ...withClient("eth") }),
      );
      expect(res.status).toBe(200);
      const body = ((await res.json()) as { quote: Record<string, unknown> }).quote;
      expect(body["netTargetAmountAtomic"]).toBe("10000000");
      expect(body["network"]).toBe("Ethereum");
      const fees = body["fees"] as { unit: string; networkFeeSats: number };
      expect(fees.unit).toBe("sats");
      expect(fees.networkFeeSats).toBeGreaterThan(0);
      const after = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));
      expect(after.length).toBe(before.length);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("quotes classic USDT where offered (Ethereum) via the adapter", async () => {
    const resolved = await resolveRoute("USDT", "Ethereum");
    expect(resolved.tokenAddress.toLowerCase()).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
    expect(resolved.tokenDecimals).toBe(6);
    // NOTE: the provider prices below its own published pair minimum here
    // (net < min_sats); the quote service therefore rejects small L1 quotes
    // with BELOW_MINIMUM and only actionable amounts are quoted exactly.
    const { getExactQuote } = await import("@/lib/satora");
    const quote = await getExactQuote(resolved, "25000000"); // 25 USDT
    expect(quote.netTargetAtomic).toBe("25000000");
    expect(BigInt(quote.netSourceSats)).toBeGreaterThanOrEqual(BigInt(quote.minSats));
    expect(quote.protocolFeeRate).toBeGreaterThan(0);
  });

  it("marks unavailable routes honestly in the public catalogue", async () => {
    const previous = setRoutes(ALL_ROUTES);
    try {
      const res = await routesGet(new Request("http://localhost/api/routes/public"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as {
        providerFresh: boolean;
        routes: { id: string; status: string; quoteable: boolean; enabled: boolean; limitsSats: unknown; tokenAddress: string | null; chainId: string | null; availabilityReason: string }[];
      };
      expect(body.providerFresh).toBe(true);
      const byId = new Map(body.routes.map((r) => [r.id, r]));
      expect(byId.get("usdc-polygon")).toMatchObject({ status: "live", quoteable: true });
      expect(byId.get("usdc-arbitrum")).toMatchObject({ status: "live", quoteable: true });
      expect(byId.get("usdc-ethereum")).toMatchObject({ status: "live", quoteable: true });
      expect(byId.get("usdt-polygon")).toMatchObject({ status: "unavailable-token", quoteable: false });
      expect(byId.get("usdt-arbitrum")).toMatchObject({ status: "unavailable-token", quoteable: false });
      expect(byId.get("usdc-base")).toMatchObject({ status: "unavailable-token", quoteable: false });
      expect(byId.get("btc-lightning")).toMatchObject({ status: "host-dependent", quoteable: false });
      expect(byId.get("usdc-polygon")?.limitsSats).not.toBeNull();
      expect(typeof byId.get("usdc-polygon")?.tokenAddress).toBe("string");
      expect(byId.get("usdt-polygon")?.availabilityReason).toMatch(/not offered/i);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("quotes payment-request snapshots on newly enabled routes", async () => {
    const previous = setRoutes(ALL_ROUTES);
    try {
      const { cookie } = await login("snap2");
      const created = (await (
        await createRequest(
          postJson("http://localhost/api/requests", { recipientName: "Mara", asset: "USDC", network: "Ethereum", address: "0x0000000000000000000000000000000000000001", amount: "12.50", expiresInSeconds: 3600 }, { cookie, ...withClient("snap2") }),
        )
      ).json()) as { request: { publicId: string; amountAtomic: string } };
      expect(created.request.amountAtomic).toBe("12500000");
      const quoted = await quotePost(
        postJson("http://localhost/api/quotes", { routeId: "usdc-ethereum", targetAmountAtomic: created.request.amountAtomic, requestId: created.request.publicId }, { cookie, ...withClient("snap2") }),
      );
      expect(quoted.status).toBe(200);
      expect(((await quoted.json()) as { quote: { netTargetAmountAtomic: string } }).quote.netTargetAmountAtomic).toBe("12500000");
    } finally {
      restoreRoutes(previous);
    }
  });
});
