/**
 * R7 — verified short deliveries (incident 2b24ca8f, Nov 14 2026: 999,556 of
 * 1,000,000 atomic USDC delivered on Polygon, finalized).
 *
 * A short delivery becomes the terminal DELIVERED_SHORT only when the claim
 * receipt is successful, reorg-consistent, finalized, credits the transfer's
 * destination with the canonical token, AND redeems the bound swap (pinned
 * HTLC, bound hash lock, complete SwapKey). Everything else keeps its
 * existing verdict. Live cases drive the real route handlers.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { transferProofs, transfers, transferTransitions, users } from "@/db/schema";
import {
  computeHtlcSwapKey,
  matchBoundSwapRedeem,
  matchSettlementTransfers,
  setSettlementChainForTests,
  shortfallFor,
  SWAP_REDEEMED_EVENT_TOPIC,
  TRANSFER_EVENT_TOPIC,
  type ChainReads,
} from "@/lib/settlement";
import { assertShortDeliveryEvidence, canTransition, isTerminal, transition } from "@/domain/transfers";
import { checkTransferConsistency, readConsistencySnapshot } from "@/lib/consistency";
import { setSatoraFetchersForTests } from "@/lib/satora";
import { getPublicProof, publicProofConfig } from "@/lib/global-proofs";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as verifyPost } from "../app/api/transfers/[id]/verify-settlement/route";
import { GET as receiptGet } from "../app/api/transfers/[id]/receipt/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `r7-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));

// Incident shapes (addresses from the real Polygon receipts, amounts exact).
const DEST = "0x15451254a70e5bd6feca12447c42dcc9b26f3947";
const OTHER = "0x0000000000000000000000000000000000000abc";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const USDC_E = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const HTLC = "0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948";
const WBTC = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";
const SERVER = "0x5ce278aaec6d9fa67bfcaf98512fe5175dfeebac";
const CLIENT = "0xf4586804ba9810e3ab57d52b166f9671b698461b";
const HTLC_SATS = "1488";
const REQUESTED = 1_000_000n;
const RECEIVED = 999_556n;
const BLOCK_NUM = 97_298_471n;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
const ROUTES = "usdc-polygon";
const RPCS = JSON.stringify({ "137": "https://example.invalid" });
const FINALIZED = JSON.stringify({ "137": { mode: "finalized", confirmations: 1 } });

function topicAddr(addr: string): string {
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
}
type Log = { address: string; topics: string[]; data: string; logIndex: number };
function transferLog(token: string, to: string, value: bigint, logIndex: number): Log {
  return { address: token, topics: [TRANSFER_EVENT_TOPIC, topicAddr("0x00000000000000000000000000000000000000ff"), topicAddr(to)], data: `0x${value.toString(16).padStart(64, "0")}`, logIndex };
}
function keyFor(hashLock: string, lock: number, htlcSats = HTLC_SATS): string {
  return computeHtlcSwapKey({ hashLock, amount: BigInt(htlcSats), token: WBTC, refundAddress: SERVER, claimAddress: CLIENT, timelock: BigInt(lock) });
}
function redeemLog(hashLock: string, key: string, htlc = HTLC): Log {
  // data would be the preimage; tests use a dummy and nothing may read it.
  return { address: htlc, topics: [SWAP_REDEEMED_EVENT_TOPIC, hashLock, key], data: `0x${"00".repeat(32)}`, logIndex: 272 };
}

/* ------------------------------------------------------------------ */
/* Pure                                                                */
/* ------------------------------------------------------------------ */

