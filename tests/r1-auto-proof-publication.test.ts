/**
 * R1 — automatic Global Proof Feed publication, end to end against the
 * ISOLATED test database (anchor-proven; never production).
 *
 * Pipeline under test, through the real route handlers:
 *   Nimiq Pay handoff (host hash = untrusted hint)
 *   → independent Nimiq source verification (mocked Nimiq RPC)
 *   → Satora settlement (mocked provider)
 *   → independent Polygon USDC delivery verification (synthetic chain)
 *   → DELIVERED (My Activity receipt)
 *   → Global Proof Feed (`/api/proofs` publication query).
 *
 * No wallet, invoice, swap, claim or refund exists anywhere: every provider,
 * Nimiq and Polygon read is a test-seam fixture.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import fixture from "./fixtures/incidents-2026-11-02.json";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { transferProofs, transferTransitions, transfers, users } from "@/db/schema";
import { getPublicProof, listPublicProofs, publicProofConfig } from "@/lib/global-proofs";
import { nimiqBase32Decode } from "@/lib/nimiq";
import { deriveNimiqHtlcCreationAddress, setNimiqSourceRpcTransportForTests } from "@/lib/nimiq-source";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { runServerReconciliation } from "@/lib/server-reconciler";
import { SOURCE_RETRY_WINDOW_MS } from "@/lib/reconcile";
import { TRANSFER_EVENT_TOPIC, setSettlementChainForTests, type ChainLog, type ChainReads } from "@/lib/settlement";
import { checkTransferConsistency, readConsistencySnapshot } from "@/lib/consistency";
import { LIVE, RUN, fixtureWallet, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as verifySettlementPost } from "../app/api/transfers/[id]/verify-settlement/route";
import { GET as receiptGet } from "../app/api/transfers/[id]/receipt/route";
import { GET as reconciliationGet } from "../app/api/transfers/[id]/reconciliation/route";

const INC = fixture.incident_077770a1;
const HASH_LOCK = INC.attachment.payment_hash;
const HTLC = INC.satora.getSwap.evm_htlc_address;
const FUND_TX = INC.satora.getSwap.evm_fund_txid as string;
const SCAN = INC.polygonHtlcScan;
const EVM_A = "0x0000000000000000000000000000000000000001";
const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();
const h = (s: string) => createHash("sha256").update(`r1-${RUN}-${s}`).digest("hex");

/* ------------------------- synthetic Polygon chain ------------------------- */

const CLAIM_BLOCK = BigInt(SCAN.toBlock) - 400n;
const CLAIM_BLOCK_HASH = `0x${"c2".repeat(32)}`;
const claimTxs = new Set<string>();
function chain(): ChainReads {
  return {
    async getTransaction(_c, hash) {
      return claimTxs.has(hash.toLowerCase()) ? { hash, blockNumber: CLAIM_BLOCK } : null;
    },
    async getReceipt(_c, hash) {
      if (!claimTxs.has(hash.toLowerCase())) return null;
      return {
        status: "success" as const,
        blockNumber: CLAIM_BLOCK,
        blockHash: CLAIM_BLOCK_HASH,
        logs: [{ address: USDC_POLYGON, topics: [TRANSFER_EVENT_TOPIC, pad(HTLC), pad(EVM_A)], data: "0x" + (300000).toString(16).padStart(64, "0"), logIndex: 3 }],
      };
    },
    async getLatestBlockNumber() { return BigInt(SCAN.toBlock); },
    async getFinalizedBlockNumber() { return BigInt(SCAN.toBlock) - 300n; },
    async getBlockHash(_c, n) { return n === CLAIM_BLOCK ? CLAIM_BLOCK_HASH : `0x${n.toString(16).padStart(64, "0")}`; },
    async getBlockTimestamp() { return Math.floor(Date.now() / 1000) - 600; },
    async getLogsByTopic1(): Promise<ChainLog[]> { return []; },
  };
}

/* --------------------------- mocked Nimiq RPC ------------------------------ */

const NIM_TX_BLOCK = 3_456_001;
const NIM_MACRO_BLOCK = 3_456_060;
const HTLC_RECIPIENT_BYTES = Buffer.from("33445566778899aabbccddeeff00112233445566", "hex");

/** Nimiq node state per source tx hash: `final` = closing macro block exists. */
const nimTxs = new Map<string, { tx: Record<string, unknown>; final: boolean; indexed?: boolean }>();
let nimCalls = 0;

