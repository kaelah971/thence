/**
 * P6 — automatic server-side reconciliation.
 *
 * Pure tests for scheduling/priority/auth, then live tests against the
 * ISOLATED test database (anchor-proven; never production). Payments are
 * built through the real routes (create → prepare → attach → authorize) with
 * the provider mocked from the REAL 2026-11-02 evidence: 077770a1's hash
 * lock, HTLC and on-chain refund receipt (served by a fixture chain), and
 * eddaa6de's terminal `expired` shape. After setup NO owner session call is
 * made unless a test says so — the cron runs with the browser closed.
 *
 * Every run is scoped to the test's own transfers and a unique lease name,
 * so it never touches unrelated rows in the shared test database.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import fixture from "./fixtures/incidents-2026-11-02.json";
import { getDb } from "@/lib/db";
import { reconciliationObservations, swapAttachments, transferTransitions, transfers, users } from "@/db/schema";
import { setSatoraFetchersForTests, SATORA_READ_TIMEOUT_MS } from "@/lib/satora";
import { setSettlementChainForTests, type ChainReads } from "@/lib/settlement";
import {
  dueIntervalMs,
  isDue,
  isWellFormedProviderSwapId,
  priorityOrder,
  runServerReconciliation,
  setCronRunOptionsForTests,
  verifyCronAuthorization,
  type Candidate,
} from "@/lib/server-reconciler";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { GET as cronGet } from "../app/api/cron/reconcile/route";

const INC = fixture.incident_077770a1;
const REAL_HASH_LOCK = INC.attachment.payment_hash;
const REAL_HTLC = INC.satora.getSwap.evm_htlc_address;
const REAL_FUND_TX = INC.satora.getSwap.evm_fund_txid as string;
const REAL_REFUND_TX = INC.satora.getSwap.evm_claim_txid as string;
const EVM_A = "0x0000000000000000000000000000000000000001";

/* ======================= pure ======================= */

const base = (over: Partial<Candidate>): Candidate => ({
  transferId: "t",
  status: "SERVER_FUNDED",
  claimDeadline: null,
  invoiceExpiresAt: null,
  lastObservedAt: null,
  lastProviderStatus: null,
  lastKind: null,
  ...over,
});

