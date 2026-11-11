/**
 * A3d.6 — operator-only recovery of independent source evidence for two
 * historical, already-delivered payments (NOV6, NOV7).
 *
 * Scope is deliberately closed: only the allowlisted cases below can be
 * processed, there is no generic import, and nothing here publishes. A dry
 * run performs reads only. An apply writes exactly two things per case, in
 * one transaction under the same advisory lock the live source binder uses:
 *   1. one append-only `transfer_source_evidence` row (VERIFIED), and
 *   2. a guarded NULL→value fill of `transfer_proofs.nimiq_tx_hash`
 *      (never overwrites a non-null value).
 * It never inserts a status transition: DELIVERED is terminal.
 *
 * Trust policy (zero-cost, documented): the Nimiq leg is checked by PR #64's
 * verifier against one named public history RPC; the Polygon leg must pass on
 * two independent public RPC operators that agree. Any mismatch, missing
 * evidence, RPC failure or disagreement blocks the case (fail closed).
 */
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { swapAttachments, transferProofs, transferSourceEvidence, transfers, users } from "@/db/schema";
import { TRANSFER_EVENT_TOPIC } from "@/lib/settlement";
import { normalizeNimiqSourceHash, verifyNimiqSourceTransaction, type VerifiedNimiqSource } from "@/lib/nimiq-source";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Tx;

/** Native (Circle) USDC on Polygon PoS. */
export const CANONICAL_POLYGON_USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

export const HISTORICAL_RECOVERY_POLICY = {
  id: "a3d6-public-rpc-v1",
  nimiq: {
    url: "https://rpc.nimiqwatch.com",
    operator: "Nimiq Watch open RPC (rpc.nimiqwatch.com)",
    network: "mainnet" as const,
    minConfirmations: 6,
  },
  polygon: [
    { label: "PublicNode (polygon-bor-rpc.publicnode.com)", url: "https://polygon-bor-rpc.publicnode.com" },
    { label: "dRPC (polygon.drpc.org)", url: "https://polygon.drpc.org" },
  ],
  sourceFinality:
    "Included in a Nimiq batch whose closing macro block the RPC returned with a Tendermint justification; the aggregate validator signature was not independently verified.",
  destinationFinality: "At or below Polygon's finalized block, with the same block hash, on two independent RPC operators.",
} as const;

export interface HistoricalRecoveryCase {
  caseId: "NOV6" | "NOV7";
  /** Prefix of the authenticated transfer id established in A3d.3 (guards the lookup). */
  transferIdPrefix: string;
  nimiqTxHash: string;
  polygonTxHash: string;
  /** Exact NIM amount in luna established in A3d.4. */
  expectedAmountLuna: string;
}

export const HISTORICAL_RECOVERY_CASES: readonly HistoricalRecoveryCase[] = [
  {
    caseId: "NOV6",
    transferIdPrefix: "1dfd7782",
    nimiqTxHash: "d234c7623ce9c60da88235263dd13d77f9858ba32c8b376f5dff07c4fce6b213",
    polygonTxHash: "0xf47a2c7f5b9dfb4871f1ed95be8fece5de70b5a2edb5c72a0237a301c429b441",
    expectedAmountLuna: "114389614",
  },
  {
    caseId: "NOV7",
    transferIdPrefix: "8aeefc3a",
    nimiqTxHash: "23537261c697042e62756a7fa1bd85092b69154f959b930c39c62d8ccf4fb449",
    polygonTxHash: "0x84eb92f0752d6100407cbce3d1b2eb9ff643338bb6133e3a310f1524376b9dbc",
    expectedAmountLuna: "108885558",
  },
];

