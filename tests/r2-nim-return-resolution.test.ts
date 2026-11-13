/**
 * R2 — evidence-gated close of a failed Lightning handoff whose NIM returned,
 * end to end against the ISOLATED test database (anchor-proven; never
 * production), through the real route handlers.
 *
 * Each scenario reproduces incident 6f44918d: authorized payment → Nimiq Pay
 * reports a hash → the NIM source verifies on a SIMULATED Nimiq chain → the
 * provider never sees Lightning and expires → the transfer sits in
 * LIGHTNING_HANDOFF. Provider reads come from the Satora test seam; Polygon
 * from a synthetic chain; Nimiq from tests/fixtures/nimiq-htlc-chain.ts with
 * genuine Ed25519 proofs. No real payment, swap, invoice, claim or refund.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { handoffAttempts, reconciliationObservations, swapAttachments, transferProofs, transferTransitions, transfers, users } from "@/db/schema";
import { assertFundingExposure, getPilotConfig } from "@/lib/pilot";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { setNimiqSourceRpcTransportForTests } from "@/lib/nimiq-source";
import { setSettlementChainForTests, type ChainLog, type ChainReads } from "@/lib/settlement";
import { TRUSTED_HTLC_CONTRACTS } from "@/lib/expiry-resolution";
import { checkTransferConsistency, readConsistencySnapshot } from "@/lib/consistency";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { SimulatedNimiqNode, buildFunding, buildSpend, keypair, txHash, type Funding, type Keypair } from "./fixtures/nimiq-htlc-chain";
import { POST as createTransfer } from "../app/api/transfers/route";
import { GET as getTransferRoute } from "../app/api/transfers/[id]/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as reportPost } from "../app/api/transfers/[id]/handoff-result/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as closeExpiredPost } from "../app/api/transfers/[id]/close-expired/route";
import { POST as closeReturnedPost } from "../app/api/transfers/[id]/close-nim-returned/route";

const HTLC = TRUSTED_HTLC_CONTRACTS[137]![0]!;
/** HTLC funding event topic (same constant as tests/p4-expiry-resolution.test.ts). */
const FUNDED_EVENT_TOPIC_FOR_TESTS = "0x127ba86dffa89675eb78a2ca7203c29f865789ebec607b9424ed9f8d3d533e9f";
const EVM_A = "0x0000000000000000000000000000000000000001";
const createdUserIds: string[] = [];
let cc = 0;
const client = (tag: string): Record<string, string> => ({ "x-forwarded-for": `r2-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const unarmed = getPilotConfig({ NODE_ENV: "test" });

/* ---------------- synthetic Polygon (no activity unless a test adds it) ---------------- */
const HEAD = 100_000_000n;
const nowSec = () => Math.floor(Date.now() / 1000);
let chainLogs: (lock: string) => ChainLog[] = () => [];
function syntheticChain(): ChainReads {
  return {
    async getTransaction() { return null; },
    async getReceipt() { return null; },
    async getLatestBlockNumber() { return HEAD; },
    async getFinalizedBlockNumber() { return HEAD - 300n; },
    async getBlockHash(_c, n) { return `0x${n.toString(16).padStart(64, "0")}`; },
    async getBlockTimestamp(_c, n) { return nowSec() - Number(HEAD - n) * 2; },
    async getLogsByTopic1(_c, address, topic1) { return chainLogs(topic1).map((l) => ({ ...l, address })); },
  };
}

/* ---------------- provider ---------------- */
const swaps = new Map<string, Record<string, unknown>>();
let swapOverrides: Record<string, unknown> = {};
function installProvider(): void {
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      const s = swaps.get(id);
      if (!s) throw Object.assign(new Error("not found"), { code: 404 });
      return { ...s, ...swapOverrides, id };
    },
  });
}

/* ---------------- Nimiq ---------------- */
let node: SimulatedNimiqNode;

interface Stuck {
  id: string;
  userId: string;
  cookie: string;
  owner: Keypair;
  swapRecipient: Keypair;
  funding: Funding;
  fundHash: string;
  swapId: string;
  hashLock: string;
}

/** Incident 6f44918d: NIM locked and VERIFIED, provider expired, transfer in LIGHTNING_HANDOFF. */
async function incident(tag: string, opts: { reportHash?: boolean } = {}): Promise<Stuck> {
  const owner = keypair();
  const swapRecipient = keypair();
  const { userId, cookie } = await loginAs(client(`login-${tag}`), (id) => createdUserIds.push(id), owner);
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: "300000", idempotencyKey: `r2-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } }, { cookie, ...client(tag) }),
  );
  if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(tag) }), params(transfer.id));
  if (prep.status !== 201) throw new Error(`prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken: string }).attemptToken;
  const swapId = `r2-swap-${RUN}-${tag}`;
  const hashLock = `0x${txHash(`lock-${RUN}-${tag}`)}`;
  swaps.set(swapId, {
    id: swapId, direction: "lightning_to_evm", bolt11_invoice: "lnbc-test-redacted", hash_lock: hashLock,
    source_amount: transfer.quote.sourceSats, target_amount: "300000", evm_chain_id: 137, evm_htlc_address: HTLC,
    target_evm_address: EVM_A, target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
    status: "pending", invoice_expires_at: nowSec() + 3600, evm_fund_txid: null, evm_claim_txid: null, fee_sats: 6, created_at: new Date().toISOString(),
  });
  const attached = await attachPost(
    postJson(`http://localhost/api/transfers/${transfer.id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: swapId, recoveryAcknowledged: true }, { cookie, ...client(tag) }),
    params(transfer.id),
  );
  if (attached.status !== 201) throw new Error(`attach failed: ${attached.status} ${JSON.stringify(await attached.json())}`);
  const authed = await authorizePost(postJson(`http://localhost/api/transfers/${transfer.id}/authorize-handoff`, { attemptToken: token }, { cookie, ...client(tag) }), params(transfer.id));
  if (authed.status !== 200) throw new Error(`authorize failed: ${authed.status}`);

  // Nimiq Pay locks the NIM in a native HTLC hash-locked to the provider invoice.
  const fundHash = txHash(`fund-${RUN}-${tag}`);
  const funding = buildFunding({ owner, htlcRecipient: swapRecipient.address, hashLock, hash: fundHash });
  node.addTx(funding.tx);
  node.balances.set(funding.htlcAddress, funding.lockedLuna);
  const reported = await reportPost(
    postJson(`http://localhost/api/transfers/${transfer.id}/handoff-result`, { outcome: "initiated", ...(opts.reportHash === false ? {} : { sourceTxHash: fundHash }) }, { cookie, ...client(tag) }),
    params(transfer.id),
  );
  if (reported.status !== 200) throw new Error(`report failed: ${reported.status}`);
  // A reconcile (provider still pending) records late source evidence if needed.
  await reconcilePost(postJson(`http://localhost/api/transfers/${transfer.id}/reconcile`, {}, { cookie, ...client(tag) }), params(transfer.id));

  // The provider never receives Lightning; age the bound swap in the TEST DB and expire it.
  const boundAt = new Date(Date.now() - 3 * 3600_000);
  const expiredAt = new Date(Date.now() - 2 * 3600_000);
  await getDb().update(swapAttachments).set({ createdAt: boundAt, invoiceExpiresAt: expiredAt }).where(eq(swapAttachments.transferId, transfer.id));
  swaps.set(swapId, { ...swaps.get(swapId)!, status: "expired", invoice_expires_at: Math.floor(expiredAt.getTime() / 1000) });
  return { id: transfer.id, userId, cookie, owner, swapRecipient, funding, fundHash, swapId, hashLock };
}

