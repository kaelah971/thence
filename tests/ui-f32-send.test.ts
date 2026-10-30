/**
 * F3.2 — exact amounts, live-quote state, money honesty and request helpers.
 * Pure tests; the live-handler flow is in tests/f32-requests-quotes.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { destinationAddressIssue, looksLikeNimiqAddress } from "@/ui/lib/assets";
import { amountIssue, evaluate, press, toAtomic, type CalcTokens } from "@/ui/lib/calculator";
import {
  checkSendAmount,
  formatSats,
  quoteFreshness,
  quoteKey,
  quoteProblem,
  quoteRows,
  quoteWarnings,
  requestQuote,
  resolveQuoteState,
  type ApiQuote,
} from "@/ui/lib/quotes-api";
import { payableWallets, type ApiDestination } from "@/ui/lib/recipients-api";
import { absoluteShareUrl, canPayRequest, isPublicId, payRequestHref, requestFormError, type ApiPublicRequest } from "@/ui/lib/requests-api";
import { tokenDecimalsFor, type RouteCatalogue } from "@/ui/lib/routes-api";

const ADDR = "0x4f2a9c1e7b3d8a0f6c5e2d1b9a8c7f6e5d4c3b21";
const NIMIQ = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

const quote = (over: Partial<ApiQuote> = {}): ApiQuote => ({
  routeId: "usdc-polygon",
  asset: "USDC",
  network: "Polygon",
  targetAmountAtomic: "25500000",
  targetAmount: "25.5",
  netTargetAmountAtomic: "25500000",
  exact: true,
  sourceAmountSats: "32270",
  sourceAmountPreFeeSats: "32105",
  sourceChain: "Lightning",
  fees: { networkFeeSats: 4, gaslessNetworkFeeSats: 0, protocolFeeSats: 161, protocolFeeRate: 0.005, unit: "sats" },
  limits: { minSats: 356, maxSats: 20000000 },
  observedAt: "2026-10-29T12:00:00.000Z",
  validUntil: "2026-10-29T12:05:00.000Z",
  availability: "available",
  settlementProven: false,
  warnings: [],
  ...over,
});

const OBSERVED = Date.parse("2026-10-29T12:00:00.000Z");
const ok = (q: ApiQuote) => ({ ok: true as const, status: 200, data: { quote: q } });

const tokens = (keys: string[]): CalcTokens => keys.reduce<CalcTokens>((t, k) => press(t, k as never, 2).tokens, []);

describe("exact amount conversion", () => {
  it("converts to the token's smallest unit with integer math only", () => {
    expect(toAtomic("25.5", 6)).toBe("25500000");
    expect(toAtomic("0.01", 6)).toBe("10000");
    expect(toAtomic("123456789.99", 6)).toBe("123456789990000");
    expect(toAtomic("1", 8)).toBe("100000000");
  });

  it("never rounds: unrepresentable, zero or malformed amounts are refused", () => {
    expect(toAtomic("1.1234567", 6)).toBeNull();
    expect(toAtomic("0", 6)).toBeNull();
    expect(toAtomic("0.00", 6)).toBeNull();
    expect(toAtomic("-1", 6)).toBeNull();
    expect(toAtomic("1e3", 6)).toBeNull();
  });

  it("keeps decimal values exact where floats would drift", () => {
    const value = evaluate(tokens(["0", ".", "1", "+", "0", ".", "2"]), 2);
    expect(value.kind === "value" && value.value).toBe("0.3");
    expect(toAtomic("0.3", 6)).toBe("300000");
  });
});

describe("calculator precision", () => {
  it("rejects a third decimal for 2-decimal entry instead of rounding it away", () => {
    const t = tokens(["1", ".", "2", "5"]);
    expect(press(t, "9", 2).rejected).toBe("precision");
    expect(press(t, "9", 2).tokens).toEqual(t);
  });

  it("flags division results that had to be rounded", () => {
    const result = evaluate(tokens(["1", "0", "÷", "3"]), 2);
    expect(result).toMatchObject({ kind: "value", value: "3.33", exact: false });
  });

  it("classifies empty, zero and negative amounts", () => {
    expect(amountIssue(evaluate([], 2))).toBe("empty");
    expect(amountIssue(evaluate(["0"], 2))).toBe("zero");
    expect(amountIssue(evaluate(tokens(["1", "−", "5"]), 2))).toBe("negative");
  });
});

describe("checkSendAmount", () => {
  const base = { value: "25.5", issue: null, availability: "available" as const, tokenDecimals: 6 };

  it("produces the exact atomic amount only when the route is payable", () => {
    expect(checkSendAmount(base)).toEqual({ ok: true, atomic: "25500000" });
  });

  it("blocks invalid amounts and unavailable currencies with a reason", () => {
    expect(checkSendAmount({ ...base, value: null, issue: "empty" })).toEqual({ ok: false, block: "empty" });
    expect(checkSendAmount({ ...base, issue: "zero" })).toEqual({ ok: false, block: "zero" });
    expect(checkSendAmount({ ...base, issue: "negative" })).toEqual({ ok: false, block: "negative" });
    expect(checkSendAmount({ ...base, availability: "unavailable" })).toEqual({ ok: false, block: "unavailable" });
    expect(checkSendAmount({ ...base, availability: "host-dependent" })).toEqual({ ok: false, block: "unavailable" });
    expect(checkSendAmount({ ...base, availability: "loading" })).toEqual({ ok: false, block: "checking" });
    expect(checkSendAmount({ ...base, availability: "unknown" })).toEqual({ ok: false, block: "unknown" });
    expect(checkSendAmount({ ...base, tokenDecimals: null })).toEqual({ ok: false, block: "unavailable" });
    expect(checkSendAmount({ ...base, value: "1.123", tokenDecimals: 2 })).toEqual({ ok: false, block: "precision" });
  });

  it("takes token decimals only from a live catalogue route", () => {
    const catalogue: RouteCatalogue = {
      providerFresh: true,
      routes: [
        { id: "usdc-polygon", asset: "USDC", network: "Polygon", enabled: true, supported: true, quoteable: true, status: "live", tokenDecimals: 6 },
        { id: "usdc-base", asset: "USDC", network: "Base", enabled: false, supported: true, quoteable: false, status: "disabled", tokenDecimals: null },
      ],
    };
    expect(tokenDecimalsFor("usdc-polygon", catalogue)).toBe(6);
    expect(tokenDecimalsFor("usdc-base", catalogue)).toBeNull();
    expect(tokenDecimalsFor("usdc-polygon", null)).toBeNull();
  });
});

describe("live quote state", () => {
  const input = { routeId: "usdc-polygon", targetAmountAtomic: "25500000" };
  const key = quoteKey(input, ADDR);

  it("changes identity when amount, wallet, currency or request changes", () => {
    expect(quoteKey({ ...input, targetAmountAtomic: "25510000" }, ADDR)).not.toBe(key);
    expect(quoteKey(input, "0x1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e")).not.toBe(key);
    expect(quoteKey({ ...input, routeId: "usdc-arbitrum" }, ADDR)).not.toBe(key);
    expect(quoteKey({ ...input, requestId: "abcdefghijklmnopqrstuv" }, ADDR)).not.toBe(key);
    expect(quoteKey(input, ADDR.toUpperCase().replace("0X", "0x"))).toBe(key);
  });

  it("is idle without input and loading until the matching answer arrives", () => {
    expect(resolveQuoteState(null, null, OBSERVED).status).toBe("idle");
    expect(resolveQuoteState(key, null, OBSERVED).status).toBe("loading");
  });

  it("ignores a late answer for an earlier selection", () => {
    const stale = { key: quoteKey({ ...input, targetAmountAtomic: "1000000" }, ADDR), result: ok(quote({ netTargetAmountAtomic: "1000000" })) };
    expect(resolveQuoteState(key, stale, OBSERVED).status).toBe("loading");
  });

  it("shows a fresh quote with a countdown, then expires it", () => {
    const settled = { key, result: ok(quote()) };
    const fresh = resolveQuoteState(key, settled, OBSERVED + 55_000, input);
    expect(fresh).toMatchObject({ status: "ready", freshness: { expired: false, countdown: "4:05" } });
    expect(resolveQuoteState(key, settled, OBSERVED + 300_000, input).status).toBe("expired");
    expect(quoteFreshness("not-a-date", OBSERVED).expired).toBe(true);
  });

  it("refuses a quote that doesn't match the exact requested amount", () => {
    const settled = { key, result: ok(quote({ netTargetAmountAtomic: "25499999" })) };
    expect(resolveQuoteState(key, settled, OBSERVED, input)).toMatchObject({ status: "error", problem: { kind: "provider" } });
  });

  it("treats an aborted request as still loading, not as an error", () => {
    const settled = { key, result: { ok: false as const, status: 0, kind: "aborted" as const, code: null } };
    expect(resolveQuoteState(key, settled, OBSERVED).status).toBe("loading");
  });
});

describe("quote problems in everyday language", () => {
  it("guides below-minimum and above-maximum amounts to a different amount", () => {
    expect(quoteProblem({ kind: "invalid", code: "BELOW_MINIMUM" })).toMatchObject({ kind: "below-minimum", changeAmount: true, retryable: false });
    expect(quoteProblem({ kind: "invalid", code: "ABOVE_MAXIMUM" })).toMatchObject({ kind: "above-maximum", changeAmount: true });
  });

  it("explains disabled or unquoteable currencies without retry loops", () => {
    for (const code of ["ROUTE_DISABLED", "ROUTE_NOT_QUOTEABLE", "UNSUPPORTED_ROUTE", "UNKNOWN_ROUTE"]) {
      expect(quoteProblem({ kind: "invalid", code })).toMatchObject({ kind: "unavailable", retryable: false });
    }
  });

  it("offers recovery for provider outages and throttling, and asks to sign in on session end", () => {
    expect(quoteProblem({ kind: "server", code: "PROVIDER_UNAVAILABLE" })).toMatchObject({ kind: "provider", retryable: true });
    expect(quoteProblem({ kind: "network", code: null })).toMatchObject({ kind: "provider", retryable: true });
    expect(quoteProblem({ kind: "rate-limited", code: "RATE_LIMITED" })).toMatchObject({ kind: "busy", retryable: true });
    expect(quoteProblem({ kind: "unauthorized", code: "UNAUTHORIZED" }).kind).toBe("session");
    expect(quoteProblem({ kind: "conflict", code: "REQUEST_EXPIRED" }).kind).toBe("request");
  });

  it("never leaks provider jargon", () => {
    const codes = ["BELOW_MINIMUM", "ABOVE_MAXIMUM", "ROUTE_DISABLED", "PROVIDER_TIMEOUT", "INEXACT_QUOTE", "SNAPSHOT_MISMATCH", null];
    for (const code of codes) {
      const p = quoteProblem({ kind: "server", code });
      expect(`${p.title} ${p.body}`).not.toMatch(/route|swap|htlc|atomic|provider|adapter|blockchain/i);
    }
    expect(quoteWarnings(quote({ warnings: ["Amount is close to the route minimum; re-quote before approving.", "other"] })).join(" ")).not.toMatch(/route|re-quote/i);
  });
});

describe("no sats-as-NIM misrepresentation", () => {
  const rows = quoteRows(quote(), 2, 6);

  it("labels every sats value as Lightning sats and never as NIM", () => {
    for (const row of rows) {
      const text = `${row.label} ${row.value} ${row.sub ?? ""}`;
      if (/sats/.test(text)) expect(text).not.toMatch(/NIM/);
    }
    expect(rows.find((r) => r.label === "Lightning needed")?.value).toBe("32,270 sats");
    expect(formatSats(1234567)).toBe("1,234,567 sats");
  });

  it("never puts a number on the NIM cost (no invented NIM rate)", () => {
    const nim = rows.find((r) => /NIM/.test(r.label));
    expect(nim?.value).toBe("Shown by Nimiq Pay");
    expect(`${nim?.value} ${nim?.sub}`).not.toMatch(/\d/);
  });

  it("shows the exact receive amount without dropping precision", () => {
    expect(rows[0]?.value).toBe("25.50 USDC");
    expect(quoteRows(quote({ netTargetAmountAtomic: "25123456" }), 2, 6)[0]?.value).toBe("25.123456 USDC");
  });
});

describe("receiving wallets", () => {
  const dest = (over: Partial<ApiDestination>): ApiDestination => ({
    id: "d",
    asset: "USDC",
    network: "Polygon",
    address: ADDR,
    label: null,
    isDefault: false,
    verification: { status: "added-by-you" },
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  });

  it("puts the preferred wallet first and drops wallets that can't be paid", () => {
    const list = payableWallets([
      dest({ id: "old", createdAt: "2026-09-01T00:00:00Z" }),
      dest({ id: "pref", isDefault: true, network: "Arbitrum" }),
      dest({ id: "new", createdAt: "2026-10-20T00:00:00Z", network: "Ethereum" }),
      dest({ id: "odd", asset: "DAI" }),
      dest({ id: "ln", asset: "BTC", network: "Lightning", address: "a@b.com" }),
    ]);
    expect(list.map((w) => w.id)).toEqual(["pref", "new", "old"]);
    expect(list[0]?.routeId).toBe("usdc-arbitrum");
  });

  it("never accepts a Nimiq address as an EVM receiving wallet", () => {
    expect(looksLikeNimiqAddress(NIMIQ)).toBe(true);
    expect(looksLikeNimiqAddress(NIMIQ.replace(/\s/g, ""))).toBe(true);
    expect(looksLikeNimiqAddress(ADDR)).toBe(false);
    expect(destinationAddressIssue("Polygon", NIMIQ)).toMatch(/Nimiq address/);
    expect(destinationAddressIssue("Polygon", ADDR)).toBeNull();
  });
});

describe("payment request helpers", () => {
  const req = (over: Partial<ApiPublicRequest> = {}): ApiPublicRequest => ({
    publicId: "AbCdEfGhIjKlMnOpQrStUv",
    recipientName: "Daniel",
    amount: "12.5",
    amountAtomic: "12500000",
    asset: "USDC",
    network: "Polygon",
    destination: ADDR,
    memo: null,
    expiresAt: "2026-11-05T00:00:00Z",
    status: "active",
    route: { id: "usdc-polygon", supported: true, quoteable: true },
    url: "/r/AbCdEfGhIjKlMnOpQrStUv",
    ...over,
  });

  it("only lets active requests on a payable route be paid", () => {
    expect(canPayRequest(req())).toBe(true);
    expect(canPayRequest(req({ status: "expired" }))).toBe(false);
    expect(canPayRequest(req({ status: "cancelled" }))).toBe(false);
    expect(canPayRequest(req({ route: { id: "usdc-base", supported: true, quoteable: false } }))).toBe(false);
    expect(canPayRequest(req({ asset: "DAI" }))).toBe(false);
  });

  it("builds links from the trusted URL or the current origin, never a guessed domain", () => {
    expect(absoluteShareUrl("/r/abc", "http://localhost:3000")).toBe("http://localhost:3000/r/abc");
    expect(absoluteShareUrl("https://pay.example/r/abc", "http://localhost:3000")).toBe("https://pay.example/r/abc");
    expect(payRequestHref("AbCdEfGhIjKlMnOpQrStUv")).toBe("/app/send?request=AbCdEfGhIjKlMnOpQrStUv");
  });

  it("accepts only well-formed public ids", () => {
    expect(isPublicId("AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(isPublicId("../../api/me")).toBe(false);
    expect(isPublicId("short")).toBe(false);
    expect(isPublicId(null)).toBe(false);
  });

  it("maps request errors to the right field", () => {
    expect(requestFormError("INVALID_ADDRESS")?.field).toBe("address");
    expect(requestFormError("BAD_AMOUNT")?.field).toBe("amount");
    expect(requestFormError("NOPE")).toBeNull();
  });
});

describe("quote request body", () => {
  it("sends the exact atomic amount, and the request id only when paying a request", async () => {
    const seen: unknown[] = [];
    const fake = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ quote: quote() }), { status: 200 });
    }) as unknown as typeof fetch;
    await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "25500000" }, { fetch: fake });
    await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "12500000", requestId: "AbCdEfGhIjKlMnOpQrStUv" }, { fetch: fake });
    expect(seen).toEqual([
      { routeId: "usdc-polygon", targetAmountAtomic: "25500000" },
      { routeId: "usdc-polygon", targetAmountAtomic: "12500000", requestId: "AbCdEfGhIjKlMnOpQrStUv" },
    ]);
  });
});
