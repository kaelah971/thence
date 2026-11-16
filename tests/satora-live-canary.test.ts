/**
 * LIVE Satora canary: external-provider availability and compatibility.
 *
 * Runs ONLY with THENCE_TEST_LIVE_SATORA=1 (skipped otherwise, and reported as
 * skipped). It talks to the real api.satora.io through the production client,
 * read-only: token catalogue, swap pairs and exact-output quotes for the
 * enabled routes. It creates nothing (no swap, invoice or payment).
 *
 * A failure here means Satora is down or changed its contract; it is never a
 * Thence regression signal for the release suite, which uses the deterministic
 * provider (tests/satora-fixture.ts). Run:
 *   THENCE_TEST_LIVE_SATORA=1 npx vitest run tests/satora-live-canary.test.ts
 * See also scripts/probe-arbitrum-route.ts (chain + provider canary).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLiveSatoraRequested } from "./satora-fixture";
import { getExactQuote, getProviderPairs, getProviderTokens, resetSatoraCachesForTests, resolveRoute } from "@/lib/satora";

const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const USDC_ARBITRUM = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

describe.skipIf(!isLiveSatoraRequested())("LIVE Satora canary (THENCE_TEST_LIVE_SATORA=1)", () => {
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

  it("lists the trusted route tokens and Lightning pairs", async () => {
    const tokens = await getProviderTokens();
    expect(tokens.some((t) => t.chain === "137" && t.address.toLowerCase() === USDC_POLYGON && t.decimals === 6)).toBe(true);
    expect(tokens.some((t) => t.chain === "42161" && t.address.toLowerCase() === USDC_ARBITRUM && t.decimals === 6)).toBe(true);
    const pairs = await getProviderPairs();
    for (const target of ["137", "42161"]) expect(pairs.some((p) => p.source === "Lightning" && p.target === target)).toBe(true);
  });

  it("returns exact-output quotes the production parser accepts on both routes", async () => {
    for (const network of ["Polygon", "Arbitrum"] as const) {
      const q = await getExactQuote(await resolveRoute("USDC", network), "300000");
      expect(q.netTargetAtomic).toBe("300000");
      expect(Number(q.netSourceSats)).toBeGreaterThan(0);
      expect(q.minSats).toBeLessThanOrEqual(q.maxSats);
    }
  });
});
