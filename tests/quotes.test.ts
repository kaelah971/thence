/**
 * B3.1 — exact-receive quoting tests.
 *
 * Pure unit tests use a recorded real provider response shape (no floats,
 * atomic strings) and never touch the network. Live tests execute REAL
 * read-only Satora quotes (no swap creation, no funding) against the
 * dedicated development setup.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { routeObservations, transfers, users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import {
  assertSourceBounds,
  buildQuoteResponse,
  createQuote,
  humanAmount,
  listPublicRoutes,
  quoteRequestSchema,
} from "@/lib/quotes";
import { isAtomicAmount } from "@/domain/money";
import { LIVE, RUN, loginAs, patchJson, postJson } from "./helpers";
import { POST as quotePost } from "../app/api/quotes/route";
import { GET as routesGet } from "../app/api/routes/public/route";
import { POST as createRequest } from "../app/api/requests/route";
import { PATCH as cancelRequest } from "../app/api/requests/[publicId]/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b31-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
async function authedQuote(cookie: string, tag: string, body: unknown) {
  return quotePost(postJson("http://localhost/api/quotes", body, { cookie, ...withClient(`q-${tag}`) }));
}

/** Recorded real provider response (USDC/Polygon, target 5.00). */
const RECORDED = {
  exchange_rate: "79465.988556897647",
  network_fee: 4,
  gasless_network_fee: 0,
  protocol_fee: 31,
  protocol_fee_rate: 0.005,
  min_amount: 356,
  max_amount: 20000000,
  source_amount: "6292",
  target_amount: "5000000",
  net_source_amount: "6327",
  net_target_amount: "5000000",
};

describe("quote contracts (pure)", () => {
  it("rejects malformed quote requests", () => {
    expect(quoteRequestSchema.safeParse({}).success).toBe(false);
    expect(quoteRequestSchema.safeParse({ routeId: "usdc-polygon" }).success).toBe(false);
    expect(quoteRequestSchema.safeParse({ routeId: "usdc-polygon", targetAmountAtomic: "50.00" }).success).toBe(true); // shape ok; atomicity enforced later
  });

  it("formats human amounts exactly per asset decimals", () => {
    expect(humanAmount("USDC", "5000000")).toBe("5");
    expect(humanAmount("USDC", "1")).toBe("0.000001");
    expect(humanAmount("BTC", "100000000")).toBe("1");
  });

  it("builds a typed exact quote with local-only validity", () => {
    const observedAt = new Date("2030-01-01T00:00:00.000Z");
    const view = buildQuoteResponse({
      routeId: "usdc-polygon",
      asset: "USDC",
      network: "Polygon",
      chainId: "137",
      targetAmountAtomic: "5000000",
      quote: {
        netTargetAtomic: RECORDED.net_target_amount,
        netSourceSats: RECORDED.net_source_amount,
        sourceAtomicPreFee: RECORDED.source_amount,
        exchangeRate: RECORDED.exchange_rate,
        networkFeeSats: RECORDED.network_fee,
        gaslessNetworkFeeSats: RECORDED.gasless_network_fee,
        protocolFeeSats: RECORDED.protocol_fee,
        protocolFeeRate: RECORDED.protocol_fee_rate,
        minSats: RECORDED.min_amount,
        maxSats: RECORDED.max_amount,
      },
      observedAt,
      ttlSeconds: 300,
    });
    expect(view.exact).toBe(true);
    expect(view.netTargetAmountAtomic).toBe("5000000");
    expect(view.sourceAmountSats).toBe("6327");
    expect(view.fees.unit).toBe("sats");
    expect(view.sourceAmountPreFeeSats).toBe("6292");
    expect(view.validUntil).toBe(new Date(observedAt.getTime() + 300_000).toISOString());
    expect(view.validityNote).toMatch(/Local estimate only/);
    expect(view.settlementProven).toBe(false);
    // Exactness arithmetic in integers: pre-fee + fees == net source.
    expect(
      BigInt(view.sourceAmountPreFeeSats) +
        BigInt(view.fees.networkFeeSats + view.fees.gaslessNetworkFeeSats + view.fees.protocolFeeSats),
    ).toBe(BigInt(view.sourceAmountSats));
    for (const a of [view.targetAmountAtomic, view.netTargetAmountAtomic, view.sourceAmountSats]) {
      expect(isAtomicAmount(a)).toBe(true);
    }
  });

  it("enforces provider min/max in integer sats", () => {
    const codeOf = (fn: () => void): string => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        return (err as AuthError).code;
      }
      throw new Error("expected to throw");
    };
    expect(codeOf(() => assertSourceBounds("100", 356, 20000000))).toBe("BELOW_MINIMUM");
    expect(codeOf(() => assertSourceBounds("20000001", 356, 20000000))).toBe("ABOVE_MAXIMUM");
    expect(assertSourceBounds("356", 356, 20000000)).toBeUndefined();
    expect(assertSourceBounds("20000000", 356, 20000000)).toBeUndefined();
    expect(assertSourceBounds("6327", 356, 20000000)).toBeUndefined();
  });
});