/** A native NIM HTLC funding tx from `owner`, hash-locked to the bound Lightning payment hash. */
function nimHtlcFunding(owner: string, txHash: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const ownerBytes = nimiqBase32Decode(owner.replace(/ /g, "").slice(4));
  const data = Buffer.alloc(82);
  ownerBytes.copy(data, 0);
  HTLC_RECIPIENT_BYTES.copy(data, 20);
  data[40] = 3;
  Buffer.from(HASH_LOCK.replace(/^0x/, ""), "hex").copy(data, 41);
  data[73] = 1;
  data.writeBigUInt64BE(9007199254740993n, 74);
  const to = deriveNimiqHtlcCreationAddress({
    data, senderAddress: owner, senderType: 0, recipientType: 2, value: 100000n, fee: 100n,
    validityStartHeight: 100, networkId: 24, flags: 1, senderData: new Uint8Array(0),
  });
  return {
    hash: txHash, blockNumber: NIM_TX_BLOCK, confirmations: 12, from: owner, fromType: 0, to, toType: 2,
    value: "100000", fee: "100", recipientData: data.toString("hex"), senderData: "", flags: 1,
    executionResult: true, networkId: 24, validityStartHeight: 100, ...over,
  };
}

function installNimiqRpc(): void {
  setNimiqSourceRpcTransportForTests(async (_url, body) => {
    nimCalls++;
    const req = JSON.parse(body) as { method: string; params: unknown[] };
    if (req.method === "getTransactionByHash") {
      const s = nimTxs.get(String(req.params[0]));
      // R1.1: what the Nimiq node really answers for a hash it has not indexed yet.
      if (s?.indexed === false) return { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: `Transaction not found: ${String(req.params[0])}` } };
      return { jsonrpc: "2.0", id: 1, result: { data: s ? { ...s.tx, confirmations: s.final ? 12 : 2 } : null } };
    }
    const anyFinal = [...nimTxs.values()].some((s) => s.final);
    return {
      jsonrpc: "2.0",
      id: 1,
      result: {
        data: anyFinal && req.params[0] === NIM_MACRO_BLOCK
          ? { type: "macro", number: NIM_MACRO_BLOCK, network: "MainAlbatross", justification: { round: 0, sig: { signature: { signature: "00" }, signers: [0] } } }
          : null,
      },
    };
  });
}

/* ----------------------------- mocked provider ----------------------------- */

const provider = new Map<string, Record<string, unknown>>();
function swapShape(id: string, sourceSats: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, direction: "lightning_to_evm", bolt11_invoice: "lnbc3980n1p4testinvoice", hash_lock: HASH_LOCK,
    source_amount: sourceSats, target_amount: "300000", evm_chain_id: 137, evm_htlc_address: HTLC,
    target_evm_address: EVM_A,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC_POLYGON },
    status: "pending", invoice_expires_at: Math.floor(Date.now() / 1000) + 5400,
    evm_fund_txid: null, evm_claim_txid: null, fee_sats: 6, created_at: new Date().toISOString(), ...over,
  };
}

/* ------------------------------- live helpers ------------------------------ */

const createdUserIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `r1-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
interface Paid { id: string; cookie: string; owner: string; swapId: string; sourceSats: string; tag: string; claimTx: string }

/** create → prepare → attach → authorize through the real routes (mocked provider). */
async function authorized(tag: string, wallet: ReturnType<typeof fixtureWallet> = fixtureWallet()): Promise<Paid> {
  const { cookie, address } = await loginAs(client(`login-${tag}`), (uid) => createdUserIds.push(uid), wallet);
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `r1-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  const swapId = randomUUID();
  provider.set(swapId, swapShape(swapId, transfer.quote.sourceSats));
  const a = await attachPost(postJson(`http://localhost/api/transfers/${transfer.id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...client(tag) }), params(transfer.id));
  if (a.status !== 201) throw new Error(`attach failed: ${a.status} ${JSON.stringify(await a.json())}`);
  const z = await authorizePost(postJson(`http://localhost/api/transfers/${transfer.id}/authorize-handoff`, { attemptToken: token }, { cookie, ...client(tag) }), params(transfer.id));
  if (z.status !== 200) throw new Error(`authorize failed: ${z.status}`);
  const claimTx = `0x${h(`claim-${tag}`)}`;
  claimTxs.add(claimTx);
  return { id: transfer.id, cookie, owner: address, swapId, sourceSats: transfer.quote.sourceSats, tag, claimTx };
}

const report = (p: Paid, outcome: string, sourceTxHash?: string) =>
  reportPost(postJson(`http://localhost/api/transfers/${p.id}/handoff-result`, { outcome, ...(sourceTxHash ? { sourceTxHash } : {}) }, { cookie: p.cookie, ...client(p.tag) }), params(p.id));
const reconcile = (p: Paid) => reconcilePost(postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client(p.tag) }), params(p.id));
const verifySettlement = (p: Paid) => verifySettlementPost(postJson(`http://localhost/api/transfers/${p.id}/verify-settlement`, {}, { cookie: p.cookie, ...client(p.tag) }), params(p.id));
const fundOnProvider = (p: Paid) => provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "serverfunded", evm_fund_txid: FUND_TX }));
const settleOnProvider = (p: Paid) => provider.set(p.swapId, swapShape(p.swapId, p.sourceSats, { status: "clientredeemed", evm_fund_txid: FUND_TX, evm_claim_txid: p.claimTx }));

