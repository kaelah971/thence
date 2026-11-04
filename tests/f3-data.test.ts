/**
 * F3.1 — recipients, wallets, activity, receipts and routes through the
 * browser client against the REAL route handlers (live dev database).
 * Transfers are inserted directly as fixtures: F3.1 never creates payments.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { recipientDestinations, recipientVerifications, transfers, users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { setUnauthorizedHandler } from "@/ui/lib/api";
import { addPerson, addWallet, editWallet, makePreferred, renamePerson, setArchived } from "@/ui/lib/recipient-actions";
import { getRecipient, listRecipients, toRecipientView, updateRecipient } from "@/ui/lib/recipients-api";
import { availabilityFor, fetchRouteCatalogue } from "@/ui/lib/routes-api";
import { canHaveReceipt, getReceipt, getTransfer, listTransfers, toActivityItem } from "@/ui/lib/transfers-api";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { GET as recipientsGET, POST as recipientsPOST } from "../app/api/recipients/route";
import { GET as recipientGET, PATCH as recipientPATCH } from "../app/api/recipients/[id]/route";
import { POST as destinationsPOST } from "../app/api/recipients/[id]/destinations/route";
import { PATCH as destinationPATCH } from "../app/api/recipients/[id]/destinations/[destId]/route";
import { GET as transfersGET } from "../app/api/transfers/route";
import { GET as transferGET } from "../app/api/transfers/[id]/route";
import { GET as receiptGET } from "../app/api/transfers/[id]/receipt/route";
import { GET as routesGET } from "../app/api/routes/public/route";
import { POST as logoutPOST } from "../app/api/session/logout/route";

const created: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of created) await getDb().delete(users).where(eq(users.id, id));
});

type Ctx = { params: Promise<Record<string, string>> };
type H = (req: Request, ctx: Ctx) => Promise<Response>;
const ROUTES: Array<[string, RegExp, H]> = [
  ["GET", /^\/api\/recipients$/, recipientsGET as unknown as H],
  ["POST", /^\/api\/recipients$/, recipientsPOST as unknown as H],
  ["GET", /^\/api\/recipients\/(?<id>[^/]+)$/, recipientGET as unknown as H],
  ["PATCH", /^\/api\/recipients\/(?<id>[^/]+)$/, recipientPATCH as unknown as H],
  ["POST", /^\/api\/recipients\/(?<id>[^/]+)\/destinations$/, destinationsPOST as unknown as H],
  ["PATCH", /^\/api\/recipients\/(?<id>[^/]+)\/destinations\/(?<destId>[^/]+)$/, destinationPATCH as unknown as H],
  ["GET", /^\/api\/transfers$/, transfersGET as unknown as H],
  ["GET", /^\/api\/transfers\/(?<id>[^/]+)$/, transferGET as unknown as H],
  ["GET", /^\/api\/transfers\/(?<id>[^/]+)\/receipt$/, receiptGET as unknown as H],
  ["GET", /^\/api\/routes\/public$/, routesGET as unknown as H],
  ["POST", /^\/api\/session\/logout$/, logoutPOST as unknown as H],
];

/** Browser-like fetch with a cookie, dispatching to the real handlers. */
function clientFor(cookie: string, label: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [m, re, handler] of ROUTES) {
      const match = m === method ? re.exec(url.pathname) : null;
      if (!match) continue;
      const headers = new Headers(init?.headers);
      headers.set("cookie", cookie);
      headers.set("x-forwarded-for", `f3-${label}-${RUN}`);
      const request = new Request(url, { method, headers, ...(init?.body ? { body: init.body as string } : {}) });
      return handler(request, { params: Promise.resolve({ ...(match.groups ?? {}) }) });
    }
    throw new TypeError(`no route ${method} ${url.pathname}`);
  }) as typeof fetch;
}

const ADDR_A = "0x4f2a9c1e7b3d8a0f6c5e2d1b9a8c7f6e5d4c3b21";
const ADDR_B = "0x1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e";
const ADDR_C = "0x9a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c";

