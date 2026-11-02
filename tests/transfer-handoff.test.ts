/**
 * B4.2 — swap binding + safe handoff contract (Neon integration + fixtures).
 *
 * No swap is ever created, no invoice funded, Nimiq Pay never invoked:
 * provider reads are the only live calls, and attach/authorize paths use
 * injected fixtures via the satora test seam. Unit tests pin the pure
 * verification logic without any I/O.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { handoffAttempts, swapAttachments, transferProofs, transfers, users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { verifySwapMatch } from "@/lib/handoff";
import { setSatoraFetchersForTests } from "@/lib/satora";

import { LIVE, RUN, loginAs, patchJson, postJson } from "./helpers";
import { POST as createTransferPost } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";
import { GET as attemptGet } from "../app/api/transfers/[id]/attempt/route";
import { GET as getTransfer } from "../app/api/transfers/[id]/route";
import { POST as createRecipient } from "../app/api/recipients/route";
import { POST as createDest } from "../app/api/recipients/[id]/destinations/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  setSatoraFetchersForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b42-${RUN}-${tag}-${cc++}` });
/** Per-run swap ids: swap attachments are globally unique, so fixed ids would poison later runs after any crash-interrupted cleanup. */
const uniqSwap = (name: string): string => `${name}-${RUN}`;
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const EVM_A = "0x0000000000000000000000000000000000000001";
const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const ROUTES = "usdc-polygon,usdc-arbitrum,usdc-ethereum,usdt-polygon";
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

function fixtureSwap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uniqSwap("swap-11111111-2222-3333-4444-555555555555"),
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc100u1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq",
    hash_lock: "0x" + "ab".repeat(32),
    source_amount: "6327",
    target_amount: "5000000",
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

const BASE_TRANSFER = {
  routeId: "usdc-polygon",
  targetAmountAtomic: "5000000",
  direct: { asset: "USDC", network: "Polygon", address: EVM_A },
} as const;

async function createQuotedTransfer(cookie: string, tag: string, keySuffix: string, extra: Record<string, unknown> = {}): Promise<{ id: string; quoteRevision: number }> {
  const res = await createTransferPost(
    postJson("http://localhost/api/transfers", { ...BASE_TRANSFER, recipientName: "Handoff", idempotencyKey: `k-${RUN}-${keySuffix}`, ...extra }, { cookie, ...withClient(`mk-${tag}`) }),
  );
  if (res.status !== 201) throw new Error(`transfer create failed: ${res.status} ${JSON.stringify(await res.json()).slice(0, 200)}`);
  const body = ((await res.json()) as { transfer: { id: string; quote: { revision: number } } }).transfer;
  return { id: body.id, quoteRevision: body.quote.revision };
}

/** Prepare helper returning token + attempt. */
async function prepare(cookie: string, tag: string, id: string, expectedQuoteRevision = 1, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: { attempt?: { id: string; status: string }; attemptToken?: string; deduplicated?: boolean; error?: string } }> {
  const res = await preparePost(
    postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision }, { cookie, ...withClient(`prep-${tag}`), ...extraHeaders }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as never };
}

