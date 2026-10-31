/**
 * F7.1 send-flow UX: banking-natural one-off sends with optional saving.
 *
 * - A pasted/typed address never creates records by itself: the direct
 *   transfer body carries no recipient linkage (pure, no DB).
 * - The receipt "Save recipient" path creates exactly one recipient plus one
 *   default wallet, and rejects an empty nickname with zero rows (live,
 *   isolated test DB only — never production).
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/db/schema";
import { buildTransferBody } from "@/ui/lib/prepare-flow";
import { LIVE, loginAs, postJson } from "./helpers";
import { GET as listRecipients, POST as createRecipient } from "../app/api/recipients/route";
import { GET as getRecipient } from "../app/api/recipients/[id]/route";
import { POST as createDest } from "../app/api/recipients/[id]/destinations/route";

const ADDRESS = "0x0000000000000000000000000000000000000001";

describe("F7.1 one-off continue carries no recipient linkage", () => {
  it("builds a direct body with no recipient id, destination id, or name requirement", () => {
    const body = buildTransferBody({
      payee: { id: null, destinationId: null, routeId: "usdc-polygon", address: ADDRESS, name: null },
      fixed: null,
      targetAmountAtomic: "1000000",
      idempotencyKey: "k-f7-direct",
    });
    expect(body).toEqual({
      routeId: "usdc-polygon",
      targetAmountAtomic: "1000000",
      idempotencyKey: "k-f7-direct",
      direct: { asset: "USDC", network: "Polygon", address: ADDRESS },
    });
    expect(body).not.toHaveProperty("recipientId");
    expect(body).not.toHaveProperty("recipientDestinationId");
  });
});

const createdUserIds = new Set<string>();
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

let clientCounter = 0;
const withClient = (tag: string): Record<string, string> => ({
  "x-forwarded-for": `f71-${tag}-${clientCounter++}`,
});

describe.skipIf(!LIVE)("F7.1 receipt save offer", () => {
  it("rejects an empty nickname with zero recipient rows", async () => {
    const { cookie } = await loginAs(withClient("empty"), (id) => createdUserIds.add(id));
    const before = (await (
      await listRecipients(new Request("http://localhost/api/recipients", { headers: { cookie } }))
    ).json()) as { recipients: unknown[] };
    expect(before.recipients).toEqual([]);
    const res = await createRecipient(postJson("http://localhost/api/recipients", { displayName: "" }, { cookie, ...withClient("empty") }));
    expect(res.status).toBe(400);
    const after = (await (
      await listRecipients(new Request("http://localhost/api/recipients", { headers: { cookie } }))
    ).json()) as { recipients: unknown[] };
    expect(after.recipients).toEqual([]);
  });

  it("saves exactly one recipient plus one default wallet from the receipt", async () => {
    const { cookie } = await loginAs(withClient("save"), (id) => createdUserIds.add(id));
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Mina" }, { cookie, ...withClient("save") }))
    ).json()) as { recipient: { id: string } };
    const wallet = await createDest(
      postJson(
        `http://localhost/api/recipients/${created.recipient.id}/destinations`,
        { asset: "USDC", network: "Polygon", address: ADDRESS },
        { cookie, ...withClient("save") },
      ),
      { params: Promise.resolve({ id: created.recipient.id }) },
    );
    expect(wallet.status).toBe(201);
    const list = (await (
      await listRecipients(new Request("http://localhost/api/recipients", { headers: { cookie } }))
    ).json()) as { recipients: { id: string }[] };
    expect(list.recipients).toHaveLength(1);
    const detail = (await (
      await getRecipient(new Request(`http://localhost/api/recipients/${list.recipients[0]?.id}`, { headers: { cookie } }), {
        params: Promise.resolve({ id: list.recipients[0]?.id as string }),
      })
    ).json()) as { recipient: { destinations: unknown[] } };
    expect(detail.recipient.destinations).toHaveLength(1);
  });
});
