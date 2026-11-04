/**
 * P2 — claim deadline persistence and exposure, end to end against the
 * ISOLATED test database (anchor-proven; never production).
 *
 * Real routes: create → prepare → attach → authorize, then reconcile/resume.
 * The provider is the Satora test seam; no swap, invoice, payment or claim
 * is created anywhere.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { swapAttachments, transfers, users } from "@/db/schema";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { GET as resumeGet } from "../app/api/transfers/[id]/reconciliation/route";

const EVM_A = "0x0000000000000000000000000000000000000001";
const createdUserIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `p2-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const nowSec = () => Math.floor(Date.now() / 1000);

afterAll(async () => {
  setSatoraFetchersForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

const swaps = new Map<string, Record<string, unknown>>();
let overrides: Record<string, unknown> = {};
function installProvider(): void {
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      const s = swaps.get(id);
      if (!s) throw Object.assign(new Error("not found"), { code: 404 });
      return { ...s, ...overrides, id };
    },
  });
}

let previousRoutes: string | undefined;
beforeEach(() => {
  previousRoutes = process.env["THENCE_ENABLED_ROUTES"];
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  overrides = {};
  installProvider();
  return () => {
    if (previousRoutes === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
    else process.env["THENCE_ENABLED_ROUTES"] = previousRoutes;
  };
});

/** Satora-shaped swap: created now, Polygon locktime +1 h, invoice expiry +1.5 h (as observed in production). */
function satoraSwap(id: string, hashLock: string, sourceSats: string, locktime: number | undefined): Record<string, unknown> {
  const swap: Record<string, unknown> = {
    id,
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc3980n1p4testinvoice",
    hash_lock: hashLock,
    source_amount: sourceSats,
    target_amount: "300000",
    evm_chain_id: 137,
    evm_htlc_address: "0xf12A26a6CEfc1F5a0772fAf09F94c5e5662a3948",
    target_evm_address: EVM_A,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
    status: "pending",
    invoice_expires_at: nowSec() + 5400,
    evm_fund_txid: null,
    evm_claim_txid: null,
    fee_sats: 6,
    created_at: new Date().toISOString(),
  };
  if (locktime !== undefined) swap["evm_refund_locktime"] = locktime;
  return swap;
}

async function bind(tag: string, locktime: number | undefined, authorize = true): Promise<{ id: string; cookie: string; attachStatus: number; attachBody: Record<string, unknown> }> {
  const { cookie } = await loginAs(client(`login-${tag}`), (uid) => createdUserIds.push(uid));
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `p2-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  const swapId = `p2-swap-${RUN}-${tag}`;
  const hashLock = `0x${Buffer.from(`p2-${RUN}-${tag}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  swaps.set(swapId, satoraSwap(swapId, hashLock, transfer.quote.sourceSats, locktime));
  const attached = await attachPost(
    postJson(`http://localhost/api/transfers/${transfer.id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...client(tag) }),
    params(transfer.id),
  );
  const attachBody = (await attached.json()) as Record<string, unknown>;
  if (attached.status === 201 && authorize) {
    const authed = await authorizePost(postJson(`http://localhost/api/transfers/${transfer.id}/authorize-handoff`, { attemptToken: token }, { cookie, ...client(tag) }), params(transfer.id));
    if (authed.status !== 200) throw new Error(`setup authorize failed: ${authed.status}`);
  }
  return { id: transfer.id, cookie, attachStatus: attached.status, attachBody };
}

const storedDeadline = async (id: string) => (await getDb().select({ d: swapAttachments.evmRefundLocktime }).from(swapAttachments).where(eq(swapAttachments.transferId, id)))[0]?.d ?? null;

async function reconcile(id: string, cookie: string, tag: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...client(tag) }), params(id));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function resume(id: string, cookie: string): Promise<{ swap: Record<string, unknown> | null; latest: Record<string, unknown> }> {
  const res = await resumeGet(new Request(`http://localhost/api/transfers/${id}/reconciliation`, { headers: { cookie } }), params(id));
  return (await res.json()) as { swap: Record<string, unknown> | null; latest: Record<string, unknown> };
}