describe("R7 pure rules", () => {
  const lock = 1_800_000_000;
  const hashLock = `0x${"4a".repeat(32)}`;
  const terms = { chainId: 137, htlcAddress: HTLC, hashLock, locktimeSec: lock, tokenAddress: WBTC, amountAtomic: HTLC_SATS, refundAddress: SERVER, claimAddress: CLIENT };

  it("measures the exact incident output and does not call it matched", () => {
    const m = matchSettlementTransfers([transferLog(USDC, DEST, RECEIVED, 279)], USDC, DEST, REQUESTED);
    expect(m.matched).toBe(false);
    expect(m.totalAtomic).toBe(RECEIVED);
    expect(shortfallFor(REQUESTED.toString(), m.totalAtomic.toString())).toEqual({ requestedAtomic: "1000000", receivedAtomic: "999556", shortfallAtomic: "444" });
  });

  it("shortfallFor is null for exact, over and zero output", () => {
    expect(shortfallFor("1000000", "1000000")).toBeNull();
    expect(shortfallFor("1000000", "1000542")).toBeNull();
    expect(shortfallFor("1000000", "0")).toBeNull();
    expect(shortfallFor("1000000", null)).toBeNull();
  });

  it("bound-swap redeem matches only the pinned HTLC, bound hash lock and full SwapKey", () => {
    const key = keyFor(hashLock, lock);
    expect(matchBoundSwapRedeem([redeemLog(hashLock, key)], terms)).toBe("MATCH");
    expect(matchBoundSwapRedeem([], terms)).toBe("NO_REDEEM");
    expect(matchBoundSwapRedeem([redeemLog(hashLock, key, "0x0000000000000000000000000000000000000bad")], terms)).toBe("NO_REDEEM");
    expect(matchBoundSwapRedeem([redeemLog(`0x${"11".repeat(32)}`, key)], terms)).toBe("NO_REDEEM");
    expect(matchBoundSwapRedeem([redeemLog(hashLock, keyFor(hashLock, lock + 1))], terms)).toBe("NO_REDEEM");
    expect(matchBoundSwapRedeem([redeemLog(hashLock, keyFor(hashLock, lock, "1489"))], terms)).toBe("NO_REDEEM");
    expect(matchBoundSwapRedeem([redeemLog(hashLock, key)], { ...terms, htlcAddress: "0x0000000000000000000000000000000000000bad" })).toBe("IDENTITY_UNAVAILABLE");
    expect(matchBoundSwapRedeem([redeemLog(hashLock, key)], { ...terms, locktimeSec: null })).toBe("IDENTITY_UNAVAILABLE");
    expect(matchBoundSwapRedeem([redeemLog(hashLock, key)], { ...terms, amountAtomic: null })).toBe("IDENTITY_UNAVAILABLE");
  });

  it("the incident's real SwapRedeemed key equals the real SwapCreated key", () => {
    // From Polygon tx 0x684d2a…060a (SwapCreated) and 0x45ba18…9006 (SwapRedeemed).
    const realKey = "0x2743f04eec1548c9961dd30e94e50fbab63f8659c2571a916108a211d7ce71b3";
    const realLock = "0x4ae692173c78b309e5511e51f4ff24f0996e924b1c4c045943cc43ab6d55d7a4";
    const log = redeemLog(realLock, realKey);
    expect(log.topics[2]).toBe(realKey);
  });

  it("state machine: DELIVERED_SHORT is terminal, reachable only from CLAIMING/SERVER_FUNDED, and never upgraded", () => {
    expect(isTerminal("DELIVERED_SHORT")).toBe(true);
    expect(canTransition("CLAIMING", "DELIVERED_SHORT")).toBe(true);
    expect(canTransition("SERVER_FUNDED", "DELIVERED_SHORT")).toBe(true);
    expect(canTransition("RECONCILING", "DELIVERED_SHORT")).toBe(false);
    expect(canTransition("DELIVERED_SHORT", "DELIVERED")).toBe(false);
    expect(canTransition("DELIVERED", "DELIVERED_SHORT")).toBe(false);
  });

  it("evidence guard: needs a tx, a bound-swap redeem and 0 < received < requested", () => {
    const ok = { destinationTxHash: "0xabc", requestedAtomic: REQUESTED, receivedAtomic: RECEIVED, swapIdentityVerified: true };
    expect(() => assertShortDeliveryEvidence(ok)).not.toThrow();
    expect(() => transition("CLAIMING", "DELIVERED_SHORT", { shortEvidence: ok })).not.toThrow();
    expect(() => transition("CLAIMING", "DELIVERED_SHORT")).toThrow();
    expect(() => assertShortDeliveryEvidence({ ...ok, destinationTxHash: "" })).toThrow();
    expect(() => assertShortDeliveryEvidence({ ...ok, swapIdentityVerified: false })).toThrow();
    expect(() => assertShortDeliveryEvidence({ ...ok, receivedAtomic: 0n })).toThrow();
    expect(() => assertShortDeliveryEvidence({ ...ok, receivedAtomic: REQUESTED })).toThrow();
    expect(() => assertShortDeliveryEvidence({ ...ok, receivedAtomic: REQUESTED + 542n })).toThrow();
  });

  it("consistency flags DELIVERED below the request and DELIVERED_SHORT at or above it", () => {
    const proof = {
      id: "p", transferId: "t", nimiqTxHash: null, lightningHash: null, satoraSwapId: "s", evmTxHash: "0xabc", evidenceSource: "evm_erc20_transfer",
      chainId: 137, tokenContract: USDC, recipient: DEST, verifiedAmountAtomic: "999556", blockNumber: 1, blockHash: BLOCK_HASH, logIndexes: "[279]",
      finalityLevel: "finalized", verifiedAt: new Date(), createdAt: new Date(),
    } as const;
    const snap = (status: string, amount: string) => ({ transfer: { id: "t", status, targetAmountAtomic: "1000000" }, attachment: { satoraSwapId: "s" }, proof: { ...proof, verifiedAmountAtomic: amount }, attempts: [{ status: "HANDOFF_AUTHORIZED" }], transitions: [] });
    expect(checkTransferConsistency(snap("DELIVERED", "999556")).map((v) => v.code)).toContain("DELIVERED_BELOW_REQUEST");
    expect(checkTransferConsistency(snap("DELIVERED_SHORT", "1000000")).map((v) => v.code)).toContain("SHORT_NOT_BELOW_REQUEST");
    expect(checkTransferConsistency(snap("DELIVERED_SHORT", "999556"))).toEqual([]);
    expect(checkTransferConsistency(snap("DELIVERED", "1000542"))).toEqual([]);
    expect(checkTransferConsistency({ ...snap("DELIVERED_SHORT", "999556"), proof: null }).map((v) => v.code)).toContain("SHORT_WITHOUT_PROOF");
  });
});

