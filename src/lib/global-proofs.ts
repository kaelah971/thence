/**
 * A3c.1 — read-only global proof-of-payments publication.
 *
 * This module exposes only already-committed delivery evidence. It never
 * changes transfer state or trusts Nimiq Pay's host response as proof. Source
 * rows are publishable only after the server-side independent NIM verifier has
 * recorded its result during reconciliation.
 */
import { and, desc, eq, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { transferProofs, transferTransitions, transfers } from "@/db/schema";
import { getDb } from "@/lib/db";
import { DEFAULT_FINALITY_POLICY, explorerTxUrl } from "@/lib/settlement";
import { isValidNimiqAddress } from "@/lib/nimiq";
import { TRUSTED_ROUTE_TOKEN_IDENTITIES } from "@/lib/satora";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const ATOMIC_RE = /^[0-9]+$/;

export const PUBLIC_PROOF_DEFAULT_LIMIT = 20;
export const PUBLIC_PROOF_MAX_LIMIT = 50;
export const PUBLIC_PROOF_DECIMALS = 6;
export const PUBLIC_PROOF_NIM_DECIMALS = 5;
export const PUBLIC_PROOF_ASSET = "USDC" as const;

export type PublicProofNetwork = "Polygon" | "Arbitrum";
export type PublicProofChainId = 137 | 42161;
export type PublicProofSourceNetwork = "mainnet" | "testnet";
export type PublicProofSourceEvidence = "VERIFIED";

export interface PublicProofPublicationConfig {
  routeTokens: Record<string, string>;
  finalityPolicies: Record<string, { mode: string; confirmations: number }>;
}

export interface PublicProofRow {
  proof: typeof transferProofs.$inferSelect;
  transfer: typeof transfers.$inferSelect;
  /** Set by the publication query from an internal verified-source audit row. */
  sourceVerified?: boolean;
  /** The source hash recorded by that same internal audit row. */
  sourceVerifiedHash?: string | null;
  /** Full verified source fields selected from that same audit row. */
  sourceVerifiedEvidence?: unknown;
}

/**
 * The source verifier writes a non-secret VERIFIED marker into the same
 * transaction as the handoff transition. The publication query also requires
 * that marker, while this boundary independently checks the stored hash shape.
 * A host hash without that marker remains only an unverified identifier.
 */
export function getIndependentNimiqSourceProof(row: PublicProofRow): { transactionHash: string } | null {
  const transactionHash = row.proof.nimiqTxHash?.trim().toLowerCase().replace(/^0x/, "");
  const markerHash = row.sourceVerifiedHash === undefined
    ? transactionHash
    : row.sourceVerifiedHash?.trim().toLowerCase().replace(/^0x/, "");
  if (
    row.sourceVerified !== true ||
    !transactionHash ||
    !/^[0-9a-f]{64}$/.test(transactionHash) ||
    markerHash !== transactionHash
  ) {
    return null;
  }
  return { transactionHash };
}

interface VerifiedNimiqSourcePublication {
  network: PublicProofSourceNetwork;
  sender: string;
  amountLuna: string;
  feeLuna: string;
  totalDebitLuna: string;
  transactionHash: string;
  blockNumber: string;
  confirmations: number;
  /** Internal finality evidence; not exposed in the public proof view. */
  macroBlockNumber: string;
  verifiedAt: string;
}

function decimalString(value: unknown, allowZero: boolean): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  if (!allowZero && BigInt(value) === 0n) return null;
  return value;
}

function sourceExplorerTxUrl(network: PublicProofSourceNetwork, transactionHash: string): string {
  const explorer = network === "mainnet" ? "https://nimiq.watch" : "https://testnet.nimiq.watch";
  return `${explorer}/#${transactionHash}`;
}

