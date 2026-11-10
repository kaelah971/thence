/**
 * Independent NIM source evidence for a Nimiq Pay Lightning handoff.
 *
 * Nimiq Pay's `payLightningInvoice()` result is only a client-visible
 * identifier. This module upgrades that identifier only after a trusted
 * Nimiq node proves the exact native NIM HTLC-creation transaction:
 * - the transaction is the requested hash and executed successfully;
 * - it is on the configured Nimiq network and has configured confirmation finality;
 * - it is a native NIM HTLC creation, not an unrelated transaction/asset;
 * - the HTLC's refund sender is the authenticated wallet address; and
 * - the HTLC's SHA-256 payment hash is the bound Satora Lightning hash.
 *
 * No payment, swap, claim or refund is initiated here. A missing/ambiguous
 * fact returns a non-proof result; callers must keep the source unverified.
 */
import { blake2b256, nimiqBase32Decode, normalizeNimiqAddress, toUserFriendlyAddress } from "@/lib/nimiq";

export const NIMIQ_SOURCE_RPC_TIMEOUT_MS = 8_000;
export const NIMIQ_SOURCE_TX_HASH_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** Nimiq Albatross account types accepted for the authenticated sender. */
export const NIMIQ_BASIC_ACCOUNT_TYPE = 0;
export const NIMIQ_HTLC_ACCOUNT_TYPE = 2;
/** TransactionFlags::CONTRACT_CREATION. */
export const NIMIQ_CONTRACT_CREATION_FLAG = 1;
/** SHA-256 discriminator written by Nimiq Pay's Lightning HTLC builder. */
export const NIMIQ_SHA256_HASH_ALGORITHM = 3;
/** Core-rs HTLC creation data length: 20 + 20 + 1 + 32 + 1 + 4 bytes. */
export const NIMIQ_HTLC_CREATION_DATA_BYTES = 78;

export type NimiqSourceNetwork = "mainnet" | "testnet";

export interface NimiqSourceRpcConfig {
  url: string;
  network: NimiqSourceNetwork;
  minConfirmations: number;
  timeoutMs?: number;
}

export interface NimiqSourceVerificationInput {
  txHash: string;
  ownerAddress: string;
  lightningPaymentHash: string;
  config: NimiqSourceRpcConfig;
  /** Optional only for a separately trusted historical binding. */
  expectedAmountLuna?: string;
}

export interface VerifiedNimiqSource {
  asset: "NIM";
  transactionHash: string;
  /** Actual transaction sender, independently matched to the authenticated wallet. */
  senderAddress: string;
  ownerAddress: string;
  amountLuna: string;
  feeLuna: string;
  totalDebitLuna: string;
  blockNumber: number;
  confirmations: number;
  network: NimiqSourceNetwork;
  lightningPaymentHash: string;
  htlcRecipient: string;
  htlcTimeout: string;
  verifiedAt: string;
}

export type NimiqSourceFailureCode =
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_MALFORMED"
  | "HASH_MISMATCH"
  | "UNSUCCESSFUL"
  | "WRONG_NETWORK"
  | "INSUFFICIENT_FINALITY"
  | "WRONG_ASSET"
  | "WRONG_SENDER"
  | "PAYMENT_HASH_MISMATCH"
  | "INVALID_AMOUNT"
  | "AMOUNT_MISMATCH";

export type NimiqSourceVerification =
  | { ok: true; evidence: VerifiedNimiqSource }
  | { ok: false; code: NimiqSourceFailureCode };

type PostJson = (url: string, body: string, signal: AbortSignal) => Promise<unknown>;

const defaultPostJson: PostJson = async (url, body, signal) => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      signal,
      cache: "no-store",
    });
  } catch {
    throw new Error("Nimiq source RPC unavailable.");
  }
  if (!response.ok) throw new Error("Nimiq source RPC unavailable.");
  return response.json();
};

let postJson: PostJson = defaultPostJson;

/** Test seam: replace the trusted-node transport without touching a network. */
export function setNimiqSourceRpcTransportForTests(next: PostJson | null): void {
  postJson = next ?? defaultPostJson;
}

