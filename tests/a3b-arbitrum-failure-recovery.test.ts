/**
 * A3b — failure and recovery lifecycle integration for Arbitrum native USDC.
 *
 * The real transfer, handoff, reconciliation, claim-intent, expiry-resolution,
 * proof and audit paths run against the isolated test database. Only Satora,
 * wallet/session and Arbitrum chain reads are deterministic fixtures. This
 * suite never creates a swap, invoice, payment, claim or refund.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { checkTransferConsistency, readConsistencySnapshot } from "@/lib/consistency";
import { getPilotConfig, assertFundingExposure } from "@/lib/pilot";
import { jobLeases, reconciliationObservations, swapAttachments, transferProofs, transferTransitions, transfers, users } from "@/db/schema";
import { getSatoraClient, resetSatoraCachesForTests, setSatoraFetchersForTests } from "@/lib/satora";
import {
  HTLC_SWAP_STATE,
  SWAP_FUNDED_EVENT_TOPIC,
  SWAP_REHASHED_EVENT_TOPIC,
  SWAP_REFUNDED_EVENT_TOPIC,
  TRANSFER_EVENT_TOPIC,
  computeHtlcSwapKey,
  setSettlementChainForTests,
  type ChainLog,
  type ChainReads,
} from "@/lib/settlement";
import { runServerReconciliation } from "@/lib/server-reconciler";
import { LIVE, RUN, fixtureWallet, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { POST as attachPost } from "../app/api/transfers/[id]/attach/route";
import { POST as authorizePost } from "../app/api/transfers/[id]/authorize-handoff/route";
import { POST as handoffResultPost } from "../app/api/transfers/[id]/handoff-result/route";
import { POST as reconcilePost } from "../app/api/transfers/[id]/reconcile/route";
import { POST as closeExpiredPost } from "../app/api/transfers/[id]/close-expired/route";
import { POST as claimIntentPost } from "../app/api/transfers/[id]/claim-intent/route";

const ARBITRUM_CHAIN_ID = 42161;
const NATIVE_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const ARBITRUM_HTLC = "0x6c38bf44a327bf36bfbefcedc514c0fb3fec6748";
const ARBITRUM_WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";
const HTLC_REFUND_ADDRESS = "0x5ce278aaec6d9fa67bfcaf98512fe5175dfeebac";
const HTLC_CLAIM_ADDRESS = "0x204e6e1ba85effb5212042ff16b4205ce6cddddd";
const RECIPIENT = "0x0000000000000000000000000000000000000001";
const HTLC_AMOUNT = 392n;
const TARGET_AMOUNT = "300000";
const FUND_BLOCK = 91_000_000n;
const REFUND_BLOCK = FUND_BLOCK + 500n;
const CLAIM_BLOCK = FUND_BLOCK + 700n;
const CHAIN_HEAD = FUND_BLOCK + 20_000n;
const FUND_BLOCK_HASH = `0x${"f0".repeat(32)}`;
const REFUND_BLOCK_HASH = `0x${"b2".repeat(32)}`;
const CLAIM_BLOCK_HASH = `0x${"c1".repeat(32)}`;
const ZERO_PREIMAGE = `0x${"00".repeat(32)}`;

const hex32 = (tag: string): string => `0x${createHash("sha256").update(`a3b-${RUN}-${tag}`).digest("hex")}`;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address: string): string => address.slice(2).toLowerCase().padStart(64, "0");
const addressTopic = (address: string): string => `0x${addressWord(address)}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

interface Pay {
  id: string;
  cookie: string;
  userId: string;
  swapId: string;
  sourceSats: string;
  hashLock: string;
  lock: number;
  fundTx: string;
  tag: string;
  attemptToken: string;
}

interface ClaimReceipt {
  status: "success" | "reverted";
  to: string;
  amount: bigint;
  token: string;
}

interface RefundReceipt {
  status: "success" | "reverted";
  hashLock: string;
  swapKey: string;
  htlcAddress?: string;
}

type FixtureLog = ChainLog & { blockNumber: bigint };

const provider = new Map<string, Record<string, unknown> | "unavailable">();
const funded = new Map<string, Pay>();
const refundReceipts = new Map<string, RefundReceipt>();
const claimTransactions = new Set<string>();
const claimReceipts = new Map<string, ClaimReceipt>();
const lifecycleStates = new Map<string, number>();
const lifecycleLogs: FixtureLog[] = [];
const createdUserIds: string[] = [];
const createdTransferIds: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const testPilot = getPilotConfig({ NODE_ENV: "test" });
let latestBlock = CHAIN_HEAD;
let finalizedBlock: bigint | null = CHAIN_HEAD;
let chainDown = false;
let logsDown = false;
let lifecycleDown = false;
let headerMismatch = false;
let clientCounter = 0;
let quoteSpy: { mockRestore: () => void } | null = null;

const client = (tag: string): Record<string, string> => ({
  "x-forwarded-for": `a3b-${RUN}-${tag}-${clientCounter++}`,
});

function expectedKey(p: Pay): string {
  return computeHtlcSwapKey({
    hashLock: p.hashLock,
    amount: HTLC_AMOUNT,
    token: ARBITRUM_WBTC,
    refundAddress: HTLC_REFUND_ADDRESS,
    claimAddress: HTLC_CLAIM_ADDRESS,
    timelock: BigInt(p.lock),
  });
}

function fundingData(p: Pay, key = expectedKey(p)): string {
  return `0x${addressWord(ARBITRUM_WBTC)}${word(HTLC_AMOUNT)}${word(p.lock)}${key.slice(2)}`;
}

function swapShape(p: Pay, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: p.swapId,
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc300u1p4a3atestinvoice",
    hash_lock: p.hashLock,
    source_amount: p.sourceSats,
    target_amount: TARGET_AMOUNT,
    evm_chain_id: ARBITRUM_CHAIN_ID,
    evm_htlc_address: ARBITRUM_HTLC,
    target_evm_address: RECIPIENT,
    target_token: { chain: String(ARBITRUM_CHAIN_ID), decimals: 6, name: "USD Coin", symbol: "USDC", token_id: NATIVE_USDC },
    wbtc_address: ARBITRUM_WBTC,
    evm_expected_sats: HTLC_AMOUNT.toString(),
    server_evm_address: HTLC_REFUND_ADDRESS,
    client_evm_address: HTLC_CLAIM_ADDRESS,
    status: "pending",
    invoice_expires_at: nowSec() + 5_400,
    evm_refund_locktime: p.lock,
    evm_fund_txid: null,
    evm_claim_txid: null,
    fee_sats: 6,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function fundingLog(p: Pay, key = expectedKey(p), blockNumber = FUND_BLOCK): FixtureLog {
  return {
    address: ARBITRUM_HTLC,
    topics: [SWAP_FUNDED_EVENT_TOPIC, p.hashLock, addressTopic(HTLC_REFUND_ADDRESS), addressTopic(HTLC_CLAIM_ADDRESS)],
    data: fundingData(p, key),
    logIndex: 1,
    transactionHash: p.fundTx,
    blockNumber,
  };
}

function refundLog(p: Pay, txHash: string, key = expectedKey(p), blockNumber = CHAIN_HEAD - 1_000n): FixtureLog {
  return {
    address: ARBITRUM_HTLC,
    topics: [SWAP_REFUNDED_EVENT_TOPIC, p.hashLock, key],
    data: "0x",
    logIndex: 3,
    transactionHash: txHash,
    blockNumber,
  };
}

function rehashLog(p: Pay, replacementKey = hex32(`${p.tag}-replacement`)): FixtureLog {
  return {
    address: ARBITRUM_HTLC,
    topics: [SWAP_REHASHED_EVENT_TOPIC, p.hashLock, expectedKey(p), replacementKey],
    data: "0x",
    logIndex: 4,
    transactionHash: hex32(`${p.tag}-rehash`),
    blockNumber: REFUND_BLOCK,
  };
}

function installProvider(): void {
  setSatoraFetchersForTests({
    getTokens: async () => ({
      evm_tokens: [{ token_id: NATIVE_USDC, symbol: "USDC", chain: String(ARBITRUM_CHAIN_ID), decimals: 6 }],
    }),
    getSwapPairs: async () => ({ pairs: [{ source: "Lightning", target: String(ARBITRUM_CHAIN_ID), min_sats: 1_000, max_sats: 20_000_000 }] }),
    getSwap: async (id: string) => {
      const swap = provider.get(id);
      if (!swap) throw Object.assign(new Error("swap not found"), { code: 404 });
      if (swap === "unavailable") throw Object.assign(new Error("provider unavailable"), { code: "PROVIDER_UNAVAILABLE" });
      return { ...swap, id };
    },
  });
}

function blockHash(blockNumber: bigint): string {
  if (headerMismatch) return `0x${"ff".repeat(32)}`;
  if (blockNumber === FUND_BLOCK) return FUND_BLOCK_HASH;
  if (blockNumber === REFUND_BLOCK) return REFUND_BLOCK_HASH;
  if (blockNumber === CLAIM_BLOCK) return CLAIM_BLOCK_HASH;
  return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function syntheticChain(): ChainReads {
  return {
    async getTransaction(_chainId, hash) {
      const normalized = hash.toLowerCase();
      if (funded.has(normalized)) return { hash, blockNumber: FUND_BLOCK };
      if (refundReceipts.has(normalized)) return { hash, blockNumber: REFUND_BLOCK };
      if (claimTransactions.has(normalized)) return { hash, blockNumber: CLAIM_BLOCK };
      return null;
    },
    async getReceipt(_chainId, hash) {
      if (chainDown) throw new Error("rpc 502");
      const normalized = hash.toLowerCase();
      const p = funded.get(normalized);
      if (p) {
        return {
          status: "success",
          blockNumber: FUND_BLOCK,
          blockHash: FUND_BLOCK_HASH,
          logs: [fundingLog(p)],
        };
      }
      const refund = refundReceipts.get(normalized);
      if (refund) {
        return {
          status: refund.status,
          blockNumber: REFUND_BLOCK,
          blockHash: REFUND_BLOCK_HASH,
          logs: [refundLog({ hashLock: refund.hashLock, tag: "refund", lock: 1, fundTx: "0x", id: "", cookie: "", userId: "", swapId: "", sourceSats: "", attemptToken: "" }, normalized, refund.swapKey, REFUND_BLOCK)],
        };
      }
      const claim = claimReceipts.get(normalized);
      if (!claim) return null;
      return {
        status: claim.status,
        blockNumber: CLAIM_BLOCK,
        blockHash: CLAIM_BLOCK_HASH,
        logs: [{
          address: claim.token,
          topics: [TRANSFER_EVENT_TOPIC, addressTopic(HTLC_CLAIM_ADDRESS), addressTopic(claim.to)],
          data: `0x${word(claim.amount)}`,
          logIndex: 7,
        }],
      };
    },
    async getLatestBlockNumber() {
      if (chainDown) throw new Error("rpc 502");
      return latestBlock;
    },
    async getFinalizedBlockNumber() {
      if (chainDown) throw new Error("rpc 502");
      return finalizedBlock;
    },
    async getBlockHash(_chainId, blockNumber) {
      if (chainDown) throw new Error("rpc 502");
      return blockHash(blockNumber);
    },
    async getBlockTimestamp(_chainId, blockNumber) {
      if (chainDown) throw new Error("rpc 502");
      const chainNow = nowSec() + 7_200;
      return chainNow - Number(latestBlock - blockNumber) * 2;
    },
    async getLogsByTopic1(_chainId, address, topic1, fromBlock, toBlock) {
      if (chainDown || logsDown) throw new Error("rpc 502");
      return lifecycleLogs.filter((log) =>
        log.address.toLowerCase() === address.toLowerCase() &&
        log.topics[1]?.toLowerCase() === topic1.toLowerCase() &&
        log.blockNumber >= fromBlock &&
        log.blockNumber <= toBlock,
      );
    },
    async getHtlcSwapState(_chainId, _address, key) {
      if (chainDown || lifecycleDown) throw new Error("rpc 502");
      return { state: lifecycleStates.get(key.toLowerCase()) ?? HTLC_SWAP_STATE.NONE, preimage: ZERO_PREIMAGE };
    },
  };
}

function putSwap(p: Pay, overrides: Record<string, unknown> = {}): void {
  provider.set(p.swapId, swapShape(p, overrides));
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await getDb().select({ status: transfers.status }).from(transfers).where(eq(transfers.id, id)))[0]?.status;
}

async function errorBody(response: Response): Promise<{ error: string; message?: string; [key: string]: unknown }> {
  return (await response.json()) as { error: string; message?: string; [key: string]: unknown };
}

async function ageObservations(id: string): Promise<void> {
  await getDb().execute(sql`UPDATE reconciliation_observations SET observed_at = observed_at - make_interval(mins => 10) WHERE transfer_id = ${id}::uuid`);
}

async function expireClaimLease(id: string): Promise<void> {
  await getDb().update(jobLeases).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(jobLeases.name, `claim:${id}`));
}

async function terminalRows(id: string): Promise<Array<typeof transferTransitions.$inferSelect>> {
  return getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, id), eq(transferTransitions.terminal, true)));
}

async function expectConsistent(id: string): Promise<void> {
  const snapshot = await readConsistencySnapshot(getDb(), id);
  expect(checkTransferConsistency(snapshot!, { requireAudit: true })).toEqual([]);
}

async function createAuthorizedPayment(tag: string): Promise<Pay> {
  const wallet = fixtureWallet();
  const { cookie, userId } = await loginAs(client(`login-${tag}`), (id) => createdUserIds.push(id), wallet);
  const created = await createTransfer(
    postJson(
      "http://localhost/api/transfers",
      { routeId: "usdc-arbitrum", targetAmountAtomic: TARGET_AMOUNT, idempotencyKey: `a3b-${RUN}-${tag}`, direct: { asset: "USDC", network: "Arbitrum", address: RECIPIENT } },
      { cookie, ...client(tag) },
    ),
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { transfer: { id: string; targetAmountAtomic: string; quote: { sourceSats: string; netTargetAmountAtomic: string } } };
  const p: Pay = {
    id: body.transfer.id,
    cookie,
    userId,
    swapId: randomUUID(),
    sourceSats: body.transfer.quote.sourceSats,
    hashLock: hex32(`lock-${tag}`),
    lock: nowSec() + 3_600,
    fundTx: hex32(`fund-${tag}`),
    tag,
    attemptToken: "",
  };
  createdTransferIds.push(p.id);
  expect(body.transfer).toMatchObject({ targetAmountAtomic: TARGET_AMOUNT });
  expect(body.transfer.quote).toMatchObject({ sourceSats: "3004", netTargetAmountAtomic: TARGET_AMOUNT });

  const prepared = await preparePost(
    postJson(`http://localhost/api/transfers/${p.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie, ...client(`${tag}-prepare`) }),
    params(p.id),
  );
  expect(prepared.status).toBe(201);
  p.attemptToken = ((await prepared.json()) as { attemptToken: string }).attemptToken;
  putSwap(p);

  const attached = await attachPost(
    postJson(
      `http://localhost/api/transfers/${p.id}/attach`,
      { attemptToken: p.attemptToken, expectedQuoteRevision: 1, satoraSwapId: p.swapId, recoveryAcknowledged: true },
      { cookie, ...client(`${tag}-attach`) },
    ),
    params(p.id),
  );
  expect(attached.status).toBe(201);
  expect(await statusOf(p.id)).toBe("SWAP_CREATED");

  const authorized = await authorizePost(
    postJson(`http://localhost/api/transfers/${p.id}/authorize-handoff`, { attemptToken: p.attemptToken }, { cookie, ...client(`${tag}-authorize`) }),
    params(p.id),
  );
  expect(authorized.status).toBe(200);
  expect(await statusOf(p.id)).toBe("AWAITING_NIM_APPROVAL");

  const initiated = await handoffResultPost(
    postJson(`http://localhost/api/transfers/${p.id}/handoff-result`, { outcome: "initiated" }, { cookie, ...client(`${tag}-initiated`) }),
    params(p.id),
  );
  expect(initiated.status).toBe(200);
  expect(await statusOf(p.id)).toBe("LIGHTNING_HANDOFF");
  return p;
}

async function fundPayment(p: Pay): Promise<void> {
  putSwap(p, { status: "clientfunded" });
  let response = await reconcilePost(
    postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client(`${p.tag}-clientfunded`) }),
    params(p.id),
  );
  expect(response.status).toBe(200);
  expect(await statusOf(p.id)).toBe("CLIENT_FUNDED");

  funded.set(p.fundTx.toLowerCase(), p);
  lifecycleStates.set(expectedKey(p).toLowerCase(), HTLC_SWAP_STATE.ACTIVE);
  lifecycleLogs.push(fundingLog(p));
  putSwap(p, { status: "serverfunded", evm_fund_txid: p.fundTx });
  response = await reconcilePost(
    postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client(`${p.tag}-serverfunded`) }),
    params(p.id),
  );
  expect(response.status).toBe(200);
  expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
}

async function reportUnknown(p: Pay): Promise<void> {
  const response = await handoffResultPost(
    postJson(`http://localhost/api/transfers/${p.id}/handoff-result`, { outcome: "unknown" }, { cookie: p.cookie, ...client(`${p.tag}-unknown`) }),
    params(p.id),
  );
  expect(response.status).toBe(200);
  expect(await statusOf(p.id)).toBe("RECONCILING");
}

async function expireProviderSwap(p: Pay): Promise<void> {
  const boundAt = new Date(Date.now() - 3 * 3_600_000);
  const expiredAt = new Date(Date.now() - 2 * 3_600_000);
  await getDb().update(swapAttachments).set({ createdAt: boundAt, invoiceExpiresAt: expiredAt }).where(eq(swapAttachments.transferId, p.id));
  putSwap(p, { status: "expired", invoice_expires_at: Math.floor(expiredAt.getTime() / 1000) });
  latestBlock = CHAIN_HEAD;
  finalizedBlock = CHAIN_HEAD;
}

async function reconcile(p: Pay, tag: string): Promise<Response> {
  return reconcilePost(
    postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client(`${p.tag}-${tag}`) }),
    params(p.id),
  );
}

async function closeExpired(p: Pay, tag: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await closeExpiredPost(
    postJson(`http://localhost/api/transfers/${p.id}/close-expired`, {}, { cookie: p.cookie, ...client(`${p.tag}-${tag}`) }),
    params(p.id),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function authorizeClaim(p: Pay): Promise<Response> {
  return claimIntentPost(
    postJson(`http://localhost/api/transfers/${p.id}/claim-intent`, {}, { cookie: p.cookie, ...client(`${p.tag}-claim`) }),
    params(p.id),
  );
}

function simulateClaim(p: Pay, claimTx: string): void {
  claimTransactions.add(claimTx.toLowerCase());
  claimReceipts.set(claimTx.toLowerCase(), { status: "success", to: RECIPIENT, amount: BigInt(TARGET_AMOUNT), token: NATIVE_USDC });
  putSwap(p, { status: "clientredeemed", evm_fund_txid: p.fundTx, evm_claim_txid: claimTx });
}

beforeAll(async () => {
  if (!LIVE) return;
  for (const key of ["THENCE_ENABLED_ROUTES", "THENCE_ROUTE_TOKENS_JSON", "THENCE_EVM_RPCS_JSON", "THENCE_SETTLEMENT_FINALITY_JSON"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.THENCE_ENABLED_ROUTES = "usdc-arbitrum";
  process.env.THENCE_ROUTE_TOKENS_JSON = JSON.stringify({ "usdc-arbitrum": NATIVE_USDC });
  process.env.THENCE_EVM_RPCS_JSON = JSON.stringify({ [String(ARBITRUM_CHAIN_ID)]: "https://fixture.invalid" });
  process.env.THENCE_SETTLEMENT_FINALITY_JSON = JSON.stringify({ [String(ARBITRUM_CHAIN_ID)]: { mode: "finalized", confirmations: 1 } });
  resetSatoraCachesForTests();
  installProvider();
  const clientInstance = await getSatoraClient();
  quoteSpy = vi.spyOn(clientInstance, "getQuote").mockImplementation((async (request: { targetAmount?: bigint; targetChain?: string; targetToken?: string }) => {
    expect(request.targetChain).toBe(String(ARBITRUM_CHAIN_ID));
    expect(request.targetToken?.toLowerCase()).toBe(NATIVE_USDC);
    expect((request.targetAmount as bigint).toString()).toBe(TARGET_AMOUNT);
    return {
      net_target_amount: TARGET_AMOUNT,
      target_amount: TARGET_AMOUNT,
      net_source_amount: "3004",
      source_amount: "3000",
      network_fee: 4,
      gasless_network_fee: 0,
      protocol_fee: 0,
      protocol_fee_rate: 0,
      exchange_rate: "100000000",
      min_amount: 1_000,
      max_amount: 20_000_000,
    };
  }) as never);
});

beforeEach(() => {
  if (!LIVE) return;
  provider.clear();
  funded.clear();
  refundReceipts.clear();
  claimTransactions.clear();
  claimReceipts.clear();
  lifecycleStates.clear();
  lifecycleLogs.length = 0;
  latestBlock = CHAIN_HEAD;
  finalizedBlock = CHAIN_HEAD;
  chainDown = false;
  logsDown = false;
  lifecycleDown = false;
  headerMismatch = false;
  resetSatoraCachesForTests();
  installProvider();
  setSettlementChainForTests(syntheticChain());
});

afterAll(async () => {
  setSatoraFetchersForTests(null);
  setSettlementChainForTests(null);
  resetSatoraCachesForTests();
  quoteSpy?.mockRestore();
  if (!LIVE) return;
  for (const id of createdTransferIds) await getDb().delete(jobLeases).where(eq(jobLeases.name, `claim:${id}`));
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.skipIf(!LIVE)("A3b Arbitrum failure and recovery lifecycle (isolated database)", () => {
  it("keeps a pending payment recoverable when the provider is unavailable", async () => {
    const p = await createAuthorizedPayment("provider-down");
    provider.set(p.swapId, "unavailable");
    const failed = await reconcile(p, "provider-down");
    expect(failed.status).toBe(503);
    expect((await errorBody(failed)).error).toBe("PROVIDER_UNAVAILABLE");
    expect(await statusOf(p.id)).toBe("LIGHTNING_HANDOFF");
    const observation = (await getDb().select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, p.id))).at(-1);
    expect(observation).toMatchObject({ providerStatus: "unknown", kind: "provider_error", errorCode: "PROVIDER_UNAVAILABLE" });
    expect(await terminalRows(p.id)).toHaveLength(0);
    await expect(assertFundingExposure(p.userId, TARGET_AMOUNT, testPilot)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });

    putSwap(p, { status: "clientfunded" });
    const recovered = await reconcile(p, "provider-recovered");
    expect(recovered.status).toBe(200);
    expect(await statusOf(p.id)).toBe("CLIENT_FUNDED");
    expect(await terminalRows(p.id)).toHaveLength(0);
    await expectConsistent(p.id);
  }, 180_000);

  it("closes expired-unfunded Arbitrum only after finalized no-activity evidence and releases exposure atomically", async () => {
    const p = await createAuthorizedPayment("expiry-safe");
    await reportUnknown(p);
    await expireProviderSwap(p);
    expect(await statusOf(p.id)).toBe("RECONCILING");
    await expect(assertFundingExposure(p.userId, TARGET_AMOUNT, testPilot)).rejects.toMatchObject({ code: "PAYMENT_EXPOSURE_UNCERTAIN" });

    const closed = await closeExpired(p, "safe");
    expect(closed.status).toBe(200);
    expect(closed.body.resolution).toMatchObject({ transferId: p.id, status: "EXPIRED_UNFUNDED", deduplicated: false });
    expect(await statusOf(p.id)).toBe("EXPIRED_UNFUNDED");
    const audit = (await terminalRows(p.id))[0]!;
    expect(audit).toMatchObject({ fromStatus: "RECONCILING", toStatus: "EXPIRED_UNFUNDED", actor: "owner", actorUserId: p.userId, reasonCode: "EXPIRED_UNFUNDED_VERIFIED" });
    expect(audit.evidence).toMatchObject({
      chain: { chainId: ARBITRUM_CHAIN_ID, htlcAddress: ARBITRUM_HTLC, hashLock: p.hashLock.toLowerCase(), verdict: "NO_ACTIVITY", activityMatching: "hash_lock_conservative" },
      nimiq: { nimiqFundingRecorded: false, refundProof: "NOT_OBSERVABLE_BY_THENCE" },
    });
    const expiryProofs = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id));
    expect(expiryProofs).toHaveLength(1);
    expect(expiryProofs[0]).toMatchObject({ satoraSwapId: p.swapId, lightningHash: p.hashLock, evmTxHash: null, verifiedAt: null });
    await expect(assertFundingExposure(p.userId, TARGET_AMOUNT, testPilot)).resolves.toBeUndefined();

    const repeat = await closeExpired(p, "safe-repeat");
    expect(repeat.status).toBe(200);
    expect(repeat.body.resolution).toMatchObject({ status: "EXPIRED_UNFUNDED", deduplicated: true });
    expect(await terminalRows(p.id)).toHaveLength(1);
    await expectConsistent(p.id);
  }, 180_000);

  it("refuses expiry closure for same-hash activity, missing finality or network failure, then recovers only on a clean finalized scan", async () => {
    const p = await createAuthorizedPayment("expiry-fail-closed");
    await reportUnknown(p);
    await expireProviderSwap(p);

    lifecycleLogs.push(fundingLog(p, hex32("different-same-hash-key"), CHAIN_HEAD - 6_000n));
    const activity = await closeExpired(p, "same-hash-activity");
    expect(activity.status).toBe(409);
    expect(activity.body.error).toBe("CHAIN_ACTIVITY_FOUND");
    expect(await statusOf(p.id)).toBe("RECONCILING");
    expect(await terminalRows(p.id)).toHaveLength(0);

    lifecycleLogs.length = 0;
    finalizedBlock = null;
    const noFinality = await closeExpired(p, "missing-finality");
    expect(noFinality.status).toBe(409);
    expect(noFinality.body.error).toBe("CHAIN_INCONCLUSIVE");
    expect(await statusOf(p.id)).toBe("RECONCILING");

    finalizedBlock = CHAIN_HEAD;
    chainDown = true;
    const unavailable = await closeExpired(p, "chain-down");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe("CHAIN_UNAVAILABLE");
    expect(await statusOf(p.id)).toBe("RECONCILING");

    chainDown = false;
    const recovered = await closeExpired(p, "final-retry");
    expect(recovered.status).toBe(200);
    expect(recovered.body.resolution).toMatchObject({ status: "EXPIRED_UNFUNDED", deduplicated: false });
    expect(await statusOf(p.id)).toBe("EXPIRED_UNFUNDED");
    expect(await terminalRows(p.id)).toHaveLength(1);
    await expectConsistent(p.id);
  }, 180_000);

  it("never marks an Arbitrum provider refund verified without the exact finalized SwapKey evidence", async () => {
    const p = await createAuthorizedPayment("refund-evidence");
    await fundPayment(p);
    const refundTx = hex32("refund-correct");
    const wrongTx = hex32("refund-wrong");
    const wrongKey = hex32("refund-wrong-key");

    // Provider says refunded, but its pointer is not mined: no terminal transition.
    putSwap(p, { status: "clientfundedserverrefunded", evm_fund_txid: p.fundTx, evm_claim_txid: refundTx });
    let response = await reconcile(p, "refund-missing");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    expect((await errorBody(response)).error).toBeUndefined();
    expect((await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.toStatus, "REFUNDED")))).length).toBe(0);

    // Another same-hash swap's key cannot be borrowed from its receipt or log.
    refundReceipts.set(wrongTx.toLowerCase(), { status: "success", hashLock: p.hashLock, swapKey: wrongKey });
    lifecycleLogs.push(refundLog(p, wrongTx, wrongKey));
    putSwap(p, { status: "clientfundedserverrefunded", evm_fund_txid: p.fundTx, evm_claim_txid: wrongTx });
    response = await reconcile(p, "refund-wrong-key");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    // A matching receipt that is not in finalized ancestry is still unresolved.
    refundReceipts.set(refundTx.toLowerCase(), { status: "success", hashLock: p.hashLock, swapKey: expectedKey(p) });
    putSwap(p, { status: "clientfundedserverrefunded", evm_fund_txid: p.fundTx, evm_claim_txid: refundTx });
    finalizedBlock = REFUND_BLOCK - 1n;
    response = await reconcile(p, "refund-unfinalized");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    finalizedBlock = null;
    response = await reconcile(p, "refund-no-finality");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    finalizedBlock = CHAIN_HEAD;
    headerMismatch = true;
    response = await reconcile(p, "refund-reorg");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    headerMismatch = false;
    chainDown = true;
    response = await reconcile(p, "refund-network-down");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    // Missing provider pointer is recoverable only through the exact finalized receipt/log.
    chainDown = false;
    refundReceipts.set(refundTx.toLowerCase(), { status: "success", hashLock: p.hashLock, swapKey: expectedKey(p) });
    lifecycleLogs.push(refundLog(p, refundTx));
    putSwap(p, { status: "clientfundedserverrefunded", evm_fund_txid: p.fundTx, evm_claim_txid: null });
    response = await reconcile(p, "refund-verified");
    expect(response.status).toBe(200);
    expect(await statusOf(p.id)).toBe("REFUNDED");

    const audit = (await terminalRows(p.id))[0]!;
    expect(audit.evidence).toMatchObject({
      refundVerified: true,
      refundScope: "arbitrum_htlc",
      refundTxHash: refundTx.toLowerCase(),
      refundEvidenceSource: "htlc_log_scan",
      nimiqSideRefund: "not_observable",
    });
    const refundProofs = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id));
    expect(refundProofs).toHaveLength(1);
    expect(refundProofs[0]).toMatchObject({ satoraSwapId: p.swapId, lightningHash: p.hashLock, evmTxHash: null, verifiedAt: null });
    await expect(assertFundingExposure(p.userId, TARGET_AMOUNT, testPilot)).resolves.toBeUndefined();

    const duplicate = await reconcile(p, "refund-repeat");
    expect(duplicate.status).toBe(200);
    expect(await statusOf(p.id)).toBe("REFUNDED");
    expect(await terminalRows(p.id)).toHaveLength(1);
    const claimAfterRefund = await authorizeClaim(p);
    expect(claimAfterRefund.status).toBe(409);
    expect((await errorBody(claimAfterRefund)).error).toBe("NOT_CLAIMABLE");
    await expectConsistent(p.id);
  }, 180_000);

  it("keeps an unknown claim unresolved until the lease and independent original-key evidence permit retry", async () => {
    const p = await createAuthorizedPayment("claim-retry");
    await fundPayment(p);
    const first = await authorizeClaim(p);
    expect(first.status).toBe(200);
    const firstIntent = (await first.clone().json()) as { claim: { leaseExpiresAt: string; claimDeadline: string } };
    expect(new Date(firstIntent.claim.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(firstIntent.claim.claimDeadline).getTime()).toBeGreaterThan(Date.now());
    expect(await statusOf(p.id)).toBe("CLAIMING");
    expect(await getDb().select().from(jobLeases).where(eq(jobLeases.name, `claim:${p.id}`))).toHaveLength(1);
    expect((await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.reasonCode, "CLAIM_AUTHORIZED")))).length).toBe(1);

    const liveLeaseRetry = await authorizeClaim(p);
    expect(liveLeaseRetry.status).toBe(409);
    expect((await errorBody(liveLeaseRetry)).error).toBe("CLAIM_IN_PROGRESS");
    expect(await statusOf(p.id)).toBe("CLAIMING");

    await expireClaimLease(p.id);
    logsDown = true;
    let retry = await authorizeClaim(p);
    expect(retry.status).toBe(503);
    expect((await errorBody(retry)).error).toBe("CLAIM_OUTCOME_UNRESOLVED");
    expect(await statusOf(p.id)).toBe("CLAIMING");

    logsDown = false;
    finalizedBlock = null;
    retry = await authorizeClaim(p);
    expect(retry.status).toBe(503);
    expect((await errorBody(retry)).error).toBe("CHAIN_UNAVAILABLE");
    expect(await statusOf(p.id)).toBe("CLAIMING");

    finalizedBlock = CHAIN_HEAD;
    lifecycleStates.set(expectedKey(p).toLowerCase(), HTLC_SWAP_STATE.REHASHED);
    retry = await authorizeClaim(p);
    expect(retry.status).toBe(409);
    expect((await errorBody(retry)).error).toBe("HTLC_NOT_ACTIVE");
    expect(await statusOf(p.id)).toBe("CLAIMING");
    expect(await getDb().select().from(swapAttachments).where(eq(swapAttachments.transferId, p.id))).toHaveLength(1);

    // A redeem event for the original key is spent evidence, never retry permission.
    lifecycleStates.set(expectedKey(p).toLowerCase(), HTLC_SWAP_STATE.ACTIVE);
    lifecycleLogs.push({
      address: ARBITRUM_HTLC,
      topics: ["0x935f11873f0f4154186d30d8d4181c7694ac59f800873f9c44b0a5122043660a", p.hashLock, expectedKey(p)],
      data: "0x",
      logIndex: 5,
      transactionHash: hex32("original-redeemed"),
      blockNumber: REFUND_BLOCK,
    });
    await expireClaimLease(p.id);
    retry = await authorizeClaim(p);
    expect(retry.status).toBe(409);
    expect((await errorBody(retry)).error).toBe("CLAIM_ALREADY_SUBMITTED");
    expect(await statusOf(p.id)).toBe("CLAIMING");

    // Remove the spent event: only then can the expired lease plus a stable,
    // finalized, active and unspent original key authorize one retry.
    lifecycleLogs.splice(lifecycleLogs.findIndex((log) => log.topics[0] === "0x935f11873f0f4154186d30d8d4181c7694ac59f800873f9c44b0a5122043660a"), 1);
    await expireClaimLease(p.id);
    retry = await authorizeClaim(p);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { claim: { retry: boolean } }).claim.retry).toBe(true);
    expect(await statusOf(p.id)).toBe("CLAIMING");
    expect((await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.reasonCode, "CLAIM_AUTHORIZED")))).length).toBe(1);

    // A later provider redemption can deliver once, but never twice or again by claim intent.
    const claimTx = hex32("claim-after-retry");
    simulateClaim(p, claimTx);
    lifecycleStates.set(expectedKey(p).toLowerCase(), HTLC_SWAP_STATE.REDEEMED);
    await ageObservations(p.id);
    const delivered = await runServerReconciliation({ scope: [p.id], leaseName: `a3b-${RUN}-claim-delivery` });
    expect(delivered.advanced).toContainEqual({ transferId: p.id, from: "CLAIMING", to: "DELIVERED" });
    expect(await statusOf(p.id)).toBe("DELIVERED");
    expect(await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id))).toHaveLength(1);

    await ageObservations(p.id);
    const repeat = await runServerReconciliation({ scope: [p.id], leaseName: `a3b-${RUN}-claim-delivery-repeat` });
    expect(repeat.advanced.filter((item) => item.to === "DELIVERED")).toHaveLength(0);
    expect(await terminalRows(p.id)).toHaveLength(1);
    const claimAfterDelivery = await authorizeClaim(p);
    expect(claimAfterDelivery.status).toBe(409);
    expect((await errorBody(claimAfterDelivery)).error).toBe("NOT_CLAIMABLE");
    await expectConsistent(p.id);
  }, 180_000);
});
