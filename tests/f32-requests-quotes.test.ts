/**
 * F3.2 — live quotes and payment requests through the browser client
 * against the REAL route handlers (live dev database). The external quote
 * provider is mocked: no network call, and every other provider method is
 * trapped so any swap/invoice/claim attempt would fail the suite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { paymentRequests, transfers, users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { getSatoraClient, setSatoraFetchersForTests } from "@/lib/satora";
import { apiRequest, setUnauthorizedHandler } from "@/ui/lib/api";
import { toAtomic } from "@/ui/lib/calculator";
import { quoteProblem, requestQuote, resolveQuoteState, quoteKey } from "@/ui/lib/quotes-api";
import {
  canPayRequest,
  cancelPaymentRequest,
  createPaymentRequest,
  getPublicRequest,
  listPaymentRequests,
  requestFormError,
} from "@/ui/lib/requests-api";
import { availabilityFor, fetchRouteCatalogue, tokenDecimalsFor } from "@/ui/lib/routes-api";
import { listTransfers } from "@/ui/lib/transfers-api";
import { LIVE, RUN, loginAs } from "./helpers";
import { POST as quotesPOST } from "../app/api/quotes/route";
import { GET as requestsGET, POST as requestsPOST } from "../app/api/requests/route";
import { GET as requestGET, PATCH as requestPATCH } from "../app/api/requests/[publicId]/route";
import { GET as routesGET } from "../app/api/routes/public/route";
import { GET as transfersGET } from "../app/api/transfers/route";
import { POST as logoutPOST } from "../app/api/session/logout/route";

const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const ADDR = "0x4f2a9c1e7b3d8a0f6c5e2d1b9a8c7f6e5d4c3b21";
const NIMIQ = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

type Ctx = { params: Promise<Record<string, string>> };
type H = (req: Request, ctx: Ctx) => Promise<Response>;
const ROUTES: Array<[string, RegExp, H]> = [
  ["POST", /^\/api\/quotes$/, quotesPOST as unknown as H],
  ["GET", /^\/api\/requests$/, requestsGET as unknown as H],
  ["POST", /^\/api\/requests$/, requestsPOST as unknown as H],
  ["GET", /^\/api\/requests\/(?<publicId>[^/]+)$/, requestGET as unknown as H],
  ["PATCH", /^\/api\/requests\/(?<publicId>[^/]+)$/, requestPATCH as unknown as H],
  ["GET", /^\/api\/routes\/public$/, routesGET as unknown as H],
  ["GET", /^\/api\/transfers$/, transfersGET as unknown as H],
  ["POST", /^\/api\/session\/logout$/, logoutPOST as unknown as H],
];

function clientFor(cookie: string | null, label: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [m, re, handler] of ROUTES) {
      const match = m === method ? re.exec(url.pathname) : null;
      if (!match) continue;
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("cookie", cookie);
      headers.set("x-forwarded-for", `f32-${label}-${RUN}`);
      const request = new Request(url, { method, headers, ...(init?.body ? { body: init.body as string } : {}) });
      return handler(request, { params: Promise.resolve({ ...(match.groups ?? {}) }) });
    }
    throw new TypeError(`no route ${method} ${url.pathname}`);
  }) as typeof fetch;
}

const created: string[] = [];
async function newUser(label: string) {
  const login = await loginAs({ "x-forwarded-for": `f32-login-${label}-${RUN}` }, (id) => created.push(id));
  return { ...login, fetch: clientFor(login.cookie, label) };
}

/* ---------- mocked provider ---------- */

