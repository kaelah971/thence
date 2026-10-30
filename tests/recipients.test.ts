/**
 * B2.1 — recipients + payment destinations integration tests (live database).
 *
 * Runs against the dedicated Thence development database with isolated
 * records per run; existing data is never reset. Skipped when DATABASE_URL
 * is absent. Pure validation tests (keccak, guards) always run.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, getPool } from "@/lib/db";
import { transfers, users } from "@/db/schema";
import { issueChallenge, verifyChallengeAndLogin } from "@/lib/auth";
import { keccak256 } from "@/lib/keccak";
import {
  MAX_BODY_BYTES,
  checkDestination,
  isValidEvmAddress,
  readJsonBody,
  rejectForbiddenKeys,
} from "@/lib/recipients";
import { LIVE, RUN, deleteJson, fixtureWallet, loginAs, patchJson, postJson } from "./helpers";
import { DELETE as deleteDest, PATCH as patchDest } from "../app/api/recipients/[id]/destinations/[destId]/route";
import { GET as listDest, POST as createDest } from "../app/api/recipients/[id]/destinations/route";
import { GET as getRecipient, PATCH as patchRecipient } from "../app/api/recipients/[id]/route";
import { POST as verifyRoutePOST } from "../app/api/session/verify/route";
import { GET as listRecipients, POST as createRecipient } from "../app/api/recipients/route";
import { recipientDestinations, recipients } from "@/db/schema";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let clientCounter = 0;
const clientKey = (tag: string): string => `b21-${RUN}-${tag}-${clientCounter++}`;
const withClient = (tag: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "x-forwarded-for": clientKey(tag),
  ...extra,
});

const trackLogin = (tag: string) =>
  loginAs(withClient(`login-${tag}`), (id) => {
    createdUserIds.push(id);
  });

const EVM_A = "0x0000000000000000000000000000000000000001";
const EVM_B = "0x0000000000000000000000000000000000000002";
// Canonical EIP-55 checksummed addresses (ERC-55 spec test vectors; mixed-case
// must validate exactly, single-case flips must fail).
const EVM_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const EVM_CHECKSUMMED_2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const EVM_BAD_CHECKSUM = "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("keccak256 (EIP-55 dependency)", () => {
  it("matches the well-known empty-input vector", () => {
    expect(keccak256(Buffer.alloc(0)).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("validates EVM syntax and EIP-55 checksums", () => {
    expect(isValidEvmAddress(EVM_A)).toBe(true);
    expect(isValidEvmAddress(EVM_CHECKSUMMED)).toBe(true);
    expect(isValidEvmAddress(EVM_CHECKSUMMED_2)).toBe(true);
    expect(isValidEvmAddress(EVM_BAD_CHECKSUM)).toBe(false);
    expect(isValidEvmAddress("0x123")).toBe(false);
    expect(isValidEvmAddress("not-an-address")).toBe(false);
    expect(isValidEvmAddress("0xZZ00000000000000000000000000000000000001")).toBe(false);
  });
});

describe("network guard (pure)", () => {
  it("accepts supported pairs with valid addresses", () => {
    expect(checkDestination("Polygon", "USDT", EVM_A)).toEqual({ ok: true });
    expect(checkDestination("Base", "USDC", EVM_CHECKSUMMED)).toEqual({ ok: true });
  });
  it("rejects unsupported pairs", () => {
    expect(checkDestination("Base", "USDT", EVM_A)).toMatchObject({ ok: false, code: "UNSUPPORTED_ROUTE" });
    expect(checkDestination("Ethereum", "BTC", EVM_A)).toMatchObject({ ok: false, code: "UNSUPPORTED_ROUTE" });
  });
  it("rejects bad EVM addresses", () => {
    expect(checkDestination("Polygon", "USDT", "0x123")).toMatchObject({ ok: false, code: "INVALID_ADDRESS" });
  });
  it("rejects BOLT11 invoices as reusable destinations", () => {
    expect(
      checkDestination("Lightning", "BTC", "lnbc100n1p0examplepp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fake"),
    ).toMatchObject({ ok: false, code: "BOLT11_NOT_REUSABLE" });
  });
  it("marks other Lightning endpoints pending without a resolution contract", () => {
    expect(checkDestination("Lightning", "BTC", "satoshi@thence.example")).toMatchObject({
      ok: false,
      code: "LIGHTNING_DESTINATION_PENDING",
    });
    expect(checkDestination("Lightning", "BTC", "lnurl1dp68gurn8ghj7mrww4excttsd3hqc")).toMatchObject({
      ok: false,
      code: "LIGHTNING_DESTINATION_PENDING",
    });
  });
  it("rejects server-owned field forgery", () => {
    expect(() => rejectForbiddenKeys({ displayName: "x", verified: true })).toThrow();
    expect(() => rejectForbiddenKeys({ verificationId: "y" })).toThrow();
    expect(() => rejectForbiddenKeys({ owner_user_id: "z" })).toThrow();
    expect(() => rejectForbiddenKeys({ displayName: "ok" })).not.toThrow();
  });
  it("enforces the JSON body size cap", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    await expect(readJsonBody(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ displayName: big }) }))).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe.skipIf(!LIVE)("recipient CRUD", () => {
  it("creates, fetches, renames, archives and unarchives", async () => {
    const { cookie } = await trackLogin("crud");
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Daniel" }, { cookie, ...withClient("crud") }))
    ).json()) as { recipient: { id: string; displayName: string; archivedAt: null; defaultDestination: null; destinationCount: number } };
    expect(created.recipient.displayName).toBe("Daniel");
    const id = created.recipient.id;

    const fetched = (await (
      await getRecipient(new Request(`http://localhost/api/recipients/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })
    ).json()) as { recipient: { displayName: string; destinations: unknown[] } };
    expect(fetched.recipient.displayName).toBe("Daniel");
    expect(fetched.recipient.destinations).toEqual([]);

    const renamed = await patchRecipient(
      patchJson(`http://localhost/api/recipients/${id}`, { displayName: "Daniel M." }, { cookie, ...withClient("crud") }),
      { params: Promise.resolve({ id }) },
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { recipient: { displayName: string } }).recipient.displayName).toBe("Daniel M.");

    // Empty name rejected, empty patch rejected.
    expect((await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, { displayName: "  " }, { cookie, ...withClient("crud") }), { params: Promise.resolve({ id }) })).status).toBe(400);
    expect((await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, {}, { cookie, ...withClient("crud") }), { params: Promise.resolve({ id }) })).status).toBe(400);

    const archived = await patchRecipient(
      patchJson(`http://localhost/api/recipients/${id}`, { archived: true }, { cookie, ...withClient("crud") }),
      { params: Promise.resolve({ id }) },
    );
    expect(archived.status).toBe(200);
    const listed = (await (
      await listRecipients(new Request("http://localhost/api/recipients", { headers: { cookie } }))
    ).json()) as { recipients: { id: string }[]; total: number };
    expect(listed.recipients.find((r) => r.id === id)).toBeUndefined();
    const withArchived = (await (
      await listRecipients(new Request("http://localhost/api/recipients?archived=true", { headers: { cookie } }))
    ).json()) as { recipients: { id: string }[] };
    expect(withArchived.recipients.find((r) => r.id === id)).toBeDefined();

    // Archived recipients are frozen except for unarchive.
    expect((await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, { displayName: "Nope" }, { cookie, ...withClient("crud") }), { params: Promise.resolve({ id }) })).status).toBe(409);
    const unarchived = await patchRecipient(
      patchJson(`http://localhost/api/recipients/${id}`, { archived: false }, { cookie, ...withClient("crud") }),
      { params: Promise.resolve({ id }) },
    );
    expect(unarchived.status).toBe(200);
    expect(((await unarchived.json()) as { recipient: { archivedAt: null } }).recipient.archivedAt).toBeNull();
  });

  it("lists with search and pagination", async () => {
    const { cookie } = await trackLogin("search");
    for (const name of ["Alice Cooper", "Alice Springs", "Bob"]) {
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: name }, { cookie, ...withClient("search") }));
    }
    const q = (await (
      await listRecipients(new Request("http://localhost/api/recipients?q=Alice", { headers: { cookie } }))
    ).json()) as { recipients: { displayName: string }[]; total: number };
    expect(q.total).toBe(2);
    const page = (await (
      await listRecipients(new Request("http://localhost/api/recipients?page=2&pageSize=2", { headers: { cookie } }))
    ).json()) as { recipients: unknown[]; total: number; page: number; pageSize: number };
    expect(page.total).toBe(3);
    expect(page.recipients.length).toBe(1);
    expect(page.page).toBe(2);
  });

  it("returns 404 for unknown ids and requires authentication", async () => {
    const { cookie } = await trackLogin("nf");
    const missing = "00000000-0000-0000-0000-000000000000";
    expect((await getRecipient(new Request(`http://localhost/api/recipients/${missing}`, { headers: { cookie } }), { params: Promise.resolve({ id: missing }) })).status).toBe(404);
    expect((await listRecipients(new Request("http://localhost/api/recipients"))).status).toBe(401);
    expect((await createRecipient(postJson("http://localhost/api/recipients", { displayName: "X" }))).status).toBe(401);
  });

  it("forbids forged owner and verified fields", async () => {
    const { cookie } = await trackLogin("forge");
    expect((await createRecipient(postJson("http://localhost/api/recipients", { displayName: "X", owner_user_id: "other" }, { cookie, ...withClient("forge") }))).status).toBe(400);
    expect((await createRecipient(postJson("http://localhost/api/recipients", { displayName: "X", verified: true }, { cookie, ...withClient("forge") }))).status).toBe(400);
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Y" }, { cookie, ...withClient("forge") }))
    ).json()) as { recipient: { id: string } };
    const id = created.recipient.id;
    expect((await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, { verified: true }, { cookie, ...withClient("forge") }), { params: Promise.resolve({ id }) })).status).toBe(400);
  });
});

describe.skipIf(!LIVE)("destinations", () => {
  /**
   * B4.4.1: four workers share one Neon database; a single request can
   * rarely fail with a transient 5xx (connection pressure) while siblings
   * succeed. Retry a bounded number of times ONLY on 5xx, then assert as
   * usual — deterministic defects reproduce through the retry and still
   * fail loudly. 4xx responses are never retried.
   */
  async function patchDefault(
    cookie: string,
    id: string,
    destId: string,
    tag: string,
  ): Promise<{ status: number; body: unknown }> {
    const attempt = async () => {
      const r = await patchDest(
        patchJson(`http://localhost/api/recipients/${id}/destinations/${destId}`, { isDefault: true }, { cookie, ...withClient(tag) }),
        { params: Promise.resolve({ id, destId }) },
      );
      return { status: r.status, body: r.status === 200 ? null : await r.json().catch(() => null) };
    };
    // Up to 4 attempts with growing backoff: shared-DB stalls under
    // four-worker parallel load can outlast a single retry window.
    let res = await attempt();
    for (let i = 0; i < 3 && res.status >= 500; i++) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      res = await attempt();
    }
    return res;
  }
  async function recipientWith(tag: string): Promise<{ cookie: string; id: string }> {
    const { cookie } = await trackLogin(tag);
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Daniel" }, { cookie, ...withClient(tag) }))
    ).json()) as { recipient: { id: string } };
    return { cookie, id: created.recipient.id };
  }

  it("adds destinations; first becomes default; switches preserve one default", async () => {
    const { cookie, id } = await recipientWith("dest");
    const d1 = (await (
      await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDC", network: "Base", address: EVM_A, label: "Base savings" }, { cookie, ...withClient("dest") }), { params: Promise.resolve({ id }) })
    ).json()) as { destination: { id: string; isDefault: boolean; label: string; verification: { status: string } } };
    expect(d1.destination.isDefault).toBe(true);
    expect(d1.destination.label).toBe("Base savings");
    expect(d1.destination.verification).toEqual({ status: "added-by-you" });

    const d2 = (await (
      await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDT", network: "Polygon", address: EVM_B }, { cookie, ...withClient("dest") }), { params: Promise.resolve({ id }) })
    ).json()) as { destination: { id: string; isDefault: boolean } };
    expect(d2.destination.isDefault).toBe(false);

    const switched = await patchDefault(cookie, id, d2.destination.id, "dest");
    expect(switched.status).toBe(200);
    const all = (await (
      await listDest(new Request(`http://localhost/api/recipients/${id}/destinations`, { headers: { cookie } }), { params: Promise.resolve({ id }) })
    ).json()) as { destinations: { id: string; isDefault: boolean }[] };
    expect(all.destinations.filter((d) => d.isDefault).map((d) => d.id)).toEqual([d2.destination.id]);
  });

  it("keeps exactly one default under concurrent switches", async () => {
    const { cookie, id } = await recipientWith("conc");
    const ids: string[] = [];
    for (const [asset, network, address] of [["USDC", "Base", EVM_A], ["USDT", "Polygon", EVM_B], ["USDC", "Arbitrum", EVM_CHECKSUMMED]] as const) {
      const created = (await (
        await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset, network, address }, { cookie, ...withClient("conc") }), { params: Promise.resolve({ id }) })
      ).json()) as { destination: { id: string } };
      ids.push(created.destination.id);
    }
    const results = await Promise.all(
      [0, 1, 2, 0, 1].map((slot) => patchDefault(cookie, id, ids[slot] as string, "conc")),
    );
    expect(results.every((s) => s.status === 200), JSON.stringify(results.filter((s) => s.status !== 200))).toBe(true);
    const all = (await (
      await listDest(new Request(`http://localhost/api/recipients/${id}/destinations`, { headers: { cookie } }), { params: Promise.resolve({ id }) })
    ).json()) as { destinations: { isDefault: boolean }[] };
    expect(all.destinations.filter((d) => d.isDefault).length).toBe(1);
  });

  it("promotes the most recent sibling when the default is deleted", async () => {
    const { cookie, id } = await recipientWith("promo");
    const d1 = (await (
      await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDC", network: "Base", address: EVM_A }, { cookie, ...withClient("promo") }), { params: Promise.resolve({ id }) })
    ).json()) as { destination: { id: string } };
    const d2 = (await (
      await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDT", network: "Polygon", address: EVM_B }, { cookie, ...withClient("promo") }), { params: Promise.resolve({ id }) })
    ).json()) as { destination: { id: string } };
    const del = await deleteDest(deleteJson(`http://localhost/api/recipients/${id}/destinations/${d1.destination.id}`, { cookie, ...withClient("promo") }), {
      params: Promise.resolve({ id, destId: d1.destination.id }),
    });
    expect(del.status).toBe(200);
    const all = (await (
      await listDest(new Request(`http://localhost/api/recipients/${id}/destinations`, { headers: { cookie } }), { params: Promise.resolve({ id }) })
    ).json()) as { destinations: { id: string; isDefault: boolean }[] };
    expect(all.destinations.length).toBe(1);
    expect(all.destinations[0]).toMatchObject({ id: d2.destination.id, isDefault: true });
  });

  it("validates pairs and addresses on create and update", async () => {
    const { cookie, id } = await recipientWith("guard");
    const bad = [
      [{ asset: "USDT", network: "Base", address: EVM_A }, "UNSUPPORTED_ROUTE"],
      [{ asset: "USDC", network: "Base", address: "0x123" }, "INVALID_ADDRESS"],
      [{ asset: "USDC", network: "Base", address: EVM_BAD_CHECKSUM }, "INVALID_ADDRESS"],
      [{ asset: "BTC", network: "Lightning", address: "lnbc100n1p0fakepp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fake" }, "BOLT11_NOT_REUSABLE"],
      [{ asset: "BTC", network: "Lightning", address: "satoshi@thence.example" }, "LIGHTNING_DESTINATION_PENDING"],
    ] as const;
    for (const [payload, code] of bad) {
      const res = await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, payload, { cookie, ...withClient("guard") }), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
    // No partial writes: nothing persisted from the rejected batch.
    const all = (await (
      await listDest(new Request(`http://localhost/api/recipients/${id}/destinations`, { headers: { cookie } }), { params: Promise.resolve({ id }) })
    ).json()) as { destinations: unknown[] };
    expect(all.destinations).toEqual([]);

    const good = (await (
      await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDC", network: "Base", address: EVM_CHECKSUMMED }, { cookie, ...withClient("guard") }), { params: Promise.resolve({ id }) }
      )
    ).json()) as { destination: { id: string } };
    const badUpdate = await patchDest(
      patchJson(`http://localhost/api/recipients/${id}/destinations/${good.destination.id}`, { network: "Ethereum", asset: "BTC" }, { cookie, ...withClient("guard") }),
      { params: Promise.resolve({ id, destId: good.destination.id }) },
    );
    expect(badUpdate.status).toBe(400);
    expect(((await badUpdate.json()) as { error: string }).error).toBe("UNSUPPORTED_ROUTE");
  });

  it("edits labels and clears them", async () => {
    const { cookie, id } = await recipientWith("label");
    const created = (await (
      await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDC", network: "Base", address: EVM_A, label: "Main" }, { cookie, ...withClient("label") }), { params: Promise.resolve({ id }) })
    ).json()) as { destination: { id: string; label: string } };
    expect(created.destination.label).toBe("Main");
    const relabeled = (await (
      await patchDest(patchJson(`http://localhost/api/recipients/${id}/destinations/${created.destination.id}`, { label: "Savings" }, { cookie, ...withClient("label") }), { params: Promise.resolve({ id, destId: created.destination.id }) })
    ).json()) as { destination: { label: string } };
    expect(relabeled.destination.label).toBe("Savings");
    const cleared = (await (
      await patchDest(patchJson(`http://localhost/api/recipients/${id}/destinations/${created.destination.id}`, { label: null }, { cookie, ...withClient("label") }), { params: Promise.resolve({ id, destId: created.destination.id }) })
    ).json()) as { destination: { label: null } };
    expect(cleared.destination.label).toBeNull();
  });

  it("freezes archived recipients for destination writes", async () => {
    const { cookie, id } = await recipientWith("frozen");
    await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, { archived: true }, { cookie, ...withClient("frozen") }), { params: Promise.resolve({ id }) });
    expect((await createDest(postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDC", network: "Base", address: EVM_A }, { cookie, ...withClient("frozen") }), { params: Promise.resolve({ id }) })).status).toBe(409);
  });

  it("enforces the single-default constraint at the database level", async () => {
    const { rows } = await getPool().query(
      "SELECT indexname FROM pg_indexes WHERE tablename='recipient_destinations' AND indexname='recipient_destinations_single_default_uidx'",
    );
    expect(rows.length).toBe(1);
  });
});