/** Owner path: handoff (with optional host hash) → funded → settled → DELIVERED. */
async function deliverViaOwner(p: Paid, sourceTxHash: string | undefined, beforeSettle?: () => void): Promise<void> {
  expect((await report(p, "initiated", sourceTxHash)).status).toBe(200);
  fundOnProvider(p);
  beforeSettle?.();
  expect((await reconcile(p)).status).toBe(200);
  expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
  settleOnProvider(p);
  expect((await verifySettlement(p)).status).toBe(200);
  expect(await statusOf(p.id)).toBe("DELIVERED");
}

const statusOf = async (id: string) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.s;
const proofRow = async (id: string) => (await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id)))[0];
const markers = async (id: string) =>
  (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, id)).orderBy(asc(transferTransitions.createdAt), asc(transferTransitions.id)))
    .map((t) => (t.evidence as Record<string, unknown>)["nimiqSourceVerification"])
    .filter((v) => v !== undefined);
const failures = async (id: string) =>
  (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, id)))
    .map((t) => (t.evidence as Record<string, unknown>)["nimiqSourceFailure"])
    .filter((v) => v !== undefined);
const config = () => publicProofConfig({ routeTokens: getEnv().THENCE_ROUTE_TOKENS_JSON, finalityPolicies: getEnv().THENCE_SETTLEMENT_FINALITY_JSON });
async function published(id: string) {
  const row = await proofRow(id);
  return row ? getPublicProof(row.id, config()) : null;
}
async function expectConsistent(id: string): Promise<void> {
  const snapshot = await readConsistencySnapshot(getDb(), id);
  expect(checkTransferConsistency(snapshot!, { requireAudit: true })).toEqual([]);
}
const ageObservations = (id: string, minutes: number) =>
  getDb().execute(sql`UPDATE reconciliation_observations SET observed_at = observed_at - make_interval(mins => ${minutes}) WHERE transfer_id = ${id}::uuid`);
let leaseSeq = 0;
const lease = (tag: string) => `r1-${RUN}-${tag}-${leaseSeq++}`;

let previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["THENCE_ENABLED_ROUTES", "THENCE_EVM_RPCS_JSON", "THENCE_NIMIQ_PROOF_RPC_URL", "THENCE_NIMIQ_NETWORK"];
beforeEach(() => {
  previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://fixture.invalid" });
  process.env["THENCE_NIMIQ_PROOF_RPC_URL"] = "https://nimiq-proof.fixture.invalid/rpc";
  process.env["THENCE_NIMIQ_NETWORK"] = "mainnet";
  setSettlementChainForTests(chain());
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      const s = provider.get(id);
      if (!s) throw Object.assign(new Error("not found"), { code: 404 });
      return { ...s, id };
    },
  });
  installNimiqRpc();
  nimCalls = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
});
afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  setNimiqSourceRpcTransportForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

