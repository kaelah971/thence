/**
 * P3 — server claim authorization and browser-independent delivery, live
 * against the ISOLATED test database (anchor-proven; never production).
 *
 * Payments are built through the real routes (create → prepare → attach →
 * authorize → reconcile) with the provider mocked on the REAL 077770a1 shape
 * (hash lock, pinned HTLC). Because Nov 2's real deadline is in the past, the
 * funding and claim receipts here are SYNTHETIC: a fund event of the pinned
 * HTLC carrying this run's future deadline, and an ERC20 Transfer of exactly
 * 300000 USDC to the recipient. Nothing claims, pays or refunds — the
 * browser SDK claim is not involved at all; only the server gate is.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { keccak256 } from "viem";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import fixture from "./fixtures/incidents-2026-11-02.json";
import { getDb } from "@/lib/db";
import { jobLeases, swapAttachments, transferTransitions, transfers, users } from "@/db/schema";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { CLAIM_FUNDING_MIN_CONFIRMATIONS, SWAP_FUNDED_EVENT_TOPIC, TRANSFER_EVENT_TOPIC, setSettlementChainForTests, type ChainReads } from "@/lib/settlement";
import { runServerReconciliation } from "@/lib/server-reconciler";
import { checkTransferConsistency, readConsistencySnapshot } from "@/lib/consistency";
import { LIVE, RUN, fixtureWallet, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as claimIntentPost } from "../app/api/transfers/[id]/claim-intent/route";
import { GET as listTransfers } from "../app/api/transfers/route";
import { GET as getTransfer } from "../app/api/transfers/[id]/route";
import { POST as logoutPost } from "../app/api/session/logout/route";
import { handoffAttempts } from "@/db/schema";

const INC = fixture.incident_077770a1;
const LOCK = INC.attachment.payment_hash;
const HTLC = INC.satora.getSwap.evm_htlc_address;
const EVM_A = "0x0000000000000000000000000000000000000001";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const HTLC_TOKEN = INC.satora.getSwap.wbtc_address;
const HTLC_REFUND_ADDRESS = INC.satora.getSwap.server_evm_address;
const HTLC_CLAIM_ADDRESS = INC.satora.getSwap.client_evm_address;
const hex32 = (tag: string) => "0x" + createHash("sha256").update(`p3-${RUN}-${tag}`).digest("hex");
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const syntheticSwapKey = (hashLock: string, amount: bigint | number, token: string, refundAddress: string, claimAddress: string, timelock: number) =>
  keccak256(`0x${[hashLock.slice(2), word(amount), pad(token).slice(2), pad(refundAddress).slice(2), pad(claimAddress).slice(2), word(timelock)].join("")}` as `0x${string}`);
const nowSec = () => Math.floor(Date.now() / 1000);

/* --------------------------- synthetic chain --------------------------- */

const FUND_BLOCK = 80_000_000n;
const CLAIM_BLOCK = 80_000_500n;
let latestBlock = FUND_BLOCK + 1_000n;
/** fund tx hash → on-chain timelock the fund event carries */
const fundReceipts = new Map<string, number>();
const claimReceipts = new Set<string>();
/** fund tx hashes whose lock was later redeemed on chain (SIMULATED HTLC redeem event). */
const spentFunds = new Set<string>();
let chainDown = false;
let logsDown = false;

