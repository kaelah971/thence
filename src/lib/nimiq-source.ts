/**
 * Independent NIM source evidence for a Nimiq Pay Lightning handoff.
 *
 * Nimiq Pay's `payLightningInvoice()` result is only a client-visible
 * identifier. This module upgrades that identifier only after a trusted
 * Nimiq node proves the exact native NIM HTLC-creation transaction:
 * - the transaction is the requested hash and executed successfully;
 * - it is on the configured Nimiq network, has configured confirmations, and
 *   is covered by the next justified Albatross macro block;
 * - it is a native NIM HTLC creation, not an unrelated transaction/asset;
 * - the HTLC's refund sender is the authenticated wallet address; for an
 *   HTLC-funded source, Core's EarlyResolve owner signature proves that
 *   relationship instead of trusting the encoded address alone; and
 * - the HTLC's SHA-256 payment hash is the bound Satora Lightning hash.
 *
 * No payment, swap, claim or refund is initiated here. A missing/ambiguous
 * fact returns a non-proof result; callers must keep the source unverified.
 */
import {
  blake2b256,
  deriveNimiqAddress,
  nimiqBase32Decode,
  normalizeNimiqAddress,
  toUserFriendlyAddress,
  verifyEd25519Raw,
} from "@/lib/nimiq";

export const NIMIQ_SOURCE_RPC_TIMEOUT_MS = 8_000;
export const NIMIQ_SOURCE_TX_HASH_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** Nimiq Albatross account types accepted for the authenticated sender. */
export const NIMIQ_BASIC_ACCOUNT_TYPE = 0;
export const NIMIQ_HTLC_ACCOUNT_TYPE = 2;
/** TransactionFlags::CONTRACT_CREATION. */
export const NIMIQ_CONTRACT_CREATION_FLAG = 1;
/** SHA-256 discriminator written by Nimiq Pay's Lightning HTLC builder. */
export const NIMIQ_SHA256_HASH_ALGORITHM = 3;
/**
 * Core-rs Albatross HTLC creation data length:
 * 20 sender + 20 recipient + 1 algorithm + 32 hash root + 1 hash count +
 * 8-byte big-endian u64 timeout.
 */
export const NIMIQ_HTLC_CREATION_DATA_BYTES = 82;
/** Albatross finality policy: one macro block closes each 60-block batch. */
export const NIMIQ_BLOCKS_PER_BATCH = 60;
/** Official Albatross genesis heights used to locate the finalizing macro block. */
export const NIMIQ_MAINNET_GENESIS_BLOCK = 3_456_000;
export const NIMIQ_TESTNET_GENESIS_BLOCK = 3_032_010;

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
  /** Actual transaction sender, independently matched to the authenticated wallet or its authenticated HTLC owner proof. */
  senderAddress: string;
  ownerAddress: string;
  senderBinding: "DIRECT" | "HTLC_OWNER_SIGNATURE";
  amountLuna: string;
  feeLuna: string;
  totalDebitLuna: string;
  blockNumber: number;
  confirmations: number;
  /** Macro block whose Tendermint justification finalizes the transaction batch. */
  finalizedByMacroBlock: number;
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
  /** R1.1: the node has not indexed this hash (yet). Temporary; never proof of anything. */
  | "TRANSACTION_NOT_FOUND"
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
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

interface HtlcCreationData {
  sender: string;
  recipient: string;
  hashRoot: string;
  hashCount: number;
  /** Core-rs Albatross `u64` timeout, retained as a decimal string. */
  timeout: string;
}

function readBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function parseHtlcCreationData(value: unknown): HtlcCreationData | null {
  const bytes = hexBytes(value);
  // Core-rs Albatross serializes CreationTransactionData as:
  // 20 sender + 20 recipient + 1 algorithm + 32 hash + 1 count + 8-byte u64 timeout.
  if (!bytes || bytes.length !== NIMIQ_HTLC_CREATION_DATA_BYTES) return null;
  const sender = toUserFriendlyAddress(bytes.slice(0, 20));
  const recipient = toUserFriendlyAddress(bytes.slice(20, 40));
  const algorithm = bytes[40];
  const hashRoot = Buffer.from(bytes.slice(41, 73)).toString("hex");
  const hashCount = bytes[73];
  const timeout = readBigEndian(bytes.slice(74, 82));
  if (algorithm !== NIMIQ_SHA256_HASH_ALGORITHM || hashCount === undefined || hashCount < 1 || timeout <= 0n) return null;
  return { sender, recipient, hashRoot, hashCount, timeout: timeout.toString() };
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

/** postcard's unsigned variable-length integer encoding used for Vec<u8>. */
function pushUnsignedVarInt(output: number[], value: number): void {
  let remaining = value;
  do {
    const lower = remaining % 128;
    remaining = Math.floor(remaining / 128);
    output.push(lower | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
}

interface NimiqTransactionContentInput {
  data: Uint8Array;
  senderAddress: string;
  senderType: number;
  recipient: Uint8Array;
  recipientType: number;
  value: bigint;
  fee: bigint;
  validityStartHeight: number;
  networkId: number;
  flags: number;
  /** Albatross serializes sender_data as a postcard Vec<u8>. */
  senderData?: Uint8Array;
}

/**
 * Serialize the exact Core-rs `Transaction::serialize_content` bytes. The
 * recipient is supplied by the caller because contract creation hashes the
 * same content with a zero recipient, while signatures use the actual one.
 */
function serializeNimiqTransactionContent(input: NimiqTransactionContentInput): Uint8Array | null {
  const sender = addressBytes(input.senderAddress);
  const senderData = input.senderData ?? new Uint8Array(0);
  if (
    !sender ||
    input.recipient.length !== 20 ||
    input.data.length > 0xffff ||
    !Number.isSafeInteger(senderData.length) ||
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
  content.push(...sender, input.senderType, ...input.recipient, input.recipientType);
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
  // Core-rs omits sender_data only for PoW networks. The verifier accepts
  // Albatross mainnet/testnet only, both of which include this length byte.
  if (input.networkId === 5 || input.networkId === 24) {
    pushUnsignedVarInt(content, senderData.length);
    content.push(...senderData);
  }
  return Uint8Array.from(content);
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
  senderData?: Uint8Array;
}): string | null {
  const content = serializeNimiqTransactionContent({
    ...input,
    recipient: new Uint8Array(20),
  });
  return content ? toUserFriendlyAddress(blake2b256(content).subarray(0, 20)) : null;
}

const NIMIQ_ED25519_SIGNATURE_PROOF_BYTES = 1 + 32 + 1 + 64;
const NIMIQ_EARLY_RESOLVE_PROOF_BYTES = 1 + (2 * NIMIQ_ED25519_SIGNATURE_PROOF_BYTES);

interface Ed25519SignatureProof {
  publicKey: Uint8Array;
  signature: Uint8Array;
  end: number;
}

/**
 * Parse only the simple Ed25519/no-merkle-path SignatureProof form. Core also
 * supports ES256, merkle paths, and WebAuthn fields; unsupported forms stay
 * untrusted rather than being approximated here.
 */
function parseSimpleEd25519SignatureProof(bytes: Uint8Array, offset: number): Ed25519SignatureProof | null {
  const end = offset + NIMIQ_ED25519_SIGNATURE_PROOF_BYTES;
  if (end > bytes.length || bytes[offset] !== 0 || bytes[offset + 33] !== 0) return null;
  const publicKey = bytes.slice(offset + 1, offset + 33);
  const signature = bytes.slice(offset + 34, end);
  if (publicKey.every((byte) => byte === 0)) return null;
  return { publicKey, signature, end };
}

/**
 * Authenticate an HTLC-funded source transaction without treating the encoded
 * refund address alone as an ownership mapping. Albatross EarlyResolve proofs
 * serialize the recipient signature first and the original HTLC sender's
 * signature second. Both signatures must verify over the exact transaction
 * content, and the latter public key must derive to the authenticated owner.
 */
function hasAuthenticatedHtlcOwnerProof(
  proof: Uint8Array | null,
  transactionContent: Uint8Array | null,
  ownerAddress: string,
): boolean {
  if (!proof || !transactionContent || proof.length !== NIMIQ_EARLY_RESOLVE_PROOF_BYTES || proof[0] !== 1) return false;
  const recipientProof = parseSimpleEd25519SignatureProof(proof, 1);
  const senderProof = recipientProof ? parseSimpleEd25519SignatureProof(proof, recipientProof.end) : null;
  if (!recipientProof || !senderProof || senderProof.end !== proof.length) return false;
  if (
    !verifyEd25519Raw(recipientProof.publicKey, transactionContent, recipientProof.signature) ||
    !verifyEd25519Raw(senderProof.publicKey, transactionContent, senderProof.signature)
  ) {
    return false;
  }
  return deriveNimiqAddress(Buffer.from(senderProof.publicKey).toString("hex")) === ownerAddress;
}

/**
 * R1.1: Nimiq Albatross JSON-RPC answers an unknown hash with
 * `{"error":{"code":-32603,"message":"Internal error","data":"Transaction not found: <hash>"}}`.
 * Matches only that code AND that exact data for the requested hash; every
 * other -32603 (or any other error) stays a permanent PROVIDER_MALFORMED.
 */
export function isTransactionNotFoundError(payload: unknown, txHash: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const error = (payload as Record<string, unknown>)["error"];
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const e = error as Record<string, unknown>;
  if (e["code"] !== -32603 || typeof e["data"] !== "string") return false;
  const match = /^Transaction not found: (?:0x)?([0-9a-fA-F]{64})$/.exec(e["data"].trim());
  return match !== null && match[1]!.toLowerCase() === txHash.toLowerCase().replace(/^0x/, "");
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

function macroBlockNumberFor(blockNumber: number, network: NimiqSourceNetwork): number | null {
  const genesis = network === "mainnet" ? NIMIQ_MAINNET_GENESIS_BLOCK : NIMIQ_TESTNET_GENESIS_BLOCK;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < genesis) return null;
  const relative = blockNumber - genesis;
  const offset = relative % NIMIQ_BLOCKS_PER_BATCH;
  const macroBlock = blockNumber + (NIMIQ_BLOCKS_PER_BATCH - offset);
  return Number.isSafeInteger(macroBlock) ? macroBlock : null;
}

/** Minimal shape check for the RPC's serialized Tendermint macro justification. */
function hasMacroJustification(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const justification = value as Record<string, unknown>;
  const round = safeNumber(justification["round"], true);
  const signature = justification["sig"];
  if (!signature || typeof signature !== "object" || Array.isArray(signature) || round === null) return false;
  const multiSignature = signature as Record<string, unknown>;
  const signers = multiSignature["signers"];
  const encodedSignature = multiSignature["signature"];
  const hasSignatureBytes = typeof encodedSignature === "string"
    ? encodedSignature.length > 0
    : Array.isArray(encodedSignature)
      ? encodedSignature.length > 0
      : Boolean(encodedSignature && typeof encodedSignature === "object" && Object.keys(encodedSignature).length > 0);
  return Array.isArray(signers) && signers.length > 0 && hasSignatureBytes;
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
  const callRaw = (method: string, params: unknown[] = []): Promise<unknown> =>
    postJson(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), controller.signal);
  const call = async (method: string, params: unknown[] = []): Promise<unknown | null> => rpcResult(await callRaw(method, params));
  let transactionResult: unknown | null;
  try {
    const payload = await callRaw("getTransactionByHash", [txHash]);
    // R1.1: a hash the node has not indexed yet is a temporary lookup miss,
    // not a malformed response. Only this exact error for THIS hash qualifies.
    if (isTransactionNotFoundError(payload, txHash)) return fail("TRANSACTION_NOT_FOUND");
    transactionResult = rpcResult(payload);
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
  // Albatross confirmations are head-distance only. A transaction is final
  // only after the next macro block carries a Tendermint justification for its
  // batch; six confirmations alone are never treated as macro finality.
  const finalizedByMacroBlock = macroBlockNumberFor(blockNumber, input.config.network);
  if (finalizedByMacroBlock === null) return fail("PROVIDER_MALFORMED");
  let macroResult: unknown | null;
  try {
    macroResult = await call("getBlockByNumber", [finalizedByMacroBlock, false]);
  } catch {
    return fail("PROVIDER_UNAVAILABLE");
  }
  const macro = transactionRecord(macroResult);
  if (!macro) return fail("INSUFFICIENT_FINALITY");
  const observedMacroNumber = safeNumber(macro["number"], true);
  if (
    observedMacroNumber !== finalizedByMacroBlock ||
    macro["type"] !== "macro" ||
    !hasExpectedNetwork(macro["network"], input.config.network) ||
    !hasMacroJustification(macro["justification"])
  ) {
    return fail("PROVIDER_MALFORMED");
  }
  const fromType = safeNumber(record["fromType"] ?? record["senderType"], true);
  const toType = safeNumber(record["toType"] ?? record["recipientType"], true);
  const flags = safeNumber(record["flags"], true);
  const validityStartHeight = safeNumber(record["validityStartHeight"] ?? record["validity_start_height"], true);
  const networkId = safeNumber(record["networkId"] ?? record["network_id"], true);
  const sender = cleanAddress(record["from"] ?? record["sender"]);
  const recipient = cleanAddress(record["to"] ?? record["recipient"]);
  const recipientData = hexBytes(record["recipientData"] ?? record["recipient_data"]);
  const senderDataValue = record["senderData"] ?? record["sender_data"];
  const senderData = senderDataValue === undefined ? null : hexBytes(senderDataValue);
  const htlc = parseHtlcCreationData(record["recipientData"] ?? record["recipient_data"]);
  const optionalAsset = record["asset"];
  if (senderData === null) return fail("PROVIDER_MALFORMED");
  // Core's basic and HTLC outgoing verifiers reject sender_data for these
  // account types. Do not derive or authenticate a non-canonical transaction.
  if (senderData.length !== 0) return fail("WRONG_ASSET");
  if (
    (optionalAsset !== undefined && (typeof optionalAsset !== "string" || optionalAsset.toUpperCase() !== "NIM")) ||
    (fromType !== NIMIQ_BASIC_ACCOUNT_TYPE && fromType !== NIMIQ_HTLC_ACCOUNT_TYPE) ||
    toType !== NIMIQ_HTLC_ACCOUNT_TYPE ||
    flags !== NIMIQ_CONTRACT_CREATION_FLAG ||
    sender === null ||
    recipient === null ||
    recipientData === null ||
    htlc === null
  ) {
    return fail("WRONG_ASSET");
  }
  // A basic-account funding transaction must be sent by the authenticated
  // owner. An HTLC-funded transaction may only use the encoded refund sender
  // after Core's EarlyResolve owner signature independently authenticates that
  // HTLC-to-owner relationship; the address in creation data alone is not
  // sufficient evidence and never relaxes WRONG_SENDER.
  if (htlc.sender !== ownerAddress) return fail("WRONG_SENDER");
  if (fromType === NIMIQ_BASIC_ACCOUNT_TYPE && sender !== ownerAddress) return fail("WRONG_SENDER");
  if (htlc.hashRoot !== lightningPaymentHash || htlc.hashCount !== 1) {
    return fail("PAYMENT_HASH_MISMATCH");
  }

  const amount = integer(record["value"], false);
  const fee = integer(record["fee"], true);
  if (amount === null || fee === null) return fail("INVALID_AMOUNT");
  if (validityStartHeight === null || networkId === null) return fail("PROVIDER_MALFORMED");
  const recipientBytes = addressBytes(recipient);
  if (!recipientBytes) return fail("WRONG_ASSET");
  if (fromType === NIMIQ_HTLC_ACCOUNT_TYPE) {
    const transactionContent = serializeNimiqTransactionContent({
      data: recipientData,
      senderAddress: sender,
      senderType: fromType,
      recipient: recipientBytes,
      recipientType: toType,
      value: amount,
      fee,
      validityStartHeight,
      networkId,
      flags,
      senderData,
    });
    if (!hasAuthenticatedHtlcOwnerProof(hexBytes(record["proof"]), transactionContent, ownerAddress)) {
      return fail("WRONG_SENDER");
    }
  }
  const expectedRecipient = deriveNimiqHtlcCreationAddress({
    data: recipientData,
    senderAddress: sender,
    senderType: fromType,
    recipientType: toType,
    value: amount,
    fee,
    validityStartHeight,
    networkId,
    flags,
    senderData,
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
      senderBinding: fromType === NIMIQ_HTLC_ACCOUNT_TYPE ? "HTLC_OWNER_SIGNATURE" : "DIRECT",
      amountLuna: amount.toString(),
      feeLuna: fee.toString(),
      totalDebitLuna: (amount + fee).toString(),
      blockNumber,
      confirmations,
      finalizedByMacroBlock,
      network: input.config.network,
      lightningPaymentHash,
      htlcRecipient: htlc.recipient,
      htlcTimeout: htlc.timeout,
      verifiedAt: new Date().toISOString(),
    },
  };
}