function verifiedNimiqSourceFor(row: PublicProofRow, transactionHash: string): VerifiedNimiqSourcePublication | null {
  const raw = row.sourceVerifiedEvidence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const normalizedHash = typeof value["transactionHash"] === "string"
    ? value["transactionHash"].trim().toLowerCase().replace(/^0x/, "")
    : "";
  const sender = typeof value["sender"] === "string" ? value["sender"] : "";
  const network = value["network"];
  const amountLuna = decimalString(value["amountLuna"], false);
  const feeLuna = decimalString(value["feeLuna"], true);
  const totalDebitLuna = decimalString(value["totalDebitLuna"], false);
  const blockNumber = decimalString(value["blockNumber"], true);
  const confirmationsRaw = decimalString(value["confirmations"], true);
  const macroBlockNumber = decimalString(value["macroBlockNumber"], true);
  const verifiedAt = value["verifiedAt"];
  if (
    normalizedHash !== transactionHash ||
    !/^[0-9a-f]{64}$/.test(normalizedHash) ||
    !isValidNimiqAddress(sender) ||
    (network !== "mainnet" && network !== "testnet") ||
    amountLuna === null ||
    feeLuna === null ||
    totalDebitLuna === null ||
    BigInt(totalDebitLuna) !== BigInt(amountLuna) + BigInt(feeLuna) ||
    blockNumber === null ||
    confirmationsRaw === null ||
    macroBlockNumber === null ||
    BigInt(macroBlockNumber) < BigInt(blockNumber) ||
    BigInt(confirmationsRaw) < 1n ||
    BigInt(confirmationsRaw) > BigInt(Number.MAX_SAFE_INTEGER) ||
    BigInt(blockNumber) > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof verifiedAt !== "string" ||
    Number.isNaN(new Date(verifiedAt).getTime()) ||
    new Date(verifiedAt).toISOString() !== verifiedAt
  ) {
    return null;
  }
  return {
    network,
    sender,
    amountLuna,
    feeLuna,
    totalDebitLuna,
    transactionHash: normalizedHash,
    blockNumber,
    confirmations: Number(confirmationsRaw),
    macroBlockNumber,
    verifiedAt,
  };
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
    source: "VERIFIED";
    overall: "VERIFIED";
  };
  source: {
    asset: "NIM";
    network: PublicProofSourceNetwork;
    sender: string;
    amountLuna: string;
    feeLuna: string;
    totalDebitLuna: string;
    decimals: typeof PUBLIC_PROOF_NIM_DECIMALS;
    transactionHash: string;
    blockNumber: string;
    confirmations: number;
    verifiedAt: string;
    explorerTxUrl: string;
    evidence: PublicProofSourceEvidence;
    verification: "VERIFIED";
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
  // A3c.1 may not publish destination-only records. The optional hash in the
  // legacy proof row is usable only when reconciliation recorded independent
  // source verification in the same transaction as the handoff transition.
  const sourceProof = getIndependentNimiqSourceProof(row);
  const sourceEvidence = sourceProof === null ? null : verifiedNimiqSourceFor(row, sourceProof.transactionHash);
  // Public proofs are production-facing mainnet records. Testnet source
  // evidence may be useful for controlled verification, but must never be
  // paired with a mainnet USDC destination and published as a real payment.
  if (sourceEvidence === null || sourceEvidence.network !== "mainnet") return false;
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
  const sourceHash = getIndependentNimiqSourceProof(row)!;
  const source = verifiedNimiqSourceFor(row, sourceHash.transactionHash)!;
  const sourceEvidence: PublicProofSourceEvidence = "VERIFIED";
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
      source: "VERIFIED",
      overall: "VERIFIED",
    },
    source: {
      asset: "NIM",
      network: source.network,
      sender: source.sender,
      amountLuna: source.amountLuna,
      feeLuna: source.feeLuna,
      totalDebitLuna: source.totalDebitLuna,
      decimals: PUBLIC_PROOF_NIM_DECIMALS,
      transactionHash: source.transactionHash,
      blockNumber: source.blockNumber,
      confirmations: source.confirmations,
      verifiedAt: source.verifiedAt,
      explorerTxUrl: sourceExplorerTxUrl(source.network, source.transactionHash),
      evidence: sourceEvidence,
      verification: "VERIFIED",
      note: "The NIM HTLC transaction sender, amount, network, confirmation depth and justified macro-block finality were independently verified and bound to this delivery; payment hashes and HTLC internals are not published.",
    },
  };
}

/** Serialize one row only after all publication invariants pass. */
export function toPublicProof(row: PublicProofRow, config: PublicProofPublicationConfig): PublicProofView | null {
  return publicProofFromRow(row, config);
}

