/**
 * P5 — safe locking, transition audit coverage and refund-state consistency,
 * live against the ISOLATED test database (anchor-proven; never production).
 *
 * Payments are built through the real routes (create → prepare → attach →
 * authorize) with the provider mocked from the REAL 2026-11-02 evidence:
 * 077770a1's hash lock, pinned HTLC, refund locktime and on-chain receipts,
 * plus the captured HTLC log scan. Nothing here pays, swaps, claims or
 * refunds: every provider and chain read is a test-seam fixture.
 *
 * Every transfer created here must pass the strict consistency checker
 * (complete audit trail, proof/refund records matching status).
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import fixture from "./fixtures/incidents-2026-11-02.json";
import { getDb } from "@/lib/db";
import { reconciliationObservations, transferTransitions, transfers, users } from "@/db/schema";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { TRANSFER_EVENT_TOPIC, setSettlementChainForTests, type ChainLog, type ChainReads } from "@/lib/settlement";
import { checkTransferConsistency, readConsistencySnapshot } from "@/lib/consistency";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as verifySettlementPost } from "../app/api/transfers/[id]/verify-settlement/route";

const INC = fixture.incident_077770a1;
const REAL_HASH_LOCK = INC.attachment.payment_hash;
const REAL_HTLC = INC.satora.getSwap.evm_htlc_address;
const REAL_FUND_TX = INC.satora.getSwap.evm_fund_txid as string;
const REAL_REFUND_TX = INC.satora.getSwap.evm_claim_txid as string;
const REAL_LOCKTIME = INC.satora.getSwap.evm_refund_locktime;
const SCAN = INC.polygonHtlcScan;
const EVM_A = "0x0000000000000000000000000000000000000001";
const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

/* ----------------------------- chain fixture ----------------------------- */

type RawReceipt = (typeof INC.polygon.receipts)[keyof typeof INC.polygon.receipts];
const receipts = INC.polygon.receipts as Record<string, RawReceipt>;
const blocks = INC.polygon.blocks as Record<string, { number: string; hash: string; timestamp: string }>;
const anchor = blocks[receipts[REAL_FUND_TX]!.blockNumber]!;
const tsOf = (n: bigint) => Number(anchor.timestamp) + Math.floor((Number(n) - Number(anchor.number)) * 1.5);

/** Synthetic claim receipt crediting EVM_A with exactly 300000 USDC (settlement path only). */
const CLAIM_TX = "0x" + createHash("sha256").update(`p5-claim-${RUN}`).digest("hex");
const CLAIM_BLOCK = BigInt(SCAN.toBlock) - 400n;
const CLAIM_BLOCK_HASH = `0x${"c1".repeat(32)}`;
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();

let chainFailure: "none" | "receipts" = "none";

/** Real receipts + real captured HTLC scan; latest block = end of the captured scan. */
function realChain(): ChainReads {
  return {
    async getTransaction(_c, hash) {
      const r = receipts[hash.toLowerCase()];
      return r ? { hash, blockNumber: BigInt(r.blockNumber) } : null;
    },
    async getReceipt(_c, hash) {
      if (chainFailure === "receipts") throw new Error("rpc 502");
      if (hash.toLowerCase() === CLAIM_TX) {
        return {
          status: "success" as const,
          blockNumber: CLAIM_BLOCK,
          blockHash: CLAIM_BLOCK_HASH,
          logs: [{ address: USDC_POLYGON, topics: [TRANSFER_EVENT_TOPIC, pad(REAL_HTLC), pad(EVM_A)], data: "0x" + (300000).toString(16).padStart(64, "0"), logIndex: 7 }],
        };
      }
      const r = receipts[hash.toLowerCase()];
      return r
        ? { status: r.status as "success", blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) }
        : null;
    },
    async getLatestBlockNumber() {
      return BigInt(SCAN.toBlock);
    },
    async getFinalizedBlockNumber() {
      return BigInt(SCAN.toBlock) - 300n;
    },
    async getBlockHash(_c, n) {
      if (n === CLAIM_BLOCK) return CLAIM_BLOCK_HASH;
      return blocks[n.toString()]?.hash ?? null;
    },
    async getBlockTimestamp(_c, n) {
      return tsOf(n);
    },
    async getLogsByTopic1(_c, address, topic1, from, to): Promise<ChainLog[]> {
      if (from < BigInt(SCAN.fromBlock) || to > BigInt(SCAN.toBlock)) throw new Error("outside captured evidence");
      if (topic1.toLowerCase() !== SCAN.hashLock.toLowerCase()) return [];
      return SCAN.logs
        .filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to)
        .map((l) => ({ address, topics: [l.topic0, topic1, "0x" + "00".repeat(32)], data: "0x", logIndex: l.logIndex, transactionHash: l.transactionHash }));
    },
  };
}

