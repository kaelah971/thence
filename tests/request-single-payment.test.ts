/**
 * A payment request can be paid at most once (isolated test database).
 *
 * Defect: requests had no derived "taken" state, so a shared link stayed
 * payable after delivery, and two payers could pay it concurrently, while the
 * Send screen promised it "counts as paid once delivery is confirmed".
 * Statuses of the first payment are set directly in the TEST database: the
 * guard reads only linked transfer statuses, never provider or chain state.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { transfers, users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { assertRequestPayable } from "@/lib/request-payment";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { declaredHtlc } from "./htlc-fixture";
import { POST as createTransferPost } from "../app/api/transfers/route";
import { POST as createRequestPost } from "../app/api/requests/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  setSatoraFetchersForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const FIXTURE_LOCKTIME = Math.floor(Date.now() / 1000) + 3000;

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `rsp-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));
const EVM_A = "0x0000000000000000000000000000000000000001";

async function payRequest(cookie: string, tag: string, publicId: string, amountAtomic: string, key: string) {
  const res = await createTransferPost(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: amountAtomic, idempotencyKey: `rsp-${RUN}-${key}`, requestPublicId: publicId }, { cookie, ...withClient(tag) }),
  );
  return { status: res.status, body: (await res.json()) as { error?: string; transfer?: { id: string; requestId?: string | null } } };
}

const setStatus = (id: string, status: string) => getDb().update(transfers).set({ status }).where(eq(transfers.id, id));

describe.skipIf(!LIVE)("payment request: one payment only", () => {
  it("refuses a second payment while the first is authorized, and after it delivered; replay and abandoned drafts stay safe", async () => {
    const owner = await login("owner");
    const created = (await (
      await createRequestPost(
        postJson("http://localhost/api/requests", { recipientName: "R", asset: "USDC", network: "Polygon", address: EVM_A, amount: "0.30", expiresInSeconds: 3600 }, { cookie: owner.cookie, ...withClient("owner") }),
      )
    ).json()) as { request: { publicId: string; amountAtomic: string } };
    const { publicId, amountAtomic } = created.request;

    const first = await login("first");
    const second = await login("second");
    const third = await login("third");

    // An unauthorized draft never blocks another payer.
    const t1 = await payRequest(first.cookie, "first", publicId, amountAtomic, "t1");
    expect(t1.status).toBe(201);
    const t1id = t1.body.transfer!.id;
    const t2 = await payRequest(second.cookie, "second", publicId, amountAtomic, "t2");
    expect(t2.status).toBe(201);
    const t2id = t2.body.transfer!.id;
    const requestId = (await getDb().select({ r: transfers.requestId }).from(transfers).where(eq(transfers.id, t1id)))[0]!.r!;

    // First payment authorized (NIM may be committed): nobody else may pay.
    await setStatus(t1id, "AWAITING_NIM_APPROVAL");
    const blocked = await payRequest(third.cookie, "third", publicId, amountAtomic, "t3");
    expect(blocked).toMatchObject({ status: 409, body: { error: "REQUEST_PAYMENT_IN_PROGRESS" } });
    // The already-created draft is stopped at the authorize gate (same check, under the request lock there).
    await expect(assertRequestPayable(getDb(), requestId, t2id)).rejects.toMatchObject({ code: "REQUEST_PAYMENT_IN_PROGRESS" } satisfies Partial<AuthError>);
    // The paying transfer itself is never blocked by its own row.
    await expect(assertRequestPayable(getDb(), requestId, t1id)).resolves.toBeUndefined();

    // Delivered: the request is paid.
    await setStatus(t1id, "DELIVERED");
    expect(await payRequest(third.cookie, "third", publicId, amountAtomic, "t4")).toMatchObject({ status: 409, body: { error: "REQUEST_ALREADY_PAID" } });
    await expect(assertRequestPayable(getDb(), requestId, t2id)).rejects.toMatchObject({ code: "REQUEST_ALREADY_PAID" });

    // Idempotent replay of an existing transfer still converges (no new payment created).
    const replay = await payRequest(second.cookie, "second", publicId, amountAtomic, "t2");
    expect(replay.status).toBe(200);
    expect(replay.body.transfer!.id).toBe(t2id);

    // A first payment that ended without delivery frees the request again.
    await setStatus(t1id, "REFUNDED");
    await expect(assertRequestPayable(getDb(), requestId, t2id)).resolves.toBeUndefined();
  });

  it("two payers authorizing the same request at the same instant: exactly one reaches Nimiq Pay", async () => {
    const owner = await login("race-owner");
    const created = (await (
      await createRequestPost(
        postJson("http://localhost/api/requests", { recipientName: "R", asset: "USDC", network: "Polygon", address: EVM_A, amount: "0.30", expiresInSeconds: 3600 }, { cookie: owner.cookie, ...withClient("race-owner") }),
      )
    ).json()) as { request: { publicId: string; amountAtomic: string } };
    const { publicId, amountAtomic } = created.request;
    const swaps = new Map<string, Record<string, unknown>>();
    setSatoraFetchersForTests({ getSwap: async (id: string) => ({ ...swaps.get(id), id }) });

    // Both payers bind a verified swap (unauthorized drafts never block each other).
    const ready: Array<{ id: string; cookie: string; token: string; tag: string }> = [];
    for (const tag of ["race-a", "race-b"]) {
      const payer = await login(tag);
      const t = await payRequest(payer.cookie, tag, publicId, amountAtomic, tag);
      expect(t.status, tag).toBe(201);
      const id = t.body.transfer!.id;
      const sourceSats = ((t.body.transfer as unknown as { quote: { sourceSats: string } }).quote).sourceSats;
      const prep = await preparePost(postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 1 }, { cookie: payer.cookie, ...withClient(tag) }), params(id));
      expect(prep.status, tag).toBe(201);
      const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
      const swapId = `rsp-swap-${RUN}-${tag}`;
      swaps.set(swapId, {
        ...declaredHtlc(137),
        evm_refund_locktime: FIXTURE_LOCKTIME,
        direction: "lightning_to_evm",
        bolt11_invoice: `lnbc3u1p4${tag.replace("-", "")}testinvoice`,
        hash_lock: `0x${Buffer.from(`${RUN}-${tag}`).toString("hex").padEnd(64, "0").slice(0, 64)}`,
        source_amount: sourceSats,
        target_amount: amountAtomic,
        evm_chain_id: 137,
        target_evm_address: EVM_A,
        target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
        status: "pending",
        invoice_expires_at: Math.floor(Date.now() / 1000) + 5400,
        fee_sats: 6,
      });
      const attached = await attachPost(postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie: payer.cookie, ...withClient(tag) }), params(id));
      expect(attached.status, `${tag} ${JSON.stringify(await attached.clone().json())}`).toBe(201);
      ready.push({ id, cookie: payer.cookie, token, tag });
    }

    const results = await Promise.all(
      ready.map(async (r) => {
        const res = await authorizePost(postJson(`http://localhost/api/transfers/${r.id}/authorize-handoff`, { attemptToken: r.token }, { cookie: r.cookie, ...withClient(`${r.tag}-auth`) }), params(r.id));
        return { status: res.status, error: res.status === 200 ? null : ((await res.json()) as { error: string }).error };
      }),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.error).toBe("REQUEST_PAYMENT_IN_PROGRESS");
    // Financial invariant: exactly one transfer of this request is authorized for payment.
    const statuses = await Promise.all(ready.map(async (r) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, r.id)))[0]?.s));
    expect(statuses.filter((s) => s === "AWAITING_NIM_APPROVAL")).toHaveLength(1);
    expect(statuses.filter((s) => s === "SWAP_CREATED")).toHaveLength(1);
  });
});