describe.skipIf(!LIVE)("ownership and isolation", () => {
  it("never leaks across users (IDOR returns 404)", async () => {
    const alice = await trackLogin("alice");
    const bob = await trackLogin("bob");
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Alice Private" }, { cookie: alice.cookie, ...withClient("idor") }))
    ).json()) as { recipient: { id: string } };
    const id = created.recipient.id;
    const dest = (await (
      await createDest(
        postJson(`http://localhost/api/recipients/${id}/destinations`, { asset: "USDC", network: "Base", address: EVM_A }, { cookie: alice.cookie, ...withClient("idor") }),
        { params: Promise.resolve({ id }) },
      )
    ).json()) as { destination: { id: string } };

    expect((await getRecipient(new Request(`http://localhost/api/recipients/${id}`, { headers: { cookie: bob.cookie } }), { params: Promise.resolve({ id }) })).status).toBe(404);
    expect((await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, { displayName: "Hijacked" }, { cookie: bob.cookie, ...withClient("idor") }), { params: Promise.resolve({ id }) })).status).toBe(404);
    expect((await patchDest(patchJson(`http://localhost/api/recipients/${id}/destinations/${dest.destination.id}`, { label: "Hijacked" }, { cookie: bob.cookie, ...withClient("idor") }), { params: Promise.resolve({ id, destId: dest.destination.id }) })).status).toBe(404);
    expect((await deleteDest(deleteJson(`http://localhost/api/recipients/${id}/destinations/${dest.destination.id}`, { cookie: bob.cookie, ...withClient("idor") }), { params: Promise.resolve({ id, destId: dest.destination.id }) })).status).toBe(404);
    const bobList = (await (await listRecipients(new Request("http://localhost/api/recipients", { headers: { cookie: bob.cookie } }))).json()) as {
      recipients: { id: string }[];
    };
    expect(bobList.recipients.find((r) => r.id === id)).toBeUndefined();
    // Alice's data is untouched.
    const aliceDetail = (await (await getRecipient(new Request(`http://localhost/api/recipients/${id}`, { headers: { cookie: alice.cookie } }), { params: Promise.resolve({ id }) })).json()) as {
      recipient: { displayName: string };
    };
    expect(aliceDetail.recipient.displayName).toBe("Alice Private");
  });
});

