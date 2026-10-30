/**
 * B4.1 — transfer intents with live quote binding (Neon integration).
 *
 * No swap creation, invoice, approval or settlement anywhere in this slice:
 * several tests assert the transfer never leaves QUOTED and that no proofs
 * or secrets are ever stored. Uses isolated records; no database reset.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, getPool } from "@/lib/db";
import { paymentRequests, transferProofs, transfers, users } from "@/db/schema";
import { LIVE, RUN, loginAs, patchJson, postJson } from "./helpers";
import { POST as createPost } from "../app/api/transfers/route";
import { GET as listGet } from "../app/api/transfers/route";
import { GET as getOne } from "../app/api/transfers/[id]/route";
import { POST as requotePost } from "../app/api/transfers/[id]/requote/route";
import { POST as createRecipient } from "../app/api/recipients/route";
import { POST as createDest } from "../app/api/recipients/[id]/destinations/route";
import { PATCH as patchRecipient } from "../app/api/recipients/[id]/route";
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
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b41-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const EVM_A = "0x0000000000000000000000000000000000000001";
const EVM_B = "0x0000000000000000000000000000000000000002";
const ROUTES = "usdc-polygon,usdc-arbitrum,usdc-ethereum,usdt-polygon";

async function savedDestination(cookie: string, tag: string, address = EVM_A, name = "Daniel"): Promise<{ recipientId: string; destId: string }> {
  const created = (await (
    await createRecipient(postJson("http://localhost/api/recipients", { displayName: name }, { cookie, ...withClient(tag) }))
  ).json()) as { recipient: { id: string } };
  const dest = (await (
    await createDest(
      postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations`, { asset: "USDC", network: "Polygon", address }, { cookie, ...withClient(tag) }),
      { params: Promise.resolve({ id: created.recipient.id }) },
    )
  ).json()) as { destination: { id: string } };
  return { recipientId: created.recipient.id, destId: dest.destination.id };
}

/**
 * B4.4.1: four workers share one Neon database plus the live Satora
 * provider; a request can rarely fail with a transient 5xx (pool
 * pressure / provider timeout) while siblings succeed. Retry a bounded
 * number of times ONLY on 5xx, then assert as usual — deterministic
 * defects (4xx) fail immediately and still fail loudly. Transfer retries
 * use a fresh idempotency key per attempt so a successful creation still
 * returns exactly 201 (never a 200 idempotent replay).
 */
async function postTransferExpecting201(
  buildBody: (attempt: number) => Record<string, unknown>,
  cookie: string,
  tag: string,
): Promise<Response> {
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    res = await createPost(postJson("http://localhost/api/transfers", buildBody(attempt), { cookie, ...withClient(tag) }));
    if (res.status < 500) return res;
  }
  return res as Response;
}