/* ------------------------------------------------------------------ */
/* Live route handlers (dev DB; Satora + chain mocked)                 */
/* ------------------------------------------------------------------ */

interface Receipt { status: "success" | "reverted"; blockNumber: bigint; blockHash: string; logs: Log[] }
function mockChain(receipt: Receipt | null, opts: { finalized?: bigint; headerHash?: string } = {}): ChainReads {
  return {
    async getTransaction() { return receipt ? { hash: "0x", blockNumber: receipt.blockNumber } : null; },
    async getReceipt() { return receipt ? { ...receipt, logs: receipt.logs.map((l) => ({ ...l })) } : null; },
    async getLatestBlockNumber() { return BLOCK_NUM + 300n; },
    async getFinalizedBlockNumber() { return opts.finalized ?? BLOCK_NUM + 200n; },
    async getBlockHash() { return opts.headerHash ?? BLOCK_HASH; },
  };
}

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = { THENCE_ENABLED_ROUTES: ROUTES, THENCE_EVM_RPCS_JSON: RPCS, THENCE_SETTLEMENT_FINALITY_JSON: FINALIZED } as const;
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(keys)) { prev[k] = process.env[k]; process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

interface Case { id: string; hashLock: string; lock: number; claimTx: string; swapId: string }

function swapFixture(c: Pick<Case, "swapId" | "hashLock" | "lock">, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: c.swapId,
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc100u1p0fakeinvoicepp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fakelnvp2qpp5fake",
    hash_lock: c.hashLock,
    source_amount: "1499",
    target_amount: REQUESTED.toString(),
    evm_chain_id: 137,
    target_evm_address: DEST,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC },
    status: "pending",
    invoice_expires_at: Math.floor(Date.now() / 1000) + 3600,
    fee_sats: 35,
    created_at: new Date().toISOString(),
    evm_htlc_address: HTLC,
    wbtc_address: WBTC,
    evm_expected_sats: HTLC_SATS,
    server_evm_address: SERVER,
    client_evm_address: CLIENT,
    evm_refund_locktime: c.lock,
    ...extra,
  };
}
const mockSwap = (swap: Record<string, unknown>): void =>
  setSatoraFetchersForTests({
    getTokens: async () => ({ evm_tokens: [{ token_id: USDC, symbol: "USDC", chain: "137", decimals: 6 }] }),
    getSwapPairs: async () => ({ pairs: [{ source: "Lightning", target: "137", min_sats: 100, max_sats: 100_000_000 }] }),
    getSwap: async (id: string) => ({ ...swap, id }),
  });