async function newUser(label: string) {
  const login = await loginAs({ "x-forwarded-for": `f3-login-${label}-${RUN}` }, (id) => created.push(id));
  return { ...login, fetch: clientFor(login.cookie, label) };
}

describe.skipIf(!LIVE)("F3.1 recipients through the client", () => {
  it("starts empty, then adds a person with a preferred receiving wallet", async () => {
    const u = await newUser("add");
    const empty = await listRecipients({}, { fetch: u.fetch });
    expect(empty.ok && empty.data.total).toBe(0);

    const added = await addPerson({ name: "Daniel", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: u.fetch });
    expect(added.error).toBeNull();
    const list = await listRecipients({}, { fetch: u.fetch });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.total).toBe(1);
    const view = toRecipientView(list.data.recipients[0]!);
    expect(view).toMatchObject({ name: "Daniel", routeId: "usdc-polygon", address: ADDR_A, walletVerified: false });
  });

  it("keeps the backend's address validation and never duplicates a person on retry", async () => {
    const u = await newUser("retry");
    const bad = await addPerson({ name: "Mina", routeId: "usdc-arbitrum", address: "0x1234" }, null, { fetch: u.fetch });
    expect(bad.error?.field).toBe("address");
    expect(bad.recipientId).not.toBeNull();
    const mixedCase = await addPerson({ name: "Mina", routeId: "usdc-arbitrum", address: "0x4F2a9C1e7B3d8a0F6c5E2d1B9a8C7f6E5d4C3b21" }, bad.recipientId, { fetch: u.fetch });
    expect(mixedCase.error?.field).toBe("address"); // bad EIP-55 checksum rejected server-side
    const good = await addPerson({ name: "Mina", routeId: "usdc-arbitrum", address: ADDR_B }, bad.recipientId, { fetch: u.fetch });
    expect(good.error).toBeNull();
    expect(good.recipientId).toBe(bad.recipientId);
    const list = await listRecipients({}, { fetch: u.fetch });
    expect(list.ok && list.data.total).toBe(1);
  });

  it("renames, adds wallets, switches the preferred wallet and edits details", async () => {
    const u = await newUser("edit");
    const { recipientId } = await addPerson({ name: "Joon", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: u.fetch });
    const id = recipientId as string;
    expect(await renamePerson(id, "Joon Park", { fetch: u.fetch })).toBeNull();

    expect(await addWallet(id, { routeId: "usdc-ethereum", address: ADDR_B, makePreferred: false }, { fetch: u.fetch })).toBeNull();
    let detail = await getRecipient(id, { fetch: u.fetch });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.recipient.displayName).toBe("Joon Park");
    expect(detail.data.recipient.destinations).toHaveLength(2);
    const second = detail.data.recipient.destinations.find((d) => d.network === "Ethereum")!;
    expect(second.isDefault).toBe(false);

    expect(await makePreferred(id, second.id, { fetch: u.fetch })).toBeNull();
    expect(await editWallet(id, second.id, { routeId: "usdc-ethereum", address: ADDR_C }, { fetch: u.fetch })).toBeNull();
    detail = await getRecipient(id, { fetch: u.fetch });
    if (!detail.ok) throw new Error("detail failed");
    const preferred = detail.data.recipient.destinations.filter((d) => d.isDefault);
    expect(preferred).toHaveLength(1);
    expect(preferred[0]).toMatchObject({ network: "Ethereum", address: ADDR_C });
    const list = await listRecipients({}, { fetch: u.fetch });
    if (list.ok) expect(toRecipientView(list.data.recipients[0]!).routeId).toBe("usdc-ethereum");
  });

  it("archives (frozen, hidden by default) and reopens", async () => {
    const u = await newUser("archive");
    const { recipientId } = await addPerson({ name: "Sofia", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: u.fetch });
    const id = recipientId as string;
    expect(await setArchived(id, true, { fetch: u.fetch })).toBeNull();

    const active = await listRecipients({}, { fetch: u.fetch });
    expect(active.ok && active.data.total).toBe(0);
    const withArchived = await listRecipients({ archived: true }, { fetch: u.fetch });
    expect(withArchived.ok).toBe(true);
    if (withArchived.ok) expect(toRecipientView(withArchived.data.recipients[0]!).archived).toBe(true);

    const frozen = await renamePerson(id, "Nope", { fetch: u.fetch });
    expect(frozen?.message).toBeTruthy();
    expect(frozen?.message).not.toMatch(/409|ARCHIVED|API/);

    expect(await setArchived(id, false, { fetch: u.fetch })).toBeNull();
    const back = await listRecipients({}, { fetch: u.fetch });
    expect(back.ok && back.data.total).toBe(1);
  });

  it("searches by name", async () => {
    const u = await newUser("search");
    await addPerson({ name: "Alex Moreno", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: u.fetch });
    await addPerson({ name: "Ines Dubois", routeId: "usdc-polygon", address: ADDR_B }, null, { fetch: u.fetch });
    const found = await listRecipients({ q: "ines" }, { fetch: u.fetch });
    expect(found.ok && found.data.recipients.map((r) => r.displayName)).toEqual(["Ines Dubois"]);
  });

  it("shows Wallet verified only from a completed server-side verification", async () => {
    const u = await newUser("verified");
    const { recipientId } = await addPerson({ name: "Tomas", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: u.fetch });
    let list = await listRecipients({}, { fetch: u.fetch });
    if (list.ok) expect(toRecipientView(list.data.recipients[0]!).walletVerified).toBe(false);

    // Fixture: a completed verification row (normally produced by the B2.3 EVM proof flow).
    const db = getDb();
    const [dest] = await db.select().from(recipientDestinations).where(eq(recipientDestinations.recipientId, recipientId as string));
    const [verification] = await db
      .insert(recipientVerifications)
      .values({ address: ADDR_A, network: "Polygon", asset: "USDC", challenge: `f3-${RUN}-${Math.random()}`, verifiedAt: new Date(), destinationId: dest!.id })
      .returning();
    await db.update(recipientDestinations).set({ verificationId: verification!.id }).where(eq(recipientDestinations.id, dest!.id));

    list = await listRecipients({}, { fetch: u.fetch });
    if (list.ok) expect(toRecipientView(list.data.recipients[0]!).walletVerified).toBe(true);
    await db.update(recipientDestinations).set({ verificationId: null }).where(eq(recipientDestinations.id, dest!.id));
    await db.delete(recipientVerifications).where(eq(recipientVerifications.id, verification!.id));
  });

  it("isolates owners: another user's recipient is not found", async () => {
    const a = await newUser("ownerA");
    const b = await newUser("ownerB");
    const { recipientId } = await addPerson({ name: "Private", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: a.fetch });
    const peek = await getRecipient(recipientId as string, { fetch: b.fetch });
    expect(peek).toMatchObject({ ok: false, kind: "not-found" });
    const edit = await updateRecipient(recipientId as string, { displayName: "Hijack" }, { fetch: b.fetch });
    expect(edit).toMatchObject({ ok: false, kind: "not-found" });
    const bList = await listRecipients({}, { fetch: b.fetch });
    expect(bList.ok && bList.data.total).toBe(0);
  });

  it("rejects cross-site recipient creation (same-origin enforced)", async () => {
    const u = await newUser("origin");
    const res = await recipientsPOST(postJson("http://localhost/api/recipients", { displayName: "X" }, { cookie: u.cookie, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!LIVE)("F3.1 activity and receipts (read-only)", () => {
  async function insertTransfer(ownerUserId: string, status: string, amount = "25500000") {
    const [row] = await getDb()
      .insert(transfers)
      .values({ ownerUserId, routeId: "usdc-polygon", targetAsset: "USDC", targetNetwork: "Polygon", destination: ADDR_A, targetAmountAtomic: amount, status, recipientName: "Daniel" })
      .returning({ id: transfers.id });
    return row!.id;
  }

  it("shows an empty history for a new user", async () => {
    const u = await newUser("empty");
    const list = await listTransfers({}, { fetch: u.fetch });
    expect(list.ok && list.data.total).toBe(0);
  });

  it("maps real transfers into readable activity with everyday labels", async () => {
    const u = await newUser("activity");
    const moving = await insertTransfer(u.userId, "SERVER_FUNDED");
    await insertTransfer(u.userId, "RECONCILING", "1000000");
    const list = await listTransfers({}, { fetch: u.fetch });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const items = list.data.transfers.map((t) => toActivityItem(t)).filter(Boolean);
    expect(items).toHaveLength(2);
    const item = items.find((i) => i!.id === moving)!;
    expect(item).toMatchObject({ amount: "25.5", status: "SERVER_FUNDED", statusLabel: "Action needed — finish delivery", name: "Daniel", routeId: "usdc-polygon" });

    const detail = await getTransfer(moving, { fetch: u.fetch });
    expect(detail.ok && detail.data.transfer.status).toBe("SERVER_FUNDED");
  });

  it("offers a receipt only after delivery; the server refuses earlier", async () => {
    const u = await newUser("receipt");
    const moving = await insertTransfer(u.userId, "SERVER_FUNDED");
    expect(canHaveReceipt("SERVER_FUNDED")).toBe(false);
    const early = await getReceipt(moving, { fetch: u.fetch });
    expect(early).toMatchObject({ ok: false, kind: "conflict", code: "RECEIPT_NOT_READY" });

    // A DELIVERED row without structured proof is still not a receipt.
    const delivered = await insertTransfer(u.userId, "DELIVERED");
    expect(canHaveReceipt("DELIVERED")).toBe(true);
    const noProof = await getReceipt(delivered, { fetch: u.fetch });
    expect(noProof).toMatchObject({ ok: false, code: "RECEIPT_NOT_READY" });
  });

  it("hides other users' transfers", async () => {
    const a = await newUser("txA");
    const b = await newUser("txB");
    const id = await insertTransfer(a.userId, "SERVER_FUNDED");
    expect(await getTransfer(id, { fetch: b.fetch })).toMatchObject({ ok: false, kind: "not-found" });
    const bList = await listTransfers({}, { fetch: b.fetch });
    expect(bList.ok && bList.data.total).toBe(0);
  });
});

describe.skipIf(!LIVE)("F3.1 session expiry and logout", () => {
  it("turns data requests into a reconnect signal after logout", async () => {
    const u = await newUser("logout");
    await addPerson({ name: "Kept", routeId: "usdc-polygon", address: ADDR_A }, null, { fetch: u.fetch });
    let signalled = 0;
    setUnauthorizedHandler(() => (signalled += 1));
    try {
      const out = await u.fetch("/api/session/logout", { method: "POST" });
      expect(out.status).toBe(200);
      const after = await listRecipients({}, { fetch: u.fetch });
      expect(after).toMatchObject({ ok: false, kind: "unauthorized" });
      expect(signalled).toBe(1);
      const tx = await listTransfers({}, { fetch: u.fetch });
      expect(tx).toMatchObject({ ok: false, kind: "unauthorized" });
    } finally {
      setUnauthorizedHandler(() => {});
    }
  });
});

describe.skipIf(!LIVE)("F3.1 route catalogue", () => {
  it("derives availability from the server's own fields for every route", async () => {
    const u = await newUser("routes");
    const result = await fetchRouteCatalogue({ fetch: u.fetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const route of result.data.routes) {
      const { availability } = availabilityFor(route.id as never, result.data);
      if (availability === "available") {
        expect(route.status).toBe("live");
        expect(route.quoteable && route.enabled && route.supported).toBe(true);
      }
      if (!route.quoteable && route.status !== "host-dependent") expect(availability).not.toBe("available");
    }
    // USDT on Polygon is never satisfied by USDT0: it is only available if the server says so.
    const usdtPolygon = result.data.routes.find((r) => r.id === "usdt-polygon");
    if (usdtPolygon && usdtPolygon.status !== "live") expect(availabilityFor("usdt-polygon", result.data).availability).not.toBe("available");
  });
});
