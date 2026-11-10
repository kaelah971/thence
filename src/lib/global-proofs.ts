/**
 * A3c.1 — read-only global proof-of-payments publication.
 *
 * This module exposes only already-committed delivery evidence. It never
 * changes transfer state, re-verifies a payment by trusting provider data, or
 * publishes the NIM source side as proven: Nimiq Pay remains the approval
 * boundary and this backend has no independent NIM debit verifier.
 */
import { and, desc, eq, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { transferProofs, transfers } from "@/db/schema";
import { getDb } from "@/lib/db";
import { DEFAULT_FINALITY_POLICY, explorerTxUrl } from "@/lib/settlement";
import { TRUSTED_ROUTE_TOKEN_IDENTITIES } from "@/lib/satora";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const ATOMIC_RE = /^[0-9]+$/;

export const PUBLIC_PROOF_DEFAULT_LIMIT = 20;
export const PUBLIC_PROOF_MAX_LIMIT = 50;
export const PUBLIC_PROOF_DECIMALS = 6;
export const PUBLIC_PROOF_ASSET = "USDC" as const;

export type PublicProofNetwork = "Polygon" | "Arbitrum";
export type PublicProofChainId = 137 | 42161;
export type PublicProofSourceEvidence = "NOT_RECORDED" | "IDENTIFIER_UNVERIFIED";

export interface PublicProofPublicationConfig {
  routeTokens: Record<string, string>;
  finalityPolicies: Record<string, { mode: string; confirmations: number }>;
}

export interface PublicProofRow {
  proof: typeof transferProofs.$inferSelect;
  transfer: typeof transfers.$inferSelect;
}

export interface PublicProofView {
  proofId: string;
  status: "DELIVERED";
  destination: {
    asset: typeof PUBLIC_PROOF_ASSET;
    network: PublicProofNetwork;
    chainId: PublicProofChainId;
    tokenContract: string;
    recipient: string;
    requestedAmountAtomic: string;
    verifiedAmountAtomic: string;
    decimals: typeof PUBLIC_PROOF_DECIMALS;
    transactionHash: string;
    blockNumber: string;
    blockHash: string;
    finalityLevel: string;
    verifiedAt: string;
    explorerTxUrl: string;
  };
  verification: {
    destination: "VERIFIED";
    source: "NOT_VERIFIED";
    overall: "DESTINATION_ONLY";
  };
  source: {
    asset: "NIM";
    evidence: PublicProofSourceEvidence;
    verification: "NOT_VERIFIED";
    note: string;
  };
}

export interface PublicProofFeedQuery {
  limit: number;
  cursor: ProofCursor | null;
}

export interface PublicProofFeedResult {
  proofs: PublicProofView[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface ProofCursor {
  verifiedAt: string;
  proofId: string;
}

export class PublicProofQueryError extends Error {
  readonly code = "INVALID_QUERY";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "PublicProofQueryError";
  }
}

/** Missing or non-1 values keep publication disabled, including in production. */
export function isPublicProofPublicationEnabled(source: Record<string, string | undefined> = process.env): boolean {
  return source["THENCE_PUBLIC_PROOFS_ENABLED"] === "1";
}

export function encodeProofCursor(cursor: ProofCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeProofCursor(raw: string): ProofCursor | null {
  if (raw.length === 0 || raw.length > 256) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (value["v"] !== 1 || typeof value["verifiedAt"] !== "string" || typeof value["proofId"] !== "string") return null;
    if (!UUID_RE.test(value["proofId"])) return null;
    const date = new Date(value["verifiedAt"]);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== value["verifiedAt"]) return null;
    return { verifiedAt: value["verifiedAt"], proofId: value["proofId"] };
  } catch {
    return null;
  }
}

export function parseProofFeedQuery(url: string): PublicProofFeedQuery {
  const parsed = new URL(url);
  const rawLimit = parsed.searchParams.get("limit");
  const limit = rawLimit === null ? PUBLIC_PROOF_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PUBLIC_PROOF_MAX_LIMIT) {
    throw new PublicProofQueryError(`limit must be an integer from 1 to ${PUBLIC_PROOF_MAX_LIMIT}.`);
  }
  const rawCursor = parsed.searchParams.get("cursor");
  if (rawCursor === null) return { limit, cursor: null };
  const cursor = decodeProofCursor(rawCursor);
  if (!cursor) throw new PublicProofQueryError("cursor is invalid.");
  return { limit, cursor };
}