/* ---------------------------- provider fixture ---------------------------- */

type Gate = { kind: "gate"; started: () => void; release: Promise<void>; then: Record<string, unknown> };
type Behavior = Record<string, unknown> | "unavailable" | Gate;
const provider = new Map<string, Behavior>();
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

/** Hold the next provider read open until released (proves what is locked meanwhile). */
function gate(swapId: string, then: Record<string, unknown>): { started: Promise<void>; release: () => void } {
  let started!: () => void;
  let release!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const releaseP = new Promise<void>((r) => (release = r));
  provider.set(swapId, { kind: "gate", started, release: releaseP, then });
  return { started: startedP, release };
}

const nowSec = () => Math.floor(Date.now() / 1000);
function swapShape(id: string, sourceSats: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc3980n1p4testinvoice",
    hash_lock: REAL_HASH_LOCK,
    source_amount: sourceSats,
    target_amount: "300000",
    evm_chain_id: 137,
    evm_htlc_address: REAL_HTLC,
    target_evm_address: EVM_A,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC_POLYGON },
    status: "pending",
    invoice_expires_at: nowSec() + 5400,
    evm_fund_txid: null,
    evm_claim_txid: null,
    fee_sats: 6,
    created_at: new Date().toISOString(),
    ...over,
  };
}

/* ------------------------------ live helpers ------------------------------ */

const createdUserIds: string[] = [];
const createdTransferIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `p5-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

interface Prepared { id: string; cookie: string; token: string; swapId: string; sourceSats: string; tag: string }

async function preparedPayment(tag: string): Promise<Prepared> {
  const { cookie } = await loginAs(client(`login-${tag}`), (uid) => createdUserIds.push(uid));
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `p5-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  createdTransferIds.push(transfer.id);
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  const swapId = `p5-swap-${RUN}-${tag}`;
  provider.set(swapId, swapShape(swapId, transfer.quote.sourceSats));
  return { id: transfer.id, cookie, token, swapId, sourceSats: transfer.quote.sourceSats, tag };
}

const attach = (p: Prepared) =>
  attachPost(
    postJson(`http://localhost/api/transfers/${p.id}/attach`, { attemptToken: p.token, expectedQuoteRevision: 1, satoraSwapId: p.swapId, recoveryAcknowledged: true }, { cookie: p.cookie, ...client(p.tag) }),
    params(p.id),
  );
const authorize = (p: Prepared) =>
  authorizePost(postJson(`http://localhost/api/transfers/${p.id}/authorize-handoff`, { attemptToken: p.token }, { cookie: p.cookie, ...client(p.tag) }), params(p.id));
const report = (p: Prepared, outcome: string) =>
  reportPost(postJson(`http://localhost/api/transfers/${p.id}/handoff-result`, { outcome }, { cookie: p.cookie, ...client(p.tag) }), params(p.id));
const reconcile = (p: Prepared) => reconcilePost(postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client(p.tag) }), params(p.id));
const verifySettlement = (p: Prepared) => verifySettlementPost(postJson(`http://localhost/api/transfers/${p.id}/verify-settlement`, {}, { cookie: p.cookie, ...client(p.tag) }), params(p.id));