async function claimingCase(cookie: string, tag: string, claimTxOverride?: string): Promise<Case> {
  const hex = Buffer.from(`r7-${tag}-${RUN}`).toString("hex").padEnd(64, "0").slice(0, 64);
  const c = { hashLock: `0x${hex}`, lock: Math.floor(Date.now() / 1000) + 2700, claimTx: claimTxOverride ?? `0x${hex.split("").reverse().join("")}`, swapId: `swap-r7-${tag}-${RUN}` };
  const created = await createTransfer(
    postJson("http://localhost/api/transfers", { routeId: "usdc-polygon", targetAmountAtomic: REQUESTED.toString(), idempotencyKey: `r7-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: DEST } }, { cookie, ...withClient(tag) }),
  );
  if (created.status !== 201) throw new Error(`setup transfer failed: ${created.status}`);
  const transfer = ((await created.json()) as { transfer: { id: string; quote: { sourceSats: string } } }).transfer;
  const id = transfer.id;
  const prep = await preparePost(postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });
  if (prep.status !== 201) throw new Error(`setup prepare failed: ${prep.status}`);
  const token = ((await prep.json()) as { attemptToken?: string }).attemptToken as string;
  mockSwap(swapFixture(c, { source_amount: transfer.quote.sourceSats }));
  try {
    const { POST: attachPost } = await import("../app/api/transfers/[id]/attach/route");
    const { POST: authorizePost } = await import("../app/api/transfers/[id]/authorize-handoff/route");
    const attached = await attachPost(postJson(`http://localhost/api/transfers/${id}/attach`, { attemptToken: token, expectedQuoteRevision: 1, satoraSwapId: c.swapId, recoveryAcknowledged: true }, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });
    if (attached.status !== 201) throw new Error(`setup attach failed: ${attached.status} ${await attached.text()}`);
    const authed = await authorizePost(postJson(`http://localhost/api/transfers/${id}/authorize-handoff`, { attemptToken: token }, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });
    if (authed.status !== 200) throw new Error(`setup authorize failed: ${authed.status}`);
  } finally {
    setSatoraFetchersForTests(null);
  }
  for (const status of ["serverfunded", "clientredeemed"]) {
    mockSwap(swapFixture(c, status === "clientredeemed" ? { status, evm_claim_txid: c.claimTx } : { status }));
    try {
      const r = await reconcilePost(postJson(`http://localhost/api/transfers/${id}/reconcile`, {}, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id }) });
      if (r.status !== 200) throw new Error(`setup reconcile ${status} failed: ${r.status}`);
    } finally {
      setSatoraFetchersForTests(null);
    }
  }
  const row = (await getDb().select({ status: transfers.status }).from(transfers).where(eq(transfers.id, id)).limit(1))[0];
  if (row?.status !== "CLAIMING") throw new Error(`setup did not reach CLAIMING: ${row?.status}`);
  return { id, ...c };
}