function isAtomic(value: string | null | undefined): value is string {
  return typeof value === "string" && ATOMIC_RE.test(value) && BigInt(value) > 0n;
}

function finalityPolicyFor(
  chainId: PublicProofChainId,
  overrides: Record<string, { mode: string; confirmations: number }>,
): { mode: "finalized" | "confirmations"; confirmations: number } | null {
  // Arbitrum publication never treats a soft confirmation count as L1
  // finality, even if an operator supplied a weaker override elsewhere.
  if (chainId === 42161) return DEFAULT_FINALITY_POLICY[42161] ?? null;
  const override = overrides[String(chainId)];
  if (!override) return DEFAULT_FINALITY_POLICY[chainId] ?? null;
  if (override.mode !== "finalized" && override.mode !== "confirmations") return null;
  if (!Number.isInteger(override.confirmations) || override.confirmations < 1) return null;
  return { mode: override.mode, confirmations: override.confirmations };
}

function finalityLevelFor(policy: { mode: "finalized" | "confirmations"; confirmations: number }): string {
  return policy.mode === "finalized" ? "finalized" : `confirmations-${policy.confirmations}`;
}

function trustedTokenFor(routeId: "usdc-polygon" | "usdc-arbitrum", config: PublicProofPublicationConfig): string | null {
  const configured = config.routeTokens[routeId]?.trim().toLowerCase();
  if (!configured || !EVM_ADDRESS_RE.test(configured)) return null;
  if (routeId === "usdc-arbitrum") {
    const native = TRUSTED_ROUTE_TOKEN_IDENTITIES[routeId]?.address.toLowerCase();
    if (!native || configured !== native) return null;
  }
  return configured;
}

function routeIdentityFor(row: PublicProofRow): { routeId: "usdc-polygon" | "usdc-arbitrum"; chainId: PublicProofChainId; network: PublicProofNetwork } | null {
  if (row.transfer.routeId === "usdc-polygon" && row.transfer.targetAsset === "USDC" && row.transfer.targetNetwork === "Polygon") {
    return { routeId: "usdc-polygon", chainId: 137, network: "Polygon" };
  }
  if (row.transfer.routeId === "usdc-arbitrum" && row.transfer.targetAsset === "USDC" && row.transfer.targetNetwork === "Arbitrum") {
    return { routeId: "usdc-arbitrum", chainId: 42161, network: "Arbitrum" };
  }
  return null;
}

/**
 * Re-check the publication invariants before serializing a row. The database
 * state is treated as untrusted input at this boundary even though normal
 * writers already enforce these facts.
 */
export function isPublishableGlobalProof(row: PublicProofRow, config: PublicProofPublicationConfig): boolean {
  const identity = routeIdentityFor(row);
  const proof = row.proof;
  if (!identity || row.transfer.status !== "DELIVERED") return false;
  if (
    proof.evidenceSource !== "evm_erc20_transfer" ||
    proof.chainId !== identity.chainId ||
    proof.verifiedAt === null ||
    Number.isNaN(proof.verifiedAt.getTime()) ||
    proof.blockNumber === null ||
    !Number.isSafeInteger(proof.blockNumber) ||
    proof.blockNumber < 0 ||
    !proof.evmTxHash ||
    !TX_HASH_RE.test(proof.evmTxHash) ||
    !proof.tokenContract ||
    !EVM_ADDRESS_RE.test(proof.tokenContract) ||
    !proof.recipient ||
    !EVM_ADDRESS_RE.test(proof.recipient) ||
    !proof.verifiedAmountAtomic ||
    !isAtomic(proof.verifiedAmountAtomic) ||
    !isAtomic(row.transfer.targetAmountAtomic) ||
    BigInt(proof.verifiedAmountAtomic) < BigInt(row.transfer.targetAmountAtomic) ||
    !EVM_ADDRESS_RE.test(row.transfer.destination) ||
    proof.recipient.toLowerCase() !== row.transfer.destination.toLowerCase() ||
    !proof.blockHash ||
    !TX_HASH_RE.test(proof.blockHash) ||
    !proof.finalityLevel
  ) {
    return false;
  }
  const expectedToken = trustedTokenFor(identity.routeId, config);
  const policy = finalityPolicyFor(identity.chainId, config.finalityPolicies);
  return (
    expectedToken !== null &&
    proof.tokenContract.toLowerCase() === expectedToken &&
    policy !== null &&
    proof.finalityLevel === finalityLevelFor(policy)
  );
}