let nextSource: (targetSats: bigint) => { netSource: bigint } = (t) => ({ netSource: t });
let failNext: Error | null = null;
const quoteCalls: bigint[] = [];
const forbidden: string[] = [];
const envBefore: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!LIVE) return;
  for (const k of ["THENCE_ENABLED_ROUTES", "THENCE_ROUTE_TOKENS_JSON"]) envBefore[k] = process.env[k];
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_ROUTE_TOKENS_JSON"] = JSON.stringify({ "usdc-polygon": USDC_POLYGON });
  setSatoraFetchersForTests({
    getTokens: async () => ({ evm_tokens: [{ token_id: USDC_POLYGON, symbol: "USDC", chain: "137", decimals: 6 }] }),
    getSwapPairs: async () => ({ pairs: [{ source: "Lightning", target: "137", min_sats: 356, max_sats: 20_000_000 }] }),
  });
  const client = await getSatoraClient();
  const proto = Object.getPrototypeOf(client) as object;
  for (const name of Object.getOwnPropertyNames(proto)) {
    // Only plain methods (accessors read private state and are not actions).
    if (name === "constructor" || name === "getQuote" || typeof Object.getOwnPropertyDescriptor(proto, name)?.value !== "function") continue;
    vi.spyOn(client as unknown as Record<string, () => unknown>, name).mockImplementation(() => {
      forbidden.push(name);
      throw new Error(`provider method ${name} must not be called in F3.2`);
    });
  }
  vi.spyOn(client, "getQuote").mockImplementation((async (req: { targetAmount?: bigint }) => {
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    const target = req.targetAmount as bigint;
    quoteCalls.push(target);
    // Fictional rate: 1 sat per 790 atomic USDC units, 0.5% fee — test data only.
    const pre = target / 790n;
    const fee = pre / 200n;
    const { netSource } = nextSource(pre + fee + 4n);
    return {
      net_target_amount: target.toString(),
      target_amount: target.toString(),
      net_source_amount: netSource.toString(),
      source_amount: pre.toString(),
      network_fee: 4,
      gasless_network_fee: 0,
      protocol_fee: Number(fee),
      protocol_fee_rate: 0.005,
      exchange_rate: "79000000",
      min_amount: 356,
      max_amount: 20_000_000,
    };
  }) as never);
});

afterEach(() => {
  nextSource = (t) => ({ netSource: t });
  failNext = null;
});

afterAll(async () => {
  if (!LIVE) return;
  setSatoraFetchersForTests(null);
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const id of created) await getDb().delete(users).where(eq(users.id, id));
});

async function transferRows(userId: string): Promise<number> {
  return (await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId))).length;
}

describe.skipIf(!LIVE)("F3.2 live quotes through the client", () => {
  it("reports the configured route as payable with verified token decimals", async () => {
    const u = await newUser("catalogue");
    const result = await fetchRouteCatalogue({ fetch: u.fetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(availabilityFor("usdc-polygon", result.data).availability).toBe("available");
    expect(tokenDecimalsFor("usdc-polygon", result.data)).toBe(6);
    expect(availabilityFor("usdc-arbitrum", result.data).availability).toBe("unavailable");
  });

  it("quotes the exact amount the person should receive and creates nothing", async () => {
    const u = await newUser("quote");
    const atomic = toAtomic("25.5", 6) as string;
    const before = quoteCalls.length;
    const result = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: atomic }, { fetch: u.fetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { quote } = result.data;
    expect(quote.netTargetAmountAtomic).toBe("25500000");
    expect(quote.fees.unit).toBe("sats");
    expect(quote.settlementProven).toBe(false);
    expect(quoteCalls.slice(before)).toEqual([25500000n]);
    const state = resolveQuoteState(quoteKey({ routeId: "usdc-polygon", targetAmountAtomic: atomic }, ADDR), { key: quoteKey({ routeId: "usdc-polygon", targetAmountAtomic: atomic }, ADDR), result }, Date.parse(quote.observedAt) + 1000, { routeId: "usdc-polygon", targetAmountAtomic: atomic });
    expect(state.status).toBe("ready");
    expect(await transferRows(u.userId)).toBe(0);
    const list = await listTransfers({}, { fetch: u.fetch });
    expect(list.ok && list.data.total).toBe(0);
    expect(forbidden).toEqual([]);
  });

  it("refuses disabled routes before contacting the provider", async () => {
    const u = await newUser("disabled");
    const before = quoteCalls.length;
    const result = await requestQuote({ routeId: "usdc-arbitrum", targetAmountAtomic: "5000000" }, { fetch: u.fetch });
    expect(result).toMatchObject({ ok: false, code: "ROUTE_DISABLED" });
    if (!result.ok) expect(quoteProblem(result).kind).toBe("unavailable");
    expect(quoteCalls.length).toBe(before);
  });

  it("explains below-minimum and above-maximum amounts", async () => {
    const u = await newUser("bounds");
    nextSource = () => ({ netSource: 100n });
    const low = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "10000" }, { fetch: u.fetch });
    expect(low).toMatchObject({ ok: false, code: "BELOW_MINIMUM" });
    if (!low.ok) expect(quoteProblem(low)).toMatchObject({ kind: "below-minimum", changeAmount: true });
    nextSource = () => ({ netSource: 20_000_001n });
    const high = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "999999000000" }, { fetch: u.fetch });
    expect(high).toMatchObject({ ok: false, code: "ABOVE_MAXIMUM" });
    if (!high.ok) expect(quoteProblem(high).kind).toBe("above-maximum");
  });

  it("recovers after a provider outage with a plain refresh", async () => {
    const u = await newUser("outage");
    failNext = new Error("down");
    const failed = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "5000000" }, { fetch: u.fetch });
    expect(failed).toMatchObject({ ok: false, status: 503, code: "PROVIDER_UNAVAILABLE" });
    if (!failed.ok) expect(quoteProblem(failed)).toMatchObject({ kind: "provider", retryable: true });
    const retry = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "5000000" }, { fetch: u.fetch });
    expect(retry.ok).toBe(true);
    expect(await transferRows(u.userId)).toBe(0);
  });

  it("stops quoting when the session ends and signals reconnect", async () => {
    const u = await newUser("session");
    let signalled = 0;
    setUnauthorizedHandler(() => (signalled += 1));
    try {
      expect((await u.fetch("/api/session/logout", { method: "POST" })).status).toBe(200);
      const result = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "5000000" }, { fetch: u.fetch });
      expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
      if (!result.ok) expect(quoteProblem(result).kind).toBe("session");
      expect(signalled).toBe(1);
      expect(await createPaymentRequest({ recipientName: "X", asset: "USDC", network: "Polygon", address: ADDR, amount: "1" }, { fetch: u.fetch })).toMatchObject({ ok: false, kind: "unauthorized" });
    } finally {
      setUnauthorizedHandler(() => {});
    }
  });
});