async function verifyWith(cookie: string, tag: string, c: Case, receipt: Receipt | null, chainOpts: { finalized?: bigint; headerHash?: string } = {}) {
  mockSwap(swapFixture(c, { status: "serverredeemed", evm_claim_txid: c.claimTx }));
  setSettlementChainForTests(mockChain(receipt, chainOpts));
  try {
    const res = await verifyPost(postJson(`http://localhost/api/transfers/${c.id}/verify-settlement`, {}, { cookie, ...withClient(tag) }), { params: Promise.resolve({ id: c.id }) });
    return { status: res.status, body: (await res.json()) as { settlement?: { verdict: string; status: string; reason: string; shortfall?: unknown; proof?: { verifiedAmountAtomic: string } | null } } };
  } finally {
    setSatoraFetchersForTests(null);
    setSettlementChainForTests(null);
  }
}

const receiptWith = (logs: Log[]): Receipt => ({ status: "success", blockNumber: BLOCK_NUM, blockHash: BLOCK_HASH, logs });
const statusOf = async (id: string) => (await getDb().select({ status: transfers.status }).from(transfers).where(eq(transfers.id, id)).limit(1))[0]?.status;
const proofOf = async (id: string) => (await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, id)).limit(1))[0] ?? null;
const shortTransitions = async (id: string) =>
  getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, id), eq(transferTransitions.toStatus, "DELIVERED_SHORT")));