function syntheticChain(): ChainReads {
  return {
    async getTransaction(_c, hash) {
      return fundReceipts.has(hash) ? { hash, blockNumber: FUND_BLOCK } : claimReceipts.has(hash) ? { hash, blockNumber: CLAIM_BLOCK } : null;
    },
    async getReceipt(_c, hash) {
      if (chainDown) throw new Error("rpc 502");
      const lock = fundReceipts.get(hash);
      if (lock !== undefined) {
        return {
          status: "success" as const,
          blockNumber: FUND_BLOCK,
          blockHash: `0x${"f0".repeat(32)}`,
          logs: [{ address: HTLC, topics: [SWAP_FUNDED_EVENT_TOPIC, LOCK, pad(HTLC_REFUND_ADDRESS), pad(HTLC_CLAIM_ADDRESS)], data: "0x" + word(BigInt(`0x${HTLC_TOKEN.slice(2)}`)) + word(392) + word(lock) + syntheticSwapKey(LOCK, 392, HTLC_TOKEN, HTLC_REFUND_ADDRESS, HTLC_CLAIM_ADDRESS, lock).slice(2), logIndex: 1 }],
        };
      }
      if (claimReceipts.has(hash)) {
        return {
          status: "success" as const,
          blockNumber: CLAIM_BLOCK,
          blockHash: `0x${"c1".repeat(32)}`,
          logs: [{ address: USDC, topics: [TRANSFER_EVENT_TOPIC, pad(HTLC), pad(EVM_A)], data: "0x" + word(300000), logIndex: 7 }],
        };
      }
      return null;
    },
    async getLatestBlockNumber() {
      return latestBlock;
    },
    async getFinalizedBlockNumber() {
      return null;
    },
    async getBlockHash(_c, n) {
      return n === FUND_BLOCK ? `0x${"f0".repeat(32)}` : n === CLAIM_BLOCK ? `0x${"c1".repeat(32)}` : null;
    },
    async getBlockTimestamp(_c, n) {
      return 1_800_000_000 + Number(n - FUND_BLOCK) * 2;
    },
    async getLogsByTopic1(_c, address, topic1, from, to) {
      if (logsDown) throw new Error("rpc 502");
      const logs = [];
      for (const [hash] of fundReceipts) {
        if (address.toLowerCase() !== HTLC.toLowerCase() || topic1.toLowerCase() !== LOCK.toLowerCase()) continue;
        if (FUND_BLOCK >= from && FUND_BLOCK <= to) logs.push({ address: HTLC, topics: [SWAP_FUNDED_EVENT_TOPIC, LOCK], data: "0x", logIndex: 1, transactionHash: hash });
        if (spentFunds.has(hash) && CLAIM_BLOCK >= from && CLAIM_BLOCK <= to) logs.push({ address: HTLC, topics: [`0x${"7e".repeat(32)}`, LOCK], data: "0x", logIndex: 2, transactionHash: hex32(`redeem-${hash}`) });
      }
      return logs;
    },
  };
}

/* ------------------------------ provider ------------------------------ */

type Gate = { kind: "gate"; started: () => void; release: Promise<void>; then: Record<string, unknown> };
const provider = new Map<string, Record<string, unknown> | "unavailable" | Gate>();
function installProvider(): void {
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      const b = provider.get(id);
      if (b === undefined) throw Object.assign(new Error("not found"), { code: 404 });
      if (b === "unavailable") throw new Error("provider down");
      if ((b as Gate).kind === "gate") {
        const g = b as Gate;
        g.started();
        await g.release;
        return { ...g.then, id };
      }
      return { ...(b as Record<string, unknown>), id };
    },
  });
}

interface Pay { id: string; cookie: string; swapId: string; sourceSats: string; lock: number; fundTx: string; tag: string; userId: string; wallet: ReturnType<typeof fixtureWallet>; attemptToken: string }

const swapShape = (p: Pick<Pay, "swapId" | "sourceSats" | "lock">, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: p.swapId,
  direction: "lightning_to_evm",
  bolt11_invoice: "lnbc3980n1p4testinvoice",
  hash_lock: LOCK,
  source_amount: p.sourceSats,
  target_amount: "300000",
  evm_chain_id: 137,
  evm_htlc_address: HTLC,
  target_evm_address: EVM_A,
  target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC },
  wbtc_address: HTLC_TOKEN,
  evm_expected_sats: "392",
  server_evm_address: HTLC_REFUND_ADDRESS,
  client_evm_address: HTLC_CLAIM_ADDRESS,
  status: "pending",
  invoice_expires_at: nowSec() + 5400,
  evm_refund_locktime: p.lock,
  evm_fund_txid: null,
  evm_claim_txid: null,
  fee_sats: 6,
  created_at: new Date().toISOString(),
  ...over,
});