async function authorizedPayment(tag: string): Promise<Prepared> {
  const p = await preparedPayment(tag);
  const a = await attach(p);
  if (a.status !== 201) throw new Error(`setup attach failed: ${a.status} ${JSON.stringify(await a.json())}`);
  const z = await authorize(p);
  if (z.status !== 200) throw new Error(`setup authorize failed: ${z.status} ${JSON.stringify(await z.json())}`);
  return p;
}

const statusOf = async (id: string) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.s;
// Deterministic audit order: without ORDER BY, Postgres may return rows in any order (CI flake 2026-11-06).
const transitionsOf = (id: string) =>
  getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, id)).orderBy(asc(transferTransitions.createdAt), asc(transferTransitions.id));
const reasonsOf = async (id: string) => (await transitionsOf(id)).map((t) => t.reasonCode);
const observationsOf = (id: string) => getDb().select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, id));
const ageObservations = (id: string, minutes: number) =>
  getDb().execute(sql`UPDATE reconciliation_observations SET observed_at = observed_at - make_interval(mins => ${minutes}) WHERE transfer_id = ${id}::uuid`);

/** True when nobody holds this transfer's advisory lock right now. */
async function lockIsFree(id: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const r = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${"transfer:" + id})) AS ok`)) as unknown as { rows: Array<{ ok: boolean }> };
    return r.rows[0]?.ok === true;
  });
}

async function expectConsistent(id: string): Promise<void> {
  const snapshot = await readConsistencySnapshot(getDb(), id);
  expect(snapshot).not.toBeNull();
  expect(checkTransferConsistency(snapshot!, { requireAudit: true })).toEqual([]);
}

let previousRoutes: string | undefined;
let previousRpcs: string | undefined;
beforeEach(() => {
  previousRoutes = process.env["THENCE_ENABLED_ROUTES"];
  previousRpcs = process.env["THENCE_EVM_RPCS_JSON"];
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://fixture.invalid" });
  chainFailure = "none";
  setSettlementChainForTests(realChain());
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
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

/* --------------------------------- tests --------------------------------- */

describe.skipIf(!LIVE)("P5 locking: no transfer lock is held while the provider is read", () => {
  it("attach, authorize and the AWAITING cancel each read the provider with the lock free, then commit audited", async () => {
    const p = await preparedPayment("lockfree");

    const g1 = gate(p.swapId, swapShape(p.swapId, p.sourceSats));
    const attaching = attach(p);
    await g1.started;
    expect(await lockIsFree(p.id)).toBe(true);
    g1.release();
    expect((await attaching).status).toBe(201);

    const g2 = gate(p.swapId, swapShape(p.swapId, p.sourceSats));
    const authorizing = authorize(p);
    await g2.started;
    expect(await lockIsFree(p.id)).toBe(true);
    g2.release();
    expect((await authorizing).status).toBe(200);

    // Satora's terminal `expired` (eddaa6de shape) is the only cancel proof once authorized.
    const g3 = gate(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "expired", invoice_expires_at: nowSec() - 3600 }));
    const cancelling = report(p, "cancelled");
    await g3.started;
    expect(await lockIsFree(p.id)).toBe(true);
    g3.release();
    const res = await cancelling;
    expect(res.status).toBe(200);
    expect(await statusOf(p.id)).toBe("USER_CANCELLED");
    expect(await reasonsOf(p.id)).toEqual(["SWAP_ATTACHED", "HANDOFF_AUTHORIZED", "CANCELLED_PROVIDER_EXPIRED"]);
    await expectConsistent(p.id);
  });

  it("a status change between evidence and commit is refused (VERSION_CONFLICT), never applied on stale evidence", async () => {
    // The dangerous race: a cancel gathered `pending` while SWAP_CREATED (enough
    // to cancel there), but the owner authorized the handoff meanwhile. Once
    // AWAITING, only Satora's terminal `expired` may cancel — so the stale
    // `pending` read must not be applied.
    const p = await preparedPayment("phase-race");
    expect((await attach(p)).status).toBe(201);
    const g = gate(p.swapId, swapShape(p.swapId, p.sourceSats));
    const cancelling = report(p, "cancelled");
    await g.started;
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats));
    expect((await authorize(p)).status).toBe(200);
    g.release();
    const res = await cancelling;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("VERSION_CONFLICT");
    expect(await statusOf(p.id)).toBe("AWAITING_NIM_APPROVAL");
    expect(await reasonsOf(p.id)).toEqual(["SWAP_ATTACHED", "HANDOFF_AUTHORIZED"]);
    // A handoff already past approval is refused outright (nothing written).
    expect((await report(p, "initiated")).status).toBe(200);
    const late = await report(p, "cancelled");
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("NOT_CANCELLABLE");
    expect(await statusOf(p.id)).toBe("LIGHTNING_HANDOFF");
    await expectConsistent(p.id);
  });

  it("SWAP_CREATED cancel with the provider down: 503, nothing written", async () => {
    const p = await preparedPayment("cancel-down");
    expect((await attach(p)).status).toBe(201);
    provider.set(p.swapId, "unavailable");
    const res = await report(p, "cancelled");
    expect(res.status).toBe(503);
    expect(await statusOf(p.id)).toBe("SWAP_CREATED");
    expect(await reasonsOf(p.id)).toEqual(["SWAP_ATTACHED"]);
    await expectConsistent(p.id);
  });
});

describe.skipIf(!LIVE)("P5 audit coverage, duplicates and rollback", () => {
  it("concurrent duplicate authorizations: exactly one succeeds and exactly one audit row exists", async () => {
    const p = await preparedPayment("dup-auth");
    expect((await attach(p)).status).toBe(201);
    const [a, b] = await Promise.all([authorize(p), authorize(p)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const rows = (await transitionsOf(p.id)).filter((t) => t.reasonCode === "HANDOFF_AUTHORIZED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStatus: "SWAP_CREATED", toStatus: "AWAITING_NIM_APPROVAL", actor: "owner" });
    await expectConsistent(p.id);
  });

  it("concurrent duplicate 'unknown' reports: one path, one set of audited hops, in order", async () => {
    const p = await authorizedPayment("dup-unknown");
    const [a, b] = await Promise.all([report(p, "unknown"), report(p, "unknown")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const flags = [((await a.json()) as { handoff: { deduplicated: boolean } }).handoff.deduplicated, ((await b.json()) as { handoff: { deduplicated: boolean } }).handoff.deduplicated];
    expect(flags.sort()).toEqual([false, true]);
    const hops = (await transitionsOf(p.id)).filter((t) => t.reasonCode === "CLIENT_REPORTED_UNKNOWN").sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    expect(hops.map((t) => t.toStatus)).toEqual(["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING"]);
    // clock_timestamp(): hops written in one transaction are strictly ordered.
    expect(new Set(hops.map((t) => t.createdAt.getTime())).size).toBe(3);
    await expectConsistent(p.id);
  });

  it("an audit write that fails rolls back its status change (same transaction)", async () => {
    const p = await preparedPayment("rollback");
    // TEST database only: occupy the one-terminal-row slot so the cancel's audit insert must fail.
    await getDb().insert(transferTransitions).values({ transferId: p.id, fromStatus: "QUOTED", toStatus: "QUOTE_EXPIRED", actor: "operator", reasonCode: "P5_TEST_BLOCKER", evidence: {}, terminal: true });
    const res = await report(p, "cancelled");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await statusOf(p.id)).toBe("QUOTED");
    expect((await transitionsOf(p.id)).map((t) => t.reasonCode)).toEqual(["P5_TEST_BLOCKER"]);
    await getDb().delete(transferTransitions).where(eq(transferTransitions.transferId, p.id));
    // With the blocker gone the same report commits status + audit together.
    expect((await report(p, "cancelled")).status).toBe(200);
    expect(await reasonsOf(p.id)).toEqual(["CANCELLED_UNBOUND"]);
    await expectConsistent(p.id);
  });

  it("settlement → DELIVERED is audited with its on-chain evidence, once", async () => {
    const p = await authorizedPayment("delivered");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    expect((await reconcile(p)).status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "clientredeemed", evm_fund_txid: REAL_FUND_TX, evm_claim_txid: CLAIM_TX }));
    const [v1, v2] = await Promise.all([verifySettlement(p), verifySettlement(p)]);
    expect([v1.status, v2.status]).toEqual([200, 200]);
    expect(await statusOf(p.id)).toBe("DELIVERED");
    const delivered = (await transitionsOf(p.id)).filter((t) => t.toStatus === "DELIVERED");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ reasonCode: "SETTLEMENT_VERIFIED", fromStatus: "SERVER_FUNDED", terminal: true });
    expect(delivered[0]!.evidence).toMatchObject({ claimTxHash: CLAIM_TX, chainId: 137, verifiedAmountAtomic: "300000", finalityLevel: "confirmations-256" });
    await expectConsistent(p.id);
  });
});

describe.skipIf(!LIVE)("P5 refund state is set only by independent Polygon evidence", () => {
  async function serverFunded(tag: string): Promise<Prepared> {
    const p = await authorizedPayment(tag);
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    expect((await reconcile(p)).status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    await ageObservations(p.id, 10);
    return p;
  }

  it("missing Satora refund pointer: the refund is found in the pinned HTLC's logs; REFUNDED is audited as Polygon-only", async () => {
    const p = await serverFunded("refund-scan");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "clientfundedserverrefunded", evm_fund_txid: REAL_FUND_TX, evm_claim_txid: null, evm_refund_locktime: REAL_LOCKTIME }));
    expect((await reconcile(p)).status).toBe(200);
    expect(await statusOf(p.id)).toBe("REFUNDED");
    const into = (await transitionsOf(p.id)).find((t) => t.toStatus === "REFUNDED")!;
    expect(into.evidence).toMatchObject({
      refundVerified: true,
      refundScope: "polygon_htlc",
      refundTxHash: REAL_REFUND_TX.toLowerCase(),
      refundEvidenceSource: "htlc_log_scan",
      nimiqSideRefund: "not_observable",
    });
    await expectConsistent(p.id);
  });

  it("wrong Satora pointer (the fund tx): never trusted, the real refund is still attributed from the HTLC logs", async () => {
    const p = await serverFunded("refund-wrong-ptr");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "clientfundedserverrefunded", evm_fund_txid: REAL_FUND_TX, evm_claim_txid: REAL_FUND_TX, evm_refund_locktime: REAL_LOCKTIME }));
    expect((await reconcile(p)).status).toBe(200);
    expect(await statusOf(p.id)).toBe("REFUNDED");
    const into = (await transitionsOf(p.id)).find((t) => t.toStatus === "REFUNDED")!;
    expect(into.evidence).toMatchObject({ refundTxHash: REAL_REFUND_TX.toLowerCase(), refundEvidenceSource: "htlc_log_scan" });
    await expectConsistent(p.id);
  });

  it("failed chain RPC: provider says refunded, the transfer stays funded and nothing terminal is written", async () => {
    const p = await serverFunded("refund-rpc-down");
    chainFailure = "receipts";
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "clientfundedserverrefunded", evm_fund_txid: REAL_FUND_TX, evm_claim_txid: REAL_REFUND_TX, evm_refund_locktime: REAL_LOCKTIME }));
    const res = await reconcile(p);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reconciliation: { lastError: string | null } }).reconciliation.lastError).toBe("REFUND_UNAVAILABLE");
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    expect((await transitionsOf(p.id)).some((t) => t.terminal)).toBe(false);
    expect((await observationsOf(p.id)).some((o) => o.errorCode === "REFUND_UNAVAILABLE")).toBe(true);
    await expectConsistent(p.id);
  });

  it("every transfer this suite created is consistent under the strict checker", async () => {
    for (const id of createdTransferIds) await expectConsistent(id);
  });
});