describe.skipIf(!LIVE)("live exact-receive quotes (read-only)", () => {
  const ROUTES = "usdc-polygon,usdc-arbitrum,usdc-base,usdt-polygon";
  let previous: string | undefined;
  const setRoutes = (value: string): void => {
    previous = process.env["THENCE_ENABLED_ROUTES"];
    process.env["THENCE_ENABLED_ROUTES"] = value;
  };
  const restoreRoutes = (): void => {
    if (previous === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
    else process.env["THENCE_ENABLED_ROUTES"] = previous;
  };

  it("returns a native exact-output quote for USDC/Polygon", async () => {
    setRoutes(ROUTES);
    try {
      const { cookie, userId } = await login("exact");
      const before = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));
      const res = await authedQuote(cookie, "exact", { routeId: "usdc-polygon", targetAmountAtomic: "5000000" });
      expect(res.status).toBe(200);
      const q = ((await res.json()) as { quote: Record<string, unknown> }).quote;
      expect(q["netTargetAmountAtomic"]).toBe("5000000");
      expect(q["exact"]).toBe(true);
      expect(q["asset"]).toBe("USDC");
      expect(q["network"]).toBe("Polygon");
      expect(q["sourceChain"]).toBe("Lightning");
      expect(q["settlementProven"]).toBe(false);
      const fees = q["fees"] as { unit: string; networkFeeSats: number; gaslessNetworkFeeSats: number; protocolFeeSats: number };
      expect(fees.unit).toBe("sats");
      // Integer fee arithmetic holds exactly: pre-fee + all sats fees == net source.
      expect(
        BigInt(q["sourceAmountPreFeeSats"] as string) +
          BigInt(fees.networkFeeSats + fees.gaslessNetworkFeeSats + fees.protocolFeeSats),
      ).toBe(BigInt(q["sourceAmountSats"] as string));
      const limits = q["limits"] as { minSats: number; maxSats: number };
      expect(limits.minSats).toBeGreaterThan(0);
      expect(BigInt(q["sourceAmountSats"] as string) >= BigInt(limits.minSats)).toBe(true);
      expect(new Date(q["validUntil"] as string).getTime()).toBeGreaterThan(new Date(q["observedAt"] as string).getTime());
      // Quoting never creates transfers.
      // Scoped to this user: parallel suites create their own transfers.
      const after = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));
      expect(after.length).toBe(before.length);
      // Availability observation recorded (diagnostics, no amounts promised).
      const obs = await getDb()
        .select()
        .from(routeObservations)
        .where(eq(routeObservations.routeId, "usdc-polygon"));
      expect(obs.length).toBeGreaterThan(0);
      expect(obs[obs.length - 1]?.source).toBe("satora-quote");
    } finally {
      restoreRoutes();
    }
  });

  it("quotes a second route, proving the multi-network abstraction", async () => {
    setRoutes(ROUTES);
    try {
      const { cookie } = await login("second");
      const res = await authedQuote(cookie, "second", { routeId: "usdc-arbitrum", targetAmountAtomic: "5000000" });
      expect(res.status).toBe(200);
      const q = ((await res.json()) as { quote: Record<string, unknown> }).quote;
      expect(q["netTargetAmountAtomic"]).toBe("5000000");
      expect(q["network"]).toBe("Arbitrum");
    } finally {
      restoreRoutes();
    }
  });

  it("rejects unknown, disabled and provider-unavailable routes", async () => {
    setRoutes(ROUTES);
    try {
      const { cookie } = await login("gates");
      const cases: Array<[unknown, number, string]> = [
        [{ routeId: "doge-moon", targetAmountAtomic: "100" }, 400, "UNKNOWN_ROUTE"],
        [{ routeId: "usdc-ethereum", targetAmountAtomic: "100" }, 400, "ROUTE_DISABLED"],
        [{ routeId: "usdt-polygon", targetAmountAtomic: "5000000" }, 400, "ROUTE_NOT_QUOTEABLE"],
        [{ routeId: "usdc-base", targetAmountAtomic: "5000000" }, 400, "ROUTE_NOT_QUOTEABLE"],
        [{ routeId: "usdc-polygon", targetAmountAtomic: "0" }, 400, "BAD_AMOUNT"],
        [{ routeId: "usdc-polygon", targetAmountAtomic: "50.00" }, 400, "BAD_AMOUNT"],
        [{ routeId: "usdc-polygon", targetAmountAtomic: "-5" }, 400, "BAD_AMOUNT"],
      ];
      for (const [body, status, code] of cases) {
        const res = await authedQuote(cookie, "gates", body);
        expect(res.status).toBe(status);
        expect(((await res.json()) as { error: string }).error).toBe(code);
      }
    } finally {
      restoreRoutes();
    }
  });

  it("validates payment-request snapshots", async () => {
    setRoutes(ROUTES);
    try {
      const { cookie } = await login("snap");
      const created = (await (
        await createRequest(
          postJson("http://localhost/api/requests", { recipientName: "Daniel", asset: "USDC", network: "Polygon", address: "0x0000000000000000000000000000000000000001", amount: "25.00", expiresInSeconds: 3600 }, { cookie, ...withClient("snap") }),
        )
      ).json()) as { request: { publicId: string; amountAtomic: string } };
      const publicId = created.request.publicId;
      const ok = await authedQuote(cookie, "snap", { routeId: "usdc-polygon", targetAmountAtomic: created.request.amountAtomic, requestId: publicId });
      expect(ok.status).toBe(200);
      const mismatch = await authedQuote(cookie, "snap", { routeId: "usdc-polygon", targetAmountAtomic: "1", requestId: publicId });
      expect(mismatch.status).toBe(400);
      expect(((await mismatch.json()) as { error: string }).error).toBe("SNAPSHOT_MISMATCH");
      const wrongRoute = await authedQuote(cookie, "snap", { routeId: "usdc-arbitrum", targetAmountAtomic: created.request.amountAtomic, requestId: publicId });
      expect(wrongRoute.status).toBe(400);
      const ghost = await authedQuote(cookie, "snap", { routeId: "usdc-polygon", targetAmountAtomic: "1", requestId: "nope-nope" });
      expect(ghost.status).toBe(404);
      const cancelled = await cancelRequest(
        patchJson(`http://localhost/api/requests/${publicId}`, { action: "cancel" }, { cookie, ...withClient("snap") }),
        { params: Promise.resolve({ publicId }) },
      );
      expect(cancelled.status).toBe(200);
      const afterCancel = await authedQuote(cookie, "snap", { routeId: "usdc-polygon", targetAmountAtomic: created.request.amountAtomic, requestId: publicId });
      expect(afterCancel.status).toBe(409);
    } finally {
      restoreRoutes();
    }
  });

  it("requires auth and honours origin checks", async () => {
    const anon = await quotePost(postJson("http://localhost/api/quotes", { routeId: "usdc-polygon", targetAmountAtomic: "100" }));
    expect(anon.status).toBe(401);
    setRoutes(ROUTES);
    try {
      const { cookie } = await login("csrfq");
      const forged = await quotePost(
        postJson("http://localhost/api/quotes", { routeId: "usdc-polygon", targetAmountAtomic: "100" }, { cookie, origin: "https://evil.example", ...withClient("csrfq") }),
      );
      expect(forged.status).toBe(403);
    } finally {
      restoreRoutes();
    }
  });

  it("throttles quote bursts without blocking normal reads", async () => {
    setRoutes(ROUTES);
    try {
      const { cookie } = await login("rl");
      const one = await authedQuote(cookie, "rl-one", { routeId: "usdc-polygon", targetAmountAtomic: "1000000" });
      expect(one.status).toBe(200);
      // Invalid route bodies still pass the rate limiter first, so the flood
      // exercises the guard deterministically with zero provider calls.
      // 65 requests always contain 31 within a single fixed 60s window.
      const burst = await Promise.all(
        Array.from({ length: 65 }, () =>
          quotePost(
            postJson("http://localhost/api/quotes", { routeId: "nope", targetAmountAtomic: "1" }, { cookie, "x-forwarded-for": `b23-${RUN}-qburst2` }),
          ).then((r) => r.status),
        ),
      );
      void one;
      expect(burst.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(burst.filter((s) => s === 400).length).toBeGreaterThan(0);
    } finally {
      restoreRoutes();
    }
  }, 120_000);

  it("serves repeatable read-only quotes and public route metadata", async () => {
    setRoutes(ROUTES);
    try {
      const { cookie } = await login("repeat");
      const first = await authedQuote(cookie, "repeat", { routeId: "usdc-polygon", targetAmountAtomic: "2000000" });
      const second = await authedQuote(cookie, "repeat", { routeId: "usdc-polygon", targetAmountAtomic: "2000000" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const routes = (await (await routesGet(new Request("http://localhost/api/routes/public"))).json()) as {
        routes: { id: string; quoteable: boolean; enabled: boolean; limitsSats: unknown; tokenAddress: string | null }[];
      };
      const byId = new Map(routes.routes.map((r) => [r.id, r]));
      expect(byId.get("usdc-polygon")?.quoteable).toBe(true);
      expect(byId.get("usdc-polygon")?.limitsSats).not.toBeNull();
      expect(typeof byId.get("usdc-polygon")?.tokenAddress).toBe("string");
      expect(byId.get("usdt-polygon")?.quoteable).toBe(false);
      expect(byId.get("usdc-ethereum")?.enabled).toBe(false);
    } finally {
      restoreRoutes();
    }
  }, 120_000);
});