/* ------------------------------- helpers ------------------------------- */

const createdUserIds: string[] = [];
const createdTransferIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `p3-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** An authorized payment that the provider then funds; the server reconciles it to SERVER_FUNDED. */
async function fundedPayment(tag: string): Promise<Pay> {
  const wallet = fixtureWallet();
  const { cookie, userId } = await loginAs(client(`login-${tag}`), (uid) => createdUserIds.push(uid), wallet);
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `p3-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  createdTransferIds.push(transfer.id);
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  const p: Pay = { id: transfer.id, cookie, swapId: randomUUID(), // provider swap ids are UUIDs (the scheduled reconciler skips anything else)
    sourceSats: transfer.quote.sourceSats, lock: nowSec() + 3500, fundTx: hex32(`fund-${tag}`), tag, userId, wallet, attemptToken: token };
  provider.set(p.swapId, swapShape(p));
  const attached = await attachPost(postJson(`http://localhost/api/transfers/${p.id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: p.swapId, recoveryAcknowledged: true }, { cookie, ...client(tag) }), params(p.id));
  if (attached.status !== 201) throw new Error(`setup attach failed: ${attached.status} ${JSON.stringify(await attached.json())}`);
  const authed = await authorizePost(postJson(`http://localhost/api/transfers/${p.id}/authorize-handoff`, { attemptToken: token }, { cookie, ...client(tag) }), params(p.id));
  if (authed.status !== 200) throw new Error(`setup authorize failed: ${authed.status}`);
  fundReceipts.set(p.fundTx, p.lock);
  provider.set(p.swapId, swapShape(p, { status: "serverfunded", evm_fund_txid: p.fundTx }));
  const rec = await reconcilePost(postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie, ...client(tag) }), params(p.id));
  if (rec.status !== 200 || (await statusOf(p.id)) !== "SERVER_FUNDED") throw new Error(`setup fund failed: ${rec.status} ${await statusOf(p.id)}`);
  return p;
}

const claim = (p: Pay, cookie = p.cookie) => claimIntentPost(postJson(`http://localhost/api/transfers/${p.id}/claim-intent`, {}, { cookie, ...client(p.tag) }), params(p.id));
const statusOf = async (id: string) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.s;
const reasonsOf = async (id: string) => (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, id))).map((t) => t.reasonCode);
const errorOf = async (res: Response) => ((await res.json()) as { error: string; message: string });
/** TEST database only: make observations old so the cron considers the transfer due. */
const ageObservations = (id: string) =>
  getDb().execute(sql`UPDATE reconciliation_observations SET observed_at = observed_at - make_interval(mins => 10) WHERE transfer_id = ${id}::uuid`);
/** TEST database only: end this transfer's claim lease now. */
const expireLease = (id: string) => getDb().update(jobLeases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(jobLeases.name, `claim:${id}`));