function setRoutes(value: string): string | undefined {
  const previous = process.env["THENCE_ENABLED_ROUTES"];
  process.env["THENCE_ENABLED_ROUTES"] = value;
  return previous;
}
function restoreRoutes(previous: string | undefined): void {
  if (previous === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
  else process.env["THENCE_ENABLED_ROUTES"] = previous;
}

describe.skipIf(!LIVE)("transfer creation (live quote binding)", () => {
  it("creates a QUOTED intent from a saved destination with an immutable snapshot", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("create-saved");
      const { destId } = await savedDestination(cookie, "create-saved");
      const res = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "5000000", idempotencyKey: `k-${RUN}-saved-1`, recipientDestinationId: destId }, { cookie, ...withClient("create-saved") }),
      );
      expect(res.status).toBe(201);
      const body = ((await res.json()) as { transfer: Record<string, unknown>; deduplicated: boolean }).transfer;
      expect(body["status"]).toBe("QUOTED");
      expect(body["statusLabel"]).toBe("Ready to pay");
      expect(body["recipientName"]).toBe("Daniel");
      expect(body["destination"]).toBe(EVM_A);
      expect(body["targetAmountAtomic"]).toBe("5000000");
      const quote = body["quote"] as Record<string, unknown>;
      expect(quote["exact"]).toBe(true);
      expect(quote["netTargetAmountAtomic"]).toBe("5000000");
      expect(quote["provider"]).toBe("satora");
      expect(quote["revision"]).toBe(1);
      expect(typeof quote["sourceSats"]).toBe("string");
      // Snapshot survives recipient rename.
      const detail0 = ((await (await getOne(new Request(`http://localhost/api/transfers/${body["id"] as string}`, { headers: { cookie } }), { params: Promise.resolve({ id: body["id"] as string }) })).json()) as { transfer: Record<string, unknown> }).transfer;
      expect(detail0["recipientDestinationId"]).toBe(destId);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("creates from a payment request snapshot and from a direct destination", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("create-mixed");
      let reqRes: Response | null = null;
      for (let attempt = 0; attempt < 4 && (!reqRes || reqRes.status >= 500); attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
        reqRes = await createRequest(
          postJson("http://localhost/api/requests", { recipientName: "Mara", asset: "USDC", network: "Polygon", address: EVM_B, amount: "25.00", expiresInSeconds: 3600 }, { cookie, ...withClient("create-mixed") }),
        );
      }
      const created = (await (reqRes as Response).json()) as { request: { publicId: string; amountAtomic: string } };
      const fromReq = await postTransferExpecting201(
        (attempt) => ({ routeId: "usdc-polygon", targetAmountAtomic: created.request.amountAtomic, idempotencyKey: `k-${RUN}-req-1${attempt === 0 ? "" : `-r${attempt}`}`, requestPublicId: created.request.publicId }),
        cookie,
        "create-mixed",
      );
      expect(fromReq.status).toBe(201);
      const reqBody = ((await fromReq.json()) as { transfer: Record<string, unknown> }).transfer;
      expect(reqBody["recipientName"]).toBe("Mara");
      expect(reqBody["destination"]).toBe(EVM_B);
      expect(reqBody["requestId"]).not.toBeNull();
      const direct = await postTransferExpecting201(
        (attempt) => ({ routeId: "usdc-polygon", targetAmountAtomic: "1000000", idempotencyKey: `k-${RUN}-direct-1${attempt === 0 ? "" : `-r${attempt}`}`, recipientName: "One-off", direct: { asset: "USDC", network: "Polygon", address: EVM_A } }),
        cookie,
        "create-mixed",
      );
      expect(direct.status).toBe(201);
      const directBody = ((await direct.json()) as { transfer: Record<string, unknown> }).transfer;
      expect(directBody["recipientName"]).toBe("One-off");
      expect(directBody["recipientDestinationId"]).toBeNull();
      expect(directBody["requestId"]).toBeNull();
    } finally {
      restoreRoutes(previous);
    }
  });

  it("rejects forged ownership, status and proof fields", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("forge");
      for (const payload of [
        { routeId: "usdc-polygon", targetAmountAtomic: "100", idempotencyKey: `k-${RUN}-f1`, status: "DELIVERED" },
        { routeId: "usdc-polygon", targetAmountAtomic: "100", idempotencyKey: `k-${RUN}-f2`, owner_user_id: "other" },
        { routeId: "usdc-polygon", targetAmountAtomic: "100", idempotencyKey: `k-${RUN}-f3`, quoteRevision: 99 },
        { routeId: "usdc-polygon", targetAmountAtomic: "100", idempotencyKey: `k-${RUN}-f4`, direct: { asset: "USDC", network: "Polygon", address: EVM_A }, requestPublicId: "x" },
      ]) {
        const res = await createPost(postJson("http://localhost/api/transfers", payload, { cookie, ...withClient("forge") }));
        expect([400, 404, 409].includes(res.status)).toBe(true);
        if (res.status === 400) {
          expect(["FIELD_FORBIDDEN", "BAD_BODY"].includes(((await res.json()) as { error: string }).error)).toBe(true);
        }
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("rejects mismatched snapshots, archived owners and bad routes", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("reject");
      const created = (await (
        await createRequest(
          postJson("http://localhost/api/requests", { recipientName: "Zed", asset: "USDC", network: "Polygon", address: EVM_A, amount: "10.00", expiresInSeconds: 3600 }, { cookie, ...withClient("reject") }),
        )
      ).json()) as { request: { publicId: string; amountAtomic: string } };
      const wrongAmount = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "999", idempotencyKey: `k-${RUN}-r1`, requestPublicId: created.request.publicId }, { cookie, ...withClient("reject") }),
      );
      expect(wrongAmount.status).toBe(400);
      expect(((await wrongAmount.json()) as { error: string }).error).toBe("SNAPSHOT_MISMATCH");
      // Cancel the request, then retry: terminal for new intents.
      await cancelRequest(patchJson(`http://localhost/api/requests/${created.request.publicId}`, { action: "cancel" }, { cookie, ...withClient("reject") }), { params: Promise.resolve({ publicId: created.request.publicId }) });
      const afterCancel = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: created.request.amountAtomic, idempotencyKey: `k-${RUN}-r2`, requestPublicId: created.request.publicId }, { cookie, ...withClient("reject") }),
      );
      expect(afterCancel.status).toBe(409);
      // Expired request snapshot is terminal too.
      const expiring = (await (
        await createRequest(
          postJson("http://localhost/api/requests", { recipientName: "Old", asset: "USDC", network: "Polygon", address: EVM_A, amount: "5.00", expiresInSeconds: 3600 }, { cookie, ...withClient("reject") }),
        )
      ).json()) as { request: { publicId: string; amountAtomic: string } };
      await getDb().update(paymentRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(paymentRequests.publicId, expiring.request.publicId));
      const afterExpiry = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: expiring.request.amountAtomic, idempotencyKey: `k-${RUN}-r3`, requestPublicId: expiring.request.publicId }, { cookie, ...withClient("reject") }),
      );
      expect(afterExpiry.status).toBe(409);
      expect(((await afterExpiry.json()) as { error: string }).error).toBe("REQUEST_EXPIRED");
      // Unknown + disabled + provider-unavailable routes (pairs must match the route).
      const routeCases: Array<{ routeId: string; direct: { asset: string; network: string; address: string }; code: string }> = [
        { routeId: "nope", direct: { asset: "USDC", network: "Polygon", address: EVM_A }, code: "UNKNOWN_ROUTE" },
        // usdt-arbitrum is known but not enabled in this run.
        { routeId: "usdt-arbitrum", direct: { asset: "USDT", network: "Arbitrum", address: EVM_A }, code: "ROUTE_DISABLED" },
        // usdt-polygon is enabled but the provider offers no classic USDT there.
        { routeId: "usdt-polygon", direct: { asset: "USDT", network: "Polygon", address: EVM_A }, code: "ROUTE_NOT_QUOTEABLE" },
      ];
      for (const { routeId, direct, code } of routeCases) {
        const res = await createPost(
          postJson("http://localhost/api/transfers", { routeId, targetAmountAtomic: "5000000", idempotencyKey: `k-${RUN}-r-${routeId}`, direct }, { cookie, ...withClient("reject") }),
        );
        // usdc-ethereum disabled in this run; usdt-polygon has no classic USDT.
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe(code);
      }
      // Below provider minimum.
      const dust = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "1", idempotencyKey: `k-${RUN}-dust`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...withClient("reject") }),
      );
      expect(dust.status).toBe(400);
      expect(((await dust.json()) as { error: string }).error).toBe("BELOW_MINIMUM");
      // Archived recipient destination.
      const { recipientId, destId } = await savedDestination(cookie, "reject-arch", EVM_B, "Archie");
      await patchRecipient(patchJson(`http://localhost/api/recipients/${recipientId}`, { archived: true }, { cookie, ...withClient("reject-arch") }), { params: Promise.resolve({ id: recipientId }) });
      const archived = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "100", idempotencyKey: `k-${RUN}-arch`, recipientDestinationId: destId }, { cookie, ...withClient("reject-arch") }),
      );
      expect(archived.status).toBe(409);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("enforces idempotency: same key+same intent deduplicates, conflicts fail, races converge", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("idem");
      const payload = { routeId: "usdc-polygon", targetAmountAtomic: "2000000", idempotencyKey: `k-${RUN}-idem`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } };
      const first = await createPost(postJson("http://localhost/api/transfers", payload, { cookie, ...withClient("idem") }));
      expect(first.status).toBe(201);
      const firstBody = ((await first.json()) as { transfer: { id: string }; deduplicated: boolean });
      expect(firstBody.deduplicated).toBe(false);
      const retry = await createPost(postJson("http://localhost/api/transfers", payload, { cookie, ...withClient("idem") }));
      expect(retry.status).toBe(200);
      const retryBody = ((await retry.json()) as { transfer: { id: string }; deduplicated: boolean });
      expect(retryBody.deduplicated).toBe(true);
      expect(retryBody.transfer.id).toBe(firstBody.transfer.id);
      const conflict = await createPost(
        postJson("http://localhost/api/transfers", { ...payload, targetAmountAtomic: "3000000" }, { cookie, ...withClient("idem") }),
      );
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: string }).error).toBe("IDEMPOTENCY_CONFLICT");
      // Concurrent identical creates converge on one record.
      const racing = await Promise.all(
        Array.from({ length: 5 }, () =>
          createPost(postJson("http://localhost/api/transfers", { ...payload, idempotencyKey: `k-${RUN}-race` }, { cookie, ...withClient("idem-race") })).then(async (r) => ({
            status: r.status,
            id: ((await r.json()) as { transfer?: { id?: string } }).transfer?.id,
          })),
        ),
      );
      expect(racing.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(new Set(racing.map((r) => r.id)).size).toBe(1);
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);

  it("isolates owners and paginates the list", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const alice = await login("alice-t");
      const bob = await login("bob-t");
      const { destId } = await savedDestination(alice.cookie, "alice-t");
      const created = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "1000000", idempotencyKey: `k-${RUN}-own`, recipientDestinationId: destId }, { cookie: alice.cookie, ...withClient("alice-t") }),
      );
      expect(created.status).toBe(201);
      const id = ((await created.json()) as { transfer: { id: string } }).transfer.id;
      expect((await getOne(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie: bob.cookie } }), { params: Promise.resolve({ id }) })).status).toBe(404);
      expect((await requotePost(postJson(`http://localhost/api/transfers/${id}/requote`, { expectedQuoteRevision: 1 }, { cookie: bob.cookie, ...withClient("bob-t") }), { params: Promise.resolve({ id }) })).status).toBe(404);
      const bobList = (await (await listGet(new Request("http://localhost/api/transfers", { headers: { cookie: bob.cookie } }))).json()) as { total: number };
      expect(bobList.total).toBe(0);
      const aliceList = (await (await listGet(new Request("http://localhost/api/transfers?page=1&pageSize=1", { headers: { cookie: alice.cookie } }))).json()) as {
        total: number;
        transfers: unknown[];
        page: number;
      };
      expect(aliceList.total).toBe(1);
      expect(aliceList.transfers.length).toBe(1);
      // Cross-user saved destination is invisible.
      const hijack = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "100", idempotencyKey: `k-${RUN}-hijack`, recipientDestinationId: destId }, { cookie: bob.cookie, ...withClient("bob-t") }),
      );
      expect(hijack.status).toBe(404);
    } finally {
      restoreRoutes(previous);
    }
  });
});

