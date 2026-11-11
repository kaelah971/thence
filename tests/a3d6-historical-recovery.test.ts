/**
 * A3d.6 — historical source-proof recovery.
 *
 * Unit tests replay REAL public chain responses recorded on 2026-11-11
 * (tests/fixtures/a3d6) for the NOV6/NOV7 payments through PR #64's verifier
 * and the dual-RPC Polygon check. Live tests run the operator plan/apply path
 * against the isolated test database inside a transaction that is always
 * rolled back, so no evidence row is ever committed there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { handoffAttempts, swapAttachments, transferProofs, transferSourceEvidence, transfers, users } from "@/db/schema";
import { setNimiqSourceRpcTransportForTests, verifyNimiqSourceTransaction } from "@/lib/nimiq-source";
import {
  applyRecovery,
  CANONICAL_POLYGON_USDC,
  HISTORICAL_RECOVERY_CASES,
  HISTORICAL_RECOVERY_POLICY,
  planRecovery,
  recoveryCase,
  redactPlan,
  setRecoveryEvmTransportForTests,
  verifyPolygonDelivery,
  type PolygonExpectation,
} from "@/lib/historical-proof-recovery";
import { getPublicProof, isPublishableGlobalProof, listPublicProofs, publicProofConfig, toPublicProof, type PublicProofRow } from "@/lib/global-proofs";
import { LIVE } from "./helpers";

const FIX = join(__dirname, "fixtures", "a3d6");
const load = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const OWNER = "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ";
const OTHER_OWNER = "NQ32 7HKC C30M X9NJ AURD EDSG 98H5 UX0R UEQB";

type CaseKey = "nov6" | "nov7";
const fx = (k: CaseKey) => {
  const tx = load(`nimiq-tx-${k}.json`);
  const macro = load(`nimiq-macro-${k}.json`);
  const receipt = load(`polygon-receipt-${k}.json`);
  const block = load(`polygon-block-${k}.json`);
  const data = (tx.result.data ?? tx.result) as Record<string, any>;
  const hashRoot = Buffer.from(data.recipientData, "hex").subarray(41, 73).toString("hex");
  const r = receipt.result;
  const c = k === "nov6" ? recoveryCase("NOV6")! : recoveryCase("NOV7")!;
  // Delivery log index recorded in the production proof rows (A3d.3/A3d.4).
  const deliveryIdx = k === "nov6" ? 594 : 957;
  const delivery = (r.logs as any[]).find((l) => parseInt(l.logIndex, 16) === deliveryIdx)!;
  return {
    c,
    tx,
    macro,
    receipt,
    block,
    hashRoot,
    destination: `0x${(delivery.topics[2] as string).slice(-40)}`,
    amount: BigInt(delivery.data).toString(),
    blockNumber: parseInt(r.blockNumber, 16),
    blockHash: (r.blockHash as string).toLowerCase(),
    logIndex: deliveryIdx,
  };
};
const NOV6 = fx("nov6");
const NOV7 = fx("nov7");
const BY_NIM: Record<string, ReturnType<typeof fx>> = { [NOV6.c.nimiqTxHash]: NOV6, [NOV7.c.nimiqTxHash]: NOV7 };
const BY_MACRO: Record<number, ReturnType<typeof fx>> = {
  [NOV6.macro.result.data?.number ?? NOV6.macro.result.number]: NOV6,
  [NOV7.macro.result.data?.number ?? NOV7.macro.result.number]: NOV7,
};
const BY_EVM: Record<string, ReturnType<typeof fx>> = { [NOV6.c.polygonTxHash]: NOV6, [NOV7.c.polygonTxHash]: NOV7 };
const FINALIZED = load("polygon-finalized.json");

function installNimiq(opts: { fail?: boolean; mutate?: (data: Record<string, any>) => void } = {}): void {
  setNimiqSourceRpcTransportForTests(async (_url, body) => {
    if (opts.fail) throw new Error("down");
    const req = JSON.parse(body) as { method: string; params: unknown[] };
    if (req.method === "getTransactionByHash") {
      const f = BY_NIM[String(req.params[0])];
      if (!f) return { jsonrpc: "2.0", id: 1, result: null };
      const copy = structuredClone(f.tx);
      opts.mutate?.(copy.result.data ?? copy.result);
      return copy;
    }
    if (req.method === "getBlockByNumber") {
      const f = BY_MACRO[Number(req.params[0])];
      return f ? f.macro : { jsonrpc: "2.0", id: 1, result: null };
    }
    return { jsonrpc: "2.0", id: 1, error: { message: "unexpected" } };
  });
}

function installEvm(overrides: Record<string, (method: string, params: unknown[]) => unknown> = {}): void {
  setRecoveryEvmTransportForTests(async (url, body) => {
    const req = JSON.parse(body) as { method: string; params: unknown[] };
    const o = overrides[url];
    if (o) {
      const v = o(req.method, req.params);
      if (v !== undefined) return v;
    }
    if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: 1, result: "0x89" };
    if (req.method === "eth_getTransactionReceipt") return BY_EVM[String(req.params[0])]?.receipt ?? { jsonrpc: "2.0", id: 1, result: null };
    if (req.method === "eth_getBlockByNumber") {
      if (req.params[0] === "finalized") return FINALIZED;
      const f = Object.values(BY_EVM).find((x) => x.receipt.result.blockNumber === req.params[0]);
      return f ? f.block : { jsonrpc: "2.0", id: 1, result: null };
    }
    return { jsonrpc: "2.0", id: 1, error: { message: "unexpected" } };
  });
}

function expectation(f: ReturnType<typeof fx>, over: Partial<PolygonExpectation> = {}): PolygonExpectation {
  return {
    txHash: f.c.polygonTxHash,
    tokenContract: CANONICAL_POLYGON_USDC,
    recipient: f.destination,
    amountAtomic: f.amount,
    blockNumber: f.blockNumber,
    blockHash: f.blockHash,
    logIndexes: [f.logIndex],
    ...over,
  };
}

const nimiqConfig = {
  url: HISTORICAL_RECOVERY_POLICY.nimiq.url,
  network: "mainnet" as const,
  minConfirmations: HISTORICAL_RECOVERY_POLICY.nimiq.minConfirmations,
};

afterEach(() => {
  setNimiqSourceRpcTransportForTests(null);
  setRecoveryEvmTransportForTests(null);
});

describe("A3d.6 allowlist", () => {
  it("is closed to exactly NOV6 and NOV7 with the investigation identifiers", () => {
    expect(HISTORICAL_RECOVERY_CASES.map((c) => c.caseId)).toEqual(["NOV6", "NOV7"]);
    expect(recoveryCase("NOV8")).toBeNull();
    expect(NOV6.c.expectedAmountLuna).toBe("114389614");
    expect(NOV7.c.expectedAmountLuna).toBe("108885558");
  });
});

describe("A3d.6 Nimiq source (PR #64 verifier on recorded mainnet data)", () => {
  for (const f of [NOV6, NOV7]) {
    it(`${f.c.caseId}: verifies HTLC, full 256-bit hash root, owner signature and macro inclusion`, async () => {
      installNimiq();
      const r = await verifyNimiqSourceTransaction({
        txHash: f.c.nimiqTxHash,
        ownerAddress: OWNER,
        lightningPaymentHash: f.hashRoot,
        expectedAmountLuna: f.c.expectedAmountLuna,
        config: nimiqConfig,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.evidence.senderBinding).toBe("HTLC_OWNER_SIGNATURE");
        expect(r.evidence.amountLuna).toBe(f.c.expectedAmountLuna);
        expect(r.evidence.network).toBe("mainnet");
      }
    });
  }

  it("wrong hash: a payment hash differing in one bit is refused", async () => {
    installNimiq();
    const flipped = (parseInt(NOV6.hashRoot[63]!, 16) ^ 1).toString(16);
    const r = await verifyNimiqSourceTransaction({
      txHash: NOV6.c.nimiqTxHash,
      ownerAddress: OWNER,
      lightningPaymentHash: NOV6.hashRoot.slice(0, 63) + flipped,
      config: nimiqConfig,
    });
    expect(r).toEqual({ ok: false, code: "PAYMENT_HASH_MISMATCH" });
  });

  it("incorrect owner: another wallet cannot claim the source", async () => {
    installNimiq();
    const r = await verifyNimiqSourceTransaction({ txHash: NOV6.c.nimiqTxHash, ownerAddress: OTHER_OWNER, lightningPaymentHash: NOV6.hashRoot, config: nimiqConfig });
    expect(r).toEqual({ ok: false, code: "WRONG_SENDER" });
  });

  it("forgery: altering the signed amount breaks the owner signature binding", async () => {
    installNimiq({ mutate: (d) => { d.value = Number(d.value) + 1; } });
    const r = await verifyNimiqSourceTransaction({ txHash: NOV6.c.nimiqTxHash, ownerAddress: OWNER, lightningPaymentHash: NOV6.hashRoot, config: nimiqConfig });
    expect(r.ok).toBe(false);
  });

  it("forgery: a response for a different transaction hash is refused", async () => {
    installNimiq({ mutate: (d) => { d.hash = NOV7.c.nimiqTxHash; } });
    const r = await verifyNimiqSourceTransaction({ txHash: NOV6.c.nimiqTxHash, ownerAddress: OWNER, lightningPaymentHash: NOV6.hashRoot, config: nimiqConfig });
    expect(r).toEqual({ ok: false, code: "HASH_MISMATCH" });
  });

  it("wrong amount expectation is refused", async () => {
    installNimiq();
    const r = await verifyNimiqSourceTransaction({
      txHash: NOV6.c.nimiqTxHash, ownerAddress: OWNER, lightningPaymentHash: NOV6.hashRoot, expectedAmountLuna: "114389615", config: nimiqConfig,
    });
    expect(r).toEqual({ ok: false, code: "AMOUNT_MISMATCH" });
  });

  it("RPC failure fails closed", async () => {
    installNimiq({ fail: true });
    const r = await verifyNimiqSourceTransaction({ txHash: NOV6.c.nimiqTxHash, ownerAddress: OWNER, lightningPaymentHash: NOV6.hashRoot, config: nimiqConfig });
    expect(r).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("A3d.6 Polygon destination (dual public RPC)", () => {
  const [A, B] = HISTORICAL_RECOVERY_POLICY.polygon;

  for (const f of [NOV6, NOV7]) {
    it(`${f.c.caseId}: receipt, chain, canonical USDC, full recipient, exact amount, log and finality agree on both RPCs`, async () => {
      installEvm();
      const r = await verifyPolygonDelivery(expectation(f));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.observations.map((o) => o.label)).toEqual(HISTORICAL_RECOVERY_POLICY.polygon.map((p) => p.label));
    });
  }

  it("requires a second source", async () => {
    installEvm();
    expect(await verifyPolygonDelivery(expectation(NOV6), [A!])).toEqual({ ok: false, code: "EVM_SECOND_SOURCE_REQUIRED" });
  });

  it.each([
    ["full recipient mismatch", { recipient: "0x17de000000000000000000000000000000005a15" }, "EVM_NO_RECIPIENT_TRANSFER"],
    ["exact amount mismatch", { amountAtomic: "300000" }, "EVM_AMOUNT_MISMATCH"],
    ["non-canonical token", { tokenContract: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" }, "EVM_NO_RECIPIENT_TRANSFER"],
    ["block mismatch", { blockNumber: 1 }, "EVM_BLOCK_MISMATCH"],
    ["block hash mismatch", { blockHash: `0x${"00".repeat(32)}` }, "EVM_BLOCK_HASH_MISMATCH"],
    ["log index mismatch", { logIndexes: [591] }, "EVM_LOG_INDEX_MISMATCH"],
  ])("fails closed on %s", async (_n, over, code) => {
    installEvm();
    const r = await verifyPolygonDelivery(expectation(NOV6, over as Partial<PolygonExpectation>));
    expect(r).toMatchObject({ ok: false, code });
  });

  it("fails closed when the second RPC is unavailable", async () => {
    installEvm({ [B!.url]: () => { throw new Error("down"); } });
    expect(await verifyPolygonDelivery(expectation(NOV6))).toEqual({ ok: false, code: "EVM_RPC_UNAVAILABLE", label: B!.label });
  });

  it("fails closed on RPC disagreement (second RPC reports a different block hash)", async () => {
    installEvm({
      [B!.url]: (m, p) => {
        if (m !== "eth_getTransactionReceipt") return undefined;
        const copy = structuredClone(BY_EVM[String(p[0])]!.receipt);
        copy.result.blockHash = `0x${"ee".repeat(32)}`;
        return copy;
      },
    });
    expect(await verifyPolygonDelivery(expectation(NOV6))).toMatchObject({ ok: false, code: "EVM_BLOCK_HASH_MISMATCH", label: B!.label });
  });

  it("fails closed when not finalized on one RPC", async () => {
    installEvm({ [B!.url]: (m, p) => (m === "eth_getBlockByNumber" && p[0] === "finalized" ? { jsonrpc: "2.0", id: 1, result: { number: "0x1" } } : undefined) });
    expect(await verifyPolygonDelivery(expectation(NOV6))).toMatchObject({ ok: false, code: "EVM_NOT_FINALIZED" });
  });

  it("fails closed on wrong chain and reverted receipt", async () => {
    installEvm({ [A!.url]: (m) => (m === "eth_chainId" ? { jsonrpc: "2.0", id: 1, result: "0x1" } : undefined) });
    expect(await verifyPolygonDelivery(expectation(NOV6))).toMatchObject({ ok: false, code: "EVM_WRONG_CHAIN" });
    installEvm({
      [A!.url]: (m, p) => {
        if (m !== "eth_getTransactionReceipt") return undefined;
        const copy = structuredClone(BY_EVM[String(p[0])]!.receipt);
        copy.result.status = "0x0";
        return copy;
      },
    });
    expect(await verifyPolygonDelivery(expectation(NOV6))).toMatchObject({ ok: false, code: "EVM_RECEIPT_FAILED" });
  });
});

/* ------------------------------------------------------------------ */
/* Live: plan/apply against the isolated test DB, always rolled back    */
/* ------------------------------------------------------------------ */

