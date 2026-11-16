/**
 * The deterministic Satora provider used by the integration suite must stay a
 * faithful stand-in: it reproduces the captured real quote exactly, and the
 * production parser and resolver accept it for every enabled route. No network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURED_QUOTE_300000, isLiveSatoraRequested, quoteFor } from "./satora-fixture";
import { getExactQuote, getProviderPairs, getProviderTokens, resetSatoraCachesForTests, resolveRoute } from "@/lib/satora";

const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const USDC_ARBITRUM = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const req = (chain: string, token: string, amount: bigint) => ({ sourceChain: "Lightning", sourceToken: "btc", targetChain: chain, targetToken: token, targetAmount: amount });

describe.skipIf(isLiveSatoraRequested())("deterministic Satora provider (integration fixture)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["THENCE_ENABLED_ROUTES", "THENCE_ROUTE_TOKENS_JSON"]) saved[k] = process.env[k];
    process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon,usdc-arbitrum";
    process.env["THENCE_ROUTE_TOKENS_JSON"] = JSON.stringify({ "usdc-polygon": USDC_POLYGON, "usdc-arbitrum": USDC_ARBITRUM });
    resetSatoraCachesForTests();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reproduces the captured real Satora 0.30 USDC quote exactly", () => {
    expect(quoteFor(req("137", USDC_POLYGON, 300_000n))).toEqual(CAPTURED_QUOTE_300000);
  });

  it("prices other amounts with the same composition and refuses unknown tokens and sources", () => {
    const five = quoteFor(req("137", USDC_POLYGON, 5_000_000n));
    expect(five).toMatchObject({ target_amount: "5000000", net_target_amount: "5000000" });
    expect(Number(five["net_source_amount"])).toBe(Number(five["source_amount"]) + Number(five["network_fee"]) + Number(five["protocol_fee"]));
    expect(Number(five["source_amount"])).toBeGreaterThan(16 * 383);
    expect(quoteFor(req("42161", USDC_ARBITRUM, 300_000n))).toMatchObject({ net_source_amount: "388" });
    expect(() => quoteFor(req("137", "0x0000000000000000000000000000000000000bad", 1n))).toThrow(/Unsupported target token/);
    expect(() => quoteFor({ ...req("137", USDC_POLYGON, 1n), sourceChain: "Bitcoin" })).toThrow(/Unsupported source/);
  });

  it("feeds the production resolver and exact-output parser unchanged, for Polygon and Arbitrum", async () => {
    expect((await getProviderTokens()).some((t) => t.address.toLowerCase() === USDC_ARBITRUM && t.chain === "42161")).toBe(true);
    expect((await getProviderPairs()).some((p) => p.source === "Lightning" && p.target === "42161")).toBe(true);
    for (const network of ["Polygon", "Arbitrum"] as const) {
      const resolved = await resolveRoute("USDC", network);
      const q = await getExactQuote(resolved, "300000");
      expect(q).toMatchObject({ requestedAtomic: "300000", netTargetAtomic: "300000", netSourceSats: "388", minSats: 356, maxSats: 20_000_000 });
    }
  });
});
