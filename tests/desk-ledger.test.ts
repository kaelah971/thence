import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LIVE, fixtureWallet } from "./helpers";
import { getPool } from "@/lib/db";
import { deskTransaction, loadDeskOrder } from "@/lib/desk/store";
import { authorizeDesk, checkDeskOrder, quoteDesk, reportDeskDeposit, processDeskPayout, reportDeskRefund, requestDeskRefund } from "@/lib/desk/service";

// All chain, price and signing calls are mocked. Only the proven isolated TEST DB is live.
const mocks = vi.hoisted(() => ({ balance: 1000000n, timestamp: 0, broadcasts: [] as string[], receipt: "pending", signs: 0, broadcastFails: false, discovered: [] as string[] }));
vi.mock("@/lib/desk/price", () => ({ deskRate: async () => ({ rateE18: 1000000000000000n, observedAt: new Date().toISOString() }) }));
vi.mock("@/lib/nimiq-source", () => ({ normalizeNimiqSourceHash: (h: string) => /^[0-9a-f]{64}$/.test(h) ? h : null,
  findDeskDepositHashes: async () => mocks.discovered,
  verifyDeskNimPayment: async ({ txHash }: { txHash: string }) => txHash === "ee".repeat(32) ? { ok: false, code: "PAYMENT_MISMATCH" } : ({ ok: true, timestampMs: mocks.timestamp }) }));
vi.mock("@/lib/desk/evm", () => ({
  assertDeskSigner: vi.fn(), deskBalances: async () => ({ usdc: mocks.balance }),
  deskEvm: () => ({ getChainId: async () => 137, getTransactionCount: async () => 0, sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => { mocks.broadcasts.push(serializedTransaction); if (mocks.broadcastFails) throw new Error("unknown response"); } }),
  signDeskPayout: async (_o: unknown, nonce: number) => { mocks.signs++; return { raw: `0x02${nonce}`, hash: `0x${nonce.toString(16).padStart(64, "0")}` }; },
  validateSignedDeskPayout: async () => {}, deskPayoutResult: async () => mocks.receipt,
}));