export function recoveryCase(caseId: string): HistoricalRecoveryCase | null {
  return HISTORICAL_RECOVERY_CASES.find((c) => c.caseId === caseId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Authenticated record (database)                                     */
/* ------------------------------------------------------------------ */

export interface RecoveryRecord {
  transferId: string;
  status: string;
  routeId: string;
  targetAsset: string;
  targetNetwork: string;
  destination: string;
  targetAmountAtomic: string;
  ownerAddress: string;
  /** Full authenticated Lightning payment hash (never printed or stored as evidence). */
  paymentHash: string;
  swapCount: number;
  proof: {
    id: string;
    evmTxHash: string | null;
    chainId: number | null;
    tokenContract: string | null;
    recipient: string | null;
    verifiedAmountAtomic: string | null;
    blockNumber: number | null;
    blockHash: string | null;
    logIndexes: string | null;
    nimiqTxHash: string | null;
    lightningHash: string | null;
    evidenceSource: string | null;
  };
}

const lowerHex = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase().replace(/^0x/, "");

export async function loadRecoveryRecord(db: DbLike, c: HistoricalRecoveryCase): Promise<{ record: RecoveryRecord | null; reasons: string[] }> {
  const proofs = await db
    .select({ proof: transferProofs, transfer: transfers, ownerAddress: users.nimiqAddress })
    .from(transferProofs)
    .innerJoin(transfers, eq(transfers.id, transferProofs.transferId))
    .innerJoin(users, eq(users.id, transfers.ownerUserId))
    .where(and(sql`lower(${transferProofs.evmTxHash}) = ${c.polygonTxHash.toLowerCase()}`, eq(transferProofs.chainId, 137)))
    .limit(3);
  if (proofs.length !== 1) return { record: null, reasons: [proofs.length === 0 ? "TRANSFER_NOT_FOUND" : "TRANSFER_AMBIGUOUS"] };
  const row = proofs[0]!;
  if (!row.transfer.id.toLowerCase().startsWith(c.transferIdPrefix)) return { record: null, reasons: ["TRANSFER_ID_MISMATCH"] };
  const swaps = await db
    .select({ paymentHash: swapAttachments.paymentHash })
    .from(swapAttachments)
    .where(eq(swapAttachments.transferId, row.transfer.id))
    .limit(3);
  const record: RecoveryRecord = {
    transferId: row.transfer.id,
    status: row.transfer.status,
    routeId: row.transfer.routeId,
    targetAsset: row.transfer.targetAsset,
    targetNetwork: row.transfer.targetNetwork,
    destination: row.transfer.destination,
    targetAmountAtomic: row.transfer.targetAmountAtomic,
    ownerAddress: row.ownerAddress,
    paymentHash: swaps[0]?.paymentHash ?? "",
    swapCount: swaps.length,
    proof: {
      id: row.proof.id,
      evmTxHash: row.proof.evmTxHash,
      chainId: row.proof.chainId,
      tokenContract: row.proof.tokenContract,
      recipient: row.proof.recipient,
      verifiedAmountAtomic: row.proof.verifiedAmountAtomic,
      blockNumber: row.proof.blockNumber,
      blockHash: row.proof.blockHash,
      logIndexes: row.proof.logIndexes,
      nimiqTxHash: row.proof.nimiqTxHash,
      lightningHash: row.proof.lightningHash,
      evidenceSource: row.proof.evidenceSource,
    },
  };
  return { record, reasons: [] };
}

/** Invariants of the authenticated record itself, before any chain read. */
export function checkRecordInvariants(record: RecoveryRecord): string[] {
  const reasons: string[] = [];
  if (record.status !== "DELIVERED") reasons.push("TRANSFER_NOT_DELIVERED");
  if (record.routeId !== "usdc-polygon" || record.targetAsset !== "USDC" || record.targetNetwork !== "Polygon") reasons.push("ROUTE_MISMATCH");
  if (record.swapCount !== 1) reasons.push("SWAP_ATTACHMENT_NOT_UNIQUE");
  if (!/^[0-9a-f]{64}$/.test(lowerHex(record.paymentHash))) reasons.push("PAYMENT_HASH_MALFORMED");
  if (lowerHex(record.proof.lightningHash) !== lowerHex(record.paymentHash)) reasons.push("PROOF_LIGHTNING_HASH_MISMATCH");
  if (record.proof.evidenceSource !== "evm_erc20_transfer") reasons.push("DESTINATION_EVIDENCE_KIND");
  if ((record.proof.tokenContract ?? "").toLowerCase() !== CANONICAL_POLYGON_USDC) reasons.push("NON_CANONICAL_TOKEN");
  if ((record.proof.recipient ?? "").toLowerCase() !== record.destination.toLowerCase()) reasons.push("PROOF_RECIPIENT_MISMATCH");
  const amount = record.proof.verifiedAmountAtomic;
  if (!amount || !/^\d+$/.test(amount) || !/^\d+$/.test(record.targetAmountAtomic) || BigInt(amount) < BigInt(record.targetAmountAtomic)) {
    reasons.push("PROOF_AMOUNT_INVALID");
  }
  if (record.proof.blockNumber === null || !record.proof.blockHash) reasons.push("PROOF_BLOCK_MISSING");
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Polygon: dual-RPC independent receipt verification                   */
/* ------------------------------------------------------------------ */

export type JsonRpcPost = (url: string, body: string) => Promise<unknown>;

const defaultPost: JsonRpcPost = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

let evmPost: JsonRpcPost = defaultPost;
/** Test seam: replace the public EVM RPC transport. */
export function setRecoveryEvmTransportForTests(next: JsonRpcPost | null): void {
  evmPost = next ?? defaultPost;
}

async function evmCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const payload = (await evmPost(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))) as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object" || payload["error"] !== undefined || !("result" in payload)) throw new Error(`${method} failed`);
  return payload["result"];
}

export interface PolygonExpectation {
  txHash: string;
  tokenContract: string;
  recipient: string;
  amountAtomic: string;
  blockNumber: number;
  blockHash: string;
  logIndexes: number[];
}

export interface PolygonObservation {
  label: string;
  blockNumber: number;
  blockHash: string;
  finalizedBlockNumber: number;
  logIndexes: number[];
  amountAtomic: string;
}

export type PolygonVerification =
  | { ok: true; observations: PolygonObservation[] }
  | { ok: false; code: string; label?: string };

function hexToNumber(v: unknown): number | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  const n = Number(BigInt(v));
  return Number.isSafeInteger(n) ? n : null;
}

