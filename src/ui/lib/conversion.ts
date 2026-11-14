/**
 * NIM → USDC indicative value (display only).
 *
 * The estimate is an approximate MARKET value of the signed-in wallet's NIM,
 * from one public price source (CoinGecko) via Thence's server. It is NOT an
 * owned USDC balance, NOT a quote and NOT what a payment delivers: payments go
 * NIM → Lightning → USDC with provider fees, and Nimiq Pay shows the exact NIM
 * at approval. Every rate enters through this module with its source and age;
 * nothing here feeds quotes or payments.
 */
"use client";

import { useEffect, useState } from "react";
import type { BalanceState } from "./balance";
import { apiRequest } from "./api";
import { formatLuna, type FormattedNim } from "./luna";
import { decimalToE18, estimateUsdcMicro, formatUsdcEstimate, NIM_PRICE_MAX_AGE_MS } from "@/domain/nim-price";

export type PriceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ok"; rate: string; source: string; sourceUrl: string; observedAt: string };

export type ConversionPreview =
  | { status: "loading" }
  | { status: "no-balance"; message: string }
  | { status: "rate-unavailable"; nim: FormattedNim; message: string }
  | {
      status: "estimate";
      nim: FormattedNim;
      /** "12.34", "< 0.01" or "0.00" — rounded down, never overstated. */
      usdc: string;
      usdcMicro: bigint;
      source: string;
      sourceUrl: string;
      observedAt: string;
      /** "updated 3 min ago" */
      freshness: string;
      /** Vault discovery was incomplete: the real value may be higher. */
      partial: boolean;
    };

export const RATE_UNAVAILABLE_MESSAGE =
  "The market rate isn't available right now, so Thence won't guess. When you send, Nimiq Pay shows the exact NIM before you approve.";
export const ESTIMATE_DISCLAIMER =
  "Approximate market value, not an owned USDC balance. Final payment amount and fees are confirmed during payment approval.";
export const PARTIAL_BALANCE_NOTE = "Some Nimiq Pay vault funds couldn't be read, so the real value may be higher.";

/** Refresh cadence: matches the server cache window. */
export const PRICE_REFRESH_MS = 5 * 60_000;

/** Parse the server's price payload strictly; anything else is unavailable. */
export function parsePrice(value: unknown): PriceState {
  const p = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const rate = p && typeof p["rate"] === "string" ? decimalToE18(p["rate"]) : null;
  if (
    !p ||
    p["status"] !== "ok" ||
    rate === null ||
    rate <= 0n ||
    typeof p["source"] !== "string" ||
    typeof p["sourceUrl"] !== "string" ||
    !p["sourceUrl"].startsWith("https://") ||
    typeof p["observedAt"] !== "string" ||
    Number.isNaN(new Date(p["observedAt"]).getTime())
  ) {
    return { status: "unavailable" };
  }
  return { status: "ok", rate: p["rate"] as string, source: p["source"], sourceUrl: p["sourceUrl"], observedAt: p["observedAt"] };
}

export function freshnessLabel(observedAt: string, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs - new Date(observedAt).getTime()) / 60_000));
  return mins < 1 ? "updated just now" : `updated ${mins} min ago`;
}

export function nimUsdcPreview(balance: BalanceState, price: PriceState = { status: "unavailable" }, nowMs: number = Date.now()): ConversionPreview {
  switch (balance.status) {
    case "loading":
      return { status: "loading" };
    case "disconnected":
      return { status: "no-balance", message: "Connect your wallet to see your NIM balance." };
    case "loaded":
      break;
    default:
      return { status: "no-balance", message: "Your NIM balance isn't available right now, so no USDC value is shown." };
  }
  const nim = formatLuna(balance.luna);
  if (price.status === "loading") return { status: "loading" };
  const rateE18 = price.status === "ok" ? decimalToE18(price.rate) : null;
  // The client re-checks freshness too: a long-open page never shows a stale rate.
  if (price.status !== "ok" || rateE18 === null || rateE18 <= 0n || nowMs - new Date(price.observedAt).getTime() > NIM_PRICE_MAX_AGE_MS) {
    return { status: "rate-unavailable", nim, message: RATE_UNAVAILABLE_MESSAGE };
  }
  const usdcMicro = estimateUsdcMicro(balance.luna, rateE18);
  return {
    status: "estimate",
    nim,
    usdc: formatUsdcEstimate(usdcMicro),
    usdcMicro,
    source: price.source,
    sourceUrl: price.sourceUrl,
    observedAt: price.observedAt,
    freshness: freshnessLabel(price.observedAt, nowMs),
    partial: balance.vaultUnknown,
  };
}

/** One read of the server's indicative rate; any failure is "unavailable". */
export async function fetchNimUsdcPrice(): Promise<PriceState> {
  const res = await apiRequest<{ price: unknown }>("/api/prices/nim-usdc");
  return res.ok ? parsePrice(res.data.price) : { status: "unavailable" };
}

/** Fetch the indicative rate on mount, every 5 min and when the app returns to view. */
export function useNimUsdcPrice(enabled: boolean): PriceState {
  const [state, setState] = useState<PriceState>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = () =>
      void fetchNimUsdcPrice().then((next) => {
        if (!cancelled) setState(next);
      });
    run();
    const timer = setInterval(run, PRICE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  return enabled ? state : { status: "unavailable" };
}
