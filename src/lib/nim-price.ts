/**
 * Server-only, display-only NIM/USDC indicative rate from CoinGecko.
 *
 * - One fixed upstream (`/simple/price?ids=nimiq-2,usd-coin`), GET only.
 * - 5 s timeout; strict validation in `deriveNimUsdcRate` (fail closed).
 * - In-memory cache (5 min) with single-flight, so the server makes at most
 *   ~1 upstream call per 5 min regardless of traffic (~8,640/month: inside the
 *   free Demo tier). 429 honors Retry-After (min 5 min); other failures back
 *   off 60 s. A cached value is served only while its observation is fresh.
 * - The optional Demo key is sent only to CoinGecko, never to browsers.
 *
 * Never used by quotes, transfers, settlement or any payment logic.
 */
import { getEnv } from "@/lib/env";
import { deriveNimUsdcRate, NIM_PRICE_MAX_AGE_MS, type NimUsdcRate } from "@/domain/nim-price";

export const NIM_PRICE_SOURCE = "CoinGecko" as const;
export const NIM_PRICE_SOURCE_URL = "https://www.coingecko.com/en/coins/nimiq-2";
const UPSTREAM =
  "https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2,usd-coin&vs_currencies=usd&include_last_updated_at=true&precision=full";
export const NIM_PRICE_CACHE_MS = 5 * 60_000;
export const NIM_PRICE_ERROR_BACKOFF_MS = 60_000;
export const NIM_PRICE_TIMEOUT_MS = 5_000;

export type NimPriceResult =
  | ({ status: "ok"; source: typeof NIM_PRICE_SOURCE; sourceUrl: string; fetchedAt: string; maxAgeSeconds: number } & Omit<NimUsdcRate, "rateE18">)
  | { status: "unavailable"; reason: "disabled" | "upstream" | "rate-limited" | "malformed" | "implausible" | "depegged" | "stale" | "future" | "internal" };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
let lastGood: { rate: NimUsdcRate; fetchedAtMs: number } | null = null;
let nextFetchAtMs = 0;
let lastFailure: Exclude<NimPriceResult, { status: "ok" }>["reason"] | null = null;
let inflight: Promise<void> | null = null;

export function setNimPriceFetchForTests(next: Fetcher | null): void {
  fetcher = next ?? ((url, init) => fetch(url, init));
}
export function resetNimPriceCacheForTests(): void {
  lastGood = null;
  nextFetchAtMs = 0;
  lastFailure = null;
  inflight = null;
}

async function refresh(nowMs: number): Promise<void> {
  const key = getEnv().THENCE_COINGECKO_DEMO_API_KEY.trim();
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers["x-cg-demo-api-key"] = key;
  let res: Response;
  try {
    res = await fetcher(UPSTREAM, { method: "GET", headers, signal: AbortSignal.timeout(NIM_PRICE_TIMEOUT_MS), cache: "no-store" });
  } catch {
    lastFailure = "upstream";
    nextFetchAtMs = nowMs + NIM_PRICE_ERROR_BACKOFF_MS;
    return;
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    lastFailure = "rate-limited";
    nextFetchAtMs = nowMs + Math.max(NIM_PRICE_CACHE_MS, Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) * 1000 : 0);
    return;
  }
  if (!res.ok) {
    lastFailure = "upstream";
    nextFetchAtMs = nowMs + NIM_PRICE_ERROR_BACKOFF_MS;
    return;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    lastFailure = "malformed";
    nextFetchAtMs = nowMs + NIM_PRICE_ERROR_BACKOFF_MS;
    return;
  }
  const b = (body ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const nim = b["nimiq-2"];
  const usdc = b["usd-coin"];
  const v = deriveNimUsdcRate(
    { nimUsd: nim?.["usd"], usdcUsd: usdc?.["usd"], nimUpdatedAtSec: nim?.["last_updated_at"], usdcUpdatedAtSec: usdc?.["last_updated_at"] },
    nowMs,
  );
  if (!v.ok) {
    lastFailure = v.reason;
    nextFetchAtMs = nowMs + NIM_PRICE_ERROR_BACKOFF_MS;
    return;
  }
  lastGood = { rate: v.rate, fetchedAtMs: nowMs };
  lastFailure = null;
  nextFetchAtMs = nowMs + NIM_PRICE_CACHE_MS;
}

function view(nowMs: number): NimPriceResult {
  if (lastGood && nowMs - new Date(lastGood.rate.observedAt).getTime() <= NIM_PRICE_MAX_AGE_MS) {
    const { rateE18: _omit, ...rate } = lastGood.rate;
    return {
      status: "ok",
      source: NIM_PRICE_SOURCE,
      sourceUrl: NIM_PRICE_SOURCE_URL,
      fetchedAt: new Date(lastGood.fetchedAtMs).toISOString(),
      maxAgeSeconds: NIM_PRICE_MAX_AGE_MS / 1000,
      ...rate,
    };
  }
  return { status: "unavailable", reason: lastGood ? "stale" : (lastFailure ?? "upstream") };
}

/** Current indicative rate (cached; at most one upstream call in flight). */
export async function getNimUsdcPrice(nowMs: number = Date.now()): Promise<NimPriceResult> {
  if (getEnv().THENCE_NIM_PRICE_ENABLED !== "1") return { status: "unavailable", reason: "disabled" };
  if (nowMs >= nextFetchAtMs) {
    inflight ??= refresh(nowMs).finally(() => {
      inflight = null;
    });
    await inflight;
  }
  return view(nowMs);
}