async function observeOne(rpc: { label: string; url: string }, exp: PolygonExpectation): Promise<PolygonObservation | { code: string }> {
  let chainId: unknown, receipt: unknown, header: unknown, finalized: unknown;
  try {
    chainId = await evmCall(rpc.url, "eth_chainId", []);
    receipt = await evmCall(rpc.url, "eth_getTransactionReceipt", [exp.txHash]);
    finalized = await evmCall(rpc.url, "eth_getBlockByNumber", ["finalized", false]);
  } catch {
    return { code: "EVM_RPC_UNAVAILABLE" };
  }
  if (hexToNumber(chainId) !== 137) return { code: "EVM_WRONG_CHAIN" };
  if (!receipt || typeof receipt !== "object") return { code: "EVM_RECEIPT_MISSING" };
  const r = receipt as Record<string, unknown>;
  if (String(r["transactionHash"] ?? "").toLowerCase() !== exp.txHash.toLowerCase()) return { code: "EVM_TX_HASH_MISMATCH" };
  if (r["status"] !== "0x1") return { code: "EVM_RECEIPT_FAILED" };
  const blockNumber = hexToNumber(r["blockNumber"]);
  const blockHash = String(r["blockHash"] ?? "").toLowerCase();
  if (blockNumber === null || blockNumber !== exp.blockNumber) return { code: "EVM_BLOCK_MISMATCH" };
  if (blockHash !== exp.blockHash.toLowerCase()) return { code: "EVM_BLOCK_HASH_MISMATCH" };
  try {
    header = await evmCall(rpc.url, "eth_getBlockByNumber", [r["blockNumber"], false]);
  } catch {
    return { code: "EVM_RPC_UNAVAILABLE" };
  }
  if (!header || typeof header !== "object" || String((header as Record<string, unknown>)["hash"] ?? "").toLowerCase() !== blockHash) {
    return { code: "EVM_REORG_OR_HEADER_MISMATCH" };
  }
  const finalizedNumber = finalized && typeof finalized === "object" ? hexToNumber((finalized as Record<string, unknown>)["number"]) : null;
  if (finalizedNumber === null) return { code: "EVM_FINALITY_UNAVAILABLE" };
  if (blockNumber > finalizedNumber) return { code: "EVM_NOT_FINALIZED" };
  const logs = Array.isArray(r["logs"]) ? (r["logs"] as Record<string, unknown>[]) : [];
  const token = exp.tokenContract.toLowerCase();
  const recipient = exp.recipient.toLowerCase();
  let total = 0n;
  const indexes: number[] = [];
  for (const log of logs) {
    const topics = Array.isArray(log["topics"]) ? (log["topics"] as string[]) : [];
    if (String(log["address"] ?? "").toLowerCase() !== token) continue;
    if ((topics[0] ?? "").toLowerCase() !== TRANSFER_EVENT_TOPIC || topics.length < 3) continue;
    if (`0x${(topics[2] ?? "").slice(-40)}`.toLowerCase() !== recipient) continue;
    let value: bigint;
    try {
      value = BigInt(String(log["data"]));
    } catch {
      return { code: "EVM_LOG_MALFORMED" };
    }
    const idx = hexToNumber(log["logIndex"]);
    if (idx === null) return { code: "EVM_LOG_MALFORMED" };
    total += value;
    indexes.push(idx);
  }
  indexes.sort((a, b) => a - b);
  if (indexes.length === 0) return { code: "EVM_NO_RECIPIENT_TRANSFER" };
  if (total.toString() !== exp.amountAtomic) return { code: "EVM_AMOUNT_MISMATCH" };
  if (JSON.stringify(indexes) !== JSON.stringify(exp.logIndexes)) return { code: "EVM_LOG_INDEX_MISMATCH" };
  return { label: rpc.label, blockNumber, blockHash, finalizedBlockNumber: finalizedNumber, logIndexes: indexes, amountAtomic: total.toString() };
}

