/**
 * Server-side NIM/USDC indicative rate (display only): fixed upstream, strict
 * validation, cache, single-flight, back-off and fail-closed behavior.
 * Upstream is mocked; nothing here touches the network or the database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getNimUsdcPrice,
  NIM_PRICE_CACHE_MS,
  NIM_PRICE_ERROR_BACKOFF_MS,
  resetNimPriceCacheForTests,
  setNimPriceFetchForTests,
} from "@/lib/nim-price";
import { NIM_PRICE_MAX_AGE_MS } from "@/domain/nim-price";

const T0 = Date.parse("2026-11-14T14:00:00Z");
const body = (nimAt = T0 / 1000 - 20, usdcAt = T0 / 1000 - 10, nim: unknown = 0.0002084293810831954, usdc: unknown = 0.9996414351539443) =>
  JSON.stringify({ "nimiq-2": { usd: nim, last_updated_at: nimAt }, "usd-coin": { usd: usdc, last_updated_at: usdcAt } });

interface Call { url: string; headers: Record<string, string> }
let calls: Call[];
function mock(responder: () => Response | Promise<Response>): void {
  setNimPriceFetchForTests(async (url, init) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    return responder();
  });
}
const ok = (text = body()) => new Response(text, { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  resetNimPriceCacheForTests();
  delete process.env["THENCE_COINGECKO_DEMO_API_KEY"];
  delete process.env["THENCE_NIM_PRICE_ENABLED"];
});
afterEach(() => {
  setNimPriceFetchForTests(null);
  resetNimPriceCacheForTests();
});

describe("getNimUsdcPrice", () => {
  it("calls only the fixed CoinGecko endpoint and returns a sourced, timestamped rate", async () => {
    mock(() => ok());
    const p = await getNimUsdcPrice(T0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,usd-coin&vs_currencies=usd&include_last_updated_at=true&precision=full");
    expect(calls[0]!.headers["x-cg-demo-api-key"]).toBeUndefined();
    expect(p.status).toBe("ok");
    if (p.status === "ok") {
      expect(p.source).toBe("CoinGecko");
      expect(p.rate.startsWith("0.00020850")).toBe(true);
      expect(p.observedAt).toBe(new Date(T0 - 20_000).toISOString());
      expect(p.fetchedAt).toBe(new Date(T0).toISOString());
      expect(JSON.stringify(p)).not.toMatch(/rateE18/);
    }
  });

  it("caches for the window and coalesces concurrent requests into one upstream call", async () => {
    mock(() => ok());
    await Promise.all([getNimUsdcPrice(T0), getNimUsdcPrice(T0), getNimUsdcPrice(T0)]);
    await getNimUsdcPrice(T0 + NIM_PRICE_CACHE_MS - 1);
    expect(calls).toHaveLength(1);
    mock(() => ok(body((T0 + NIM_PRICE_CACHE_MS) / 1000, (T0 + NIM_PRICE_CACHE_MS) / 1000)));
    await getNimUsdcPrice(T0 + NIM_PRICE_CACHE_MS);
    expect(calls).toHaveLength(2);
  });

  it("sends the optional Demo key only to the upstream, never in the result", async () => {
    process.env["THENCE_COINGECKO_DEMO_API_KEY"] = "CG-test-key-123";
    mock(() => ok());
    const p = await getNimUsdcPrice(T0);
    expect(calls[0]!.headers["x-cg-demo-api-key"]).toBe("CG-test-key-123");
    expect(JSON.stringify(p)).not.toContain("CG-test-key-123");
  });

  it("backs off on 429 (Retry-After, at least the cache window) and serves a still-fresh cached rate", async () => {
    mock(() => ok());
    await getNimUsdcPrice(T0);
    mock(() => new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
    const during = await getNimUsdcPrice(T0 + NIM_PRICE_CACHE_MS);
    expect(during.status).toBe("ok"); // last good value is still within its max age
    await getNimUsdcPrice(T0 + NIM_PRICE_CACHE_MS + 60_000);
    expect(calls).toHaveLength(2); // no retry before the back-off ends
  });

  it("fails closed with no cached value: 429, HTTP error, timeout, bad JSON, invalid prices", async () => {
    const cases: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response("{}", { status: 429 }), "rate-limited"],
      [() => new Response("oops", { status: 503 }), "upstream"],
      [() => Promise.reject(new DOMException("timeout", "TimeoutError")), "upstream"],
      [() => new Response("not json", { status: 200 }), "malformed"],
      [() => ok(JSON.stringify({ "nimiq-2": {} })), "malformed"],
      [() => ok(body(undefined, undefined, 0.0002, 0.5)), "depegged"],
      [() => ok(body(undefined, undefined, -1)), "malformed"],
      [() => ok(body(T0 / 1000 - NIM_PRICE_MAX_AGE_MS / 1000 - 60)), "stale"],
    ];
    for (const [responder, reason] of cases) {
      resetNimPriceCacheForTests();
      mock(responder);
      expect(await getNimUsdcPrice(T0)).toEqual({ status: "unavailable", reason });
    }
  });

  it("retries a failed upstream only after the error back-off", async () => {
    mock(() => new Response("x", { status: 500 }));
    await getNimUsdcPrice(T0);
    await getNimUsdcPrice(T0 + NIM_PRICE_ERROR_BACKOFF_MS - 1);
    expect(calls).toHaveLength(1);
    mock(() => ok(body((T0 + NIM_PRICE_ERROR_BACKOFF_MS) / 1000, (T0 + NIM_PRICE_ERROR_BACKOFF_MS) / 1000)));
    expect((await getNimUsdcPrice(T0 + NIM_PRICE_ERROR_BACKOFF_MS)).status).toBe("ok");
  });

  it("stops serving a cached rate once its observation is too old", async () => {
    mock(() => ok());
    await getNimUsdcPrice(T0);
    mock(() => new Response("x", { status: 500 }));
    expect(await getNimUsdcPrice(T0 + NIM_PRICE_MAX_AGE_MS + 1)).toEqual({ status: "unavailable", reason: "stale" });
  });

  it("can be switched off without touching the upstream", async () => {
    process.env["THENCE_NIM_PRICE_ENABLED"] = "0";
    mock(() => ok());
    expect(await getNimUsdcPrice(T0)).toEqual({ status: "unavailable", reason: "disabled" });
    expect(calls).toHaveLength(0);
  });
});