describe.skipIf(!LIVE)("transfer history preservation", () => {
  it("keeps transfer links across rename and archive", async () => {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    const { login } = await verifyChallengeAndLogin({ challenge: message, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(message) });
    createdUserIds.push(login.userId);
    const db = getDb();
    const recRows = await db.insert(recipients).values({ ownerUserId: login.userId, displayName: "History" }).returning();
    const recId = recRows[0]?.id as string;
    const destRows = await db.insert(recipientDestinations).values({
      recipientId: recId,
      asset: "USDC",
      network: "Base",
      address: EVM_A,
      isDefault: true,
    }).returning();
    expect(destRows.length).toBe(1);
    const txRows = await db.insert(transfers).values({
      ownerUserId: login.userId,
      recipientId: recId,
      routeId: "usdc-base",
      targetAsset: "USDC",
      targetNetwork: "Base",
      destination: EVM_A,
      targetAmountAtomic: "50000000",
      status: "DELIVERED",
    }).returning({ id: transfers.id });
    expect(txRows.length).toBe(1);

    // Re-login with the SAME wallet so the session belongs to the transfer owner.
    const { message: m2 } = await issueChallenge();
    const loginRes = await verifyRoutePOST(
      postJson("http://localhost/api/session/verify", { challenge: m2, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(m2) }, withClient("hist")),
    );
    if (loginRes.status !== 200) throw new Error(`re-login failed: ${loginRes.status}`);
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0]?.trim() ?? "";
    const renamed = await patchRecipient(patchJson(`http://localhost/api/recipients/${recId}`, { displayName: "History v2" }, { cookie, ...withClient("hist") }), { params: Promise.resolve({ id: recId }) });
    expect(renamed.status).toBe(200);
    await patchRecipient(patchJson(`http://localhost/api/recipients/${recId}`, { archived: true }, { cookie, ...withClient("hist") }), { params: Promise.resolve({ id: recId }) });
    const detail = (await (await getRecipient(new Request(`http://localhost/api/recipients/${recId}`, { headers: { cookie } }), { params: Promise.resolve({ id: recId }) })).json()) as {
      recipient: { transferCount: number; lastPaidAt: string | null; destinationCount: number };
    };
    expect(detail.recipient.transferCount).toBe(1);
    expect(detail.recipient.lastPaidAt).not.toBeNull();
    expect(detail.recipient.destinationCount).toBe(1);
  });
});