describe("P6 scheduling rules (pure)", () => {
  const now = Date.parse("2026-11-02T21:30:26.000Z");
  const deadline = new Date(INC.satora.getSwap.evm_refund_locktime * 1000);

  it("never-observed transfers are due immediately; funded ones every minute while claimable", () => {
    expect(isDue(base({}), now)).toBe(true);
    expect(dueIntervalMs(base({ claimDeadline: deadline }), now)).toBe(60_000);
    expect(isDue(base({ claimDeadline: deadline, lastObservedAt: new Date(now - 30_000) }), now)).toBe(false);
    expect(isDue(base({ claimDeadline: deadline, lastObservedAt: new Date(now - 61_000) }), now)).toBe(true);
    // After the deadline: slower (2 min), watching for the provider refund.
    expect(dueIntervalMs(base({ claimDeadline: deadline }), deadline.getTime() + 1)).toBe(120_000);
  });

  it("terminal-looking provider expiry slows to 6 h; failed reads back off to >= 5 min", () => {
    expect(dueIntervalMs(base({ status: "RECONCILING", lastProviderStatus: "expired", lastKind: "observation" }), now)).toBe(6 * 3600_000);
    expect(dueIntervalMs(base({ status: "OUTCOME_UNKNOWN", lastKind: "provider_error", invoiceExpiresAt: new Date(now + 60_000) }), now)).toBe(5 * 60_000);
    expect(dueIntervalMs(base({ status: "LIGHTNING_HANDOFF", invoiceExpiresAt: new Date(now + 60_000) }), now)).toBe(2 * 60_000);
    expect(dueIntervalMs(base({ status: "LIGHTNING_HANDOFF", invoiceExpiresAt: new Date(now - 60_000) }), now)).toBe(10 * 60_000);
  });

  it("priority: open claim windows by soonest deadline first (P2), then funded, then uncertain", () => {
    const soon = base({ transferId: "soon", claimDeadline: new Date(now + 10 * 60_000) });
    const later = base({ transferId: "later", claimDeadline: new Date(now + 50 * 60_000) });
    const uncertain = base({ transferId: "unk", status: "OUTCOME_UNKNOWN", lastObservedAt: new Date(0) });
    const awaiting = base({ transferId: "await", status: "AWAITING_NIM_APPROVAL" });
    const order = [awaiting, uncertain, later, soon].sort((a, b) => priorityOrder(a, b, now)).map((c) => c.transferId);
    expect(order).toEqual(["soon", "later", "unk", "await"]);
  });

  it("cron authentication is fail-closed and exact", () => {
    const secret = "s".repeat(40);
    expect(verifyCronAuthorization(`Bearer ${secret}`, undefined)).toBe("not-configured");
    expect(verifyCronAuthorization(`Bearer short`, "short")).toBe("not-configured");
    expect(verifyCronAuthorization(null, secret)).toBe("unauthorized");
    expect(verifyCronAuthorization(secret, secret)).toBe("unauthorized");
    expect(verifyCronAuthorization(`Bearer ${secret}x`, secret)).toBe("unauthorized");
    expect(verifyCronAuthorization(`Bearer ${secret}`, secret)).toBe("ok");
  });

  it("provider swap ids: only well-formed UUIDs are scheduled (pre-S0 synthetic ids are not)", () => {
    // Real provider ids (eddaa6de/077770a1 shape) and any UUID version/case.
    expect(isWellFormedProviderSwapId("5cc444f5-6a1b-4c2d-8e3f-0123456789ab")).toBe(true);
    expect(isWellFormedProviderSwapId("5CC444F5-6A1B-4C2D-8E3F-0123456789AB")).toBe(true);
    expect(isWellFormedProviderSwapId(randomUUID())).toBe(true);
    // Synthetic shapes found in production (rejected by the provider: "UUID parsing failed").
    for (const bad of ["swap-11111111-2222-3333-4444-555555555555", "p6-swap-abcd-tag", "e2e-0123456789abcdef", "swap-test-1", "", " 5cc444f5-6a1b-4c2d-8e3f-0123456789ab", "5cc444f5-6a1b-4c2d-8e3f-0123456789ab\n", "5cc444f56a1b4c2d8e3f0123456789ab"]) {
      expect(isWellFormedProviderSwapId(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isWellFormedProviderSwapId(null)).toBe(false);
    expect(isWellFormedProviderSwapId(undefined)).toBe(false);
  });
});

/* ======================= live (isolated test DB) ======================= */

const createdUserIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `p6-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const nowSec = () => Math.floor(Date.now() / 1000);

afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  setCronRunOptionsForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

/** Real public Polygon evidence for 077770a1 (receipts + block hashes). */
function fixtureChain(): ChainReads {
  const receipts = INC.polygon.receipts as Record<string, (typeof INC.polygon.receipts)[keyof typeof INC.polygon.receipts]>;
  const blocks = INC.polygon.blocks as Record<string, { hash: string }>;
  return {
    async getTransaction(_c, hash) {
      const r = receipts[hash.toLowerCase()];
      return r ? { hash, blockNumber: BigInt(r.blockNumber) } : null;
    },
    async getReceipt(_c, hash) {
      const r = receipts[hash.toLowerCase()];
      return r
        ? { status: r.status as "success", blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) }
        : null;
    },
    async getLatestBlockNumber() {
      return BigInt(fixture._meta.polygonLatestBlockAtCapture);
    },
    async getFinalizedBlockNumber() {
      return BigInt(fixture._meta.polygonLatestBlockAtCapture) - 300n;
    },
    async getBlockHash(_c, n) {
      return blocks[n.toString()]?.hash ?? null;
    },
  };
}

type Behavior = Record<string, unknown> | "timeout" | "unavailable";
const provider = new Map<string, Behavior>();
function installProvider(): void {
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      const b = provider.get(id);
      if (b === undefined) throw Object.assign(new Error("not found"), { code: 404 });
      if (b === "timeout") return new Promise<never>(() => undefined);
      if (b === "unavailable") throw new Error("provider down");
      return { ...b, id };
    },
  });
}

/** Satora-shaped swap carrying the REAL 077770a1 hash lock and HTLC. */
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
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
    status: "pending",
    invoice_expires_at: nowSec() + 5400,
    evm_fund_txid: null,
    evm_claim_txid: null,
    fee_sats: 6,
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** Authorized, bound payment (AWAITING_NIM_APPROVAL); returns the swap id for provider scripting. */
async function authorizedPayment(tag: string, swapIdOverride?: string): Promise<{ id: string; cookie: string; swapId: string; sourceSats: string }> {
  const { cookie } = await loginAs(client(`login-${tag}`), (uid) => createdUserIds.push(uid));
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `p6-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  // Provider swap ids are UUIDs (the scheduled reconciler skips anything else).
  const swapId = swapIdOverride ?? randomUUID();
  provider.set(swapId, swapShape(swapId, transfer.quote.sourceSats));
  const attached = await attachPost(
    postJson(`http://localhost/api/transfers/${transfer.id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...client(tag) }),
    params(transfer.id),
  );
  if (attached.status !== 201) throw new Error(`setup attach failed: ${attached.status} ${JSON.stringify(await attached.json())}`);
  const authed = await authorizePost(postJson(`http://localhost/api/transfers/${transfer.id}/authorize-handoff`, { attemptToken: token }, { cookie, ...client(tag) }), params(transfer.id));
  if (authed.status !== 200) throw new Error(`setup authorize failed: ${authed.status}`);
  return { id: transfer.id, cookie, swapId, sourceSats: transfer.quote.sourceSats };
}

const statusOf = async (id: string) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.s;
const transitionsOf = (id: string) => getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, id));
const observationsOf = (id: string) => getDb().select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, id));
/** Make existing observations look old (TEST database only) so the transfer is due again. */
const ageObservations = (id: string, minutes: number) =>
  getDb().execute(sql`UPDATE reconciliation_observations SET observed_at = observed_at - make_interval(mins => ${minutes}) WHERE transfer_id = ${id}::uuid`);