function publicProofFromRow(row: PublicProofRow, config: PublicProofPublicationConfig): PublicProofView | null {
  if (!isPublishableGlobalProof(row, config)) return null;
  const identity = routeIdentityFor(row)!;
  const proof = row.proof;
  const txHash = proof.evmTxHash!;
  const verifiedAt = proof.verifiedAt!;
  const policy = finalityPolicyFor(identity.chainId, config.finalityPolicies)!;
  const sourceEvidence: PublicProofSourceEvidence = proof.nimiqTxHash?.trim() ? "IDENTIFIER_UNVERIFIED" : "NOT_RECORDED";
  return {
    proofId: proof.id,
    status: "DELIVERED",
    destination: {
      asset: PUBLIC_PROOF_ASSET,
      network: identity.network,
      chainId: identity.chainId,
      tokenContract: proof.tokenContract!.toLowerCase(),
      recipient: proof.recipient!.toLowerCase(),
      requestedAmountAtomic: row.transfer.targetAmountAtomic,
      verifiedAmountAtomic: proof.verifiedAmountAtomic!,
      decimals: PUBLIC_PROOF_DECIMALS,
      transactionHash: txHash.toLowerCase(),
      blockNumber: String(proof.blockNumber),
      blockHash: proof.blockHash!.toLowerCase(),
      finalityLevel: proof.finalityLevel!,
      verifiedAt: verifiedAt.toISOString(),
      explorerTxUrl: explorerTxUrl(identity.chainId, txHash),
    },
    verification: {
      destination: "VERIFIED",
      source: "NOT_VERIFIED",
      overall: "DESTINATION_ONLY",
    },
    source: {
      asset: "NIM",
      evidence: sourceEvidence,
      verification: "NOT_VERIFIED",
      note: "The Nimiq Pay debit is not independently verified by this public proof; no NIM amount, wallet, or transaction is published.",
    },
  };
}

/** Serialize one row only after all publication invariants pass. */
export function toPublicProof(row: PublicProofRow, config: PublicProofPublicationConfig): PublicProofView | null {
  return publicProofFromRow(row, config);
}