describe.skipIf(!LIVE)("R1 automatic Global Proof Feed publication (isolated test database)", { timeout: 240_000 }, () => {
  it("a NIM payment already final at handoff publishes on delivery with both independently verified legs", async () => {
    const p = await authorized("final");
    const nimHash = h("nim-final");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: true });
    await deliverViaOwner(p, nimHash);

    expect(await markers(p.id)).toEqual(["VERIFIED"]);
    const view = await published(p.id);
    expect(view).not.toBeNull();
    expect(view).toMatchObject({ status: "DELIVERED" });
    const json = JSON.stringify(view);
    expect(json).toContain(nimHash);
    expect(json).toContain(p.claimTx);
    expect(json.toLowerCase()).toContain(EVM_A.toLowerCase());
    // The verifying RPC host is recorded at verification time and disclosed by name (no operator claim for unknown hosts).
    expect(view!.method.sourceRpc).toBe("nimiq-proof.fixture.invalid");
    // My Activity: the owner's receipt shows the same verified delivery.
    const receipt = await receiptGet(new Request(`http://localhost/api/transfers/${p.id}/receipt`, { headers: { cookie: p.cookie, ...client("final") } }), params(p.id));
    expect(receipt.status).toBe(200);
    expect(JSON.stringify(await receipt.json())).toContain(p.claimTx);
    await expectConsistent(p.id);
  });

  it("incident 6f44918d: verified NIM source with an unpaid Lightning invoice is reported to the client, and a late provider payment still advances", async () => {
    const p = await authorized("lightning-unpaid");
    const nimHash = h("nim-lightning-unpaid");
    const latest = async () => {
      const res = await reconciliationGet(new Request(`http://localhost/api/transfers/${p.id}/reconciliation`, { headers: { cookie: p.cookie, ...client(p.tag) } }), params(p.id));
      expect(res.status).toBe(200);
      return ((await res.json()) as { latest: { status: string; providerStatus: string; sourceVerifiedAt: string | null; handoffAt: string | null } }).latest;
    };
    // Production shape: the host returned a hash that was not final yet (UNVERIFIED / INSUFFICIENT_FINALITY).
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: false });
    expect((await report(p, "initiated", nimHash)).status).toBe(200);
    let view = await latest();
    expect(view).toMatchObject({ status: "LIGHTNING_HANDOFF", sourceVerifiedAt: null });
    expect(view.handoffAt).not.toBeNull();

    // NIM finalizes; the provider still never sees the Lightning payment.
    nimTxs.set(nimHash, { ...nimTxs.get(nimHash)!, final: true });
    expect((await reconcile(p)).status).toBe(200);
    view = await latest();
    expect(view.status).toBe("LIGHTNING_HANDOFF");
    expect(view.providerStatus).toBe("pending");
    expect(view.sourceVerifiedAt).not.toBeNull();
    expect(await markers(p.id)).toEqual(["UNVERIFIED", "VERIFIED"]);

    // A late provider payment still advances the transfer normally.
    fundOnProvider(p);
    expect((await reconcile(p)).status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    await expectConsistent(p.id);
  });

  it("a NIM payment NOT yet final at handoff still publishes automatically once a later reconcile sees finality", async () => {
    const p = await authorized("late");
    const nimHash = h("nim-late");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: false });
    // Finality arrives after the handoff report, before the next reconcile.
    await deliverViaOwner(p, nimHash, () => nimTxs.set(nimHash, { ...nimTxs.get(nimHash)!, final: true }));

    expect(await markers(p.id)).toEqual(["UNVERIFIED", "VERIFIED"]);
    expect((await proofRow(p.id))?.nimiqTxHash).toBe(nimHash);
    const view = await published(p.id);
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).toContain(nimHash);
    await expectConsistent(p.id);
  });

  it("the server reconciler alone (no owner session after handoff) records late source evidence and delivers to the feed", async () => {
    const p = await authorized("cron");
    const nimHash = h("nim-cron");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: false });
    expect((await report(p, "initiated", nimHash)).status).toBe(200);
    nimTxs.set(nimHash, { ...nimTxs.get(nimHash)!, final: true });
    fundOnProvider(p);
    const run1 = await runServerReconciliation({ scope: [p.id], leaseName: lease("cron") });
    expect(run1.errors).toEqual({});
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    settleOnProvider(p);
    await ageObservations(p.id, 10);
    const run2 = await runServerReconciliation({ scope: [p.id], leaseName: lease("cron") });
    expect(run2.errors).toEqual({});
    expect(await statusOf(p.id)).toBe("DELIVERED");
    expect(await markers(p.id)).toEqual(["UNVERIFIED", "VERIFIED"]);
    expect(await published(p.id)).not.toBeNull();
    await expectConsistent(p.id);
  });

  it("source evidence that never verifies (wrong sender) is delivered privately but never published", async () => {
    const p = await authorized("wrong-sender");
    const nimHash = h("nim-wrong");
    const stranger = "NQ97 6RE8 X2XN 2094 GRU7 BJER GTEK 1BMA 52CC";
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash, { from: stranger }), final: true });
    await deliverViaOwner(p, nimHash);
    expect((await markers(p.id)).every((m) => m === "UNVERIFIED")).toBe(true);
    expect(await published(p.id)).toBeNull();
    // A permanent verifier refusal is not retried every cycle.
    const before = nimCalls;
    await reconcile(p);
    expect(nimCalls).toBe(before);
  });

  it("a NIM hash already attributed to another transfer is never published twice (conflicting source evidence)", async () => {
    // Same owner, two payments: the second reports the FIRST payment's host hash.
    const wallet = fixtureWallet();
    const a = await authorized("dup-a", wallet);
    const nimHash = h("nim-dup");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(a.owner, nimHash), final: true });
    await deliverViaOwner(a, nimHash);
    expect(await published(a.id)).not.toBeNull();
    const b = await authorized("dup-b", wallet);
    expect(b.owner).toBe(a.owner);
    await deliverViaOwner(b, nimHash);
    expect((await proofRow(b.id))?.nimiqTxHash ?? null).toBeNull();
    expect(await markers(b.id)).not.toContain("VERIFIED");
    expect(await published(b.id)).toBeNull();
    expect(await published(a.id)).not.toBeNull();
  }, 240_000);

  it("no host hash: delivered for the owner, absent from the public feed", async () => {
    const p = await authorized("nohash");
    await deliverViaOwner(p, undefined);
    expect(await markers(p.id)).toEqual([]);
    expect(await published(p.id)).toBeNull();
    await expectConsistent(p.id);
  });

  it("publication is idempotent: repeated reconcile, settlement checks and reports never duplicate the proof or marker", async () => {
    const p = await authorized("idem");
    const nimHash = h("nim-idem");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: false });
    await deliverViaOwner(p, nimHash, () => nimTxs.set(nimHash, { ...nimTxs.get(nimHash)!, final: true }));
    const [v1, v2] = await Promise.all([verifySettlement(p), verifySettlement(p)]);
    expect([v1.status, v2.status]).toEqual([200, 200]);
    await reconcile(p);
    expect((await report(p, "initiated", nimHash)).status).toBe(409);
    expect(await markers(p.id)).toEqual(["UNVERIFIED", "VERIFIED"]);
    const rows = await getDb().select().from(transferProofs).where(and(eq(transferProofs.transferId, p.id)));
    expect(rows).toHaveLength(1);
    const feed = await listPublicProofs({ limit: 50, cursor: null }, config());
    expect(feed.proofs.filter((v) => JSON.stringify(v).includes(nimHash))).toHaveLength(1);
    await expectConsistent(p.id);
  });
  it("R1.1: a NIM tx not yet indexed by the proof node at handoff verifies and publishes once the node has it", async () => {
    const p = await authorized("unindexed");
    const nimHash = h("nim-unindexed");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: true, indexed: false });
    await deliverViaOwner(p, nimHash, () => nimTxs.set(nimHash, { ...nimTxs.get(nimHash)!, indexed: true }));
    expect(await failures(p.id)).toEqual(["TRANSACTION_NOT_FOUND"]);
    expect(await markers(p.id)).toEqual(["UNVERIFIED", "VERIFIED"]);
    const view = await published(p.id);
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).toContain(nimHash);
    await expectConsistent(p.id);
  });

  it("R1.1: a hash the node never knows is retried only inside the bounded window, then never again", async () => {
    const p = await authorized("never-indexed");
    const nimHash = h("nim-never");
    nimTxs.set(nimHash, { tx: nimHtlcFunding(p.owner, nimHash), final: true, indexed: false });
    expect((await report(p, "initiated", nimHash)).status).toBe(200);
    expect(await failures(p.id)).toEqual(["TRANSACTION_NOT_FOUND"]);
    // Inside the window: each reconcile re-asks the node (one lookup), records nothing new.
    let before = nimCalls;
    expect((await reconcile(p)).status).toBe(200);
    expect(nimCalls).toBe(before + 1);
    expect(await markers(p.id)).toEqual(["UNVERIFIED"]);
    // Past the window: no more lookups, no new rows.
    await getDb().execute(sql`UPDATE transfer_transitions SET created_at = created_at - make_interval(secs => ${Math.ceil(SOURCE_RETRY_WINDOW_MS / 1000) + 3600}) WHERE transfer_id = ${p.id}::uuid`);
    before = nimCalls;
    expect((await reconcile(p)).status).toBe(200);
    expect((await reconcile(p)).status).toBe(200);
    expect(nimCalls).toBe(before);
    expect(await markers(p.id)).toEqual(["UNVERIFIED"]);
    expect(await published(p.id)).toBeNull();
  });
});