/** Every configured operator must independently pass and agree; otherwise fail closed. */
export async function verifyPolygonDelivery(
  exp: PolygonExpectation,
  rpcs: readonly { label: string; url: string }[] = HISTORICAL_RECOVERY_POLICY.polygon,
): Promise<PolygonVerification> {
  if (rpcs.length < 2) return { ok: false, code: "EVM_SECOND_SOURCE_REQUIRED" };
  const observations: PolygonObservation[] = [];
  for (const rpc of rpcs) {
    const o = await observeOne(rpc, exp);
    if ("code" in o) return { ok: false, code: o.code, label: rpc.label };
    observations.push(o);
  }
  const first = observations[0]!;
  for (const o of observations.slice(1)) {
    if (o.blockHash !== first.blockHash || o.blockNumber !== first.blockNumber || o.amountAtomic !== first.amountAtomic || JSON.stringify(o.logIndexes) !== JSON.stringify(first.logIndexes)) {
      return { ok: false, code: "EVM_RPC_DISAGREEMENT", label: o.label };
    }
  }
  return { ok: true, observations };
}

export function parseLogIndexes(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    return [...(v as number[])].sort((a, b) => a - b);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Evidence payload (bounded, non-secret)                              */
/* ------------------------------------------------------------------ */

export interface RecoveryEvidence {
  schema: 1;
  policy: string;
  source: {
    transactionHash: string;
    network: "mainnet";
    sender: string;
    senderBinding: VerifiedNimiqSource["senderBinding"];
    amountLuna: string;
    feeLuna: string;
    totalDebitLuna: string;
    blockNumber: string;
    confirmations: string;
    macroBlockNumber: string;
    verifiedAt: string;
    rpcOperator: string;
    paymentHashMatch: "full-256-bit";
    aggregateSignatureVerified: false;
  };
  destination: {
    chainId: 137;
    transactionHash: string;
    blockNumber: string;
    blockHash: string;
    logIndexes: number[];
    tokenContract: string;
    recipient: string;
    amountAtomic: string;
    finalityLevel: "finalized";
    rpcOperators: string[];
    verifiedAt: string;
  };
}

function buildEvidence(src: VerifiedNimiqSource, dst: PolygonObservation[], exp: PolygonExpectation, now: Date): RecoveryEvidence {
  return {
    schema: 1,
    policy: HISTORICAL_RECOVERY_POLICY.id,
    source: {
      transactionHash: src.transactionHash,
      network: "mainnet",
      sender: src.senderAddress,
      senderBinding: src.senderBinding,
      amountLuna: src.amountLuna,
      feeLuna: src.feeLuna,
      totalDebitLuna: src.totalDebitLuna,
      blockNumber: String(src.blockNumber),
      confirmations: String(src.confirmations),
      macroBlockNumber: String(src.finalizedByMacroBlock),
      verifiedAt: src.verifiedAt,
      rpcOperator: HISTORICAL_RECOVERY_POLICY.nimiq.operator,
      paymentHashMatch: "full-256-bit",
      aggregateSignatureVerified: false,
    },
    destination: {
      chainId: 137,
      transactionHash: exp.txHash.toLowerCase(),
      blockNumber: String(exp.blockNumber),
      blockHash: exp.blockHash.toLowerCase(),
      logIndexes: exp.logIndexes,
      tokenContract: exp.tokenContract.toLowerCase(),
      recipient: exp.recipient.toLowerCase(),
      amountAtomic: exp.amountAtomic,
      finalityLevel: "finalized",
      rpcOperators: dst.map((o) => o.label),
      verifiedAt: now.toISOString(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Attribution checks (database)                                       */
/* ------------------------------------------------------------------ */

export type AttributionState = "UNATTRIBUTED" | "ALREADY_RECOVERED" | "DUPLICATE_SOURCE" | "CONFLICTING_SOURCE";

export async function checkAttribution(db: DbLike, transferId: string, sourceHash: string): Promise<AttributionState> {
  const hash = lowerHex(sourceHash);
  const proofOwners = await db
    .select({ transferId: transferProofs.transferId, nimiqTxHash: transferProofs.nimiqTxHash })
    .from(transferProofs)
    .where(sql`${transferProofs.nimiqTxHash} IS NOT NULL AND (lower(regexp_replace(${transferProofs.nimiqTxHash}, '^0x', '', 'i')) = ${hash} OR ${transferProofs.transferId} = ${transferId})`);
  for (const p of proofOwners) {
    const h = lowerHex(p.nimiqTxHash);
    if (p.transferId !== transferId && h === hash) return "DUPLICATE_SOURCE";
    if (p.transferId === transferId && h !== hash) return "CONFLICTING_SOURCE";
  }
  const markerOwners = (await db.execute(sql`
    SELECT transfer_id::text AS transfer_id FROM transfer_transitions
    WHERE evidence->>'nimiqSourceVerification' = 'VERIFIED'
      AND lower(regexp_replace(evidence->>'nimiqSourceTxHash', '^0x', '', 'i')) = ${hash}
      AND transfer_id <> ${transferId}::uuid
    LIMIT 1`)) as unknown as { rows: unknown[] };
  if (markerOwners.rows.length > 0) return "DUPLICATE_SOURCE";
  const evidence = await db
    .select({ transferId: transferSourceEvidence.transferId, nimiqTxHash: transferSourceEvidence.nimiqTxHash })
    .from(transferSourceEvidence)
    .where(and(eq(transferSourceEvidence.verdict, "VERIFIED"), sql`(${transferSourceEvidence.nimiqTxHash} = ${hash} OR ${transferSourceEvidence.transferId} = ${transferId})`));
  let already = false;
  for (const e of evidence) {
    if (e.transferId !== transferId) return "DUPLICATE_SOURCE";
    if (e.nimiqTxHash !== hash) return "CONFLICTING_SOURCE";
    already = true;
  }
  return already ? "ALREADY_RECOVERED" : "UNATTRIBUTED";
}

/* ------------------------------------------------------------------ */
/* Plan (dry run) and apply                                            */
/* ------------------------------------------------------------------ */

export interface RecoveryPlan {
  caseId: HistoricalRecoveryCase["caseId"];
  status: "READY" | "ALREADY_RECOVERED" | "BLOCKED";
  reasons: string[];
  transferId: string | null;
  evidence: RecoveryEvidence | null;
}

export async function planRecovery(db: DbLike, c: HistoricalRecoveryCase, now = new Date()): Promise<RecoveryPlan> {
  const blocked = (reasons: string[], transferId: string | null = null): RecoveryPlan => ({ caseId: c.caseId, status: "BLOCKED", reasons, transferId, evidence: null });
  const loaded = await loadRecoveryRecord(db, c);
  if (!loaded.record) return blocked(loaded.reasons);
  const record = loaded.record;
  const invariants = checkRecordInvariants(record);
  if (invariants.length > 0) return blocked(invariants, record.transferId);
  const logIndexes = parseLogIndexes(record.proof.logIndexes);
  if (!logIndexes) return blocked(["PROOF_LOG_INDEX_MALFORMED"], record.transferId);
  const sourceHash = normalizeNimiqSourceHash(c.nimiqTxHash);
  if (!sourceHash) return blocked(["SOURCE_HASH_MALFORMED"], record.transferId);

  const attribution = await checkAttribution(db, record.transferId, sourceHash);
  if (attribution === "DUPLICATE_SOURCE" || attribution === "CONFLICTING_SOURCE") return blocked([attribution], record.transferId);

  const source = await verifyNimiqSourceTransaction({
    txHash: sourceHash,
    ownerAddress: record.ownerAddress,
    lightningPaymentHash: record.paymentHash,
    expectedAmountLuna: c.expectedAmountLuna,
    config: {
      url: HISTORICAL_RECOVERY_POLICY.nimiq.url,
      network: HISTORICAL_RECOVERY_POLICY.nimiq.network,
      minConfirmations: HISTORICAL_RECOVERY_POLICY.nimiq.minConfirmations,
      timeoutMs: 15_000,
    },
  });
  if (!source.ok) return blocked([`NIMIQ_${source.code}`], record.transferId);

  const expectation: PolygonExpectation = {
    txHash: c.polygonTxHash,
    tokenContract: CANONICAL_POLYGON_USDC,
    recipient: record.destination,
    amountAtomic: record.proof.verifiedAmountAtomic!,
    blockNumber: record.proof.blockNumber!,
    blockHash: record.proof.blockHash!,
    logIndexes,
  };
  const destination = await verifyPolygonDelivery(expectation);
  if (!destination.ok) return blocked([destination.code], record.transferId);

  return {
    caseId: c.caseId,
    status: attribution === "ALREADY_RECOVERED" ? "ALREADY_RECOVERED" : "READY",
    reasons: [],
    transferId: record.transferId,
    evidence: buildEvidence(source.evidence, destination.observations, expectation, now),
  };
}

export interface ApplyResult {
  caseId: string;
  outcome: "INSERTED" | "ALREADY_RECOVERED" | "REFUSED";
  reason?: string;
  proofHashFilled?: boolean;
}

/**
 * Persist one READY plan. Re-validates attribution under the same advisory
 * lock key the live binder uses, then appends evidence and fills the proof
 * pointer only when it is NULL. Idempotent: a repeat returns ALREADY_RECOVERED.
 */
export async function applyRecovery(
  db: DbLike,
  plan: RecoveryPlan,
  meta: { operatorRef: string; verifierVersion: string },
): Promise<ApplyResult> {
  if (plan.status === "ALREADY_RECOVERED") return { caseId: plan.caseId, outcome: "ALREADY_RECOVERED" };
  if (plan.status !== "READY" || !plan.evidence || !plan.transferId) return { caseId: plan.caseId, outcome: "REFUSED", reason: "PLAN_NOT_READY" };
  if (!recoveryCase(plan.caseId)) return { caseId: plan.caseId, outcome: "REFUSED", reason: "CASE_NOT_ALLOWLISTED" };
  const operatorRef = meta.operatorRef.trim();
  if (operatorRef.length === 0 || operatorRef.length > 128) return { caseId: plan.caseId, outcome: "REFUSED", reason: "OPERATOR_REF_REQUIRED" };
  if (!/^[0-9a-f]{7,64}$/.test(meta.verifierVersion)) return { caseId: plan.caseId, outcome: "REFUSED", reason: "VERIFIER_VERSION_INVALID" };
  const hash = plan.evidence.source.transactionHash;
  const transferId = plan.transferId;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`nimiq-source:${hash}`}))`);
    const locked = await tx
      .select({ status: transfers.status })
      .from(transfers)
      .where(eq(transfers.id, transferId))
      .for("update");
    if (locked[0]?.status !== "DELIVERED") return { caseId: plan.caseId, outcome: "REFUSED", reason: "TRANSFER_NOT_DELIVERED" } as ApplyResult;
    const attribution = await checkAttribution(tx, transferId, hash);
    if (attribution === "ALREADY_RECOVERED") return { caseId: plan.caseId, outcome: "ALREADY_RECOVERED" } as ApplyResult;
    if (attribution !== "UNATTRIBUTED") return { caseId: plan.caseId, outcome: "REFUSED", reason: attribution } as ApplyResult;
    await tx.insert(transferSourceEvidence).values({
      transferId,
      nimiqTxHash: hash,
      verdict: "VERIFIED",
      evidence: plan.evidence,
      verifierVersion: meta.verifierVersion,
      rpcSource: `nimiq:${HISTORICAL_RECOVERY_POLICY.nimiq.url};polygon:${HISTORICAL_RECOVERY_POLICY.polygon.map((p) => p.url).join("+")}`,
      finalityPolicy: HISTORICAL_RECOVERY_POLICY.id,
      operatorRef,
    });
    // Guarded NULL→value fill. Never overwrites: a non-null value must already
    // equal the verified hash (checkAttribution refused any conflict above).
    const filled = await tx
      .update(transferProofs)
      .set({ nimiqTxHash: hash })
      .where(and(eq(transferProofs.transferId, transferId), sql`${transferProofs.nimiqTxHash} IS NULL`))
      .returning({ id: transferProofs.id });
    if (filled.length === 0) {
      const current = await tx
        .select({ nimiqTxHash: transferProofs.nimiqTxHash })
        .from(transferProofs)
        .where(eq(transferProofs.transferId, transferId));
      if (lowerHex(current[0]?.nimiqTxHash) !== hash) throw new Error("CONFLICTING_SOURCE");
    }
    return { caseId: plan.caseId, outcome: "INSERTED", proofHashFilled: filled.length === 1 } as ApplyResult;
  });
}

/** Redacted, operator-safe summary: never prints payment hashes, owner address or full ids. */
export function redactPlan(plan: RecoveryPlan): Record<string, unknown> {
  const e = plan.evidence;
  return {
    caseId: plan.caseId,
    status: plan.status,
    reasons: plan.reasons,
    transfer: plan.transferId ? `${plan.transferId.slice(0, 8)}…` : null,
    source: e
      ? {
          tx: e.source.transactionHash,
          amountLuna: e.source.amountLuna,
          sender: e.source.sender,
          senderBinding: e.source.senderBinding,
          block: e.source.blockNumber,
          macroBlock: e.source.macroBlockNumber,
          paymentHashMatch: e.source.paymentHashMatch,
          rpc: e.source.rpcOperator,
        }
      : null,
    destination: e
      ? {
          tx: e.destination.transactionHash,
          amountAtomic: e.destination.amountAtomic,
          recipient: `${e.destination.recipient.slice(0, 6)}…${e.destination.recipient.slice(-4)}`,
          block: e.destination.blockNumber,
          logIndexes: e.destination.logIndexes,
          finality: e.destination.finalityLevel,
          rpcs: e.destination.rpcOperators,
        }
      : null,
  };
}