function publicationCondition(config: PublicProofPublicationConfig): SQL {
  const polygonToken = trustedTokenFor("usdc-polygon", config);
  const polygonPolicy = finalityPolicyFor(137, config.finalityPolicies);
  const arbitrumToken = trustedTokenFor("usdc-arbitrum", config);
  const arbitrumPolicy = finalityPolicyFor(42161, config.finalityPolicies);
  const routeConditions: SQL[] = [];
  if (polygonToken && polygonPolicy) {
    routeConditions.push(
      and(
        eq(transfers.routeId, "usdc-polygon"),
        eq(transfers.targetAsset, "USDC"),
        eq(transfers.targetNetwork, "Polygon"),
        eq(transferProofs.chainId, 137),
        sql`lower(${transferProofs.tokenContract}) = ${polygonToken}`,
        eq(transferProofs.finalityLevel, finalityLevelFor(polygonPolicy)),
      )!,
    );
  }
  if (arbitrumToken && arbitrumPolicy) {
    routeConditions.push(
      and(
        eq(transfers.routeId, "usdc-arbitrum"),
        eq(transfers.targetAsset, "USDC"),
        eq(transfers.targetNetwork, "Arbitrum"),
        eq(transferProofs.chainId, 42161),
        sql`lower(${transferProofs.tokenContract}) = ${arbitrumToken}`,
        eq(transferProofs.finalityLevel, finalityLevelFor(arbitrumPolicy)),
      )!,
    );
  }
  const routeCondition = routeConditions.length > 0 ? or(...routeConditions) : sql`false`;
  return and(
    eq(transfers.status, "DELIVERED"),
    eq(transferProofs.evidenceSource, "evm_erc20_transfer"),
    isNotNull(transferProofs.evmTxHash),
    isNotNull(transferProofs.tokenContract),
    isNotNull(transferProofs.recipient),
    isNotNull(transferProofs.verifiedAmountAtomic),
    isNotNull(transferProofs.blockNumber),
    isNotNull(transferProofs.blockHash),
    isNotNull(transferProofs.finalityLevel),
    isNotNull(transferProofs.verifiedAt),
    sql`${transferProofs.evmTxHash} ~ '^0x[0-9a-fA-F]{64}$'`,
    sql`${transferProofs.tokenContract} ~ '^0x[0-9a-fA-F]{40}$'`,
    sql`${transferProofs.recipient} ~ '^0x[0-9a-fA-F]{40}$'`,
    sql`${transferProofs.verifiedAmountAtomic} ~ '^[0-9]+$'`,
    sql`${transfers.targetAmountAtomic} ~ '^[0-9]+$'`,
    sql`${transferProofs.blockHash} ~ '^0x[0-9a-fA-F]{64}$'`,
    sql`lower(${transferProofs.recipient}) = lower(${transfers.destination})`,
    sql`(${transferProofs.verifiedAmountAtomic})::numeric >= (${transfers.targetAmountAtomic})::numeric`,
    routeCondition,
  )!;
}

function cursorCondition(cursor: ProofCursor): SQL {
  const date = new Date(cursor.verifiedAt);
  return or(
    lt(transferProofs.verifiedAt, date),
    and(eq(transferProofs.verifiedAt, date), lt(transferProofs.id, cursor.proofId)),
  )!;
}

export async function listPublicProofs(
  query: PublicProofFeedQuery,
  config: PublicProofPublicationConfig,
): Promise<PublicProofFeedResult> {
  const db = getDb();
  const conditions: SQL[] = [publicationCondition(config)];
  if (query.cursor) conditions.push(cursorCondition(query.cursor));
  const rows = await db
    .select({ proof: transferProofs, transfer: transfers })
    .from(transferProofs)
    .innerJoin(transfers, eq(transferProofs.transferId, transfers.id))
    .where(and(...conditions))
    .orderBy(desc(transferProofs.verifiedAt), desc(transferProofs.id))
    .limit(query.limit + 1);
  const views = rows.map((row) => publicProofFromRow(row, config)).filter((row): row is PublicProofView => row !== null);
  const hasMore = views.length > query.limit;
  const proofs = views.slice(0, query.limit);
  const last = proofs[proofs.length - 1];
  return {
    proofs,
    pagination: {
      limit: query.limit,
      nextCursor: hasMore && last ? encodeProofCursor({ verifiedAt: last.destination.verifiedAt, proofId: last.proofId }) : null,
      hasMore,
    },
  };
}

export async function getPublicProof(
  proofId: string,
  config: PublicProofPublicationConfig,
): Promise<PublicProofView | null> {
  if (!UUID_RE.test(proofId)) return null;
  const rows = await getDb()
    .select({ proof: transferProofs, transfer: transfers })
    .from(transferProofs)
    .innerJoin(transfers, eq(transferProofs.transferId, transfers.id))
    .where(and(eq(transferProofs.id, proofId), publicationCondition(config)))
    .limit(1);
  const row = rows[0];
  return row ? publicProofFromRow(row, config) : null;
}

export function publicProofConfig(input: {
  routeTokens: Record<string, string>;
  finalityPolicies: Record<string, { mode: string; confirmations: number }>;
}): PublicProofPublicationConfig {
  return {
    routeTokens: input.routeTokens,
    finalityPolicies: input.finalityPolicies,
  };
}

export function settlementFinalityLevelForPublicProof(
  chainId: PublicProofChainId,
  finalityPolicies: Record<string, { mode: string; confirmations: number }>,
): string | null {
  const policy = finalityPolicyFor(chainId, finalityPolicies);
  return policy ? finalityLevelFor(policy) : null;
}
