/**
 * Failed-payment retirement + replacement (live TEST DB, mocked provider).
 *
 * No swap is ever created, no invoice funded, Nimiq Pay never invoked:
 * swaps come from injected fixtures via the satora test seam, and the
 * production pilot is never armed here (legacy skip covers creation;
 * the cancel path is ungated by design). d3debd19 itself is untouched.
 *
 * - Definitively unpaid payments (never authorized) retire to
 *   USER_CANCELLED with history preserved — even with an expired attempt
 *   and an ambiguous invoice, which previously refused.
 * - Funded/uncertain payments stay open (reconcile, never silent close).
 * - A retired attempt frees the pilot slot without resetting caps:
 *   DELIVERED spend still counts and a live attempt still blocks.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { handoffAttempts, transfers, users } from "@/db/schema";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { assertPilotBudget } from "@/lib/pilot";

import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransferPost } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { GET as getTransfer } from "../app/api/transfers/[id]/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  setSatoraFetchersForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `f812r-${RUN}-${tag}-${cc++}` });
const uniqSwap = (name: string): string => `${name}-${RUN}`;
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const EVM_A = "0x0000000000000000000000000000000000000001";
const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const ROUTES = "usdc-polygon";
const setRoutes = (value: string): string | undefined => {
  const previous = process.env["THENCE_ENABLED_ROUTES"];
  process.env["THENCE_ENABLED_ROUTES"] = value;
  return previous;
};
const restoreRoutes = (previous: string | undefined): void => {
  if (previous === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
  else process.env["THENCE_ENABLED_ROUTES"] = previous;
};

function futureUnix(secondsAhead = 3600): number {
  return Math.floor(Date.now() / 1000) + secondsAhead;
}

/** Schema-true provider swap fragment (token identity via token_id). */
function fixtureSwap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uniqSwap("swap-99999999-9999-9999-9999-999999999999"),
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc100u1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq",
    hash_lock: "0x" + "ef".repeat(32),
    source_amount: "6327",
    target_amount: "300000",
    evm_chain_id: 137,
    target_evm_address: EVM_A,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC_POLYGON },
    status: "pending",
    invoice_expires_at: futureUnix(),
    fee_sats: 35,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

async function createDirect(cookie: string, tag: string, keySuffix: string): Promise<{ id: string; quoteRevision: number }> {
  const res = await createTransferPost(
    postJson(
      "http://localhost/api/transfers",
      {
        routeId: "usdc-polygon",
        targetAmountAtomic: "300000",
        recipientName: "Retire",
        idempotencyKey: `k-${RUN}-${keySuffix}`,
        direct: { asset: "USDC", network: "Polygon", address: EVM_A },
      },
      { cookie, ...withClient(`mk-${tag}`) },
    ),
  );
  if (res.status !== 201) throw new Error(`transfer create failed: ${res.status} ${JSON.stringify(await res.json()).slice(0, 200)}`);
  const body = ((await res.json()) as { transfer: { id: string; quote: { revision: number } } }).transfer;
  return { id: body.id, quoteRevision: body.quote.revision };
}

async function cancel(cookie: string, tag: string, id: string): Promise<{ status: number; body: { handoff?: { status: string }; error?: string } }> {
  const res = await reportPost(
    postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient(`cancel-${tag}`) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as never };
}

async function transferStatus(cookie: string, id: string): Promise<string> {
  const res = await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
  return ((await res.json()) as { transfer: { status: string } }).transfer.status;
}