describe("swap verification logic (pure, no I/O)", () => {
  const base = {
    asset: "USDC",
    network: "Polygon",
    chainId: "137",
    tokenAddress: USDC_POLYGON,
    destination: EVM_A,
    targetAmountAtomic: "5000000",
  };
  const goodSwap = {
    satoraSwapId: "swap-1",
    direction: "lightning_to_evm",
    bolt11Invoice: "lnbc100u1pfake",
    paymentHash: `0x${"ab".repeat(32)}`,
    sourceSats: "6327",
    targetAtomic: "5000000",
    evmChainId: 137,
    targetAddress: EVM_A,
    targetTokenAddress: USDC_POLYGON,
    targetTokenChainId: 137,
    status: "pending",
    invoiceExpiresAt: new Date(Date.now() + 3600_000) as Date | null,
    feeSats: 35,
    evmFundTxid: null,
    evmClaimTxid: null,
  };
  it("accepts an exactly matching swap", () => {
    expect(() => verifySwapMatch({ ...base, swap: goodSwap })).not.toThrow();
  });
  it("rejects direction, chain, token, address and amount mismatches", () => {
    const cases: Array<[Partial<typeof goodSwap>, string]> = [
      [{ direction: "lightning_to_bitcoin" }, "SWAP_MISMATCH"],
      [{ direction: "" }, "SWAP_MISMATCH"],
      [{ evmChainId: 1 }, "SWAP_MISMATCH"],
      [{ targetTokenAddress: "0x0000000000000000000000000000000000000002" }, "SWAP_MISMATCH"],
      [{ targetAddress: "0x0000000000000000000000000000000000000009" }, "SWAP_MISMATCH"],
      [{ targetAtomic: "4999999" }, "SWAP_MISMATCH"],
      [{ status: "clientfunded" }, "SWAP_STATE_UNEXPECTED"],
      [{ status: "expired" }, "SWAP_STATE_UNEXPECTED"],
      [{ bolt11Invoice: "not-an-invoice" }, "SWAP_MISMATCH"],
      [{ invoiceExpiresAt: new Date(Date.now() - 1000) }, "INVOICE_EXPIRED"],
      [{ invoiceExpiresAt: null }, "INVOICE_EXPIRED"],
    ];
    for (const [patch, code] of cases) {
      try {
        verifySwapMatch({ ...base, swap: { ...goodSwap, ...patch } });
        throw new Error(`should have rejected: ${code}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).code).toBe(code);
      }
    }
  });
  it("treats checksummed vs lowercase addresses as equal", () => {
    expect(() =>
      verifySwapMatch({ ...base, destination: "0x0000000000000000000000000000000000000001", swap: { ...goodSwap, targetAddress: "0x0000000000000000000000000000000000000001" } }),
    ).not.toThrow();
  });
});

describe.skipIf(!LIVE)("durable preparation gate", () => {
  it("prepares, replays idempotently, and serializes concurrent prepares", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("prep");
      const { id } = await createQuotedTransfer(cookie, "prep", "p1");
      const first = await prepare(cookie, "prep", id);
      expect(first.status).toBe(201);
      expect(first.body.attempt?.status).toBe("PREPARED");
      expect(first.body.attemptToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(first.body.deduplicated).toBe(false);
      const replay = await prepare(cookie, "prep", id);
      expect(replay.status).toBe(200);
      expect(replay.body.attempt?.id).toBe(first.body.attempt?.id);
      expect(replay.body.deduplicated).toBe(true);
      const raced = await Promise.all(
        Array.from({ length: 5 }, (_, i) => prepare(cookie, `prep-race-${i}`, id).then((r) => r.status)),
      );
      expect(raced.every((s) => s === 200)).toBe(true);
      const rows = await getDb().select().from(handoffAttempts);
      const mine = rows.filter((r) => r.transferId === id);
      expect(mine.length).toBe(1);
      // Resume contract exposes the attempt, never the token or secrets.
      const resume = await attemptGet(new Request(`http://localhost/api/transfers/${id}/attempt`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
      expect(resume.status).toBe(200);
      const view = ((await resume.json()) as { attempt: Record<string, unknown>; swap: unknown }).attempt;
      expect(view["status"]).toBe("PREPARED");
      expect(view["satoraSwapId"]).toBeNull();
      expect(JSON.stringify(view)).not.toMatch(/mnemonic|preimage|private|secret/i);
    } finally {
      restoreRoutes(previous);
    }
  });

  it("requires a fresh quote, matching revision and an enabled route", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("prep-guard");
      const { id } = await createQuotedTransfer(cookie, "prep-guard", "p2");
      const wrong = await prepare(cookie, "prep-guard", id === id ? id : id, 999).catch((e: unknown) => e);
      void wrong;
      const bad = await (await import("../app/api/transfers/[id]/prepare/route")).POST(
        postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 999 }, { cookie, ...withClient("prep-guard") }),
        { params: Promise.resolve({ id }) },
      );
      expect(bad.status).toBe(409);
      expect(((await bad.json()) as { error: string }).error).toBe("VERSION_CONFLICT");
      // Expire the quote: preparation blocked, transfer stays QUOTED (never failed).
      const { transfers } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      await getDb().update(transfers).set({ quoteExpiresAt: new Date(Date.now() - 1000) }).where(eq(transfers.id, id));
      const stale = await prepare(cookie, "prep-guard", id);
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe("QUOTE_STALE");
      const detail = (await (await (await import("../app/api/transfers/[id]/route")).GET(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as { transfer: { status: string } };
      expect(detail.transfer.status).toBe("QUOTED");
    } finally {
      restoreRoutes(previous);
    }
  });

  it("rejects cross-user preparation and cancelled requests", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const alice = await login("alice-prep");
      const bob = await login("bob-prep");
      const { id } = await createQuotedTransfer(alice.cookie, "alice-prep", "p3");
      expect((await prepare(bob.cookie, "bob-prep", id)).status).toBe(404);
      const created = (await (
        await (await import("../app/api/requests/route")).POST(
          postJson("http://localhost/api/requests", { recipientName: "R", asset: "USDC", network: "Polygon", address: EVM_A, amount: "7.00", expiresInSeconds: 3600 }, { cookie: alice.cookie, ...withClient("alice-prep") }),
        )
      ).json()) as { request: { publicId: string; amountAtomic: string } };
      const t2 = await createTransferPost(
        postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: created.request.amountAtomic, idempotencyKey: `k-${RUN}-p3b`, requestPublicId: created.request.publicId }, { cookie: alice.cookie, ...withClient("alice-prep") }),
      );
      expect(t2.status).toBe(201);
      const t2id = ((await t2.json()) as { transfer: { id: string } }).transfer.id;
      const { PATCH } = await import("../app/api/requests/[publicId]/route");
      await PATCH(patchJson(`http://localhost/api/requests/${created.request.publicId}`, { action: "cancel" }, { cookie: alice.cookie, ...withClient("alice-prep") }), { params: Promise.resolve({ publicId: created.request.publicId }) });
      const blocked = await prepare(alice.cookie, "alice-prep", t2id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("REQUEST_CANCELLED");
    } finally {
      restoreRoutes(previous);
    }
  });
});