describe.skipIf(!LIVE)("F3.2 request money through the client", () => {
  it("creates, lists and publicly resolves a request with exact terms", async () => {
    const a = await newUser("reqA");
    const made = await createPaymentRequest({ recipientName: "Daniel Okafor", asset: "USDC", network: "Polygon", address: ADDR, amount: "12.5", memo: "Dinner" }, { fetch: a.fetch });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const req = made.data.request;
    expect(req).toMatchObject({ amountAtomic: "12500000", status: "active", memo: "Dinner", route: { id: "usdc-polygon", quoteable: true } });
    expect(req.url).toBe(`/r/${req.publicId}`);

    const list = await listPaymentRequests({}, { fetch: a.fetch });
    expect(list.ok && list.data.requests.map((r) => r.publicId)).toEqual([req.publicId]);

    const anon = clientFor(null, "anon");
    const pub = await getPublicRequest(req.publicId, { fetch: anon });
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;
    expect(Object.keys(pub.data.request).sort()).toEqual(
      ["publicId", "recipientName", "amount", "amountAtomic", "asset", "network", "destination", "memo", "expiresAt", "status", "route", "url"].sort(),
    );
    expect(JSON.stringify(pub.data)).not.toContain(a.userId);
    expect(canPayRequest(pub.data.request)).toBe(true);
    expect(await transferRows(a.userId)).toBe(0);
  });

  it("prefills a quote from the immutable snapshot and rejects altered terms", async () => {
    const a = await newUser("prefill");
    const payer = await newUser("payer");
    const made = await createPaymentRequest({ recipientName: "Mina", asset: "USDC", network: "Polygon", address: ADDR, amount: "40" }, { fetch: a.fetch });
    if (!made.ok) throw new Error("create failed");
    const { publicId, amountAtomic } = made.data.request;

    const ok = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: amountAtomic, requestId: publicId }, { fetch: payer.fetch });
    expect(ok.ok && ok.data.quote.netTargetAmountAtomic).toBe("40000000");

    const altered = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: "1000000", requestId: publicId }, { fetch: payer.fetch });
    expect(altered).toMatchObject({ ok: false, code: "SNAPSHOT_MISMATCH" });
    if (!altered.ok) expect(quoteProblem(altered).kind).toBe("request");

    const patch = await apiRequest(`/api/requests/${publicId}`, { method: "PATCH", body: { amount: "1" }, fetch: a.fetch });
    expect(patch).toMatchObject({ ok: false, code: "IMMUTABLE" });
    expect(await transferRows(payer.userId)).toBe(0);
  });

  it("keeps owners isolated", async () => {
    const a = await newUser("isoA");
    const b = await newUser("isoB");
    const made = await createPaymentRequest({ recipientName: "Ana", asset: "USDC", network: "Polygon", address: ADDR, amount: "5" }, { fetch: a.fetch });
    if (!made.ok) throw new Error("create failed");
    const bList = await listPaymentRequests({}, { fetch: b.fetch });
    expect(bList.ok && bList.data.total).toBe(0);
    expect(await cancelPaymentRequest(made.data.request.publicId, { fetch: b.fetch })).toMatchObject({ ok: false, kind: "not-found" });
    const still = await getPublicRequest(made.data.request.publicId, { fetch: b.fetch });
    expect(still.ok && still.data.request.status).toBe("active");
  });

  it("cancels idempotently and never presents a cancelled request as payable", async () => {
    const a = await newUser("cancel");
    const payer = await newUser("cancelPayer");
    const made = await createPaymentRequest({ recipientName: "Joon", asset: "USDC", network: "Polygon", address: ADDR, amount: "9.99" }, { fetch: a.fetch });
    if (!made.ok) throw new Error("create failed");
    const { publicId, amountAtomic } = made.data.request;
    const first = await cancelPaymentRequest(publicId, { fetch: a.fetch });
    const second = await cancelPaymentRequest(publicId, { fetch: a.fetch });
    expect(first.ok && first.data.request.status).toBe("cancelled");
    expect(second.ok && second.data.request.cancelledAt).toBe(first.ok ? first.data.request.cancelledAt : "x");
    const pub = await getPublicRequest(publicId, { fetch: clientFor(null, "anon2") });
    expect(pub.ok && pub.data.request.status).toBe("cancelled");
    if (pub.ok) expect(canPayRequest(pub.data.request)).toBe(false);
    const quote = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: amountAtomic, requestId: publicId }, { fetch: payer.fetch });
    expect(quote).toMatchObject({ ok: false, code: "REQUEST_CANCELLED" });
    const active = await listPaymentRequests({ status: "active" }, { fetch: a.fetch });
    expect(active.ok && active.data.total).toBe(0);
  });

  it("treats an expired request as unpayable", async () => {
    const a = await newUser("expire");
    const payer = await newUser("expirePayer");
    const made = await createPaymentRequest({ recipientName: "Lea", asset: "USDC", network: "Polygon", address: ADDR, amount: "3" }, { fetch: a.fetch });
    if (!made.ok) throw new Error("create failed");
    const { publicId, amountAtomic } = made.data.request;
    // Fixture: move expiry into the past (a request can't be created already expired).
    await getDb().update(paymentRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(paymentRequests.publicId, publicId));
    const pub = await getPublicRequest(publicId, { fetch: clientFor(null, "anon3") });
    expect(pub.ok && pub.data.request.status).toBe("expired");
    if (pub.ok) expect(canPayRequest(pub.data.request)).toBe(false);
    const quote = await requestQuote({ routeId: "usdc-polygon", targetAmountAtomic: amountAtomic, requestId: publicId }, { fetch: payer.fetch });
    expect(quote).toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
  });

  it("rejects a Nimiq address as the receiving wallet", async () => {
    const a = await newUser("nimiq");
    const made = await createPaymentRequest({ recipientName: "Sam", asset: "USDC", network: "Polygon", address: NIMIQ, amount: "1" }, { fetch: a.fetch });
    expect(made).toMatchObject({ ok: false, code: "INVALID_ADDRESS" });
    if (!made.ok) expect(requestFormError(made.code)?.field).toBe("address");
    const bad = await createPaymentRequest({ recipientName: "Sam", asset: "USDC", network: "Polygon", address: ADDR, amount: "1.1234567" }, { fetch: a.fetch });
    expect(bad).toMatchObject({ ok: false, code: "BAD_AMOUNT" });
  });

  it("never touched swap, invoice or claim provider methods", () => {
    expect(forbidden).toEqual([]);
  });
});