let leaseSeq = 0;
const lease = (tag: string) => `p6-${RUN}-${tag}-${leaseSeq++}`;

let previousRoutes: string | undefined;
let previousRpcs: string | undefined;
beforeEach(() => {
  previousRoutes = process.env["THENCE_ENABLED_ROUTES"];
  previousRpcs = process.env["THENCE_EVM_RPCS_JSON"];
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://fixture.invalid" });
  setSettlementChainForTests(fixtureChain());
  installProvider();
  return () => {
    if (previousRoutes === undefined) delete process.env["THENCE_ENABLED_ROUTES"];
    else process.env["THENCE_ENABLED_ROUTES"] = previousRoutes;
    if (previousRpcs === undefined) delete process.env["THENCE_EVM_RPCS_JSON"];
    else process.env["THENCE_EVM_RPCS_JSON"] = previousRpcs;
  };
});

describe.skipIf(!LIVE)("P6 server reconciliation (isolated test database)", () => {
  it("browser closed: the cron alone advances to SERVER_FUNDED, then to REFUNDED on the REAL verified Polygon refund", async () => {
    const p = await authorizedPayment("closed");
    // Provider funds (real fund tx); nobody has the app open.
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    const run1 = await runServerReconciliation({ scope: [p.id], leaseName: lease("closed") });
    expect(run1).toMatchObject({ outcome: "completed", reconciled: 1, advanced: [{ transferId: p.id, from: "AWAITING_NIM_APPROVAL", to: "SERVER_FUNDED" }] });
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    // P5: attach/authorize are audited too (owner rows); this asserts the cron's own hops.
    const audit1 = (await transitionsOf(p.id)).filter((r) => r.actor === "reconciler");
    expect(audit1.map((r) => r.toStatus)).toEqual(["LIGHTNING_HANDOFF", "CLIENT_FUNDED", "SERVER_FUNDED"]);
    for (const row of audit1) {
      expect(row).toMatchObject({ actor: "reconciler", actorUserId: null });
      expect((row.evidence as Record<string, unknown>)["trigger"]).toBe("server-cron");
    }
    // Deadline passes unclaimed; Satora refunds with the REAL refund tx (reported in evm_claim_txid).
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "clientfundedserverrefunded", evm_fund_txid: REAL_FUND_TX, evm_claim_txid: REAL_REFUND_TX }));
    await ageObservations(p.id, 10);
    const run2 = await runServerReconciliation({ scope: [p.id], leaseName: lease("closed") });
    expect(run2.advanced).toEqual([{ transferId: p.id, from: "SERVER_FUNDED", to: "REFUNDED" }]);
    expect(await statusOf(p.id)).toBe("REFUNDED");
    const terminal = (await transitionsOf(p.id)).filter((r) => r.terminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ toStatus: "REFUNDED", reasonCode: "PROVIDER_CLIENTFUNDEDSERVERREFUNDED" });
    expect((terminal[0]!.evidence as Record<string, unknown>)["refundVerified"]).toBe(true);
    // Terminal: no longer a candidate.
    const run3 = await runServerReconciliation({ scope: [p.id], leaseName: lease("closed") });
    expect(run3.candidates).toBe(0);
  });

  it("an unverifiable refund (receipt from another HTLC) is NOT released by the cron", async () => {
    const p = await authorizedPayment("unverified");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    await runServerReconciliation({ scope: [p.id], leaseName: lease("unverified") });
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, {
      status: "clientfundedserverrefunded", evm_fund_txid: REAL_FUND_TX, evm_claim_txid: REAL_REFUND_TX,
      evm_htlc_address: "0x0000000000000000000000000000000000000003",
    }));
    await ageObservations(p.id, 10);
    const run = await runServerReconciliation({ scope: [p.id], leaseName: lease("unverified") });
    expect(run.errors).toMatchObject({ REFUND_INVALID: 1 });
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    expect((await transitionsOf(p.id)).filter((r) => r.terminal)).toHaveLength(0);
  });

  it("uncertain outcome + provider 'expired' (eddaa6de shape): observed, never closed by the cron; then slowed to 6 h", async () => {
    const p = await authorizedPayment("uncertain");
    const unknown = await reportPost(postJson(`http://localhost/api/transfers/${p.id}/handoff-result`, { outcome: "unknown" }, { cookie: p.cookie, ...client("uncertain") }), params(p.id));
    expect(unknown.status).toBe(200);
    expect(await statusOf(p.id)).toBe("RECONCILING");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "expired", invoice_expires_at: nowSec() - 3600 }));
    const run = await runServerReconciliation({ scope: [p.id], leaseName: lease("uncertain") });
    expect(run.reconciled).toBe(1);
    expect(run.advanced).toEqual([]);
    // P4's owner-only, evidence-gated close is never applied automatically.
    expect(await statusOf(p.id)).toBe("RECONCILING");
    expect((await transitionsOf(p.id)).filter((r) => r.terminal)).toHaveLength(0);
    expect((await observationsOf(p.id)).some((o) => o.providerStatus === "expired")).toBe(true);
    // An hour later it is still not due (6 h lane): no wasted provider calls.
    await ageObservations(p.id, 60);
    const later = await runServerReconciliation({ scope: [p.id], leaseName: lease("uncertain") });
    expect(later).toMatchObject({ candidates: 1, due: 0, reconciled: 0 });
  });

  it(`provider timeout (${SATORA_READ_TIMEOUT_MS / 1000} s) is isolated: recorded, counted, and the rest of the batch proceeds`, async () => {
    const slow = await authorizedPayment("timeout");
    const healthy = await authorizedPayment("healthy");
    provider.set(slow.swapId, "timeout");
    provider.set(healthy.swapId, swapShape(healthy.swapId, healthy.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    const run = await runServerReconciliation({ scope: [slow.id, healthy.id], leaseName: lease("timeout"), timeBudgetMs: 60_000 });
    expect(run.reconciled).toBe(2);
    expect(Object.keys(run.errors)).toEqual(["PROVIDER_TIMEOUT"]);
    expect(await statusOf(slow.id)).toBe("AWAITING_NIM_APPROVAL");
    expect(await statusOf(healthy.id)).toBe("SERVER_FUNDED");
    const errs = (await observationsOf(slow.id)).filter((o) => o.kind === "provider_error");
    expect(errs.map((o) => o.errorCode)).toEqual(["PROVIDER_TIMEOUT"]);
    // Backoff: a failed read is not retried for >= 5 min.
    await ageObservations(slow.id, 2);
    const again = await runServerReconciliation({ scope: [slow.id], leaseName: lease("timeout") });
    expect(again.due).toBe(0);
  }, 120_000);

  it("duplicate cron deliveries: concurrent runs → one runs, one skips; an immediate repeat is skipped; one transition only", async () => {
    const p = await authorizedPayment("dup");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    const name = lease("dup");
    const [a, b] = await Promise.all([
      runServerReconciliation({ scope: [p.id], leaseName: name }),
      runServerReconciliation({ scope: [p.id], leaseName: name }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["completed", "skipped"]);
    expect([a, b].find((r) => r.outcome === "skipped")?.skipReason).toBe("lease-held");
    const repeat = await runServerReconciliation({ scope: [p.id], leaseName: name });
    expect(repeat).toMatchObject({ outcome: "skipped", skipReason: "too-soon" });
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    expect((await transitionsOf(p.id)).filter((r) => r.toStatus === "SERVER_FUNDED")).toHaveLength(1);
  });

  it("stale vs fresh observations: recently observed transfers are not due; identical reads within 60 s are not duplicated", async () => {
    const p = await authorizedPayment("fresh");
    // Owner's browser reconciles twice in quick succession (P1 driver).
    for (let i = 0; i < 2; i++) {
      const res = await reconcilePost(postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client("fresh") }), params(p.id));
      expect(res.status).toBe(200);
    }
    expect((await observationsOf(p.id)).filter((o) => o.providerStatus === "pending")).toHaveLength(1);
    // Fresh observation: the cron leaves it alone (no duplicate provider call).
    const skip = await runServerReconciliation({ scope: [p.id], leaseName: lease("fresh") });
    expect(skip).toMatchObject({ candidates: 1, due: 0, reconciled: 0 });
    // Stale: due again.
    await ageObservations(p.id, 30);
    const due = await runServerReconciliation({ scope: [p.id], leaseName: lease("fresh") });
    expect(due).toMatchObject({ due: 1, reconciled: 1 });
  });

  it("P1 browser driver and P6 cron racing on the same payment produce exactly one transition", async () => {
    const p = await authorizedPayment("race");
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    const [ownerRes, cron] = await Promise.all([
      reconcilePost(postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client("race") }), params(p.id)),
      runServerReconciliation({ scope: [p.id], leaseName: lease("race") }),
    ]);
    expect(ownerRes.status).toBe(200);
    expect(cron.outcome).toBe("completed");
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    const rows = (await transitionsOf(p.id)).filter((r) => r.actor === "reconciler");
    expect(rows.map((r) => r.toStatus).sort()).toEqual(["CLIENT_FUNDED", "LIGHTNING_HANDOFF", "SERVER_FUNDED"]);
  });

  it("P2: the cron backfills a missing claim deadline only after identity verification", async () => {
    const p = await authorizedPayment("backfill");
    const locktime = nowSec() + 3500;
    provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { evm_refund_locktime: locktime }));
    await runServerReconciliation({ scope: [p.id], leaseName: lease("backfill") });
    const stored = (await getDb().select({ d: swapAttachments.evmRefundLocktime }).from(swapAttachments).where(eq(swapAttachments.transferId, p.id)))[0]?.d;
    expect(stored?.getTime()).toBe(locktime * 1000);
  });

  it("cron route: fail-closed auth (503 unconfigured, 401 wrong secret), then a scoped authenticated run", async () => {
    const p = await authorizedPayment("route");
    const previous = process.env["CRON_SECRET"];
    try {
      delete process.env["CRON_SECRET"];
      const unconfigured = await cronGet(new Request("http://localhost/api/cron/reconcile", { headers: { authorization: "Bearer anything" } }));
      expect(unconfigured.status).toBe(503);
      const secret = `cron-${RUN}-${"x".repeat(40)}`;
      process.env["CRON_SECRET"] = secret;
      const wrong = await cronGet(new Request("http://localhost/api/cron/reconcile", { headers: { authorization: `Bearer ${secret}-nope` } }));
      expect(wrong.status).toBe(401);
      setCronRunOptionsForTests({ scope: [p.id], leaseName: lease("route") });
      const ok = await cronGet(new Request("http://localhost/api/cron/reconcile", { headers: { authorization: `Bearer ${secret}` } }));
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { reconciler: Record<string, unknown> };
      expect(body.reconciler).toMatchObject({ outcome: "completed", candidates: 1, reconciled: 1 });
      const text = JSON.stringify(body);
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/lnbc|0x[0-9a-f]{64}|postgres/i);
    } finally {
      setCronRunOptionsForTests(null);
      if (previous === undefined) delete process.env["CRON_SECRET"];
      else process.env["CRON_SECRET"] = previous;
    }
  });

  it("never reaches money-moving paths: only provider reads and chain reads occur", async () => {
    const p = await authorizedPayment("readonly");
    const calls: string[] = [];
    setSatoraFetchersForTests({
      getSwap: async (id: string) => {
        calls.push(`getSwap:${id === p.swapId}`);
        return { ...swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }), id };
      },
    });
    await runServerReconciliation({ scope: [p.id], leaseName: lease("readonly") });
    expect(calls).toEqual(["getSwap:true"]);
    // Funded and claim-ready, yet no claim is attempted server-side (there is no such path).
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    const attempts = await getDb().execute(sql`SELECT status FROM handoff_attempts WHERE transfer_id = ${p.id}::uuid`);
    expect((attempts as unknown as { rows: Array<{ status: string }> }).rows.map((r) => r.status)).toEqual(["HANDOFF_AUTHORIZED"]);
    void and;
  });

  /* ---- pre-S0 synthetic history (production had 33 such rows) ---- */

  /** Bind a swap with a non-UUID id exactly like the pre-S0 test rows (TEST database, mocked provider). */
  async function syntheticPayment(tag: string): Promise<{ id: string; swapId: string }> {
    const swapId = `swap-${RUN}-${tag}-1111-2222-3333`;
    const p = await authorizedPayment(tag, swapId);
    return { id: p.id, swapId };
  }

  it("synthetic non-UUID swaps are excluded and counted; untouched across repeated runs; UUID swaps still reconcile", async () => {
    const synth = await syntheticPayment("synth");
    const real = await authorizedPayment("real-uuid");
    expect(isWellFormedProviderSwapId(real.swapId)).toBe(true);
    provider.set(real.swapId, swapShape(real.swapId, real.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    const providerReads: string[] = [];
    setSatoraFetchersForTests({
      getSwap: async (id: string) => {
        providerReads.push(id);
        const b = provider.get(id);
        if (b === undefined || typeof b === "string") throw Object.assign(new Error("not found"), { code: 404 });
        return { ...b, id };
      },
    });
    const statusBefore = await statusOf(synth.id);
    const obsBefore = (await observationsOf(synth.id)).length;
    const transitionsBefore = (await transitionsOf(synth.id)).length; // setup (attach/authorize) audit rows

    const run = await runServerReconciliation({ scope: [synth.id, real.id], leaseName: lease("synth") });
    expect(run).toMatchObject({ outcome: "completed", candidates: 1, excludedMalformedSwapIds: 1, due: 1, reconciled: 1 });
    expect(run.advanced).toEqual([{ transferId: real.id, from: "AWAITING_NIM_APPROVAL", to: "SERVER_FUNDED" }]);
    expect(await statusOf(real.id)).toBe("SERVER_FUNDED");
    // Historical row: never read from the provider, never written to.
    expect(providerReads).not.toContain(synth.swapId);
    expect(await statusOf(synth.id)).toBe(statusBefore);
    expect((await observationsOf(synth.id)).length).toBe(obsBefore);
    expect(await transitionsOf(synth.id)).toHaveLength(transitionsBefore);
    // Summary is counts + ids of reconciled rows only (no swap ids, hashes or invoices).
    expect(JSON.stringify(run)).not.toContain(synth.swapId);
    expect(JSON.stringify(run)).not.toContain(real.swapId);

    // Retry behaviour: later runs (both made due again) still never touch the synthetic row.
    for (let i = 0; i < 2; i++) {
      await ageObservations(real.id, 30);
      const again = await runServerReconciliation({ scope: [synth.id, real.id], leaseName: lease("synth") });
      expect(again).toMatchObject({ candidates: 1, excludedMalformedSwapIds: 1 });
    }
    expect(providerReads).not.toContain(synth.swapId);
    expect((await observationsOf(synth.id)).length).toBe(obsBefore);
    expect(await transitionsOf(synth.id)).toHaveLength(transitionsBefore);
    installProvider();
  }, 240_000);

  it("deadline priority: a claimable UUID swap closest to its deadline wins the only slot; synthetic funded rows never take it", async () => {
    const synth = await syntheticPayment("prio-synth");
    const soon = await authorizedPayment("prio-soon");
    const later = await authorizedPayment("prio-later");
    for (const p of [soon, later]) provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: REAL_FUND_TX }));
    const setup = await runServerReconciliation({ scope: [soon.id, later.id], leaseName: lease("prio-setup") });
    expect(setup.advanced.map((a) => a.to).sort()).toEqual(["SERVER_FUNDED", "SERVER_FUNDED"]);
    // TEST database only: model a pre-S0 synthetic row stuck in a funded state with the
    // EARLIEST deadline, and two genuine claimable swaps with open windows.
    const at = (minutesFromNow: number) => new Date(Date.now() + minutesFromNow * 60_000);
    await getDb().update(transfers).set({ status: "SERVER_FUNDED" }).where(eq(transfers.id, synth.id));
    await getDb().update(swapAttachments).set({ evmRefundLocktime: at(12) }).where(eq(swapAttachments.transferId, synth.id));
    await getDb().update(swapAttachments).set({ evmRefundLocktime: at(25) }).where(eq(swapAttachments.transferId, soon.id));
    await getDb().update(swapAttachments).set({ evmRefundLocktime: at(50) }).where(eq(swapAttachments.transferId, later.id));
    await ageObservations(soon.id, 30);
    await ageObservations(later.id, 30);
    const before = { soon: (await observationsOf(soon.id)).length, later: (await observationsOf(later.id)).length, synth: (await observationsOf(synth.id)).length };

    const run = await runServerReconciliation({ scope: [synth.id, soon.id, later.id], leaseName: lease("prio"), maxTransfers: 1 });
    expect(run).toMatchObject({ candidates: 2, excludedMalformedSwapIds: 1, due: 2, reconciled: 1 });
    expect((await observationsOf(soon.id)).length).toBe(before.soon + 1);
    expect((await observationsOf(later.id)).length).toBe(before.later);
    expect((await observationsOf(synth.id)).length).toBe(before.synth);
  }, 240_000);

  it("lease safety with excluded rows: concurrent deliveries still run once; the excluded count is reported by the run that ran", async () => {
    const synth = await syntheticPayment("lease-synth");
    const real = await authorizedPayment("lease-real");
    const name = lease("lease-synth");
    const [a, b] = await Promise.all([
      runServerReconciliation({ scope: [synth.id, real.id], leaseName: name }),
      runServerReconciliation({ scope: [synth.id, real.id], leaseName: name }),
    ]);
    const ran = [a, b].find((r) => r.outcome === "completed");
    const skipped = [a, b].find((r) => r.outcome === "skipped");
    expect(ran).toMatchObject({ candidates: 1, excludedMalformedSwapIds: 1 });
    expect(skipped).toMatchObject({ skipReason: "lease-held", candidates: 0, excludedMalformedSwapIds: 0 });
    expect(await runServerReconciliation({ scope: [synth.id, real.id], leaseName: name })).toMatchObject({ outcome: "skipped", skipReason: "too-soon" });
  }, 120_000);
});