async function lockIsFree(id: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const r = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${"transfer:" + id})) AS ok`)) as unknown as { rows: Array<{ ok: boolean }> };
    return r.rows[0]?.ok === true;
  });
}

async function expectConsistent(id: string): Promise<void> {
  const snapshot = await readConsistencySnapshot(getDb(), id);
  expect(checkTransferConsistency(snapshot!, { requireAudit: true })).toEqual([]);
}

let previousRoutes: string | undefined;
let previousRpcs: string | undefined;
beforeEach(() => {
  previousRoutes = process.env["THENCE_ENABLED_ROUTES"];
  previousRpcs = process.env["THENCE_EVM_RPCS_JSON"];
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://fixture.invalid" });
  latestBlock = FUND_BLOCK + 1_000n;
  chainDown = false;
  logsDown = false;
  // All synthetic swaps share the real 077770a1 hash lock, and HTLC logs are
  // keyed by hash lock: a redeem simulated in one test must not leak into the next.
  spentFunds.clear();
  setSettlementChainForTests(syntheticChain());
  installProvider();
});
afterEach(() => {
  if (previousRoutes === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
  else process.env["THENCE_ENABLED_ROUTES"] = previousRoutes;
  if (previousRpcs === undefined) delete process.env["THENCE_EVM_RPCS_JSON"];
  else process.env["THENCE_EVM_RPCS_JSON"] = previousRpcs;
});
afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  if (!LIVE) return;
  for (const id of createdTransferIds) await getDb().delete(jobLeases).where(eq(jobLeases.name, `claim:${id}`));
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

/* -------------------------------- tests -------------------------------- */

describe.skipIf(!LIVE)("P3 claim authorization (isolated test database)", () => {
  it("funded → explicit claim authorized once (audited, lease held) → browser closed → cron verifies USDC → DELIVERED with proof", async () => {
    const p = await fundedPayment("happy");
    const res = await claim(p);
    expect(res.status).toBe(200);
    const intent = ((await res.json()) as { claim: Record<string, unknown> }).claim;
    expect(intent).toMatchObject({ transferId: p.id, status: "CLAIMING", satoraSwapId: p.swapId, paymentHash: LOCK, destination: EVM_A, targetAmountAtomic: "300000", claimDeadline: new Date(p.lock * 1000).toISOString(), retry: false });
    expect(await statusOf(p.id)).toBe("CLAIMING");
    const row = (await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.reasonCode, "CLAIM_AUTHORIZED"))))[0]!;
    expect(row).toMatchObject({ fromStatus: "SERVER_FUNDED", toStatus: "CLAIMING", actor: "owner" });
    expect(row.evidence).toMatchObject({ providerStatus: "serverfunded", fundTxHash: p.fundTx, claimDeadline: new Date(p.lock * 1000).toISOString() });
    expect((await getDb().select().from(jobLeases).where(eq(jobLeases.name, `claim:${p.id}`))).length).toBe(1);

    // The browser's SDK claim lands (simulated by the provider); the owner closes the app.
    const claimTx = hex32("claim-happy");
    claimReceipts.add(claimTx);
    latestBlock = CLAIM_BLOCK + 300n;
    provider.set(p.swapId, swapShape(p, { status: "clientredeemed", evm_fund_txid: p.fundTx, evm_claim_txid: claimTx }));
    await ageObservations(p.id);
    const run = await runServerReconciliation({ scope: [p.id], leaseName: `p3-${RUN}-happy` });
    expect(run.advanced).toContainEqual({ transferId: p.id, from: "CLAIMING", to: "DELIVERED" });
    expect(await statusOf(p.id)).toBe("DELIVERED");
    const delivered = (await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.toStatus, "DELIVERED"))))[0]!;
    expect(delivered).toMatchObject({ reasonCode: "SETTLEMENT_VERIFIED", actor: "reconciler", actorUserId: null });
    expect(delivered.evidence).toMatchObject({ claimTxHash: claimTx, verifiedAmountAtomic: "300000" });
    await expectConsistent(p.id);
  });

  it("the provider claim alone never delivers: without the USDC Transfer on chain the cron leaves it CLAIMING", async () => {
    const p = await fundedPayment("no-proof");
    expect((await claim(p)).status).toBe(200);
    provider.set(p.swapId, swapShape(p, { status: "clientredeemed", evm_fund_txid: p.fundTx, evm_claim_txid: hex32("claim-missing") }));
    await ageObservations(p.id);
    const run = await runServerReconciliation({ scope: [p.id], leaseName: `p3-${RUN}-no-proof` });
    expect(run.reconciled).toBe(1);
    expect(await statusOf(p.id)).toBe("CLAIMING");
    await expectConsistent(p.id);
  });

  it("concurrent claim authorizations (two tabs/devices): exactly one succeeds, one audit row", async () => {
    const p = await fundedPayment("dup");
    const [a, b] = await Promise.all([claim(p), claim(p)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const refused = await errorOf(a.status === 409 ? a : b);
    expect(["CLAIM_IN_PROGRESS", "VERSION_CONFLICT"]).toContain(refused.error);
    expect((await reasonsOf(p.id)).filter((r) => r === "CLAIM_AUTHORIZED")).toHaveLength(1);
    // A third attempt while the lease is live is refused.
    const third = await claim(p);
    expect(third.status).toBe(409);
    expect((await errorOf(third)).error).toBe("CLAIM_IN_PROGRESS");
    await expectConsistent(p.id);
  });

  it("retry after an unknown outcome needs chain proof: a lease expiry alone, or a provider that still says serverfunded, is not enough", async () => {
    const p = await fundedPayment("retry-chain");
    expect((await claim(p)).status).toBe(200);
    await expireLease(p.id);
    // Provider still reports serverfunded, but the chain cannot be scanned: refuse.
    logsDown = true;
    let res = await claim(p);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).error).toBe("CLAIM_OUTCOME_UNRESOLVED");
    logsDown = false;
    // Provider still reports serverfunded, but the HTLC already emitted a redeem: refuse.
    spentFunds.add(p.fundTx);
    res = await claim(p);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toBe("CLAIM_ALREADY_SUBMITTED");
    expect((await reasonsOf(p.id)).filter((r) => r === "CLAIM_AUTHORIZED")).toHaveLength(1);
    await expectConsistent(p.id);
  });

  it("retry after an unknown outcome: only once the lease expired AND the chain shows the lock unspent", async () => {
    const p = await fundedPayment("retry");
    expect((await claim(p)).status).toBe(200);
    await expireLease(p.id);
    const again = await claim(p);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { claim: { retry: boolean } }).claim.retry).toBe(true);
    expect((await reasonsOf(p.id)).filter((r) => r === "CLAIM_AUTHORIZED")).toHaveLength(1);
    // Once a claim is on record, no further authorization even after the lease.
    await expireLease(p.id);
    provider.set(p.swapId, swapShape(p, { status: "clientredeeming", evm_fund_txid: p.fundTx, evm_claim_txid: hex32("claim-retry") }));
    const blocked = await claim(p);
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).error).toBe("CLAIM_ALREADY_SUBMITTED");
    await expectConsistent(p.id);
  });

  it("no transfer lock is held while the provider is read", async () => {
    const p = await fundedPayment("lockfree");
    let started!: () => void;
    let release!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const releaseP = new Promise<void>((r) => (release = r));
    provider.set(p.swapId, { kind: "gate", started, release: releaseP, then: swapShape(p, { status: "serverfunded", evm_fund_txid: p.fundTx }) });
    const pending = claim(p);
    await startedP;
    expect(await lockIsFree(p.id)).toBe(true);
    release();
    expect((await pending).status).toBe(200);
  });

  it("refuses, with nothing written, on any identity, funding, deadline, provider or ownership doubt", async () => {
    const p = await fundedPayment("refusals");
    const funded = swapShape(p, { status: "serverfunded", evm_fund_txid: p.fundTx });
    const expectRefused = async (status: number, error: string) => {
      const res = await claim(p);
      expect(res.status).toBe(status);
      expect((await errorOf(res)).error).toBe(error);
      expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    };
    provider.set(p.swapId, { ...funded, target_evm_address: "0x0000000000000000000000000000000000000bad" });
    await expectRefused(409, "SWAP_MISMATCH");
    provider.set(p.swapId, { ...funded, target_amount: "299999" });
    await expectRefused(409, "SWAP_MISMATCH");
    provider.set(p.swapId, { ...funded, evm_refund_locktime: p.lock + 60 });
    await expectRefused(409, "SWAP_MISMATCH");
    provider.set(p.swapId, "unavailable");
    await expectRefused(503, "PROVIDER_UNAVAILABLE");
    provider.set(p.swapId, { ...funded, status: "clientfundedserverrefunded", evm_claim_txid: hex32("refund") });
    await expectRefused(409, "CLAIM_ALREADY_SUBMITTED");
    provider.set(p.swapId, { ...funded, status: "expired" });
    await expectRefused(409, "NOT_CLAIMABLE");
    // On-chain: the fund event carries a different deadline than the one bound.
    provider.set(p.swapId, funded);
    fundReceipts.set(p.fundTx, p.lock + 600);
    await expectRefused(409, "FUNDING_INVALID");
    fundReceipts.set(p.fundTx, p.lock);
    latestBlock = FUND_BLOCK + BigInt(CLAIM_FUNDING_MIN_CONFIRMATIONS - 5);
    await expectRefused(409, "FUNDING_NOT_CONFIRMED");
    // F9.1: the refusal carries public progress figures for the one-tap wait.
    const early = await errorOf(await claim(p));
    expect((early as { details?: Record<string, string> }).details?.["required"]).toBe(String(CLAIM_FUNDING_MIN_CONFIRMATIONS));
    expect(Number((early as { details?: Record<string, string> }).details?.["confirmations"])).toBeLessThan(CLAIM_FUNDING_MIN_CONFIRMATIONS);
    latestBlock = FUND_BLOCK + 1_000n;
    chainDown = true;
    await expectRefused(503, "CHAIN_UNAVAILABLE");
    chainDown = false;
    // Another user can't authorize the owner's claim.
    const { cookie: other } = await loginAs(client("login-refusals-other"), (uid) => createdUserIds.push(uid));
    const foreign = await claim(p, other);
    expect(foreign.status).toBe(404);
    // Inside the five-minute unsafe window (TEST database: move the bound deadline).
    await getDb().update(swapAttachments).set({ evmRefundLocktime: new Date(Date.now() + 4 * 60_000) }).where(eq(swapAttachments.transferId, p.id));
    await expectRefused(409, "DEADLINE_TOO_CLOSE");
    expect((await reasonsOf(p.id)).filter((r) => r === "CLAIM_AUTHORIZED")).toHaveLength(0);
    expect((await getDb().select().from(jobLeases).where(eq(jobLeases.name, `claim:${p.id}`))).length).toBe(0);
  });

  it("every transfer this suite created is consistent under the strict checker", async () => {
    for (const id of createdTransferIds) await expectConsistent(id);
  });
});

/* ------------- iOS cookie loss: re-authentication and recovery ------------- */

/**
 * 2026-11-05: Nimiq Pay iOS dropped every cookie (login and diagnostic) while
 * IndexedDB and localStorage survived. The owner then signs in again with the
 * same wallet, which issues a NEW session. These pin that the funded payment
 * is still the same owner's, resumable exactly once, and that nothing is
 * created or re-approved; absent/stale sessions and other wallets fail safe.
 */
describe.skipIf(!LIVE)("re-authentication after login-cookie loss (isolated test database)", () => {
  const transfersOf = async (userId: string) => getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));
  const attemptsOf = async (id: string) => getDb().select({ id: handoffAttempts.id }).from(handoffAttempts).where(eq(handoffAttempts.transferId, id));
  const swapsOf = async (id: string) => getDb().select({ id: swapAttachments.id }).from(swapAttachments).where(eq(swapAttachments.transferId, id));
  const get = (url: string, cookie: string, tag: string) => new Request(url, { headers: { cookie, ...client(tag) } });

  it("same wallet, new session: same owner and payment; no new transfer, swap or approval; Finish delivery authorized once", async () => {
    const p = await fundedPayment("reauth");
    const before = { transfers: await transfersOf(p.userId), attempts: await attemptsOf(p.id), swaps: await swapsOf(p.id) };
    // Cookie lost on the device: the browser signs in again with the same wallet.
    const again = await loginAs(client("reauth-again"), undefined, p.wallet);
    expect(again.userId).toBe(p.userId);
    expect(again.cookie).not.toBe(p.cookie);

    // The new session sees the original payment, funded.
    const listed = await listTransfers(get("http://localhost/api/transfers", again.cookie, "reauth-list"));
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(p.id);
    const one = await getTransfer(get(`http://localhost/api/transfers/${p.id}`, again.cookie, "reauth-get"), params(p.id));
    expect(one.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    // Nimiq Pay approval cannot be requested again for this payment.
    const reauthorize = await authorizePost(
      postJson(`http://localhost/api/transfers/${p.id}/authorize-handoff`, { attemptToken: p.attemptToken }, { cookie: again.cookie, ...client("reauth-authz") }),
      params(p.id),
    );
    expect(reauthorize.status).toBe(409);
    expect((await errorOf(reauthorize)).error).toBe("NOT_AUTHORIZABLE");
    // A second payment cannot be started while this one is unresolved.
    const second = await createTransfer(
      postJson(
        "http://localhost/api/transfers",
        { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `p3-${RUN}-reauth-second`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } },
        { cookie: again.cookie, ...client("reauth-second") },
      ),
    );
    expect(second.status).toBe(409);
    expect((await errorOf(second)).error).toBe("PAYMENT_EXPOSURE_UNCERTAIN");
    expect(await transfersOf(p.userId)).toEqual(before.transfers);
    expect(await attemptsOf(p.id)).toEqual(before.attempts);
    expect(await swapsOf(p.id)).toEqual(before.swaps);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    // Finish delivery: authorized for exactly the bound swap, deadline and destination.
    const res = await claim(p, again.cookie);
    expect(res.status).toBe(200);
    const intent = ((await res.json()) as { claim: Record<string, unknown> }).claim;
    expect(intent).toMatchObject({
      transferId: p.id,
      status: "CLAIMING",
      satoraSwapId: p.swapId,
      paymentHash: LOCK,
      destination: EVM_A,
      targetAmountAtomic: "300000",
      claimDeadline: new Date(p.lock * 1000).toISOString(),
      retry: false,
    });
    // The old session (still valid server-side) cannot start a second claim while the lease is held.
    const dup = await claim(p, p.cookie);
    expect(dup.status).toBe(409);
    expect((await reasonsOf(p.id)).filter((r) => r === "CLAIM_AUTHORIZED")).toHaveLength(1);
    await expectConsistent(p.id);
  }, 180_000); // two logins + a full funded setup + six reads on the live test database

  it("no session, a forged token or a signed-out session: Finish delivery refused with 401, nothing changes", async () => {
    const p = await fundedPayment("nosession");
    const noCookie = await claimIntentPost(postJson(`http://localhost/api/transfers/${p.id}/claim-intent`, {}, client("nosession-none")), params(p.id));
    expect(noCookie.status).toBe(401);
    expect((await claim(p, "thence_session=forged-not-a-real-token")).status).toBe(401);
    const out = await logoutPost(postJson("http://localhost/api/session/logout", {}, { cookie: p.cookie, ...client("nosession-logout") }));
    expect(out.status).toBeLessThan(300);
    expect((await claim(p)).status).toBe(401);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    expect(await reasonsOf(p.id)).not.toContain("CLAIM_AUTHORIZED");
    // Signing in again with the same wallet restores access to the same payment.
    const again = await loginAs(client("nosession-again"), undefined, p.wallet);
    expect((await claim(p, again.cookie)).status).toBe(200);
    expect((await reasonsOf(p.id)).filter((r) => r === "CLAIM_AUTHORIZED")).toHaveLength(1);
  });

  it("a different wallet signed in on the device can neither see nor finish the payment", async () => {
    const p = await fundedPayment("otherwallet");
    const other = await loginAs(client("otherwallet-login"), (uid) => createdUserIds.push(uid));
    expect(other.userId).not.toBe(p.userId);
    const seen = await getTransfer(get(`http://localhost/api/transfers/${p.id}`, other.cookie, "otherwallet-get"), params(p.id));
    expect([403, 404]).toContain(seen.status);
    const listed = await listTransfers(get("http://localhost/api/transfers", other.cookie, "otherwallet-list"));
    expect(JSON.stringify(await listed.json())).not.toContain(p.id);
    const res = await claim(p, other.cookie);
    expect([403, 404]).toContain(res.status);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    expect(await reasonsOf(p.id)).not.toContain("CLAIM_AUTHORIZED");
  });
});