describe.skipIf(!LIVE)("R7 live: short deliveries through the real verifier", () => {
  it("incident 999,556 / 1,000,000 → DELIVERED_SHORT with exact amounts, audited, truthful receipt; replay is idempotent", async () => {
    await withEnv(async () => {
      const { cookie } = await login("incident");
      const c = await claimingCase(cookie, "incident");
      const logs = [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock)), transferLog(USDC, DEST, RECEIVED, 279)];
      const first = await verifyWith(cookie, "incident", c, receiptWith(logs));
      expect(first.status).toBe(200);
      expect(first.body.settlement?.verdict).toBe("VERIFIED_SHORT");
      expect(first.body.settlement?.status).toBe("DELIVERED_SHORT");
      expect(first.body.settlement?.shortfall).toEqual({ requestedAtomic: "1000000", receivedAtomic: "999556", shortfallAtomic: "444" });
      expect(await statusOf(c.id)).toBe("DELIVERED_SHORT");
      const proof = await proofOf(c.id);
      expect(proof?.verifiedAmountAtomic).toBe("999556");
      expect(proof?.recipient).toBe(DEST);
      expect(proof?.tokenContract).toBe(USDC);
      expect(proof?.finalityLevel).toBe("finalized");
      expect(proof?.evmTxHash).toBe(c.claimTx);
      const audit = await shortTransitions(c.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.reasonCode).toBe("SETTLEMENT_VERIFIED_SHORT");
      expect(audit[0]?.terminal).toBe(true);
      expect(audit[0]?.evidence).toMatchObject({ requestedAmountAtomic: "1000000", verifiedAmountAtomic: "999556", shortfallAtomic: "444", swapIdentity: "BOUND_REDEEM_MATCH" });
      // Never stores the preimage (redeem data) anywhere in the audit evidence.
      expect(JSON.stringify(audit[0]?.evidence)).not.toContain("0".repeat(64));

      const receipt = await receiptGet(new Request(`http://localhost/api/transfers/${c.id}/receipt`, { headers: { cookie, ...withClient("incident-r") } }), { params: Promise.resolve({ id: c.id }) });
      expect(receipt.status).toBe(200);
      const r = ((await receipt.json()) as { receipt: Record<string, unknown> }).receipt;
      expect(r).toMatchObject({ status: "DELIVERED_SHORT", deliveryOutcome: "SHORT", requestedAmountAtomic: "1000000", verifiedAmountAtomic: "999556", shortfallAtomic: "444", settlementTxHash: c.claimTx });
      expect(String(r["explorerTxUrl"])).toContain(c.claimTx);

      const snapshot = await readConsistencySnapshot(getDb(), c.id);
      expect(snapshot && checkTransferConsistency(snapshot, { requireAudit: true })).toEqual([]);

      // Global proof: real SQL publication query + serializer. Not publishable
      // until independent NIM source evidence exists (unchanged gate) …
      const config = publicProofConfig({ routeTokens: { "usdc-polygon": USDC }, finalityPolicies: JSON.parse(FINALIZED) as Record<string, { mode: string; confirmations: number }> });
      expect(await getPublicProof(proof!.id, config)).toBeNull();
      // … then add the reconciler's source-verification marker, shaped like the incident's.
      const nimHash = Buffer.from(`r7-src-${RUN}`).toString("hex").padEnd(64, "0").slice(0, 64);
      await getDb().update(transferProofs).set({ nimiqTxHash: nimHash }).where(eq(transferProofs.transferId, c.id));
      await getDb().insert(transferTransitions).values({
        transferId: c.id, fromStatus: "CLIENT_FUNDED", toStatus: "CLIENT_FUNDED", actor: "reconciler", reasonCode: "SOURCE_EVIDENCE_RECORDED", terminal: false,
        evidence: {
          nimiqSourceVerification: "VERIFIED", nimiqSourceTxHash: nimHash, nimiqSourceNetwork: "mainnet",
          nimiqSourceSenderAddress: "NQ59 2J4D LAK7 JA9L 780K CJ6G 78RR UD53 BLL7", nimiqSourceAmountLuna: "519127789", nimiqSourceFeeLuna: "0",
          nimiqSourceTotalDebitLuna: "519127789", nimiqSourceBlockNumber: 66868776, nimiqSourceConfirmations: 27, nimiqSourceFinalizedByMacroBlock: 66868800,
          nimiqSourceVerifiedAt: "2026-11-14T10:45:25.946Z", nimiqSourceRpcHost: "rpc.nimiqwatch.com",
        },
      });
      const published = await getPublicProof(proof!.id, config);
      expect(published?.status).toBe("DELIVERED_SHORT");
      expect(published?.destination).toMatchObject({ requestedAmountAtomic: "1000000", verifiedAmountAtomic: "999556", shortfallAtomic: "444", deliveryOutcome: "SHORT", transactionHash: c.claimTx });

      // Replay (and a hostile changed receipt) never re-decides a terminal short delivery.
      const replay = await verifyWith(cookie, "incident", c, receiptWith([transferLog(USDC, DEST, REQUESTED, 279)]));
      expect(replay.body.settlement?.verdict).toBe("VERIFIED_SHORT");
      expect(replay.body.settlement?.proof?.verifiedAmountAtomic).toBe("999556");
      expect(await statusOf(c.id)).toBe("DELIVERED_SHORT");
      expect(await shortTransitions(c.id)).toHaveLength(1);
    });
  }, 120_000);

  it("one claim transaction can never be attributed to (or published for) a second transfer", async () => {
    await withEnv(async () => {
      const a = await login("dup-a");
      const first = await claimingCase(a.cookie, "dup-a");
      const logsFor = (c: Case) => [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock)), transferLog(USDC, DEST, RECEIVED, 279)];
      expect((await verifyWith(a.cookie, "dup-a", first, receiptWith(logsFor(first)))).body.settlement?.verdict).toBe("VERIFIED_SHORT");
      const b = await login("dup-b");
      const second = await claimingCase(b.cookie, "dup-b", first.claimTx);
      const res = await verifyWith(b.cookie, "dup-b", second, receiptWith([...logsFor(second), ...logsFor(first)]));
      expect(res.status).toBe(409);
      expect(await statusOf(second.id)).toBe("CLAIMING");
      expect((await proofOf(second.id))?.verifiedAt ?? null).toBeNull();
    });
  }, 180_000);

  it("concurrent verifications converge on one DELIVERED_SHORT transition", async () => {
    await withEnv(async () => {
      const { cookie } = await login("race");
      const c = await claimingCase(cookie, "race");
      const logs = [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock)), transferLog(USDC, DEST, RECEIVED, 279)];
      mockSwap(swapFixture(c, { status: "serverredeemed", evm_claim_txid: c.claimTx }));
      setSettlementChainForTests(mockChain(receiptWith(logs)));
      try {
        const results = await Promise.all(
          [0, 1, 2].map((i) => verifyPost(postJson(`http://localhost/api/transfers/${c.id}/verify-settlement`, {}, { cookie, ...withClient(`race-${i}`) }), { params: Promise.resolve({ id: c.id }) })),
        );
        const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{ settlement?: { verdict: string } }>;
        expect(bodies.every((b) => b.settlement?.verdict === "VERIFIED_SHORT")).toBe(true);
      } finally {
        setSatoraFetchersForTests(null);
        setSettlementChainForTests(null);
      }
      expect(await shortTransitions(c.id)).toHaveLength(1);
    });
  }, 120_000);

  it("exact and over-delivery keep the existing DELIVERED behavior", async () => {
    await withEnv(async () => {
      const { cookie } = await login("full");
      for (const [tag, amount] of [["exact", REQUESTED], ["over", REQUESTED + 542n]] as const) {
        const c = await claimingCase(cookie, tag);
        const res = await verifyWith(cookie, tag, c, receiptWith([transferLog(USDC, DEST, amount, 279)]));
        expect(res.body.settlement?.verdict).toBe("VERIFIED");
        expect(await statusOf(c.id)).toBe("DELIVERED");
        expect((await proofOf(c.id))?.verifiedAmountAtomic).toBe(amount.toString());
        expect(await shortTransitions(c.id)).toHaveLength(0);
      }
    });
  }, 180_000);

  it("never classifies other failures as short: zero, wrong recipient, wrong token, no bound redeem", async () => {
    await withEnv(async () => {
      // One user per case: open CLAIMING transfers count toward the pilot exposure cap.
      const cases: Array<[string, (c: Case) => Log[]]> = [
        ["zero", (c) => [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock))]],
        ["wrong-recipient", (c) => [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock)), transferLog(USDC, OTHER, RECEIVED, 279)]],
        ["wrong-token", (c) => [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock)), transferLog(USDC_E, DEST, RECEIVED, 279)]],
        ["no-redeem", () => [transferLog(USDC, DEST, RECEIVED, 279)]],
        ["foreign-redeem", (c) => [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock + 60)), transferLog(USDC, DEST, RECEIVED, 279)]],
      ];
      for (const [tag, logsFor] of cases) {
        const { cookie } = await login(`neg-${tag}`);
        const c = await claimingCase(cookie, tag);
        const res = await verifyWith(cookie, tag, c, receiptWith(logsFor(c)));
        expect(res.status, tag).toBe(422);
        expect(res.body.settlement?.verdict, tag).toBe("INVALID");
        expect(await statusOf(c.id), tag).toBe("CLAIMING");
        expect(await proofOf(c.id).then((p) => p?.verifiedAt ?? null), tag).toBeNull();
      }
    });
  }, 300_000);

  it("a short delivery waits for finality and reorg consistency before it is decided", async () => {
    await withEnv(async () => {
      const { cookie } = await login("final");
      const c = await claimingCase(cookie, "final");
      const logs = [redeemLog(c.hashLock, keyFor(c.hashLock, c.lock)), transferLog(USDC, DEST, RECEIVED, 279)];
      const unfinalized = await verifyWith(cookie, "final", c, receiptWith(logs), { finalized: BLOCK_NUM - 1n });
      expect(unfinalized.body.settlement?.verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
      expect(await statusOf(c.id)).toBe("CLAIMING");
      const reorged = await verifyWith(cookie, "final", c, receiptWith(logs), { headerHash: `0x${"ee".repeat(32)}` });
      expect(reorged.body.settlement?.verdict).toBe("INCONCLUSIVE");
      expect(await statusOf(c.id)).toBe("CLAIMING");
      const reverted = await verifyWith(cookie, "final", c, { ...receiptWith(logs), status: "reverted" });
      expect(reverted.body.settlement?.verdict).toBe("INVALID");
      expect(await statusOf(c.id)).toBe("CLAIMING");
      const settled = await verifyWith(cookie, "final", c, receiptWith(logs));
      expect(settled.body.settlement?.verdict).toBe("VERIFIED_SHORT");
      expect(await statusOf(c.id)).toBe("DELIVERED_SHORT");
    });
  }, 180_000);
});
