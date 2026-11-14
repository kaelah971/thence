/**
 * NIM → USDC indicative value (display only): pure math, client preview and
 * display-only safety. The server source is covered in tests/nim-price.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decimalToE18,
  deriveNimUsdcRate,
  e18ToDecimal,
  estimateUsdcMicro,
  formatUsdcEstimate,
  NIM_PRICE_MAX_AGE_MS,
  priceNumberToE18,
} from "@/domain/nim-price";
import { ESTIMATE_DISCLAIMER, nimUsdcPreview, parsePrice, RATE_UNAVAILABLE_MESSAGE, type PriceState } from "@/ui/lib/conversion";
import type { BalanceState } from "@/ui/lib/balance";

const NOW = Date.parse("2026-11-14T14:00:00Z");
const loaded = (luna: bigint, vaultUnknown = false): BalanceState => ({
  status: "loaded",
  luna,
  basicLuna: luna,
  vaultLuna: null,
  vaultUnknown,
  source: "chain",
  network: "mainnet",
});
const price = (rate: string, observedAt = new Date(NOW - 60_000).toISOString()): PriceState => ({
  status: "ok",
  rate,
  source: "CoinGecko",
  sourceUrl: "https://www.coingecko.com/en/coins/nimiq-2",
  observedAt,
});

describe("exact NIM → USDC arithmetic", () => {
  it("parses source numbers exactly, including exponent notation", () => {
    expect(priceNumberToE18(0.0002084293810831954)).toBe(208429381083195n); // 18 dp, truncated
    expect(priceNumberToE18(2.5e-7)).toBe(250_000_000_000n);
    expect(priceNumberToE18(1)).toBe(10n ** 18n);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null, undefined]) expect(priceNumberToE18(bad)).toBeNull();
    expect(decimalToE18("0.000208")).toBe(208_000_000_000_000n);
    expect(e18ToDecimal(208_000_000_000_000n)).toBe("0.000208");
  });

  it("derives NIM/USDC from the two USD prices (today's live CoinGecko values)", () => {
    const v = deriveNimUsdcRate({ nimUsd: 0.0002084293810831954, usdcUsd: 0.9996414351539443, nimUpdatedAtSec: NOW / 1000 - 30, usdcUpdatedAtSec: NOW / 1000 - 10 }, NOW);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rate.rate.startsWith("0.00020850")).toBe(true); // 0.000208429… / 0.999641…
      expect(v.rate.observedAt).toBe(new Date(NOW - 30_000).toISOString()); // older observation wins
    }
  });

  it("computes a test balance exactly and rounds down (never overstated)", () => {
    const rate = decimalToE18("0.000208504")!;
    // 3,448.43930 NIM × 0.000208504 = 0.7190130… USDC
    const micro = estimateUsdcMicro(344_843_930n, rate);
    expect(micro).toBe(719_013n);
    expect(formatUsdcEstimate(micro)).toBe("0.71");
    // 11,918.35385 NIM → 2.4850… USDC
    expect(formatUsdcEstimate(estimateUsdcMicro(1_191_835_385n, rate))).toBe("2.48");
    // Large balance: grouping and no float drift (10,000,000 NIM).
    expect(formatUsdcEstimate(estimateUsdcMicro(1_000_000_000_000n, rate))).toBe("2,085.04");
  });

  it("handles zero, dust and invalid inputs safely", () => {
    const rate = decimalToE18("0.000208504")!;
    expect(formatUsdcEstimate(estimateUsdcMicro(0n, rate))).toBe("0.00");
    expect(formatUsdcEstimate(estimateUsdcMicro(1n, rate))).toBe("0.00"); // 1 luna rounds to 0
    expect(formatUsdcEstimate(estimateUsdcMicro(1_000_000n, rate))).toBe("< 0.01"); // 10 NIM ≈ 0.0020
    expect(estimateUsdcMicro(-5n, rate)).toBe(0n);
    expect(estimateUsdcMicro(100_000n, 0n)).toBe(0n);
  });

  it("fails closed on malformed, implausible, depegged, stale and future data", () => {
    const base = { nimUsd: 0.0002, usdcUsd: 1, nimUpdatedAtSec: NOW / 1000, usdcUpdatedAtSec: NOW / 1000 };
    expect(deriveNimUsdcRate({ ...base, nimUsd: "0.0002" }, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(deriveNimUsdcRate({ ...base, nimUsd: 0 }, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(deriveNimUsdcRate({ ...base, nimUpdatedAtSec: "x" }, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(deriveNimUsdcRate({ ...base, nimUsd: 50 }, NOW)).toEqual({ ok: false, reason: "implausible" });
    expect(deriveNimUsdcRate({ ...base, usdcUsd: 0.9 }, NOW)).toEqual({ ok: false, reason: "depegged" });
    expect(deriveNimUsdcRate({ ...base, usdcUsd: 1.1 }, NOW)).toEqual({ ok: false, reason: "depegged" });
    expect(deriveNimUsdcRate({ ...base, nimUpdatedAtSec: (NOW - NIM_PRICE_MAX_AGE_MS - 1000) / 1000 }, NOW)).toEqual({ ok: false, reason: "stale" });
    expect(deriveNimUsdcRate({ ...base, usdcUpdatedAtSec: (NOW + 10 * 60_000) / 1000 }, NOW)).toEqual({ ok: false, reason: "future" });
  });
});

describe("nimUsdcPreview (client)", () => {
  it("shows the estimate with source and freshness for a loaded balance", () => {
    const p = nimUsdcPreview(loaded(344_843_930n), price("0.000208504"), NOW);
    expect(p.status).toBe("estimate");
    if (p.status === "estimate") {
      expect(p.nim.text).toBe("3,448.4393");
      expect(p.usdc).toBe("0.71");
      expect(p.source).toBe("CoinGecko");
      expect(p.freshness).toBe("updated 1 min ago");
      expect(p.partial).toBe(false);
    }
  });

  it("marks an incomplete vault discovery as a lower bound", () => {
    const p = nimUsdcPreview(loaded(100_000_000n, true), price("0.0002"), NOW);
    expect(p.status === "estimate" && p.partial).toBe(true);
  });

  it("shows zero for an empty wallet, never a guess", () => {
    const p = nimUsdcPreview(loaded(0n), price("0.0002"), NOW);
    expect(p.status === "estimate" && p.usdc).toBe("0.00");
  });

  it("is honest when the balance is missing or still loading", () => {
    expect(nimUsdcPreview({ status: "loading" }, price("0.0002"), NOW)).toEqual({ status: "loading" });
    expect(nimUsdcPreview({ status: "disconnected" }, price("0.0002"), NOW).status).toBe("no-balance");
    expect(nimUsdcPreview({ status: "error", reason: "network" }, price("0.0002"), NOW).status).toBe("no-balance");
    expect(nimUsdcPreview({ status: "unavailable", reason: "not-in-host" }, price("0.0002"), NOW).status).toBe("no-balance");
  });

  it("never shows a value without a fresh rate", () => {
    expect(nimUsdcPreview(loaded(100_000n), { status: "loading" }, NOW)).toEqual({ status: "loading" });
    for (const p of [
      nimUsdcPreview(loaded(100_000n), { status: "unavailable" }, NOW),
      nimUsdcPreview(loaded(100_000n), price("0.0002", new Date(NOW - NIM_PRICE_MAX_AGE_MS - 1).toISOString()), NOW),
      nimUsdcPreview(loaded(100_000n), price("0"), NOW),
      nimUsdcPreview(loaded(100_000n), price("abc"), NOW),
    ]) {
      expect(p.status).toBe("rate-unavailable");
      if (p.status === "rate-unavailable") expect(p.message).toBe(RATE_UNAVAILABLE_MESSAGE);
      expect(JSON.stringify(p, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/usdc"?\s*:/i);
    }
  });

  it("parses the server payload strictly", () => {
    const ok = { status: "ok", rate: "0.0002085", source: "CoinGecko", sourceUrl: "https://www.coingecko.com/en/coins/nimiq-2", observedAt: new Date(NOW).toISOString() };
    expect(parsePrice(ok).status).toBe("ok");
    expect(parsePrice({ ...ok, rate: "-1" }).status).toBe("unavailable");
    expect(parsePrice({ ...ok, rate: "0" }).status).toBe("unavailable");
    expect(parsePrice({ ...ok, sourceUrl: "javascript:alert(1)" }).status).toBe("unavailable");
    expect(parsePrice({ ...ok, observedAt: "nope" }).status).toBe("unavailable");
    expect(parsePrice({ status: "unavailable", reason: "rate-limited" }).status).toBe("unavailable");
    expect(parsePrice(null).status).toBe("unavailable");
  });
});

describe("display-only safety", () => {
  it("wording never presents the estimate as owned or guaranteed", () => {
    expect(ESTIMATE_DISCLAIMER).toMatch(/Approximate market value/);
    expect(ESTIMATE_DISCLAIMER).toMatch(/not an owned USDC balance/);
    expect(ESTIMATE_DISCLAIMER).toMatch(/Final payment amount and fees are confirmed during payment approval/);
    expect(RATE_UNAVAILABLE_MESSAGE).toMatch(/won't guess/);
  });

  it("no quote, transfer, settlement or payment module depends on the indicative rate", () => {
    for (const file of [
      "src/lib/quotes.ts",
      "src/lib/satora.ts",
      "src/lib/transfers.ts",
      "src/lib/settlement.ts",
      "src/lib/handoff.ts",
      "src/lib/claim-intent.ts",
      "src/lib/pilot.ts",
      "src/domain/estimates.ts",
      "src/ui/lib/nimiq-pay.ts",
      "src/ui/screens/send/SendFlow.tsx",
    ]) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      expect(text, file).not.toMatch(/nim-price|useNimUsdcPrice|nimUsdcPreview|estimateUsdcMicro/);
    }
  });

  it("the USDT card never borrows the NIM pricing", () => {
    const cards = readFileSync("src/ui/components/WalletCards.tsx", "utf8");
    const usdt = cards.slice(cards.indexOf("function UsdtFace"));
    expect(usdt).not.toMatch(/price|preview|estimate/i);
    expect(usdt).toMatch(/can&apos;t read USDT balances yet/);
  });

  it("mobile: the card panel scrolls instead of clipping the estimate rows", () => {
    const css = readFileSync("src/ui/components/cards.module.css", "utf8");
    const panel = css.slice(css.indexOf(".convPanel {"), css.indexOf("}", css.indexOf(".convPanel {")));
    expect(panel).toMatch(/overflow-y:\s*auto/);
    const home = readFileSync("src/ui/screens/home/home.module.css", "utf8");
    expect(home).toMatch(/\.estimateValue\[data-live="true"\][^}]*white-space:\s*nowrap/);
  });
});