describe.skipIf(!LIVE)("treasury ledger concurrency and recovery (isolated TEST DB)", () => {
  const wallets = [fixtureWallet(), fixtureWallet(), fixtureWallet()], ids = wallets.map(() => randomUUID());
  const address = `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
  const recipient = "0x1111111111111111111111111111111111111111";
  beforeAll(async () => {
    vi.stubEnv("THENCE_DESK_ENABLED", "true"); vi.stubEnv("THENCE_DESK_NIM_ADDRESS", wallets[0]!.address);
    vi.stubEnv("THENCE_DESK_POLYGON_ADDRESS", address); vi.stubEnv("THENCE_DESK_POLYGON_RPC", "https://polygon.test");
    vi.stubEnv("THENCE_NIMIQ_PROOF_RPC_URL", "https://nimiq.test"); vi.stubEnv("THENCE_DESK_OWNER_ADDRESSES", wallets.map(w => w.address).join(","));
    for (let n = 0; n < ids.length; n++) await getPool().query("INSERT INTO users(id,nimiq_address) VALUES($1,$2)", [ids[n], wallets[n]!.address]);
  });
  afterAll(async () => {
    await getPool().query("DELETE FROM desk_events WHERE order_id IN (SELECT id FROM desk_orders WHERE owner_id=ANY($1::uuid[]))", [ids]);
    await getPool().query("DELETE FROM desk_orders WHERE owner_id=ANY($1::uuid[])", [ids]);
    await getPool().query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
    vi.unstubAllEnvs();
  });
  it("serializes competing quotes, prevents oversubscription, and scopes access", async () => {
    const attempts = await Promise.allSettled(ids.slice(0, 2).map((id, n) => quoteDesk(id, wallets[n]!.address, recipient, "0.70", randomUUID())));
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const loser = attempts.find(r => r.status === "rejected"); expect(loser && loser.status === "rejected" && loser.reason.code).toBe("LIQUIDITY_LOW");
    const win = attempts.find(r => r.status === "fulfilled");
    if (!win || win.status !== "fulfilled") throw new Error("No reserved quote");
    await expect(deskTransaction(c => loadDeskOrder(c, win.value.id, ids[2]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Expire only this suite's quote so other test orders cannot be affected.
    await getPool().query("UPDATE desk_orders SET expires_at=now()-interval '1 minute' WHERE id=$1", [win.value.id]);
    await expect(authorizeDesk(ids[attempts.indexOf(win)]!, wallets[attempts.indexOf(win)]!.address, win.value.id)).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });
  it("authorizes one prompt, preserves signed bytes across unknown broadcasts, and proves delivery", async () => {
    const user = ids[2]!, owner = wallets[2]!.address;
    const quote = await quoteDesk(user, owner, recipient, "0.30", randomUUID());
    const attempts = await Promise.all([authorizeDesk(user, owner, quote.id), authorizeDesk(user, owner, quote.id)]);
    expect(attempts.filter(a => a.promptAllowed)).toHaveLength(1);
    expect((await authorizeDesk(user, owner, quote.id)).promptAllowed).toBe(false);
    mocks.timestamp = Date.now();
    expect((await reportDeskDeposit(user, owner, quote.id, "ab".repeat(32))).state).toBe("VERIFIED");
    mocks.broadcastFails = true;
    expect((await checkDeskOrder(user, owner, quote.id)).state).toBe("PAYOUT_SUBMITTED");
    // Simulate another worker/process resuming solely from the committed DB row.
    vi.stubEnv("THENCE_DESK_ENABLED", "false");
    await processDeskPayout(quote.id);
    expect(mocks.signs).toBe(1); expect(new Set(mocks.broadcasts).size).toBe(1);
    const saved = await deskTransaction(c => loadDeskOrder(c, quote.id, user));
    expect(saved.signed_payout).toBe(mocks.broadcasts[0]);
    mocks.receipt = "delivered";
    expect((await checkDeskOrder(user, owner, quote.id)).state).toBe("DELIVERED");
    await expect(quoteDesk(user, owner, recipient, "0.30", randomUUID())).rejects.toMatchObject({ code: "DESK_PAUSED" });
    vi.stubEnv("THENCE_DESK_ENABLED", "true");
  });
  it("puts late verified NIM into the refund queue without signing a payout", async () => {
    const user = ids[2]!, owner = wallets[2]!.address;
    const order = await quoteDesk(user, owner, recipient, "0.30", randomUUID());
    const auth = await authorizeDesk(user, owner, order.id);
    mocks.timestamp = auth.order.fundingDeadline! + 1;
    const signs = mocks.signs;
    expect((await reportDeskDeposit(user, owner, order.id, "cd".repeat(32))).state).toBe("REFUND_DUE");
    await processDeskPayout(order.id); expect(mocks.signs).toBe(signs);
    expect((await reportDeskRefund(user, owner, order.id, "12".repeat(32))).state).toBe("REFUNDED");
  });
  it("recovers a real deposit by memo after the owner reports an unrelated hash", async () => {
    const user = ids[0]!, owner = wallets[0]!.address;
    const order = await quoteDesk(user, owner, recipient, "0.30", randomUUID());
    await authorizeDesk(user, owner, order.id); mocks.timestamp = Date.now();
    expect((await reportDeskDeposit(user, owner, order.id, "ee".repeat(32))).state).toBe("AWAITING_NIM");
    mocks.discovered = ["ff".repeat(32)]; mocks.receipt = "pending";
    const recovered = await checkDeskOrder(user, owner, order.id);
    expect(recovered.depositHash).toBe("ff".repeat(32));
    expect(recovered.state).toBe("PAYOUT_SUBMITTED");
    await expect(requestDeskRefund(user, owner, order.id)).rejects.toMatchObject({ code: "PAYOUT_UNRESOLVED" });
  });
  it("allocates unique nonces across concurrent owners and can queue a return before signing", async () => {
    mocks.receipt = "delivered";
    const previous = await getPool().query("SELECT id FROM desk_orders WHERE owner_id=$1 AND state='PAYOUT_SUBMITTED'", [ids[0]]);
    await processDeskPayout(previous.rows[0].id);
    mocks.balance = 2000000n; mocks.discovered = []; mocks.receipt = "pending";
    const quotes = await Promise.all(ids.slice(0, 2).map((id, n) => quoteDesk(id, wallets[n]!.address, recipient, "0.30", randomUUID())));
    for (let n = 0; n < quotes.length; n++) {
      await authorizeDesk(ids[n]!, wallets[n]!.address, quotes[n]!.id); mocks.timestamp = Date.now();
      await reportDeskDeposit(ids[n]!, wallets[n]!.address, quotes[n]!.id, String(n + 2).repeat(64));
    }
    await Promise.all(quotes.map(o => processDeskPayout(o.id)));
    const saved = await getPool().query("SELECT payout_nonce FROM desk_orders WHERE id=ANY($1::uuid[])", [quotes.map(o => o.id)]);
    expect(new Set(saved.rows.map(r => r.payout_nonce)).size).toBe(2);
    const q = await quoteDesk(ids[2]!, wallets[2]!.address, recipient, "0.30", randomUUID());
    await authorizeDesk(ids[2]!, wallets[2]!.address, q.id); mocks.timestamp = Date.now();
    await reportDeskDeposit(ids[2]!, wallets[2]!.address, q.id, "45".repeat(32));
    const signs = mocks.signs;
    expect((await requestDeskRefund(ids[2]!, wallets[2]!.address, q.id)).state).toBe("REFUND_DUE");
    await processDeskPayout(q.id); expect(mocks.signs).toBe(signs);
  });
});
