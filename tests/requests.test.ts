/**
 * B2.2 — payment requests integration tests (live database).
 *
 * Isolated records per run; existing data is never reset. Skipped when
 * DATABASE_URL is absent. Pure precision/lifecycle unit checks always run.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { paymentRequests, users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import {
  amountToAtomic,
  cancelRequest,
  createRequest,
  getPublicRequest,
  listRequests,
  newPublicId,
  requestStatus,
  shareUrl,
} from "@/lib/requests";
import { LIVE, RUN, deleteJson, loginAs, patchJson, postJson } from "./helpers";
import { GET as publicGet, PATCH as cancelPatch } from "../app/api/requests/[publicId]/route";
import { GET as listGet, POST as createPost } from "../app/api/requests/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let clientCounter = 0;
const withClient = (tag: string): Record<string, string> => ({
  "x-forwarded-for": `b22-${RUN}-${tag}-${clientCounter++}`,
});
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));

const EVM_A = "0x0000000000000000000000000000000000000001";
const EVM_B = "0x0000000000000000000000000000000000000002";

async function createAs(
  cookie: string,
  tag: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; body: { request: Record<string, unknown> } }> {
  const res = await createPost(
    postJson("http://localhost/api/requests", { recipientName: "Daniel", asset: "USDC", network: "Base", address: EVM_A, amount: "50.00", ...payload }, { cookie, ...withClient(`mk-${tag}`) }),
  );
  return { status: res.status, body: (await res.json()) as { request: Record<string, unknown> } };
}

describe("request precision and lifecycle (pure)", () => {
  it("converts human decimals to exact atomic strings without floats", () => {
    expect(amountToAtomic("USDC", "50.00")).toBe("50000000");
    expect(amountToAtomic("USDC", "0.000001")).toBe("1");
    expect(amountToAtomic("USDT", "1")).toBe("1000000");
    expect(() => amountToAtomic("USDC", "0")).toThrow(AuthError);
    expect(() => amountToAtomic("USDC", "0.00")).toThrow(AuthError);
    expect(() => amountToAtomic("USDC", "-5")).toThrow(AuthError);
    expect(() => amountToAtomic("USDC", "50.0000001")).toThrow(AuthError);
    expect(() => amountToAtomic("USDC", "abc")).toThrow(AuthError);
    expect(() => amountToAtomic("USDC", "1e3")).toThrow(AuthError);
    expect(() => amountToAtomic("DOGE", "1")).toThrow(AuthError);
  });

  it("derives safe public statuses with cancelled winning", () => {
    const now = new Date();
    expect(requestStatus({ cancelledAt: null, expiresAt: new Date(now.getTime() + 1000) })).toBe("active");
    expect(requestStatus({ cancelledAt: null, expiresAt: null })).toBe("active");
    expect(requestStatus({ cancelledAt: null, expiresAt: new Date(now.getTime() - 1000) })).toBe("expired");
    expect(requestStatus({ cancelledAt: new Date(), expiresAt: new Date(now.getTime() - 1000) })).toBe("cancelled");
  });

  it("generates guess-resistant public ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newPublicId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("builds relative links without a configured origin", () => {
    expect(shareUrl("abc123")).toBe("/r/abc123");
  });

  it("builds absolute links from the trusted configured origin only", () => {
    const previous = process.env["THENCE_APP_ORIGIN"];
    process.env["THENCE_APP_ORIGIN"] = "https://pay.thence.example/";
    try {
      expect(shareUrl("abc123")).toBe("https://pay.thence.example/r/abc123");
    } finally {
      if (previous === undefined) delete process.env["THENCE_APP_ORIGIN"];
      else process.env["THENCE_APP_ORIGIN"] = previous;
    }
    expect(shareUrl("abc123")).toBe("/r/abc123");
  });
});

describe.skipIf(!LIVE)("request creation", () => {
  it("creates a request with snapshot terms and a shareable url", async () => {
    const { cookie } = await login("create");
    const { status, body } = await createAs(cookie, "create", { memo: "Dinner" });
    expect(status).toBe(201);
    const req = body.request;
    expect(req["publicId"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(req["url"]).toBe(`/r/${req["publicId"] as string}`);
    expect(req).toMatchObject({
      recipientName: "Daniel",
      asset: "USDC",
      network: "Base",
      destination: EVM_A,
      amount: "50",
      amountAtomic: "50000000",
      memo: "Dinner",
      status: "active",
    });
    expect(req["route"]).toMatchObject({ supported: true });
    expect(typeof req["expiresAt"]).toBe("string");
    // No payment machinery implied.
    expect(req["swapId"] ?? null).toBeNull();
    expect(req["quote"] ?? null).toBeNull();
  });

  it("keeps sub-cent precision exact", async () => {
    const { cookie } = await login("precision");
    const { status, body } = await createAs(cookie, "precision", { amount: "0.10" });
    expect(status).toBe(201);
    expect(body.request["amountAtomic"]).toBe("100000");
  });

  it("rejects bad input without partial writes", async () => {
    const { cookie } = await login("badinput");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ asset: "USDT", network: "Base", address: EVM_A }, "UNSUPPORTED_ROUTE"],
      [{ address: "0x123" }, "INVALID_ADDRESS"],
      [{ address: "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }, "INVALID_ADDRESS"],
      [{ asset: "BTC", network: "Lightning", address: "lnbc100n1pfake" }, "BOLT11_NOT_REUSABLE"],
      [{ asset: "BTC", network: "Lightning", address: "satoshi@thence.example" }, "LIGHTNING_DESTINATION_PENDING"],
      [{ amount: "0" }, "BAD_AMOUNT"],
      [{ amount: "-5" }, "BAD_AMOUNT"],
      [{ amount: "50.0000001" }, "BAD_AMOUNT"],
      [{ amount: "abc" }, "BAD_AMOUNT"],
      [{ recipientName: "" }, "BAD_BODY"],
      [{ recipientName: "x".repeat(121) }, "BAD_BODY"],
      [{ memo: "x".repeat(281) }, "BAD_BODY"],
      [{ expiresInSeconds: 0 }, "BAD_BODY"],
      [{ expiresInSeconds: 999 * 24 * 3600 }, "BAD_EXPIRY"],
      [{ owner_user_id: "other" }, "FIELD_FORBIDDEN"],
      [{ creatorUserId: "other" }, "FIELD_FORBIDDEN"],
      [{ publicId: "forged" }, "FIELD_FORBIDDEN"],
    ];
    for (const [payload, code] of cases) {
      const res = await createAs(cookie, "badinput", payload);
      expect(res.status).toBe(400);
      expect((res as unknown as { body: { error: string } }).body.error).toBe(code);
    }
    const listed = (await (
      await listGet(new Request("http://localhost/api/requests", { headers: { cookie } }))
    ).json()) as { total: number };
    expect(listed.total).toBe(0);
  });

  it("requires authentication", async () => {
    const res = await createPost(postJson("http://localhost/api/requests", { recipientName: "X" }));
    expect(res.status).toBe(401);
  });

  it("rejects forged origins on create", async () => {
    const { cookie } = await login("csrf");
    const res = await createPost(
      postJson(
        "http://localhost/api/requests",
        { recipientName: "D", asset: "USDC", network: "Base", address: EVM_A, amount: "1" },
        { cookie, origin: "https://evil.example", ...withClient("csrf") },
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!LIVE)("public resolution", () => {
  it("resolves active terms without login and only public fields", async () => {
    const { cookie } = await login("public");
    const { body } = await createAs(cookie, "public", { memo: "Rent" });
    const publicId = body.request["publicId"] as string;
    const res = await publicGet(new Request(`http://localhost/api/requests/${publicId}`), {
      params: Promise.resolve({ publicId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const view = ((await res.json()) as { request: Record<string, unknown> }).request;
    expect(Object.keys(view).sort()).toEqual(
      ["amount", "amountAtomic", "asset", "destination", "expiresAt", "memo", "network", "publicId", "recipientName", "route", "status", "url"].sort(),
    );
    expect(view).toMatchObject({
      publicId,
      recipientName: "Daniel",
      amount: "50",
      amountAtomic: "50000000",
      asset: "USDC",
      network: "Base",
      destination: EVM_A,
      memo: "Rent",
      status: "active",
      url: `/r/${publicId}`,
    });
    // Nothing private leaks.
    for (const leaked of ["creatorUserId", "id", "userId", "session", "openedAt", "createdAt", "transferHistory", "transfers"]) {
      expect(view[leaked]).toBeUndefined();
    }
  });

  it("returns 404 for unknown or malformed ids", async () => {
    const missing = await publicGet(new Request("http://localhost/api/requests/nope-nope"), {
      params: Promise.resolve({ publicId: "nope-nope" }),
    });
    expect(missing.status).toBe(404);
    const toolong = await publicGet(new Request("http://localhost/api/requests/x"), {
      params: Promise.resolve({ publicId: "x".repeat(65) }),
    });
    expect(toolong.status).toBe(404);
  });

  it("reports expired requests as unpayable with terms intact", async () => {
    const { cookie } = await login("expired");
    const { body } = await createAs(cookie, "expired");
    const publicId = body.request["publicId"] as string;
    await getDb().update(paymentRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(paymentRequests.publicId, publicId));
    const res = await publicGet(new Request(`http://localhost/api/requests/${publicId}`), {
      params: Promise.resolve({ publicId }),
    });
    expect(res.status).toBe(200);
    const view = ((await res.json()) as { request: { status: string; recipientName: string } }).request;
    expect(view.status).toBe("expired");
    expect(view.recipientName).toBe("Daniel");
  });
});

describe.skipIf(!LIVE)("ownership and cancellation", () => {
  it("lists only the owner's requests with status filters and pagination", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    await createAs(alice.cookie, "alice");
    await createAs(alice.cookie, "alice");
    const cancelled = await createAs(alice.cookie, "alice");
    await cancelPatch(
      patchJson(`http://localhost/api/requests/${cancelled.body.request["publicId"] as string}`, { action: "cancel" }, { cookie: alice.cookie, ...withClient("alice") }),
      { params: Promise.resolve({ publicId: cancelled.body.request["publicId"] as string }) },
    );
    const all = (await (await listGet(new Request("http://localhost/api/requests", { headers: { cookie: alice.cookie } }))).json()) as {
      requests: { status: string }[];
      total: number;
    };
    expect(all.total).toBe(3);
    const active = (await (await listGet(new Request("http://localhost/api/requests?status=active", { headers: { cookie: alice.cookie } }))).json()) as { total: number };
    expect(active.total).toBe(2);
    const done = (await (await listGet(new Request("http://localhost/api/requests?status=cancelled", { headers: { cookie: alice.cookie } }))).json()) as { total: number };
    expect(done.total).toBe(1);
    const page = (await (await listGet(new Request("http://localhost/api/requests?page=2&pageSize=2", { headers: { cookie: alice.cookie } }))).json()) as {
      requests: unknown[];
      total: number;
      page: number;
    };
    expect(page.total).toBe(3);
    expect(page.requests.length).toBe(1);
    expect(page.page).toBe(2);
    const bobList = (await (await listGet(new Request("http://localhost/api/requests", { headers: { cookie: bob.cookie } }))).json()) as { total: number };
    expect(bobList.total).toBe(0);
    const bad = await listGet(new Request("http://localhost/api/requests?status=paid", { headers: { cookie: alice.cookie } }));
    expect(bad.status).toBe(400);
  });

  it("cancels idempotently and only for the creator", async () => {
    const alice = await login("cancel-alice");
    const bob = await login("cancel-bob");
    const { body } = await createAs(alice.cookie, "cancel");
    const publicId = body.request["publicId"] as string;
    const cancelAs = (cookie: string, tag: string, payload: unknown = { action: "cancel" }) =>
      cancelPatch(patchJson(`http://localhost/api/requests/${publicId}`, payload, { cookie, ...withClient(tag) }), {
        params: Promise.resolve({ publicId }),
      });
    expect((await cancelAs(bob.cookie, "cancel")).status).toBe(404);
    const first = await cancelAs(alice.cookie, "cancel");
    expect(first.status).toBe(200);
    const firstBody = ((await first.json()) as { request: { status: string; cancelledAt: string } }).request;
    expect(firstBody.status).toBe("cancelled");
    const second = await cancelAs(alice.cookie, "cancel");
    expect(second.status).toBe(200);
    expect(((await second.json()) as { request: { cancelledAt: string } }).request.cancelledAt).toBe(firstBody.cancelledAt);
    const pub = (await (await publicGet(new Request(`http://localhost/api/requests/${publicId}`), { params: Promise.resolve({ publicId }) })).json()) as {
      request: { status: string; amountAtomic: string };
    };
    expect(pub.request.status).toBe("cancelled");
    expect(pub.request.amountAtomic).toBe("50000000");
  });

  it("rejects term edits as immutable and forged origins", async () => {
    const { cookie } = await login("immutable");
    const { body } = await createAs(cookie, "immutable");
    const publicId = body.request["publicId"] as string;
    const patchAs = (payload: unknown, extra: Record<string, string> = {}) =>
      cancelPatch(patchJson(`http://localhost/api/requests/${publicId}`, payload, { cookie, ...withClient("immutable"), ...extra }), {
        params: Promise.resolve({ publicId }),
      });
    for (const payload of [{ amount: "999" }, { destination: EVM_B }, { asset: "USDT" }, {}, { action: "delete" }, { action: "cancel", extra: 1 }]) {
      expect((await patchAs(payload)).status).toBe(400);
    }
    expect((await patchAs({ action: "cancel" }, { origin: "https://evil.example" })).status).toBe(403);
    // Still active after all rejected mutations.
    const pub = (await (await publicGet(new Request(`http://localhost/api/requests/${publicId}`), { params: Promise.resolve({ publicId }) })).json()) as {
      request: { status: string };
    };
    expect(pub.request.status).toBe("active");
  });
});

describe.skipIf(!LIVE)("snapshot independence", () => {
  it("survives recipient-book edits and archives unchanged", async () => {
    const { cookie, userId } = await login("snapshot");
    const { body } = await createAs(cookie, "snapshot", { recipientName: "Sage", asset: "USDT", network: "Polygon", address: EVM_B, amount: "25.5" });
    const publicId = body.request["publicId"] as string;
    // Recipient book churn under the same display name.
    const { POST: createRecipient } = await import("../app/api/recipients/route");
    const { PATCH: patchRecipient } = await import("../app/api/recipients/[id]/route");
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Sage" }, { cookie, ...withClient("snapshot") }))
    ).json()) as { recipient: { id: string } };
    const rid = created.recipient.id;
    const { POST: createDest } = await import("../app/api/recipients/[id]/destinations/route");
    await createDest(
      postJson(`http://localhost/api/recipients/${rid}/destinations`, { asset: "USDC", network: "Base", address: EVM_A }, { cookie, ...withClient("snapshot") }),
      { params: Promise.resolve({ id: rid }) },
    );
    await patchRecipient(patchJson(`http://localhost/api/recipients/${rid}`, { displayName: "Sage Changed" }, { cookie, ...withClient("snapshot") }), {
      params: Promise.resolve({ id: rid }),
    });
    await patchRecipient(patchJson(`http://localhost/api/recipients/${rid}`, { archived: true }, { cookie, ...withClient("snapshot") }), {
      params: Promise.resolve({ id: rid }),
    });
    void userId;
    const pub = (await (await publicGet(new Request(`http://localhost/api/requests/${publicId}`), { params: Promise.resolve({ publicId }) })).json()) as {
      request: Record<string, unknown>;
    };
    expect(pub.request).toMatchObject({
      recipientName: "Sage",
      asset: "USDT",
      network: "Polygon",
      destination: EVM_B,
      amountAtomic: "25500000",
      status: "active",
    });
  });
});

describe.skipIf(!LIVE)("concurrency and rate limits", () => {
  it("creates distinct ids and cancels atomically under concurrency", async () => {
    const { cookie } = await login("conc");
    const creations = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createAs(cookie, `conc-${i}`).then((r) => ({ status: r.status, publicId: r.body.request["publicId"] as string })),
      ),
    );
    expect(creations.every((c) => c.status === 201)).toBe(true);
    expect(new Set(creations.map((c) => c.publicId)).size).toBe(10);
    const target = creations[0]?.publicId as string;
    const cancels = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        cancelPatch(
          patchJson(`http://localhost/api/requests/${target}`, { action: "cancel" }, { cookie, ...withClient(`conc-cancel-${i}`) }),
          { params: Promise.resolve({ publicId: target }) },
        ).then((r) => r.status),
      ),
    );
    expect(cancels.every((s) => s === 200)).toBe(true);
    const pub = (await (await publicGet(new Request(`http://localhost/api/requests/${target}`), { params: Promise.resolve({ publicId: target }) })).json()) as {
      request: { status: string };
    };
    expect(pub.request.status).toBe("cancelled");
  });

  it("throttles public-read bursts without blocking normal reads", async () => {
    const { cookie } = await login("rl");
    const { body } = await createAs(cookie, "rl");
    const publicId = body.request["publicId"] as string;
    const single = await publicGet(new Request(`http://localhost/api/requests/${publicId}`), {
      params: Promise.resolve({ publicId }),
    });
    expect(single.status).toBe(200);
    const burst = await Promise.all(
      Array.from({ length: 130 }, () =>
        publicGet(new Request(`http://localhost/api/requests/${publicId}`, { headers: { "x-forwarded-for": `b22-${RUN}-burst` } }), {
          params: Promise.resolve({ publicId }),
        }).then((r) => r.status),
      ),
    );
    expect(burst.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(burst.filter((s) => s === 200).length).toBeGreaterThan(0);
  }, 120_000);
});
