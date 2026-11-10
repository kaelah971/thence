/**
 * A3a — one complete NIM-authenticated → native-USDC-on-Arbitrum lifecycle.
 *
 * This is a database-backed integration slice. The real route handlers, domain
 * transitions, provider verification, Arbitrum HTLC gates, settlement proof
 * and receipt paths run unchanged; only the wallet, Satora and chain are
 * deterministic fixtures. The suite is explicitly skipped unless Vitest has
 * installed the anchor-proven isolated test database.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { jobLeases, transferProofs, transferTransitions, transfers, users } from "@/db/schema";
import { getSatoraClient, resetSatoraCachesForTests, resolveRoute, setSatoraFetchersForTests } from "@/lib/satora";
import {
  HTLC_SWAP_STATE,
  SWAP_FUNDED_EVENT_TOPIC,
  TRANSFER_EVENT_TOPIC,
  computeHtlcSwapKey,
  setSettlementChainForTests,
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
import { POST as claimIntentPost } from "../app/api/transfers/[id]/claim-intent/route";
import { GET as receiptGet } from "../app/api/transfers/[id]/receipt/route";

const ARBITRUM_CHAIN_ID = 42161;
const NATIVE_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_E = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8";
const ARBITRUM_HTLC = "0x6c38bf44a327bf36bfbefcedc514c0fb3fec6748";
const ARBITRUM_WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";
const HTLC_REFUND_ADDRESS = "0x5ce278aaec6d9fa67bfcaf98512fe5175dfeebac";
const HTLC_CLAIM_ADDRESS = "0x204e6e1ba85effb5212042ff16b4205ce6cddddd";
const RECIPIENT = "0x0000000000000000000000000000000000000001";
const WRONG_RECIPIENT = "0x0000000000000000000000000000000000000002";
const HTLC_AMOUNT = 392n;
const TARGET_AMOUNT = "300000";
const FUND_BLOCK = 90_000_000n;
const CLAIM_BLOCK = 90_000_500n;
const FUND_BLOCK_HASH = `0x${"f0".repeat(32)}`;
const CLAIM_BLOCK_HASH = `0x${"c1".repeat(32)}`;
const ZERO_PREIMAGE = `0x${"00".repeat(32)}`;

const hex32 = (tag: string): string => `0x${createHash("sha256").update(`a3a-${RUN}-${tag}`).digest("hex")}`;
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

const provider = new Map<string, Record<string, unknown>>();
const funded = new Map<string, Pay>();
const claimTransactions = new Set<string>();
const claimReceipts = new Map<string, ClaimReceipt>();
const lifecycleStates = new Map<string, number>();
const lifecycleReads: Array<{ key: string; block: bigint }> = [];
const createdUserIds: string[] = [];
const createdTransferIds: string[] = [];
let latestBlock = FUND_BLOCK + 1_000n;
let finalizedBlock: bigint | null = FUND_BLOCK;
let clientCounter = 0;
let quoteSpy: { mockRestore: () => void } | null = null;
const savedEnv: Record<string, string | undefined> = {};

const client = (tag: string): Record<string, string> => ({
  "x-forwarded-for": `a3a-${RUN}-${tag}-${clientCounter++}`,
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

function fundingData(p: Pay): string {
  return `0x${addressWord(ARBITRUM_WBTC)}${word(HTLC_AMOUNT)}${word(p.lock)}${expectedKey(p).slice(2)}`;
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

function installProvider(): void {
  setSatoraFetchersForTests({
    getTokens: async () => ({
      evm_tokens: [
        { token_id: NATIVE_USDC, symbol: "USDC", chain: String(ARBITRUM_CHAIN_ID), decimals: 6 },
        { token_id: USDC_E, symbol: "USDC", chain: String(ARBITRUM_CHAIN_ID), decimals: 6 },
      ],
    }),
    getSwapPairs: async () => ({ pairs: [{ source: "Lightning", target: String(ARBITRUM_CHAIN_ID), min_sats: 1_000, max_sats: 20_000_000 }] }),
    getSwap: async (id: string) => {
      const swap = provider.get(id);
      if (!swap) throw Object.assign(new Error("swap not found"), { code: 404 });
      return { ...swap, id };
    },
  });
}

function syntheticChain(): ChainReads {
  return {
    async getTransaction(_chainId, hash) {
      const normalized = hash.toLowerCase();
      if (funded.has(normalized)) return { hash, blockNumber: FUND_BLOCK };
      if (claimTransactions.has(normalized)) return { hash, blockNumber: CLAIM_BLOCK };
      return null;
    },
    async getReceipt(_chainId, hash) {
      const normalized = hash.toLowerCase();
      const p = funded.get(normalized);
      if (p) {
        return {
          status: "success",
          blockNumber: FUND_BLOCK,
          blockHash: FUND_BLOCK_HASH,
          logs: [{
            address: ARBITRUM_HTLC,
            topics: [SWAP_FUNDED_EVENT_TOPIC, p.hashLock, addressTopic(HTLC_REFUND_ADDRESS), addressTopic(HTLC_CLAIM_ADDRESS)],
            data: fundingData(p),
            logIndex: 1,
          }],
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
      return latestBlock;
    },
    async getFinalizedBlockNumber() {
      return finalizedBlock;
    },
    async getBlockHash(_chainId, blockNumber) {
      if (blockNumber === FUND_BLOCK) return FUND_BLOCK_HASH;
      if (blockNumber === CLAIM_BLOCK) return CLAIM_BLOCK_HASH;
      return `0x${"a2".repeat(32)}`;
    },
    async getHtlcSwapState(_chainId, _address, key, blockNumber) {
      lifecycleReads.push({ key: key.toLowerCase(), block: blockNumber });
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

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

async function ageObservations(id: string): Promise<void> {
  await getDb().execute(sql`UPDATE reconciliation_observations SET observed_at = observed_at - make_interval(mins => 10) WHERE transfer_id = ${id}::uuid`);
}

async function createAuthorizedPayment(tag: string): Promise<Pay> {
  const wallet = fixtureWallet();
  const { cookie, userId } = await loginAs(client(`login-${tag}`), (id) => createdUserIds.push(id), wallet);
  const created = await createTransfer(
    postJson(
      "http://localhost/api/transfers",
      {
        routeId: "usdc-arbitrum",
        targetAmountAtomic: TARGET_AMOUNT,
        idempotencyKey: `a3a-${RUN}-${tag}`,
        direct: { asset: "USDC", network: "Arbitrum", address: RECIPIENT },
      },
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
  expect(await statusOf(p.id)).toBe("QUOTED");

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
  lifecycleStates.set(expectedKey(p).toLowerCase(), HTLC_SWAP_STATE.ACTIVE);
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
  putSwap(p, { status: "serverfunded", evm_fund_txid: p.fundTx });
  response = await reconcilePost(
    postJson(`http://localhost/api/transfers/${p.id}/reconcile`, {}, { cookie: p.cookie, ...client(`${p.tag}-serverfunded`) }),
    params(p.id),
  );
  expect(response.status).toBe(200);
  expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
}

async function authorizeClaim(p: Pay): Promise<Response> {
  return claimIntentPost(
    postJson(`http://localhost/api/transfers/${p.id}/claim-intent`, {}, { cookie: p.cookie, ...client(`${p.tag}-claim`) }),
    params(p.id),
  );
}

function simulateProviderClaim(p: Pay, claimTx: string, receipt: ClaimReceipt | null): void {
  claimTransactions.add(claimTx.toLowerCase());
  if (receipt) claimReceipts.set(claimTx.toLowerCase(), receipt);
  latestBlock = CLAIM_BLOCK + 300n;
  finalizedBlock = CLAIM_BLOCK;
  putSwap(p, { status: "clientredeemed", evm_fund_txid: p.fundTx, evm_claim_txid: claimTx });
}

async function reconcileClaim(p: Pay, runTag: string): Promise<Awaited<ReturnType<typeof runServerReconciliation>>> {
  await ageObservations(p.id);
  return runServerReconciliation({ scope: [p.id], leaseName: `a3a-${RUN}-${runTag}` });
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
  quoteSpy = vi.spyOn(clientInstance, "getQuote").mockImplementation((async (request: { targetAmount?: bigint; targetChain?: number; targetToken?: string }) => {
    expect(request.targetChain).toBe(ARBITRUM_CHAIN_ID);
    expect(request.targetToken?.toLowerCase()).toBe(NATIVE_USDC);
    const target = request.targetAmount as bigint;
    expect(target.toString()).toBe(TARGET_AMOUNT);
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
  claimTransactions.clear();
  claimReceipts.clear();
  lifecycleStates.clear();
  lifecycleReads.length = 0;
  latestBlock = FUND_BLOCK + 1_000n;
  finalizedBlock = FUND_BLOCK;
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

describe.skipIf(!LIVE)("A3a Arbitrum native USDC payment lifecycle (isolated database)", () => {
  it("resolves native USDC and completes quote → handoff → finalized HTLC → claim → settlement receipt → DELIVERED", async () => {
    const route = await resolveRoute("USDC", "Arbitrum");
    expect(route).toMatchObject({ chainId: ARBITRUM_CHAIN_ID, tokenAddress: NATIVE_USDC, tokenDecimals: 6 });

    const p = await createAuthorizedPayment("happy");
    await fundPayment(p);
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    const claim = await authorizeClaim(p);
    expect(claim.status).toBe(200);
    const intent = ((await claim.json()) as { claim: Record<string, unknown> }).claim;
    expect(intent).toMatchObject({
      transferId: p.id,
      status: "CLAIMING",
      satoraSwapId: p.swapId,
      paymentHash: p.hashLock,
      destination: RECIPIENT,
      targetAmountAtomic: TARGET_AMOUNT,
      retry: false,
    });
    expect(typeof intent.fundingConfirmations).toBe("number");
    expect(await statusOf(p.id)).toBe("CLAIMING");

    const key = expectedKey(p).toLowerCase();
    expect(lifecycleReads.length).toBeGreaterThanOrEqual(2);
    expect(lifecycleReads.every((read) => read.key === key)).toBe(true);
    expect(lifecycleReads.some((read) => read.block === FUND_BLOCK)).toBe(true);
    expect(lifecycleReads.some((read) => read.block === FUND_BLOCK + 1_000n)).toBe(true);

    const claimTx = hex32("claim-happy");
    simulateProviderClaim(p, claimTx, { status: "success", to: RECIPIENT, amount: BigInt(TARGET_AMOUNT), token: NATIVE_USDC });
    const firstRun = await reconcileClaim(p, "happy");
    expect(firstRun.advanced).toContainEqual({ transferId: p.id, from: "CLAIMING", to: "DELIVERED" });
    expect(await statusOf(p.id)).toBe("DELIVERED");

    const proofRows = await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id));
    expect(proofRows).toHaveLength(1);
    expect(proofRows[0]).toMatchObject({
      chainId: ARBITRUM_CHAIN_ID,
      tokenContract: NATIVE_USDC,
      recipient: RECIPIENT,
      verifiedAmountAtomic: TARGET_AMOUNT,
      evmTxHash: claimTx,
      finalityLevel: "finalized",
    });

    const transitions = await getDb()
      .select()
      .from(transferTransitions)
      .where(eq(transferTransitions.transferId, p.id))
      .orderBy(asc(transferTransitions.createdAt));
    expect(transitions.map((row) => `${row.fromStatus}->${row.toStatus}`)).toEqual(expect.arrayContaining([
      "QUOTED->SWAP_CREATED",
      "SWAP_CREATED->AWAITING_NIM_APPROVAL",
      "AWAITING_NIM_APPROVAL->LIGHTNING_HANDOFF",
      "LIGHTNING_HANDOFF->CLIENT_FUNDED",
      "CLIENT_FUNDED->SERVER_FUNDED",
      "SERVER_FUNDED->CLAIMING",
      "CLAIMING->DELIVERED",
    ]));

    const receiptRequest = () => new Request(`http://localhost/api/transfers/${p.id}/receipt`, { headers: { cookie: p.cookie } });
    const receiptOne = await receiptGet(receiptRequest(), params(p.id));
    expect(receiptOne.status).toBe(200);
    const receiptBody = (await receiptOne.json()) as { receipt: Record<string, unknown> };
    expect(receiptBody.receipt).toMatchObject({
      transferId: p.id,
      destination: RECIPIENT,
      requestedAmountAtomic: TARGET_AMOUNT,
      verifiedAmountAtomic: TARGET_AMOUNT,
      settlementTxHash: claimTx,
    });

    const secondRun = await reconcileClaim(p, "happy-repeat");
    expect(secondRun.advanced.filter((item) => item.to === "DELIVERED")).toHaveLength(0);
    expect(await statusOf(p.id)).toBe("DELIVERED");
    expect((await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id)))).toHaveLength(1);
    expect((await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.toStatus, "DELIVERED")))).length).toBe(1);
    const receiptTwo = await receiptGet(receiptRequest(), params(p.id));
    expect(await receiptTwo.json()).toEqual(receiptBody);
  }, 180_000);

  it("refuses bridged USDC.e, wrong HTLC identity, rehashed/spent keys, and unfinalized funding", async () => {
    const previousTokens = process.env.THENCE_ROUTE_TOKENS_JSON;
    process.env.THENCE_ROUTE_TOKENS_JSON = JSON.stringify({ "usdc-arbitrum": USDC_E });
    resetSatoraCachesForTests();
    await expect(resolveRoute("USDC", "Arbitrum")).rejects.toThrow(/trusted native token identity/i);
    process.env.THENCE_ROUTE_TOKENS_JSON = previousTokens;
    resetSatoraCachesForTests();

    const p = await createAuthorizedPayment("claim-gates");
    await fundPayment(p);
    const good = swapShape(p, { status: "serverfunded", evm_fund_txid: p.fundTx });

    provider.set(p.swapId, { ...good, target_token: { chain: String(ARBITRUM_CHAIN_ID), decimals: 6, name: "USD Coin", symbol: "USDC", token_id: USDC_E } });
    let response = await authorizeClaim(p);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("SWAP_MISMATCH");
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    provider.set(p.swapId, { ...good, evm_htlc_address: "0x0000000000000000000000000000000000000009" });
    response = await authorizeClaim(p);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("FUNDING_INVALID");
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    provider.set(p.swapId, { ...good, evm_expected_sats: (HTLC_AMOUNT + 1n).toString() });
    response = await authorizeClaim(p);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("FUNDING_INVALID");
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");

    provider.set(p.swapId, good);
    finalizedBlock = FUND_BLOCK - 1n;
    response = await authorizeClaim(p);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("FUNDING_NOT_CONFIRMED");
    expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
    finalizedBlock = FUND_BLOCK;

    for (const state of [HTLC_SWAP_STATE.REHASHED, HTLC_SWAP_STATE.REDEEMED]) {
      lifecycleStates.set(expectedKey(p).toLowerCase(), state);
      response = await authorizeClaim(p);
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe("HTLC_NOT_ACTIVE");
      expect(await statusOf(p.id)).toBe("SERVER_FUNDED");
      lifecycleStates.set(expectedKey(p).toLowerCase(), HTLC_SWAP_STATE.ACTIVE);
    }
  }, 180_000);

  it.each([
    ["wrong recipient", WRONG_RECIPIENT, BigInt(TARGET_AMOUNT)],
    ["short amount", RECIPIENT, BigInt(TARGET_AMOUNT) - 1n],
  ])("does not deliver when the Arbitrum receipt has a %s", async (_label, recipient, amount) => {
    const p = await createAuthorizedPayment(`settlement-${String(_label).replace(/ /g, "-")}`);
    await fundPayment(p);
    expect((await authorizeClaim(p)).status).toBe(200);
    const claimTx = hex32(`claim-${String(_label)}`);
    simulateProviderClaim(p, claimTx, { status: "success", to: recipient, amount, token: NATIVE_USDC });
    await reconcileClaim(p, `bad-${String(_label)}`);
    expect(await statusOf(p.id)).toBe("CLAIMING");
    expect((await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id))).every((row) => row.verifiedAt === null)).toBe(true);
    expect((await getDb().select().from(transferTransitions).where(and(eq(transferTransitions.transferId, p.id), eq(transferTransitions.toStatus, "DELIVERED")))).length).toBe(0);
  }, 180_000);

  it("does not deliver from provider success without a matching on-chain settlement", async () => {
    const p = await createAuthorizedPayment("provider-only");
    await fundPayment(p);
    expect((await authorizeClaim(p)).status).toBe(200);
    const claimTx = hex32("claim-provider-only");
    simulateProviderClaim(p, claimTx, null);
    await reconcileClaim(p, "provider-only");
    expect(await statusOf(p.id)).toBe("CLAIMING");
    expect((await getDb().select().from(transferProofs).where(eq(transferProofs.transferId, p.id))).every((row) => row.verifiedAt === null && row.evmTxHash === null)).toBe(true);
  }, 180_000);
});