export function normalizeNimiqSourceHash(value: unknown): string | null {
  if (typeof value !== "string" || !NIMIQ_SOURCE_TX_HASH_RE.test(value)) return null;
  return value.replace(/^0x/i, "").toLowerCase();
}

export interface NimiqSourceAttribution {
  transferId: string;
  transactionHash: string | null;
}

/** True only when no other transfer already owns this exact source hash. */
export function isNimiqSourceHashUnattributed(
  transactionHash: string,
  transferId: string,
  existing: readonly NimiqSourceAttribution[],
): boolean {
  const normalized = normalizeNimiqSourceHash(transactionHash);
  if (!normalized) return false;
  return existing.every(
    (row) => row.transferId === transferId || normalizeNimiqSourceHash(row.transactionHash) !== normalized,
  );
}

/**
 * Historical recovery accepts an exact operator-record identity only when the
 * supplied set is one valid, unambiguous hash. It never guesses from amounts,
 * timestamps, labels, or a destination-only transaction.
 */
export function selectUnambiguousHistoricalNimiqSourceHash(candidates: readonly string[]): string | null {
  const normalized = candidates.map((candidate) => normalizeNimiqSourceHash(candidate));
  if (normalized.some((candidate) => candidate === null)) return null;
  const unique = [...new Set(normalized as string[])];
  return unique.length === 1 ? unique[0]! : null;
}

function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeNimiqAddress(value);
  } catch {
    return null;
  }
}

function integer(value: unknown, allowZero = true): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) return null;
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return allowZero || parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function safeNumber(value: unknown, allowZero = true): number | null {
  const parsed = integer(value, allowZero);
  if (parsed === null || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

function expectedNetworkIds(network: NimiqSourceNetwork): Set<number | string> {
  // Nimiq's JSON-RPC serializes NetworkId as "MainAlbatross"/"TestAlbatross"
  // in human-readable JSON, while older nodes/SDKs expose 24/5.
  return network === "mainnet" ? new Set([24, "MainAlbatross", "mainalbatross"]) : new Set([5, "TestAlbatross", "testalbatross"]);
}

function hasExpectedNetwork(value: unknown, network: NimiqSourceNetwork): boolean {
  if (typeof value === "number") return expectedNetworkIds(network).has(value);
  if (typeof value === "string") return expectedNetworkIds(network).has(value) || expectedNetworkIds(network).has(value.toLowerCase());
  return false;
}

function hexBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

interface HtlcCreationData {
  sender: string;
  recipient: string;
  hashRoot: string;
  hashCount: number;
  timeout: number;
}

function parseHtlcCreationData(value: unknown): HtlcCreationData | null {
  const bytes = hexBytes(value);
  // Core-rs serializes timeout as a big-endian u32:
  // 20 sender + 20 recipient + 1 algorithm + 32 hash + 1 count + 4 timeout.
  if (!bytes || bytes.length !== NIMIQ_HTLC_CREATION_DATA_BYTES) return null;
  const sender = toUserFriendlyAddress(bytes.slice(0, 20));
  const recipient = toUserFriendlyAddress(bytes.slice(20, 40));
  const algorithm = bytes[40];
  const hashRoot = Buffer.from(bytes.slice(41, 73)).toString("hex");
  const hashCount = bytes[73];
  const timeoutBytes = Buffer.from(bytes.slice(74, 78));
  const timeout = timeoutBytes.readUInt32BE(0);
  if (algorithm !== NIMIQ_SHA256_HASH_ALGORITHM || hashCount === undefined || hashCount < 1 || timeout <= 0) return null;
  return { sender, recipient, hashRoot, hashCount, timeout };
}

function addressBytes(address: string): Uint8Array | null {
  try {
    const bytes = nimiqBase32Decode(address.replace(/ /g, "").slice(4));
    return bytes.length === 20 ? bytes : null;
  } catch {
    return null;
  }
}

function pushBigEndian(output: number[], value: bigint, byteLength: number): void {
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output.push(Number((value >> BigInt(index * 8)) & 0xffn));
  }
}

/**
 * Core-rs derives a contract-creation recipient by hashing the transaction
 * content with the recipient field replaced by 20 zero bytes. This check is
 * important: the zero address is only the derivation seed, never the on-chain
 * HTLC recipient.
 */
export function deriveNimiqHtlcCreationAddress(input: {
  data: Uint8Array;
  senderAddress: string;
  senderType: number;
  recipientType: number;
  value: bigint;
  fee: bigint;
  validityStartHeight: number;
  networkId: number;
  flags: number;
}): string | null {
  const sender = addressBytes(input.senderAddress);
  if (
    !sender ||
    input.data.length > 0xffff ||
    !Number.isSafeInteger(input.senderType) ||
    !Number.isSafeInteger(input.recipientType) ||
    input.senderType < 0 ||
    input.senderType > 0xff ||
    input.recipientType < 0 ||
    input.recipientType > 0xff ||
    !Number.isSafeInteger(input.validityStartHeight) ||
    input.validityStartHeight < 0 ||
    input.validityStartHeight > 0xffff_ffff ||
    !Number.isSafeInteger(input.networkId) ||
    input.networkId < 0 ||
    input.networkId > 0xff ||
    !Number.isSafeInteger(input.flags) ||
    input.flags < 0 ||
    input.flags > 0xff ||
    input.value < 0n ||
    input.fee < 0n ||
    input.value > 0xffff_ffff_ffff_ffffn ||
    input.fee > 0xffff_ffff_ffff_ffffn
  ) {
    return null;
  }
  const content: number[] = [input.data.length >>> 8, input.data.length & 0xff, ...input.data];
  content.push(...sender, input.senderType);
  content.push(...new Uint8Array(20), input.recipientType);
  pushBigEndian(content, input.value, 8);
  pushBigEndian(content, input.fee, 8);
  content.push(
    (input.validityStartHeight >>> 24) & 0xff,
    (input.validityStartHeight >>> 16) & 0xff,
    (input.validityStartHeight >>> 8) & 0xff,
    input.validityStartHeight & 0xff,
    input.networkId,
    input.flags,
  );
  return toUserFriendlyAddress(blake2b256(Uint8Array.from(content)).subarray(0, 20));
}

function rpcResult(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  if (root["error"] !== undefined && root["error"] !== null) return null;
  const result = root["result"];
  if (result && typeof result === "object" && !Array.isArray(result) && "data" in result) {
    return (result as Record<string, unknown>)["data"] ?? null;
  }
  return result ?? null;
}

function transactionRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  const nested = outer["transaction"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>;
    return {
      ...nestedRecord,
      executionResult: outer["executionResult"] ?? nestedRecord["executionResult"],
    };
  }
  return outer;
}