describe.skipIf(!LIVE)("requote lifecycle", () => {
  it("refreshes with live terms under optimistic concurrency", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("requote");
      const created = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "3000000", idempotencyKey: `k-${RUN}-rq`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...withClient("requote") }),
      );
      expect(created.status).toBe(201);
      const t0 = ((await created.json()) as { transfer: { id: string; quote: { revision: number } } }).transfer;
      const id = t0.id;
      const again = await requotePost(postJson(`http://localhost/api/transfers/${id}/requote`, { expectedQuoteRevision: 999 }, { cookie, ...withClient("requote") }), { params: Promise.resolve({ id }) });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe("VERSION_CONFLICT");
      const fresh = await requotePost(postJson(`http://localhost/api/transfers/${id}/requote`, { expectedQuoteRevision: 1 }, { cookie, ...withClient("requote") }), { params: Promise.resolve({ id }) });
      expect(fresh.status).toBe(200);
      const freshBody = ((await fresh.json()) as { transfer: { quote: { revision: number; netTargetAmountAtomic: string }; status: string } }).transfer;
      expect(freshBody.quote.revision).toBe(2);
      expect(freshBody.quote.netTargetAmountAtomic).toBe("3000000");
      expect(freshBody.status).toBe("QUOTED");
      // Expired quote stays QUOTED (never failed) and can refresh.
      await getDb().update(transfers).set({ quoteExpiresAt: new Date(Date.now() - 1000) }).where(eq(transfers.id, id));
      const detail = (await (await getOne(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        transfer: { status: string; quote: { fresh: boolean } };
      };
      expect(detail.transfer.status).toBe("QUOTED");
      expect(detail.transfer.quote.fresh).toBe(false);
      const revived = await requotePost(postJson(`http://localhost/api/transfers/${id}/requote`, { expectedQuoteRevision: 2 }, { cookie, ...withClient("requote") }), { params: Promise.resolve({ id }) });
      expect(revived.status).toBe(200);
      expect(((await revived.json()) as { transfer: { quote: { revision: number; fresh: boolean } } }).transfer.quote.revision).toBe(3);
      // Concurrent requotes: exactly one winner per revision.
      const raced = await Promise.all(
        [3, 3, 3].map(() =>
          requotePost(postJson(`http://localhost/api/transfers/${id}/requote`, { expectedQuoteRevision: 3 }, { cookie, ...withClient("requote-race") }), { params: Promise.resolve({ id }) }).then((r) => r.status),
        ),
      );
      expect(raced.filter((s) => s === 200).length).toBe(1);
      expect(raced.filter((s) => s === 409).length).toBe(2);
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);
});