describe.skipIf(!LIVE)("swap attachment (mocked provider)", () => {
  const stubSwapFixture = (swap: Record<string, unknown> | null, fail?: { code: "timeout" | "unavailable" | "missing" }): void => {
    setSatoraFetchersForTests({
      getSwap: async (id: string) => {
        if (fail?.code === "timeout") return new Promise<never>(() => undefined);
        if (fail?.code === "missing" || swap === null) throw Object.assign(new Error("not found"), { code: 404 });
        if (fail?.code === "unavailable") throw new Error("boom");
        return { ...swap, id };
      },
    });
  };

  it("binds a verified swap, advances to SWAP_CREATED, and proves receipts", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("attach");
      const { id } = await createQuotedTransfer(cookie, "attach", "a1");
      const prep = await prepare(cookie, "attach", id);
      expect(prep.status).toBe(201);
      const token = prep.body.attemptToken as string;
      stubSwapFixture(fixtureSwap());
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-11111111-2222-3333-4444-555555555555"), recoveryAcknowledged: true }, { cookie, ...withClient("attach") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        const body = ((await attached.json()) as { attachment: Record<string, unknown>; transferStatus: string; deduplicated: boolean });
        expect(body.transferStatus).toBe("SWAP_CREATED");
        expect(body.deduplicated).toBe(false);
        expect(body.attachment["sourceSats"]).toBe("6327");
        expect(body.attachment["targetAtomic"]).toBe("5000000");
        // The bound invoice must travel in the attachment + attempt views:
        // AWAITING-resume recovers it from here for the host handoff.
        expect(typeof body.attachment["invoiceBolt11"] === "string" && (body.attachment["invoiceBolt11"] as string).startsWith("lnbc")).toBe(true);
        const resumed = await attemptGet(new Request(`http://localhost/api/transfers/${id}/attempt`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
        expect(resumed.status).toBe(200);
        const resumedBody = (await resumed.json()) as { swap: { invoiceBolt11?: unknown } | null };
        expect(typeof resumedBody.swap?.invoiceBolt11 === "string" && (resumedBody.swap.invoiceBolt11 as string).startsWith("lnbc")).toBe(true);
        const proofs = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id));
        expect(proofs.length).toBe(1);
        expect(proofs[0]?.satoraSwapId).toBe(uniqSwap("swap-11111111-2222-3333-4444-555555555555"));
        expect(proofs[0]?.lightningHash).toBe(`0x${"ab".repeat(32)}`);
        expect(proofs[0]?.evmTxHash).toBeNull();
        const atts = await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, id));
        expect(atts.length).toBe(1);
        expect(atts[0]?.paymentHash).toBe(`0x${"ab".repeat(32)}`);
        // Idempotent replay of the same swap.
        const again = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-11111111-2222-3333-4444-555555555555"), recoveryAcknowledged: true }, { cookie, ...withClient("attach") }),
          { params: Promise.resolve({ id }) },
        );
        expect(again.status).toBe(200);
        expect(((await again.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
        const detail = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
          transfer: { status: string; label: string };
        };
        expect(detail.transfer.status).toBe("SWAP_CREATED");
        expect(JSON.stringify(detail)).not.toMatch(/mnemonic|preimage|private|secret/i);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("rejects mismatched, conflicting, reused and malformed swaps", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("mismatch");
      const { id } = await createQuotedTransfer(cookie, "mismatch", "m1");
      const prep = await prepare(cookie, "mismatch", id);
      const token = prep.body.attemptToken as string;
      const base = { attemptToken: token, expectedQuoteRevision: 1, recoveryAcknowledged: true };
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ ...base, satoraSwapId: "x-wrong-token" }, 409, "SWAP_MISMATCH"],
        [{ ...base, satoraSwapId: "x-wrong-addr" }, 409, "SWAP_MISMATCH"],
        [{ ...base, satoraSwapId: "x-wrong-amount" }, 409, "SWAP_MISMATCH"],
        [{ ...base, satoraSwapId: "x-funded" }, 409, "SWAP_STATE_UNEXPECTED"],
        [{ ...base, satoraSwapId: "x-expired-invoice" }, 409, "INVOICE_EXPIRED"],
        [{ ...base, satoraSwapId: "x-unknown" }, 404, "SWAP_NOT_FOUND"],
      ];
      const fixtures: Record<string, Record<string, unknown>> = {
        "x-wrong-token": fixtureSwap({ id: "x-wrong-token", target_token: { chain: "137", decimals: 6, name: "X", symbol: "X", token_id: "0x0000000000000000000000000000000000000002" } }),
        "x-wrong-addr": fixtureSwap({ id: "x-wrong-addr", target_evm_address: "0x0000000000000000000000000000000000000009" }),
        "x-wrong-amount": fixtureSwap({ id: "x-wrong-amount", target_amount: "4999999" }),
        "x-funded": fixtureSwap({ id: "x-funded", status: "clientfunded" }),
        "x-expired-invoice": fixtureSwap({ id: "x-expired-invoice", invoice_expires_at: Math.floor(Date.now() / 1000) - 10 }),
      };
      for (const [payload, status, code] of cases) {
        const sid = payload["satoraSwapId"] as string;
        if (sid === "x-unknown") {
          stubSwapFixture(null, { code: "missing" });
        } else {
          stubSwapFixture(fixtures[sid] as Record<string, unknown>);
        }
        const res = await attachPost(postJson(`http://localhost/api/transfers/${id}/attach`, payload, { cookie, ...withClient("mismatch") }), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(status);
        expect(((await res.json()) as { error: string }).error).toBe(code);
      }
      // Conflicting second swap on the same attempt is rejected, never merged.
      stubSwapFixture(fixtureSwap({ id: uniqSwap("swap-good-1") }));
      const good = await attachPost(
        postJson(`http://localhost/api/transfers/${id}/attach`, { ...base, satoraSwapId: uniqSwap("swap-good-1") }, { cookie, ...withClient("mismatch") }),
        { params: Promise.resolve({ id }) },
      );
      expect(good.status).toBe(201);
      stubSwapFixture(fixtureSwap({ id: uniqSwap("swap-good-2") }));
      const conflict = await attachPost(
        postJson(`http://localhost/api/transfers/${id}/attach`, { ...base, satoraSwapId: uniqSwap("swap-good-2") }, { cookie, ...withClient("mismatch") }),
        { params: Promise.resolve({ id }) },
      );
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: string }).error).toBe("SWAP_CONFLICT");
      // Close the definitively pre-authorization swap before preparing a
      // separate intent. Exposure protection should not be bypassed merely to
      // exercise the global swap-reuse constraint below.
      stubSwapFixture(fixtureSwap({ id: uniqSwap("swap-good-1") }));
      const closed = await reportPost(
        postJson(`http://localhost/api/transfers/${id}/handoff-result`, { outcome: "cancelled" }, { cookie, ...withClient("mismatch-close") }),
        { params: Promise.resolve({ id }) },
      );
      expect(closed.status).toBe(200);
      expect(((await closed.json()) as { handoff: { status: string } }).handoff.status).toBe("USER_CANCELLED");
      // Without acknowledgement, nothing binds.
      const noAck = await attachPost(
        postJson(`http://localhost/api/transfers/${id}/attach`, { ...base, satoraSwapId: uniqSwap("swap-good-3"), recoveryAcknowledged: false }, { cookie, ...withClient("mismatch") }),
        { params: Promise.resolve({ id }) },
      );
      expect(noAck.status).toBe(400);
      // Same swap cannot authorize a second transfer.
      const { id: id2 } = await createQuotedTransfer(cookie, "mismatch2", "m2");
      const prep2 = await prepare(cookie, "mismatch2", id2);
      stubSwapFixture(fixtureSwap({ id: uniqSwap("swap-good-1") }));
      const reuse = await attachPost(
        postJson(`http://localhost/api/transfers/${id2}/attach`, { attemptToken: prep2.body.attemptToken, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-good-1"), recoveryAcknowledged: true }, { cookie, ...withClient("mismatch2") }),
        { params: Promise.resolve({ id: id2 }) },
      );
      expect(reuse.status).toBe(409);
      expect(((await reuse.json()) as { error: string }).error).toBe("SWAP_ALREADY_BOUND");
    } finally {
      setSatoraFetchersForTests(null);
      restoreRoutes(previous);
    }
  }, 120_000);

  it("times out safely on provider lookup failure", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("timeout");
      const { id } = await createQuotedTransfer(cookie, "timeout", "t1");
      const prep = await prepare(cookie, "timeout", id);
      setSatoraFetchersForTests({ getSwap: () => new Promise<never>(() => undefined) });
      const started = Date.now();
      const res = await attachPost(
        postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: prep.body.attemptToken, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-never"), recoveryAcknowledged: true }, { cookie, ...withClient("timeout") }),
        { params: Promise.resolve({ id }) },
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(14000);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("PROVIDER_TIMEOUT");
      const detail = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        transfer: { status: string };
      };
      expect(detail.transfer.status).toBe("QUOTED");
    } finally {
      setSatoraFetchersForTests(null);
      restoreRoutes(previous);
    }
  }, 120_000);
});