/**
 * Verify one host-reported hash against a trusted Nimiq JSON-RPC node.
 * This is read-only and returns no partial proof on any mismatch.
 */
export async function verifyNimiqSourceTransaction(input: NimiqSourceVerificationInput): Promise<NimiqSourceVerification> {
  const txHash = normalizeNimiqSourceHash(input.txHash);
  const lightningPaymentHash = normalizeNimiqSourceHash(input.lightningPaymentHash);
  const ownerAddress = cleanAddress(input.ownerAddress);
  const url = input.config.url.trim();
  if (!txHash || !lightningPaymentHash || !ownerAddress || !url || !/^https:\/\/[^\s]+$/i.test(url)) {
    return { ok: false, code: url ? "INVALID_INPUT" : "NOT_CONFIGURED" };
  }
  if (!Number.isInteger(input.config.minConfirmations) || input.config.minConfirmations < 1) {
    return { ok: false, code: "INVALID_INPUT" };
  }
  const timeoutMs = input.config.timeoutMs ?? NIMIQ_SOURCE_RPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return { ok: false, code: "INVALID_INPUT" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fail = (code: NimiqSourceFailureCode): NimiqSourceVerification => {
    clearTimeout(timer);
    return { ok: false, code };
  };
  const call = async (method: string, params: unknown[] = []): Promise<unknown | null> => {
    const payload = await postJson(
      url,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      controller.signal,
    );
    return rpcResult(payload);
  };
  let transactionResult: unknown | null;
  try {
    transactionResult = await call("getTransactionByHash", [txHash]);
  } catch {
    return fail("PROVIDER_UNAVAILABLE");
  }

  const record = transactionRecord(transactionResult);
  if (!record) return fail("PROVIDER_MALFORMED");
  const observedHash = normalizeNimiqSourceHash(record["hash"]);
  if (!observedHash) return fail("PROVIDER_MALFORMED");
  if (observedHash !== txHash) return fail("HASH_MISMATCH");
  if (record["executionResult"] !== true) return fail("UNSUCCESSFUL");
  if (!hasExpectedNetwork(record["networkId"], input.config.network)) return fail("WRONG_NETWORK");

  const confirmations = safeNumber(record["confirmations"], true);
  const blockNumber = safeNumber(record["blockNumber"], true);
  if (confirmations === null || blockNumber === null || confirmations < input.config.minConfirmations) {
    return fail("INSUFFICIENT_FINALITY");
  }
  const fromType = safeNumber(record["fromType"] ?? record["senderType"], true);
  const toType = safeNumber(record["toType"] ?? record["recipientType"], true);
  const flags = safeNumber(record["flags"], true);
  const validityStartHeight = safeNumber(record["validityStartHeight"] ?? record["validity_start_height"], true);
  const networkId = safeNumber(record["networkId"] ?? record["network_id"], true);
  const sender = cleanAddress(record["from"] ?? record["sender"]);
  const recipient = cleanAddress(record["to"] ?? record["recipient"]);
  const htlc = parseHtlcCreationData(record["recipientData"] ?? record["recipient_data"]);
  const optionalAsset = record["asset"];
  if (
    (optionalAsset !== undefined && (typeof optionalAsset !== "string" || optionalAsset.toUpperCase() !== "NIM")) ||
    (fromType !== NIMIQ_BASIC_ACCOUNT_TYPE && fromType !== NIMIQ_HTLC_ACCOUNT_TYPE) ||
    toType !== NIMIQ_HTLC_ACCOUNT_TYPE ||
    flags !== NIMIQ_CONTRACT_CREATION_FLAG ||
    sender === null ||
    recipient === null ||
    htlc === null
  ) {
    return fail("WRONG_ASSET");
  }
  // Both the value-debiting transaction sender and the HTLC's encoded refund
  // sender must match the authenticated wallet binding.
  if (sender !== ownerAddress || htlc.sender !== ownerAddress) return fail("WRONG_SENDER");
  if (htlc.hashRoot !== lightningPaymentHash || htlc.hashCount !== 1) {
    return fail("PAYMENT_HASH_MISMATCH");
  }

  const amount = integer(record["value"], false);
  const fee = integer(record["fee"], true);
  if (amount === null || fee === null) return fail("INVALID_AMOUNT");
  if (validityStartHeight === null || networkId === null) return fail("PROVIDER_MALFORMED");
  const expectedRecipient = deriveNimiqHtlcCreationAddress({
    data: hexBytes(record["recipientData"] ?? record["recipient_data"])!,
    senderAddress: sender,
    senderType: fromType,
    recipientType: toType,
    value: amount,
    fee,
    validityStartHeight,
    networkId,
    flags,
  });
  if (expectedRecipient === null || expectedRecipient !== recipient) return fail("WRONG_ASSET");
  if (input.expectedAmountLuna !== undefined) {
    const expected = integer(input.expectedAmountLuna, false);
    if (expected === null || expected !== amount) return fail("AMOUNT_MISMATCH");
  }

  clearTimeout(timer);
  return {
    ok: true,
    evidence: {
      asset: "NIM",
      transactionHash: txHash,
      senderAddress: sender,
      ownerAddress,
      amountLuna: amount.toString(),
      feeLuna: fee.toString(),
      totalDebitLuna: (amount + fee).toString(),
      blockNumber,
      confirmations,
      network: input.config.network,
      lightningPaymentHash,
      htlcRecipient: htlc.recipient,
      htlcTimeout: String(htlc.timeout),
      verifiedAt: new Date().toISOString(),
    },
  };
}