/** After the Nimiq HTLC timeout: a genuine owner TimeoutResolve back to the owner. */
function refund(s: Stuck, over: Partial<Parameters<typeof buildSpend>[0]> = {}, opts: { final?: boolean; leftover?: bigint } = {}): string {
  const hash = txHash(`refund-${s.id}-${Math.random()}`);
  node.addTx(buildSpend({ funding: s.funding, hash, kind: "timeout", to: s.owner.address, owner: s.owner, ...over }), { final: opts.final });
  node.balances.set(s.funding.htlcAddress, opts.leftover ?? 0n);
  return hash;
}

async function closeReturned(s: Pick<Stuck, "id" | "cookie">, tag = "close"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await closeReturnedPost(postJson(`http://localhost/api/transfers/${s.id}/close-nim-returned`, {}, { cookie: s.cookie, ...client(tag) }), params(s.id));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const statusOf = async (id: string) => (await getDb().select({ s: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.s;
const terminalRows = async (id: string) => getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, id), eq(transferTransitions.terminal, true)));
async function expectStillOpen(s: Stuck): Promise<void> {
  expect(await statusOf(s.id)).toBe("LIGHTNING_HANDOFF");
  expect(await terminalRows(s.id)).toHaveLength(0);
  await expect(assertFundingExposure(s.userId, "300000", unarmed)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });
}