describe.skipIf(!LIVE)("P2 claim deadline (isolated test database)", () => {
  it("persists the authentic locktime at bind, exposes it, and makes a funded swap claim-ready inside the open window", async () => {
    const locktime = nowSec() + 3600;
    const { id, cookie, attachStatus, attachBody } = await bind("persist", locktime);
    expect(attachStatus).toBe(201);
    expect((attachBody["attachment"] as Record<string, unknown>)["claimDeadline"]).toBe(new Date(locktime * 1000).toISOString());
    expect((await storedDeadline(id))?.getTime()).toBe(locktime * 1000);

    overrides = { status: "serverfunded", evm_fund_txid: `0x${"56".repeat(32)}` };
    const rec = await reconcile(id, cookie, "persist");
    expect(rec.status).toBe(200);
    const summary = rec.body["reconciliation"] as Record<string, unknown>;
    expect(summary).toMatchObject({ status: "SERVER_FUNDED", claimReady: true, claimWindow: "open", claimDeadlineAt: new Date(locktime * 1000).toISOString(), identityMismatch: false });
    const view = await resume(id, cookie);
    expect(view.swap?.["claimDeadline"]).toBe(new Date(locktime * 1000).toISOString());
    // The deadline is not the invoice expiry (≈ 30 min later).
    expect(view.swap?.["invoiceExpiresAt"]).not.toBe(view.swap?.["claimDeadline"]);
  });

  it("refuses to bind a swap whose locktime is implausible (identity anomaly), and stores nothing", async () => {
    const afterInvoice = await bind("implausible-late", nowSec() + 6000, false);
    expect(afterInvoice.attachStatus).toBe(409);
    expect(afterInvoice.attachBody["error"]).toBe("SWAP_MISMATCH");
    expect(await storedDeadline(afterInvoice.id)).toBeNull();
    const tooSoon = await bind("implausible-soon", nowSec() + 60, false);
    expect(tooSoon.attachStatus).toBe(409);
    expect((await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, tooSoon.id)))[0]?.s).toBe("QUOTED");
  });

  it("an unreported locktime binds as unknown and is backfilled by reconciliation only after identity verification", async () => {
    const { id, cookie } = await bind("backfill", undefined);
    expect(await storedDeadline(id)).toBeNull();
    let view = await resume(id, cookie);
    expect(view.latest["claimWindow"]).toBe("unknown");
    const locktime = nowSec() + 3500;
    overrides = { evm_refund_locktime: locktime };
    const rec = await reconcile(id, cookie, "backfill");
    expect(rec.status).toBe(200);
    expect((await storedDeadline(id))?.getTime()).toBe(locktime * 1000);
    view = await resume(id, cookie);
    expect(view.latest["claimWindow"]).toBe("open");
  });

  it("a locktime that changes after bind is an identity mismatch: no claim readiness", async () => {
    const locktime = nowSec() + 3600;
    const { id, cookie } = await bind("changed", locktime);
    overrides = { status: "serverfunded", evm_refund_locktime: locktime + 600 };
    const rec = await reconcile(id, cookie, "changed");
    expect(rec.status).toBe(409);
    expect(rec.body["error"]).toBe("SWAP_MISMATCH");
    const view = await resume(id, cookie);
    expect(view.latest).toMatchObject({ claimReady: false, identityMismatch: true });
    expect((await storedDeadline(id))?.getTime()).toBe(locktime * 1000);
  });

  it("server claim readiness is time-aware: funded inside the unsafe window is NOT claim-ready", async () => {
    const locktime = nowSec() + 3600;
    const { id, cookie } = await bind("unsafe", locktime);
    overrides = { status: "serverfunded", evm_fund_txid: `0x${"78".repeat(32)}` };
    expect((await reconcile(id, cookie, "unsafe")).status).toBe(200);
    // Age the deadline in the TEST database to 3 min from now; provider agrees.
    const soon = nowSec() + 180;
    await getDb().update(swapAttachments).set({ evmRefundLocktime: new Date(soon * 1000) }).where(eq(swapAttachments.transferId, id));
    overrides = { ...overrides, evm_refund_locktime: soon };
    const rec = await reconcile(id, cookie, "unsafe");
    expect(rec.status).toBe(200);
    expect(rec.body["reconciliation"]).toMatchObject({ status: "SERVER_FUNDED", claimReady: false, claimWindow: "unsafe" });
  });
});