describe.skipIf(!LIVE)("retirement of definitively unpaid payments", () => {
  it("retires a QUOTED payment with history preserved", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie, userId } = await login("q");
      const { id } = await createDirect(cookie, "q", "q1");
      const out = await cancel(cookie, "q", id);
      expect(out.status).toBe(200);
      expect(out.body.handoff?.status).toBe("USER_CANCELLED");
      expect(await transferStatus(cookie, id)).toBe("USER_CANCELLED");
      // History row preserved (never deleted).
      const rows = await getDb().select().from(transfers).where(eq(transfers.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ownerUserId).toBe(userId);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("retires a strand-shaped payment: attached swap, expired attempt AND expired invoice", async () => {    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("strand");
      const { id } = await createDirect(cookie, "strand", "s1");
      const prep = await preparePost(
        postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...withClient("prep-strand") }),
        { params: Promise.resolve({ id }) },
      );
      if (prep.status !== 200 && prep.status !== 201) throw new Error(`prepare failed: ${prep.status}`);
      const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
      const swapId = uniqSwap("swap-strand");
      setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid }) });
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...withClient("strand") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        // Age the attempt past TTL and let the mock invoice lapse: the exact
        // d3debd19 shape. Previously this refused (ambiguous invoice).
        await getDb().update(handoffAttempts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(handoffAttempts.transferId, id));
        setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid, status: "expired", invoice_expires_at: Math.floor(Date.now() / 1000) - 10 }) });
        const out = await cancel(cookie, "strand", id);
        expect(out.status).toBe(200);
        expect(out.body.handoff?.status).toBe("USER_CANCELLED");
        expect(await transferStatus(cookie, id)).toBe("USER_CANCELLED");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("refuses retirement once authorized (funded path stays open)", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("authz");
      const { id } = await createDirect(cookie, "authz", "a1");
      const prep = await preparePost(
        postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...withClient("prep-authz") }),
        { params: Promise.resolve({ id }) },
      );
      if (prep.status !== 200 && prep.status !== 201) throw new Error(`prepare failed: ${prep.status}`);
      const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
      const swapId = uniqSwap("swap-authz");
      // Mock the live swap AT the locked quote so authorize is about the
      // funded-path gate, not price drift (repricing has its own suite).
      const locked = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        transfer: { quote: { sourceSats: string } };
      };
      setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid, source_amount: locked.transfer.quote.sourceSats }) });
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...withClient("authz") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        const { POST: authorizeRoutePost } = await import("../app/api/transfers/[id]/authorize-handoff/route");
        const authed = await authorizeRoutePost(
          postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("authz") }),
          { params: Promise.resolve({ id }) },
        );
        expect(authed.status).toBe(200);
        // Authorized = potentially payable at any moment: no terminal close.
        const out = await cancel(cookie, "authz", id);
        expect(out.status).toBe(200);
        expect(out.body.handoff?.status).not.toBe("USER_CANCELLED");
        expect(await transferStatus(cookie, id)).not.toBe("USER_CANCELLED");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });
});

describe.skipIf(!LIVE)("retired attempts free the pilot slot without resetting caps", () => {
  const armed = {
    enabled: true as boolean,
    production: false,
    owners: ["NQ00 0000 0000 0000 0000 0000 0000 0000 0000"],
    maxTargetAtomic: "300000",
    maxSpendAtomic: "300000",
    maxTransfers: 1,
  };
  it("a cancelled 0.30 no longer occupies the single slot", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie, userId } = await login("slot");
      const first = await createDirect(cookie, "slot", "b1");
      const out = await cancel(cookie, "slot", first.id);
      expect(out.body.handoff?.status).toBe("USER_CANCELLED");
      await expect(assertPilotBudget(userId, "300000", armed)).resolves.toBeUndefined();
    } finally {
      restoreRoutes(previous);
    }
  });

  it("a live 0.30 still blocks a second, and delivered spend still counts", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie, userId } = await login("cap");
      await createDirect(cookie, "cap", "c1");
      // Slot occupied by the live first transfer.
      await expect(assertPilotBudget(userId, "300000", armed)).rejects.toMatchObject({ code: "PILOT_ATTEMPTS_EXCEEDED" });
      // Delivered money keeps counting toward the spend ceiling even though
      // the attempt slot itself is free once terminal.
      const mine = await getDb().select().from(transfers).where(eq(transfers.ownerUserId, userId));
      const live = mine.find((t) => t.status === "QUOTED");
      expect(live).toBeDefined();
      await getDb().update(transfers).set({ status: "DELIVERED" }).where(eq(transfers.id, live!.id));
      await expect(assertPilotBudget(userId, "300000", armed)).rejects.toMatchObject({ code: "PILOT_SPEND_EXCEEDED" });
    } finally {
      restoreRoutes(previous);
    }
  });
});