class Rollback extends Error {}
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

function idWithPrefix(prefix: string): string {
  const u = randomUUID();
  return prefix + u.slice(8);
}

async function seed(
  tx: Tx,
  f: ReturnType<typeof fx>,
  opts: { owner?: string; paymentHash?: string; proofNimiqHash?: string | null; status?: string; transferIdPrefix?: string; evmTxHash?: string } = {},
): Promise<string> {
  const [user] = await tx.insert(users).values({ nimiqAddress: opts.owner ?? OWNER }).returning({ id: users.id });
  const transferId = idWithPrefix(opts.transferIdPrefix ?? f.c.transferIdPrefix);
  await tx.insert(transfers).values({
    id: transferId,
    ownerUserId: user!.id,
    routeId: "usdc-polygon",
    targetAsset: "USDC",
    targetNetwork: "Polygon",
    destination: f.destination,
    targetAmountAtomic: "300000",
    status: opts.status ?? "DELIVERED",
  });
  const [attempt] = await tx
    .insert(handoffAttempts)
    .values({ transferId, attemptTokenHash: randomBytes(32).toString("hex"), quoteRevision: 1, status: "HANDOFF_AUTHORIZED", expiresAt: new Date(Date.now() + 3600e3) })
    .returning({ id: handoffAttempts.id });
  const paymentHash = `0x${opts.paymentHash ?? f.hashRoot}`;
  await tx.insert(swapAttachments).values({
    transferId,
    attemptId: attempt!.id,
    satoraSwapId: `a3d6-test-${randomBytes(8).toString("hex")}`,
    invoiceBolt11: "lnbc-test-not-a-real-invoice",
    paymentHash,
    sourceSats: "403",
    targetAtomic: "300000",
  });
  await tx.insert(transferProofs).values({
    transferId,
    nimiqTxHash: opts.proofNimiqHash ?? null,
    lightningHash: paymentHash,
    evmTxHash: opts.evmTxHash ?? f.c.polygonTxHash,
    evidenceSource: "evm_erc20_transfer",
    chainId: 137,
    tokenContract: CANONICAL_POLYGON_USDC,
    recipient: f.destination,
    verifiedAmountAtomic: f.amount,
    blockNumber: f.blockNumber,
    blockHash: f.blockHash,
    logIndexes: JSON.stringify([f.logIndex]),
    finalityLevel: "confirmations-256",
    verifiedAt: new Date("2026-11-06T21:38:21.965Z"),
  });
  return transferId;
}