function sourceVerifiedEvidenceSql(): SQL {
  return sql`(
    SELECT jsonb_build_object(
      'transactionHash', ${transferTransitions.evidence}->>'nimiqSourceTxHash',
      'sender', ${transferTransitions.evidence}->>'nimiqSourceSenderAddress',
      'amountLuna', ${transferTransitions.evidence}->>'nimiqSourceAmountLuna',
      'feeLuna', ${transferTransitions.evidence}->>'nimiqSourceFeeLuna',
      'totalDebitLuna', ${transferTransitions.evidence}->>'nimiqSourceTotalDebitLuna',
      'blockNumber', ${transferTransitions.evidence}->>'nimiqSourceBlockNumber',
      'confirmations', ${transferTransitions.evidence}->>'nimiqSourceConfirmations',
      'macroBlockNumber', ${transferTransitions.evidence}->>'nimiqSourceFinalizedByMacroBlock',
      'network', ${transferTransitions.evidence}->>'nimiqSourceNetwork',
      'verifiedAt', ${transferTransitions.evidence}->>'nimiqSourceVerifiedAt'
    )
    FROM ${transferTransitions}
    WHERE ${transferTransitions.transferId} = ${transfers.id}
      AND ${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'
      AND lower(regexp_replace(lower(${transferTransitions.evidence}->>'nimiqSourceTxHash'), '^0x', '')) =
        lower(regexp_replace(lower(${transferProofs.nimiqTxHash}), '^0x', ''))
    ORDER BY ${transferTransitions.createdAt} DESC
    LIMIT 1
  )`;
}

function publicationCondition(config: PublicProofPublicationConfig): SQL {
  // Keep the database query fail-closed too. Only rows with a reconciliation
  // audit marker produced by the independent verifier are candidates; the
  // serializer still re-checks the hash and every destination invariant.
  const sourceVerificationReady = sql`EXISTS (
    SELECT 1
    FROM ${transferTransitions}
    WHERE ${transferTransitions.transferId} = ${transfers.id}
      AND ${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'
      AND ${transferTransitions.evidence}->>'nimiqSourceNetwork' = 'mainnet'
      AND ${transferTransitions.evidence}->>'nimiqSourceSenderAddress' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceAmountLuna' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceFeeLuna' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceTotalDebitLuna' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceBlockNumber' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceConfirmations' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceFinalizedByMacroBlock' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceNetwork' IS NOT NULL
      AND ${transferTransitions.evidence}->>'nimiqSourceVerifiedAt' IS NOT NULL
      AND lower(regexp_replace(lower(${transferTransitions.evidence}->>'nimiqSourceTxHash'), '^0x', '')) =
        lower(regexp_replace(lower(${transferProofs.nimiqTxHash}), '^0x', ''))
  )`;
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
    sourceVerificationReady,
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
    .select({
      proof: transferProofs,
      transfer: transfers,
      sourceVerified: sql<boolean>`EXISTS (
        SELECT 1
        FROM ${transferTransitions}
        WHERE ${transferTransitions.transferId} = ${transfers.id}
          AND ${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'
          AND lower(regexp_replace(${transferTransitions.evidence}->>'nimiqSourceTxHash', '^0x', '')) =
            lower(regexp_replace(${transferProofs.nimiqTxHash}, '^0x', ''))
      )`,
      sourceVerifiedHash: sql<string | null>`(
        SELECT ${transferTransitions.evidence}->>'nimiqSourceTxHash'
        FROM ${transferTransitions}
        WHERE ${transferTransitions.transferId} = ${transfers.id}
          AND ${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'
          AND lower(regexp_replace(${transferTransitions.evidence}->>'nimiqSourceTxHash', '^0x', '')) =
            lower(regexp_replace(${transferProofs.nimiqTxHash}, '^0x', ''))
        ORDER BY ${transferTransitions.createdAt} DESC
        LIMIT 1
      )`,
      sourceVerifiedEvidence: sourceVerifiedEvidenceSql(),
    })
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
    .select({
      proof: transferProofs,
      transfer: transfers,
      sourceVerified: sql<boolean>`EXISTS (
        SELECT 1
        FROM ${transferTransitions}
        WHERE ${transferTransitions.transferId} = ${transfers.id}
          AND ${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'
          AND lower(regexp_replace(${transferTransitions.evidence}->>'nimiqSourceTxHash', '^0x', '')) =
            lower(regexp_replace(${transferProofs.nimiqTxHash}, '^0x', ''))
      )`,
      sourceVerifiedHash: sql<string | null>`(
        SELECT ${transferTransitions.evidence}->>'nimiqSourceTxHash'
        FROM ${transferTransitions}
        WHERE ${transferTransitions.transferId} = ${transfers.id}
          AND ${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'
          AND lower(regexp_replace(${transferTransitions.evidence}->>'nimiqSourceTxHash', '^0x', '')) =
            lower(regexp_replace(${transferProofs.nimiqTxHash}, '^0x', ''))
        ORDER BY ${transferTransitions.createdAt} DESC
        LIMIT 1
      )`,
      sourceVerifiedEvidence: sourceVerifiedEvidenceSql(),
    })
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