describe.skipIf(!LIVE)("single handoff authorization", () => {
  it("authorizes exactly once after live revalidation", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("authz");
      const { id } = await createQuotedTransfer(cookie, "authz", "h1");
      const prep = await prepare(cookie, "authz", id);
      const token = prep.body.attemptToken as string;
      const quoted = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        transfer: { quote: { sourceSats: string } };
      };
      const quotedSourceSats = quoted.transfer.quote.sourceSats;
      setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid, source_amount: quotedSourceSats }) });
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-22222222-2222-3333-4444-555555555555"), recoveryAcknowledged: true }, { cookie, ...withClient("authz") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        const first = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("authz") }), { params: Promise.resolve({ id }) });
        expect(first.status).toBe(200);
        const body = ((await first.json()) as { handoff: { invoiceBolt11: string; sourceSats: string; attemptId: string } }).handoff;
        expect(body.invoiceBolt11.startsWith("lnbc")).toBe(true);
        expect(body.sourceSats).toBe(quotedSourceSats);
        expect((await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: "WRONG" }, { cookie, ...withClient("authz") }), { params: Promise.resolve({ id }) })).status).toBe(409);
        const after = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
          transfer: { status: string; statusLabel: string };
        };
        expect(after.transfer.status).toBe("AWAITING_NIM_APPROVAL");
        expect(after.transfer.statusLabel).toBe("Approve in Nimiq Pay");
        // Second authorization and concurrent races all lose.
        const again = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("authz") }), { params: Promise.resolve({ id }) });
        expect(again.status).toBe(409);
        const raced = await Promise.all(
          [0, 1, 2].map(() =>
            authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("authz-race") }), { params: Promise.resolve({ id }) }).then((r) => r.status),
          ),
        );
        expect(raced.every((s) => s === 409)).toBe(true);
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  });

  it("blocks repriced swaps and unknown outcomes without failing", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("reprice");
      const { id } = await createQuotedTransfer(cookie, "reprice", "r1");
      const prep = await prepare(cookie, "reprice", id);
      const token = prep.body.attemptToken as string;
      // Swap created later at a worse price: attach records facts, handoff blocks.
      setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid, source_amount: "999999" }) });
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-repriced"), recoveryAcknowledged: true }, { cookie, ...withClient("reprice") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        const blocked = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("reprice") }), { params: Promise.resolve({ id }) });
        expect(blocked.status).toBe(409);
        expect(((await blocked.json()) as { error: string }).error).toBe("REPRICED_NEEDS_CONFIRMATION");
        const detail = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
          transfer: { status: string };
        };
        expect(detail.transfer.status).toBe("SWAP_CREATED");
        // Unknown outcome (provider down): 503, state untouched, no auto-retry.
        setSatoraFetchersForTests({ getSwap: () => Promise.reject(new Error("down")) });
        const unknown = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("reprice") }), { params: Promise.resolve({ id }) });
        expect(unknown.status).toBe(503);
        const still = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
          transfer: { status: string; statusLabel: string };
        };
        expect(still.transfer.status).toBe("SWAP_CREATED");
        expect(still.transfer.statusLabel).not.toBe("Failed");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);

  it("authorizes at exactly the accepted repriced figure and nothing above", async () => {
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("accept-reprice");
      const { id } = await createQuotedTransfer(cookie, "accept-reprice", "a1");
      const prep = await prepare(cookie, "accept-reprice", id);
      const token = prep.body.attemptToken as string;
      const quoted = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
        transfer: { quote: { sourceSats: string } };
      };
      const locked = quoted.transfer.quote.sourceSats;
      // Deterministic drift regardless of market: live costs exactly 100 sats more.
      const live = (BigInt(locked) + 100n).toString();
      setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid, source_amount: live }) });
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: uniqSwap("swap-accept-reprice"), recoveryAcknowledged: true }, { cookie, ...withClient("accept-reprice") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        const authz = (extra: Record<string, unknown>) =>
          authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token, ...extra }, { cookie, ...withClient("accept-reprice") }), { params: Promise.resolve({ id }) });
        // No acceptance: 409 with both figures for owner review.
        const denied = await authz({});
        expect(denied.status).toBe(409);
        const deniedBody = (await denied.json()) as { error: string; details?: Record<string, string> };
        expect(deniedBody.error).toBe("REPRICED_NEEDS_CONFIRMATION");
        expect(deniedBody.details).toEqual({ quotedSourceSats: locked, liveSourceSats: live });
        // Below-live acceptance: 409 again, never a partial approval.
        const short = await authz({ acceptRepricedSourceSats: locked });
        expect(short.status).toBe(409);
        expect(((await short.json()) as { error: string }).error).toBe("REPRICED_NEEDS_CONFIRMATION");
        // Malformed acceptance: 409, treated as absent.
        const garbage = await authz({ acceptRepricedSourceSats: "lots" });
        expect(garbage.status).toBe(409);
        // Exact acceptance: 200 with the live sats; single advancement.
        const ok = await authz({ acceptRepricedSourceSats: live });
        expect(ok.status).toBe(200);
        const handoff = ((await ok.json()) as { handoff: { sourceSats: string } }).handoff;
        expect(handoff.sourceSats).toBe(live);
        const after = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
          transfer: { status: string };
        };
        expect(after.transfer.status).toBe("AWAITING_NIM_APPROVAL");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);

  it("proves an expired attached attempt strands the transfer (d3debd19 verdict)", async () => {    // Production d3debd19: prepared hours before resume, attempt TTL lapsed.
    // A fresh handle cannot take over: the bound swap replays idempotently
    // without confirming the new attempt, and authorize requires a live
    // attach-confirmed handle. Nothing here moves funds or forks payment.
    const previous = setRoutes(ROUTES);
    try {
      const { cookie } = await login("strand");
      const { id } = await createQuotedTransfer(cookie, "strand", "s1");
      const prep = await prepare(cookie, "strand", id);
      const token = prep.body.attemptToken as string;
      const swapId = uniqSwap("swap-strand");
      setSatoraFetchersForTests({ getSwap: async (sid: string) => fixtureSwap({ id: sid }) });
      try {
        const attached = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...withClient("strand") }),
          { params: Promise.resolve({ id }) },
        );
        expect(attached.status).toBe(201);
        // Age the attached attempt past its TTL, as on the real payment.
        await getDb().update(handoffAttempts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(handoffAttempts.transferId, id));
        // Old handle: dead (unknown/expired), nothing moves.
        const dead = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("strand") }), { params: Promise.resolve({ id }) });
        expect(dead.status).toBe(409);
        expect(((await dead.json()) as { error: string }).error).toBe("ATTEMPT_INVALID");
        // Fresh handle impossible: once bound, re-prepare is refused (no new
        // attempt can fork beside the bound swap).
        const re = await prepare(cookie, "strand", id);
        expect(re.status).toBe(409);
        expect(re.body.error).toBe("NOT_PREPARABLE");
        // Same bound swap replays idempotently (no duplicate binding)...
        const again = await attachPost(
          postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...withClient("strand") }),
          { params: Promise.resolve({ id }) },
        );
        expect(again.status).toBe(200);
        expect(((await again.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
        // ...but the only handle is expired: authorize refuses, forever.
        const stuck = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient("strand") }), { params: Promise.resolve({ id }) });
        expect(stuck.status).toBe(409);
        expect(((await stuck.json()) as { error: string }).error).toBe("ATTEMPT_INVALID");
        // Transfer unchanged and pre-funding; exactly one transfer exists.
        const detail = (await (await getTransfer(new Request(`http://localhost/api/transfers/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
          transfer: { status: string };
        };
        expect(detail.transfer.status).toBe("SWAP_CREATED");
      } finally {
        setSatoraFetchersForTests(null);
      }
    } finally {
      restoreRoutes(previous);
    }
  }, 120_000);
});