const ENV_KEYS = ["THENCE_ENABLED_ROUTES", "THENCE_EVM_RPCS_JSON", "THENCE_NIMIQ_PROOF_RPC_URL", "THENCE_NIMIQ_NETWORK"];
beforeEach(() => {
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://example.invalid" });
  process.env["THENCE_NIMIQ_PROOF_RPC_URL"] = "https://nimiq-proof.fixture.invalid/rpc";
  process.env["THENCE_NIMIQ_NETWORK"] = "mainnet";
  chainLogs = () => [];
  swapOverrides = {};
  node = new SimulatedNimiqNode();
  setNimiqSourceRpcTransportForTests(node.transport);
  setSettlementChainForTests(syntheticChain());
  installProvider();
  return () => {
    for (const k of ENV_KEYS) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  };
});
afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  setNimiqSourceRpcTransportForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

describe.skipIf(!LIVE)("R2 close-nim-returned (isolated test database, simulated chains)", { timeout: 300_000 }, () => {
  it("the incident before the Nimiq timeout: expired invoice, NIM still locked → stays open; P4 is unchanged", async () => {
    const s = await incident("locked");
    const markers = (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, s.id)))
      .map((t) => (t.evidence as Record<string, unknown>)["nimiqSourceVerification"]).filter(Boolean);
    expect(markers).toContain("VERIFIED");
    const res = await closeReturned(s);
    expect(res.status).toBe(409);
    expect(res.body["error"]).toBe("NIM_STILL_LOCKED");
    await expectStillOpen(s);
    // P4 still refuses this transfer exactly as before.
    const p4 = await closeExpiredPost(postJson(`http://localhost/api/transfers/${s.id}/close-expired`, {}, { cookie: s.cookie, ...client("p4") }), params(s.id));
    expect(p4.status).toBe(409);
    expect(((await p4.json()) as { error: string }).error).toBe("NOT_RESOLVABLE");
    await expectStillOpen(s);
  });

  it("verified refund: closes via existing edges, audits every hop atomically, releases exposure, exposes the verified return", async () => {
    const s = await incident("happy");
    const refundHash = refund(s);
    const attemptsBefore = await getDb().select().from(handoffAttempts).where(eq(handoffAttempts.transferId, s.id));
    const attachBefore = await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, s.id));
    const proofsBefore = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, s.id));

    const res = await closeReturned(s);
    expect(res.status).toBe(200);
    expect(res.body["resolution"]).toMatchObject({ transferId: s.id, status: "EXPIRED_UNFUNDED", deduplicated: false, nimReturn: { refundTxHash: refundHash, returnedLuna: "724409283", feeLuna: "100" } });
    expect(await statusOf(s.id)).toBe("EXPIRED_UNFUNDED");

    const hops = (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, s.id)).orderBy(asc(transferTransitions.createdAt)))
      .filter((t) => t.reasonCode === "NIM_HTLC_RETURNED_VERIFIED");
    expect(hops.map((h) => [h.fromStatus, h.toStatus, h.terminal])).toEqual([
      ["LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", false],
      ["OUTCOME_UNKNOWN", "RECONCILING", false],
      ["RECONCILING", "EXPIRED_UNFUNDED", true],
    ]);
    const ev = hops[2]!.evidence as Record<string, Record<string, unknown>>;
    expect(ev["nimiq"]).toMatchObject({
      refundProof: "VERIFIED_ON_CHAIN", fundingTxHash: s.fundHash, refundTxHash: refundHash, resolution: "TIMEOUT_RESOLVE",
      destination: s.owner.address, ownerAddress: s.owner.address, lockedLuna: "724409383", rpcHost: "nimiq-proof.fixture.invalid",
    });
    expect(ev["provider"]).toMatchObject({ status: "expired", evmFundTxid: null, evmClaimTxid: null, identityMatch: true });
    expect(ev["chain"]).toMatchObject({ chainId: 137, verdict: "NO_ACTIVITY", hashLock: s.hashLock.toLowerCase() });
    expect(JSON.stringify(ev)).not.toMatch(/lnbc|preimage|secret|mnemonic/i);

    // Financial records untouched.
    expect(await getDb().select().from(handoffAttempts).where(eq(handoffAttempts.transferId, s.id))).toEqual(attemptsBefore);
    expect(await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, s.id))).toEqual(attachBefore);
    expect(await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, s.id))).toEqual(proofsBefore);
    await expect(assertFundingExposure(s.userId, "300000", unarmed)).resolves.toBeUndefined();
    const snapshot = await readConsistencySnapshot(getDb(), s.id);
    expect(checkTransferConsistency(snapshot!, { requireAudit: true })).toEqual([]);

    // The owner's transfer view carries the verified return (and only for this close).
    const view = await getTransferRoute(new Request(`http://localhost/api/transfers/${s.id}`, { headers: { cookie: s.cookie, ...client("view") } }), params(s.id));
    expect(((await view.json()) as { transfer: Record<string, unknown> }).transfer["nimReturn"]).toEqual({ refundTxHash: refundHash, returnedLuna: "724409283", feeLuna: "100" });

    // Repeat: deduplicated, still one terminal row; reconcile cannot move it.
    const again = await closeReturned(s);
    expect(again.body["resolution"]).toMatchObject({ status: "EXPIRED_UNFUNDED", deduplicated: true, nimReturn: { refundTxHash: refundHash } });
    expect(await terminalRows(s.id)).toHaveLength(1);
    await reconcilePost(postJson(`http://localhost/api/transfers/${s.id}/reconcile`, {}, { cookie: s.cookie, ...client("rec") }), params(s.id));
    expect(await statusOf(s.id)).toBe("EXPIRED_UNFUNDED");
  });

  it("concurrent closes converge: exactly one path and one terminal audit row", async () => {
    const s = await incident("race");
    refund(s);
    const results = await Promise.all([closeReturned(s, "r1"), closeReturned(s, "r2"), closeReturned(s, "r3")]);
    for (const r of results) expect(r.status).toBe(200);
    expect(results.filter((r) => (r.body["resolution"] as { deduplicated: boolean }).deduplicated === false)).toHaveLength(1);
    expect(await terminalRows(s.id)).toHaveLength(1);
    const hops = (await getDb().select().from(transferTransitions).where(eq(transferTransitions.transferId, s.id))).filter((t) => t.reasonCode === "NIM_HTLC_RETURNED_VERIFIED");
    expect(hops).toHaveLength(3);
  });

  it("refuses Nimiq evidence that is not a full, final, owner-bound return", async () => {
    const s = await incident("nim-refusals");
    // Wrong destination.
    refund(s, { to: keypair().address });
    expect((await closeReturned(s)).body["error"]).toBe("NIM_RETURN_UNPROVEN");
    await expectStillOpen(s);
  });

  it("refuses a redeemed HTLC, a partial amount, incomplete history and non-final or unavailable evidence", async () => {
    const redeemed = await incident("redeemed");
    node.addTx(buildSpend({ funding: redeemed.funding, hash: txHash("redeem"), kind: "redeem", to: redeemed.swapRecipient.address, owner: redeemed.owner, recipient: redeemed.swapRecipient }));
    node.balances.set(redeemed.funding.htlcAddress, 0n);
    expect((await closeReturned(redeemed)).body["error"]).toBe("NIM_REDEEMED");
    await expectStillOpen(redeemed);

    const partial = await incident("partial");
    refund(partial, { valueLuna: 700_000_000n });
    expect((await closeReturned(partial)).body["error"]).toBe("NIM_RETURN_UNPROVEN");
    await expectStillOpen(partial);

    const history = await incident("history");
    refund(history);
    node.truncate = true;
    expect((await closeReturned(history)).body["error"]).toBe("NIM_RETURN_UNPROVEN");
    node.truncate = false;
    node.hashesOverride = [history.fundHash];
    expect((await closeReturned(history)).body["error"]).toBe("NIM_RETURN_UNPROVEN");
    node.hashesOverride = null;
    await expectStillOpen(history);

    const nonFinal = await incident("non-final");
    // Its own batch (block 3_456_250 → macro 3_456_300), never finalized on this node.
    refund(nonFinal, { block: 3_456_250 }, { final: false });
    expect((await closeReturned(nonFinal)).body["error"]).toBe("NIM_RETURN_NOT_FINAL");
    node.down = true;
    const down = await closeReturned(nonFinal);
    expect(down.status).toBe(503);
    expect(down.body["error"]).toBe("NIM_RETURN_UNAVAILABLE");
    node.down = false;
    await expectStillOpen(nonFinal);
  });

  it("refuses on provider movement, recent expiry, local movement or Polygon activity even with a verified NIM return", async () => {
    const s = await incident("provider");
    refund(s);
    swapOverrides = { status: "clientfunded" };
    expect((await closeReturned(s)).body["error"]).toBe("PROVIDER_NOT_EXPIRED");
    swapOverrides = { status: "expired", evm_fund_txid: `0x${"12".repeat(32)}` };
    expect((await closeReturned(s)).body["error"]).toBe("PROVIDER_REPORTS_EVM_TX");
    swapOverrides = {};
    await getDb().update(swapAttachments).set({ invoiceExpiresAt: new Date(Date.now() - 2 * 60_000) }).where(eq(swapAttachments.transferId, s.id));
    expect((await closeReturned(s)).body["error"]).toBe("INVOICE_NOT_SETTLED");
    await getDb().update(swapAttachments).set({ invoiceExpiresAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(swapAttachments.transferId, s.id));
    chainLogs = (lock) => [{ address: HTLC, topics: [FUNDED_EVENT_TOPIC_FOR_TESTS, lock], data: "0x", logIndex: 1, blockNumber: HEAD - 1000n, transactionHash: `0x${"34".repeat(32)}` } as ChainLog];
    expect((await closeReturned(s)).body["error"]).toBe("CHAIN_ACTIVITY_FOUND");
    chainLogs = () => [];
    await getDb().insert(reconciliationObservations).values({ transferId: s.id, satoraSwapId: s.swapId, providerStatus: "clientfundingseen", kind: "observation" });
    expect((await closeReturned(s)).body["error"]).toBe("LOCAL_MOVEMENT_RECORDED");
    await expectStillOpen(s);
  });

  it("refuses without independently VERIFIED source evidence, and is owner-scoped", async () => {
    const noHash = await incident("no-hash", { reportHash: false });
    expect((await closeReturned(noHash)).body["error"]).toBe("NIM_SOURCE_NOT_VERIFIED");
    expect(await statusOf(noHash.id)).toBe("LIGHTNING_HANDOFF");

    const s = await incident("scope");
    refund(s);
    const other = await loginAs(client("scope-other"), (uid) => createdUserIds.push(uid));
    expect((await closeReturned({ id: s.id, cookie: other.cookie }, "other")).status).toBe(404);
    await expectStillOpen(s);
  });
});