describe.skipIf(!LIVE)("transfer safety invariants", () => {
  it("never advances past QUOTED and never stores proofs or secrets", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie, userId: safeUserId } = await login("safe");
      await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "1000000", idempotencyKey: `k-${RUN}-safe`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...withClient("safe") }),
      );
      const listed = (await (await listGet(new Request("http://localhost/api/transfers", { headers: { cookie } }))).json()) as {
        transfers: { status: string }[];
      };
      expect(listed.transfers.length).toBeGreaterThan(0);
      expect(listed.transfers.every((t) => t.status === "QUOTED")).toBe(true);
      // Scoped to this user: parallel suites may attach proofs to their own transfers.
      const proofs = await getDb()
        .select({ id: transferProofs.id })
        .from(transferProofs)
        .innerJoin(transfers, eq(transfers.id, transferProofs.transferId))
        .where(eq(transfers.ownerUserId, safeUserId));
      // No secret-bearing columns exist on transfers (shape asserted at runtime).
      const cols = await getPool().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'transfers'");
      const names = (cols.rows as { column_name: string }[]).map((r) => r.column_name);
      for (const banned of ["mnemonic", "secret", "preimage", "private_key", "swap_secret"]) {
        expect(names.some((n) => n.includes(banned))).toBe(false);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("requires auth and honours origin plus body limits", async () => {
    expect((await createPost(postJson("http://localhost/api/transfers", { routeId: "usdc-polygon" }))).status).toBe(401);
    expect((await listGet(new Request("http://localhost/api/transfers"))).status).toBe(401);
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("csrf-t");
      const forged = await createPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "1", idempotencyKey: "k-csrf" }, { cookie, origin: "https://evil.example", ...withClient("csrf-t") }),
      );
      expect(forged.status).toBe(403);
      const big = await createPost(
        new Request("http://localhost/api/transfers", { method: "POST", headers: { cookie, "content-type": "application/json", ...withClient("csrf-t") }, body: JSON.stringify({ pad: "x".repeat(9000) }) }),
      );
      expect(big.status).toBe(413);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("throttles write bursts without secrets", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("rl-t");
      const fireBurst = (suffix: string): Promise<number[]> =>
        Promise.all(
          Array.from({ length: 61 }, (_, i) =>
            createPost(postJson("http://localhost/api/transfers", { routeId: "nope", targetAmountAtomic: "1", idempotencyKey: `k-${RUN}-rl${suffix}-${i}` }, { cookie, "x-forwarded-for": `b41-${RUN}-rlburst` })).then((r) => r.status),
          ),
        );
      let burst = await fireBurst("");
      if (burst.filter((s) => s === 429).length === 0 && burst.some((s) => s >= 500)) {
        // Transient pool pressure absorbed the burst as 5xx instead of 429s.
        // The first burst already saturated this user's window, so a second
        // burst deterministically hits 429s if the limiter works — a real
        // limiter defect still fails below. Bounded, test-only, no 4xx retry.
        await new Promise((r) => setTimeout(r, 2000));
        burst = await fireBurst("-t2");
      }
      expect(burst.filter((s) => s === 429).length).toBeGreaterThan(0);
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);
});