const META = { operatorRef: "A3D6-TEST", verifierVersion: "0123456789abcdef0123456789abcdef01234567" };

describe.skipIf(!LIVE)("A3d.6 recovery plan/apply (isolated database, rolled back)", () => {
  it("dry run, apply, replay: one append-only VERIFIED row and a guarded NULL fill", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      const transferId = await seed(tx, NOV6);
      const plan = await planRecovery(tx, NOV6.c);
      expect(plan.status).toBe("READY");
      expect(plan.transferId).toBe(transferId);
      const redacted = JSON.stringify(redactPlan(plan));
      expect(redacted).not.toContain(NOV6.hashRoot);
      expect(redacted).not.toContain(transferId);
      expect(redacted).not.toContain("VGR3");

      const applied = await applyRecovery(tx, plan, META);
      expect(applied).toEqual({ caseId: "NOV6", outcome: "INSERTED", proofHashFilled: true });
      const rows = await tx.select().from(transferSourceEvidence).where(sql`${transferSourceEvidence.transferId} = ${transferId}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.verdict).toBe("VERIFIED");
      expect(JSON.stringify(rows[0]!.evidence)).not.toContain(NOV6.hashRoot);
      const proof = await tx.select({ h: transferProofs.nimiqTxHash, f: transferProofs.finalityLevel }).from(transferProofs).where(sql`${transferProofs.transferId} = ${transferId}`);
      expect(proof[0]).toEqual({ h: NOV6.c.nimiqTxHash, f: "confirmations-256" });

      // Replay of the same (now stale) plan and a fresh plan are both idempotent.
      expect(await applyRecovery(tx, plan, META)).toEqual({ caseId: "NOV6", outcome: "ALREADY_RECOVERED" });
      expect((await planRecovery(tx, NOV6.c)).status).toBe("ALREADY_RECOVERED");
      expect(await tx.select().from(transferSourceEvidence).where(sql`${transferSourceEvidence.transferId} = ${transferId}`)).toHaveLength(1);
    });
  });

  it("publication SQL: recovered row becomes eligible only after apply, with dual-RPC finalized finality", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      const transferId = await seed(tx, NOV6);
      const [proof] = await tx.select({ id: transferProofs.id }).from(transferProofs).where(sql`${transferProofs.transferId} = ${transferId}`);
      const query = { limit: 50, cursor: null };
      const before = await listPublicProofs(query, prodLikeConfig, tx);
      expect(before.proofs.map((p) => p.proofId)).not.toContain(proof!.id);
      expect(await getPublicProof(proof!.id, prodLikeConfig, tx)).toBeNull();

      await applyRecovery(tx, await planRecovery(tx, NOV6.c), META);
      const after = await listPublicProofs(query, prodLikeConfig, tx);
      const view = after.proofs.find((p) => p.proofId === proof!.id);
      expect(view).toBeDefined();
      expect(view!.method.kind).toBe("historical-recovery");
      expect(view!.destination.finalityLevel).toBe("finalized");
      expect(view!.source.transactionHash).toBe(NOV6.c.nimiqTxHash);
      expect(JSON.stringify(view)).not.toContain(NOV6.hashRoot);
      expect((await getPublicProof(proof!.id, prodLikeConfig, tx))?.proofId).toBe(proof!.id);

      // Append-only revocation: a later REJECTED record removes it from the feed.
      await tx.insert(transferSourceEvidence).values({
        transferId, nimiqTxHash: NOV6.c.nimiqTxHash, verdict: "REJECTED", failureCode: "OPERATOR_REVOKED",
        evidence: {}, verifierVersion: "test", rpcSource: "test", finalityPolicy: "test", operatorRef: "A3D6-TEST-REVOKE",
      });
      expect((await listPublicProofs(query, prodLikeConfig, tx)).proofs.map((p) => p.proofId)).not.toContain(proof!.id);
      expect(await getPublicProof(proof!.id, prodLikeConfig, tx)).toBeNull();
    });
  });

  it("evidence history is append-only and verified uniqueness is database-enforced", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      const transferId = await seed(tx, NOV6);
      await applyRecovery(tx, await planRecovery(tx, NOV6.c), META);
      await tx.execute(sql`SAVEPOINT a`);
      await expect(tx.execute(sql`UPDATE transfer_source_evidence SET operator_ref = 'x' WHERE transfer_id = ${transferId}::uuid`)).rejects.toThrow(/append-only/);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT a`);
      await expect(tx.execute(sql`DELETE FROM transfer_source_evidence WHERE transfer_id = ${transferId}::uuid`)).rejects.toThrow(/append-only/);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT a`);
      const other = await seed(tx, NOV7, { owner: OTHER_OWNER });
      await expect(
        tx.insert(transferSourceEvidence).values({
          transferId: other, nimiqTxHash: NOV6.c.nimiqTxHash, verdict: "VERIFIED", evidence: {}, verifierVersion: "x", rpcSource: "x", finalityPolicy: "x", operatorRef: "x",
        }),
      ).rejects.toThrow();
      await tx.execute(sql`ROLLBACK TO SAVEPOINT a`);
    });
  });

  it("duplicate source: a hash already attributed to another transfer is refused", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV7, { proofNimiqHash: NOV6.c.nimiqTxHash, owner: OTHER_OWNER, transferIdPrefix: "aaaaaaaa" });
      await seed(tx, NOV6);
      const plan = await planRecovery(tx, NOV6.c);
      expect(plan).toMatchObject({ status: "BLOCKED", reasons: ["DUPLICATE_SOURCE"] });
    });
  });

  it("never overwrites: a conflicting non-null proof hash blocks recovery", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV6, { proofNimiqHash: "ab".repeat(32) });
      expect(await planRecovery(tx, NOV6.c)).toMatchObject({ status: "BLOCKED", reasons: ["CONFLICTING_SOURCE"] });
    });
  });

  it("wrong authenticated payment hash blocks with a full-hash mismatch", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV6, { paymentHash: NOV7.hashRoot });
      expect(await planRecovery(tx, NOV6.c)).toMatchObject({ status: "BLOCKED", reasons: ["NIMIQ_PAYMENT_HASH_MISMATCH"] });
    });
  });

  it("incorrect owner blocks", async () => {
    installNimiq();
    installEvm();
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV6, { owner: OTHER_OWNER });
      expect(await planRecovery(tx, NOV6.c)).toMatchObject({ status: "BLOCKED", reasons: ["NIMIQ_WRONG_SENDER"] });
    });
  });

  it("RPC failure and non-delivered or unknown transfers block without writes", async () => {
    installNimiq({ fail: true });
    installEvm();
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV6);
      expect(await planRecovery(tx, NOV6.c)).toMatchObject({ status: "BLOCKED", reasons: ["NIMIQ_PROVIDER_UNAVAILABLE"] });
    });
    installNimiq();
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV6, { status: "CLAIMING" });
      expect(await planRecovery(tx, NOV6.c)).toMatchObject({ status: "BLOCKED", reasons: ["TRANSFER_NOT_DELIVERED"] });
    });
    await inRolledBackTx(async (tx) => {
      await seed(tx, NOV6, { transferIdPrefix: "bbbbbbbb" });
      expect(await planRecovery(tx, NOV6.c)).toMatchObject({ status: "BLOCKED", reasons: ["TRANSFER_ID_MISMATCH"] });
    });
    await inRolledBackTx(async (tx) => {
      expect(await planRecovery(tx, NOV7.c)).toMatchObject({ status: "BLOCKED", reasons: ["TRANSFER_NOT_FOUND"] });
      const plan = await planRecovery(tx, NOV7.c);
      expect(await applyRecovery(tx, plan, META)).toMatchObject({ outcome: "REFUSED", reason: "PLAN_NOT_READY" });
    });
  });
});

/* ------------------------------------------------------------------ */
/* Publication: recovered evidence feeds the existing eligibility gate  */
/* ------------------------------------------------------------------ */


const prodLikeConfig = publicProofConfig({
  routeTokens: { "usdc-polygon": CANONICAL_POLYGON_USDC },
  finalityPolicies: { "137": { mode: "finalized", confirmations: 1 } },
});

function recoveredRow(over: { destination?: Record<string, unknown>; kind?: PublicProofRow["sourceRecordKind"]; proof?: Record<string, unknown> } = {}): PublicProofRow {
  const f = NOV6;
  const transferId = "1dfd7782-0000-4000-8000-000000000001";
  return {
    transfer: {
      id: transferId, ownerUserId: "33333333-3333-4333-8333-333333333333", recipientId: null, requestId: null,
      routeId: "usdc-polygon", recipientDestinationId: null, targetAsset: "USDC", targetNetwork: "Polygon",
      destination: f.destination, targetAmountAtomic: "300000", recipientName: "Private label", quoteProvider: "satora",
      quoteRevision: 1, quotedAt: null, quotedNetTargetAtomic: "300000", quotedSourceSats: "402", quotedFeesJson: null,
      quotedLimitsJson: null, status: "DELIVERED", idempotencyKey: "private-idem", quoteExpiresAt: null,
      createdAt: new Date("2026-11-06T21:28:20.263Z"), updatedAt: new Date("2026-11-06T21:38:21.986Z"),
    } as PublicProofRow["transfer"],
    proof: {
      id: "207d98b1-0000-4000-8000-000000000001", transferId, nimiqTxHash: f.c.nimiqTxHash,
      lightningHash: `0x${f.hashRoot}`, satoraSwapId: "private-satora-id", evmTxHash: f.c.polygonTxHash,
      evidenceSource: "evm_erc20_transfer", chainId: 137, tokenContract: CANONICAL_POLYGON_USDC, recipient: f.destination,
      verifiedAmountAtomic: f.amount, blockNumber: f.blockNumber, blockHash: f.blockHash, logIndexes: "[594]",
      finalityLevel: "confirmations-256", verifiedAt: new Date("2026-11-06T21:38:21.965Z"), createdAt: new Date("2026-11-06T21:28:27.006Z"),
      ...over.proof,
    } as PublicProofRow["proof"],
    sourceVerified: true,
    sourceVerifiedHash: f.c.nimiqTxHash,
    sourceVerifiedEvidence: {
      transactionHash: f.c.nimiqTxHash, sender: "NQ26 CBDC KPN2 0SX8 907X 4QBP D28L TAMT FFUS", amountLuna: "114389614",
      feeLuna: "0", totalDebitLuna: "114389614", blockNumber: "66213564", confirmations: "425504",
      macroBlockNumber: "66213600", network: "mainnet", verifiedAt: "2026-11-11T19:12:24.249Z",
    },
    sourceRecordKind: over.kind === undefined ? "historical-recovery" : over.kind,
    recoveredDestination: {
      sourceRpc: HISTORICAL_RECOVERY_POLICY.nimiq.operator,
      destination: {
        chainId: 137, transactionHash: f.c.polygonTxHash, blockNumber: String(f.blockNumber), blockHash: f.blockHash,
        logIndexes: [594], tokenContract: CANONICAL_POLYGON_USDC, recipient: f.destination, amountAtomic: f.amount,
        finalityLevel: "finalized", rpcOperators: HISTORICAL_RECOVERY_POLICY.polygon.map((p) => p.label),
        verifiedAt: "2026-11-11T19:12:30.000Z", ...over.destination,
      },
    },
  };
}

describe("A3d.6 publication of recovered evidence", () => {
  it("publishes genuine NIM and USDC facts with qualified finality under the finalized policy", () => {
    const view = toPublicProof(recoveredRow(), prodLikeConfig);
    expect(view).not.toBeNull();
    expect(view!.source.transactionHash).toBe(NOV6.c.nimiqTxHash);
    expect(view!.source.amountLuna).toBe("114389614");
    expect(view!.source.explorerTxUrl).toContain(NOV6.c.nimiqTxHash);
    expect(view!.destination.transactionHash).toBe(NOV6.c.polygonTxHash);
    expect(view!.destination.verifiedAmountAtomic).toBe(NOV6.amount);
    expect(view!.destination.finalityLevel).toBe("finalized");
    expect(view!.method).toMatchObject({ kind: "historical-recovery", sourceRpc: HISTORICAL_RECOVERY_POLICY.nimiq.operator });
    expect(view!.method.destinationRpcs).toHaveLength(2);
    expect(view!.method.sourceFinality).toMatch(/not independently verified/);
    expect(view!.source.note).toMatch(/not independently verified/);
    const json = JSON.stringify(view);
    for (const secret of [NOV6.hashRoot, "private-satora-id", "Private label", "private-idem", "lnbc", "33333333-3333"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("does not publish when the recovery re-check differs from the stored proof", () => {
    expect(isPublishableGlobalProof(recoveredRow({ destination: { blockHash: `0x${"11".repeat(32)}` } }), prodLikeConfig)).toBe(false);
    expect(isPublishableGlobalProof(recoveredRow({ destination: { amountAtomic: "1" } }), prodLikeConfig)).toBe(false);
    expect(isPublishableGlobalProof(recoveredRow({ destination: { rpcOperators: ["only-one"] } }), prodLikeConfig)).toBe(false);
    expect(isPublishableGlobalProof(recoveredRow({ destination: { finalityLevel: "confirmations-256" } }), prodLikeConfig)).toBe(false);
  });

  it("leaves live-reconciliation rows unchanged: stored confirmations-256 stays unpublishable under finalized", () => {
    expect(isPublishableGlobalProof(recoveredRow({ kind: "reconciliation" }), prodLikeConfig)).toBe(false);
    expect(isPublishableGlobalProof(recoveredRow({ kind: "reconciliation", proof: { finalityLevel: "finalized" } }), prodLikeConfig)).toBe(true);
  });

  it("does not publish unverified or mismatched source evidence", () => {
    const unverified = { ...recoveredRow(), sourceVerified: false };
    expect(isPublishableGlobalProof(unverified, prodLikeConfig)).toBe(false);
    const other = { ...recoveredRow(), sourceVerifiedHash: NOV7.c.nimiqTxHash };
    expect(isPublishableGlobalProof(other, prodLikeConfig)).toBe(false);
  });
});

describe("A3d.6 proof UI method display", () => {
  it("renders recovery method and qualified finality; drops unknown or malformed blocks", async () => {
    const { toMethodDisplay } = await import("@/ui/lib/proofs-api");
    const view = toPublicProof(recoveredRow(), prodLikeConfig)!;
    const m = toMethodDisplay(view.method)!;
    expect(m.kindLabel).toMatch(/Historical recovery/);
    expect(m.sourceChecked).toBe(HISTORICAL_RECOVERY_POLICY.nimiq.operator);
    expect(m.destinationChecked).toContain(" and ");
    expect(m.sourceFinality).toMatch(/not independently verified/);
    expect(toMethodDisplay({ ...view.method, kind: "trust-me" })).toBeNull();
    expect(toMethodDisplay({ ...view.method, sourceFinality: "x".repeat(500) })).toBeNull();
    expect(toMethodDisplay(null)).toBeNull();
  });
});
