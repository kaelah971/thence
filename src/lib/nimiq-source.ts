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
export function serializeNimiqTransactionContent(input: NimiqTransactionContentInput): Uint8Array | null {
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

/** Positional (array) or named (object) JSON-RPC params. */
type RpcCall = (method: string, params?: unknown) => Promise<unknown | null>;

/**
 * Albatross confirmations are head-distance only. A transaction is final only
 * after the next macro block carries a Tendermint justification for its batch;
 * confirmations alone are never treated as macro finality.
 */
async function macroFinality(
  call: RpcCall,
  blockNumber: number,
  network: NimiqSourceNetwork,
): Promise<{ ok: true; finalizedByMacroBlock: number } | { ok: false; code: "PROVIDER_MALFORMED" | "PROVIDER_UNAVAILABLE" | "INSUFFICIENT_FINALITY" }> {
  const finalizedByMacroBlock = macroBlockNumberFor(blockNumber, network);
  if (finalizedByMacroBlock === null) return { ok: false, code: "PROVIDER_MALFORMED" };
  let macroResult: unknown | null;
  try {
    macroResult = await call("getBlockByNumber", [finalizedByMacroBlock, false]);
  } catch {
    return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  }
  const macro = transactionRecord(macroResult);
  if (!macro) return { ok: false, code: "INSUFFICIENT_FINALITY" };
  const observedMacroNumber = safeNumber(macro["number"], true);
  if (
    observedMacroNumber !== finalizedByMacroBlock ||
    macro["type"] !== "macro" ||
    !hasExpectedNetwork(macro["network"], network) ||
    !hasMacroJustification(macro["justification"])
  ) {
    return { ok: false, code: "PROVIDER_MALFORMED" };
  }
  return { ok: true, finalizedByMacroBlock };
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
  const call: RpcCall = async (method, params = []) => rpcResult(await callRaw(method, params as unknown[]));
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
  const finality = await macroFinality(call, blockNumber, input.config.network);
  if (!finality.ok) return fail(finality.code);
  const { finalizedByMacroBlock } = finality;
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

/* ------------------------------------------------------------------ */
/* R2 — independent proof that a source NIM HTLC returned to its owner */
/* ------------------------------------------------------------------ */

/**
 * Albatross `OutgoingHTLCTransactionProof` discriminants (postcard enum
 * order). EarlyResolve = 1 is the form already verified on mainnet by the
 * source verifier above.
 */
export const NIMIQ_HTLC_PROOF_REGULAR_TRANSFER = 0;
export const NIMIQ_HTLC_PROOF_EARLY_RESOLVE = 1;
export const NIMIQ_HTLC_PROOF_TIMEOUT_RESOLVE = 2;
const NIMIQ_TIMEOUT_RESOLVE_PROOF_BYTES = 1 + NIMIQ_ED25519_SIGNATURE_PROOF_BYTES;
/**
 * Upper bound requested for the HTLC's address history. A funded-then-returned
 * Lightning HTLC has exactly two transactions; any page that reaches this
 * bound may be truncated and is refused as incomplete.
 */
export const NIMIQ_HTLC_HISTORY_MAX = 25;

export type NimiqHtlcReturnFailureCode =
  | "NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_MALFORMED"
  | "WRONG_NETWORK"
  /** The original funding transaction no longer verifies (creation, hash lock, owner or amount). */
  | "SOURCE_NOT_VERIFIED"
  /** History may be paginated/truncated or omits the funding transaction. */
  | "HISTORY_INCOMPLETE"
  /** The two history endpoints disagree, or a transaction is unrelated to the HTLC. */
  | "HISTORY_MISMATCH"
  /** No outgoing transaction yet, or the HTLC still holds a balance. */
  | "STILL_LOCKED"
  /** Spent by the HTLC recipient with the preimage (RegularTransfer). */
  | "REDEEMED"
  /** More than one outgoing or additional incoming transaction, or a non-canonical spend. */
  | "UNEXPECTED_SPEND"
  | "WRONG_DESTINATION"
  | "AMOUNT_MISMATCH"
  | "UNSUCCESSFUL"
  | "INSUFFICIENT_FINALITY"
  | "INVALID_PROOF"
  /** A TimeoutResolve included before the HTLC timeout. */
  | "BEFORE_TIMEOUT";

export interface VerifiedNimiqHtlcReturn {
  fundingTxHash: string;
  htlcAddress: string;
  /** Authenticated owner = the HTLC creation `sender` (refund address). */
  ownerAddress: string;
  refundTxHash: string;
  resolution: "TIMEOUT_RESOLVE" | "EARLY_RESOLVE";
  destination: string;
  lockedLuna: string;
  returnedLuna: string;
  feeLuna: string;
  blockNumber: number;
  confirmations: number;
  finalizedByMacroBlock: number;
  timestampMs: string;
  htlcTimeout: string;
  /** Complete, cross-checked HTLC history (exactly funding + refund). */
  historyHashes: string[];
  network: NimiqSourceNetwork;
  verifiedAt: string;
}

export type NimiqHtlcReturnVerification =
  | { ok: true; evidence: VerifiedNimiqHtlcReturn }
  | { ok: false; code: NimiqHtlcReturnFailureCode };

export interface NimiqHtlcReturnInput {
  /** The independently VERIFIED source funding transaction. */
  fundingTxHash: string;
  ownerAddress: string;
  lightningPaymentHash: string;
  /** Exact funded amount recorded by the original source verification. */
  expectedAmountLuna: string;
  config: NimiqSourceRpcConfig;
}

function balanceOf(value: unknown): bigint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return integer((value as Record<string, unknown>)["balance"], true);
}

/**
 * Prove, read-only, that a source NIM HTLC returned its ENTIRE locked amount
 * to its authenticated owner and nothing else ever happened to it:
 *
 * 1. The funding transaction re-verifies exactly as R1 source evidence does
 *    (native HTLC creation, macro-final, hash lock = bound Lightning hash,
 *    owner-authenticated sender, exact recorded amount).
 * 2. The HTLC's complete address history is read from two independent
 *    endpoints that must agree, must not reach the page bound, and must be
 *    exactly {funding, one outgoing transaction}.
 * 3. The outgoing transaction is successful, macro-final, a canonical HTLC
 *    spend to the owner (the HTLC's encoded refund address), for value + fee
 *    equal to the full locked amount, whose proof is a TimeoutResolve signed by
 *    the owner at/after the HTLC timeout, or an EarlyResolve signed by both the
 *    HTLC recipient and the owner. A RegularTransfer (preimage) is REDEEMED.
 * 4. The HTLC account now holds zero.
 *
 * Any missing, ambiguous or inconsistent fact is a refusal; there is no
 * partial proof. Nothing is signed, broadcast or refunded here.
 */
export async function verifyNimiqHtlcReturn(input: NimiqHtlcReturnInput): Promise<NimiqHtlcReturnVerification> {
  const fundingTxHash = normalizeNimiqSourceHash(input.fundingTxHash);
  const ownerAddress = cleanAddress(input.ownerAddress);
  const expectedLocked = integer(input.expectedAmountLuna, false);
  const url = input.config.url.trim();
  if (!url) return { ok: false, code: "NOT_CONFIGURED" };
  if (!fundingTxHash || !ownerAddress || expectedLocked === null || !/^https:\/\/[^\s]+$/i.test(url)) return { ok: false, code: "INVALID_INPUT" };

  // (1) Re-prove the original funding with the existing verifier (no shortcuts).
  const source = await verifyNimiqSourceTransaction({
    txHash: fundingTxHash,
    ownerAddress,
    lightningPaymentHash: input.lightningPaymentHash,
    config: input.config,
    expectedAmountLuna: expectedLocked.toString(),
  });
  if (!source.ok) return { ok: false, code: source.code === "PROVIDER_UNAVAILABLE" ? "PROVIDER_UNAVAILABLE" : "SOURCE_NOT_VERIFIED" };

  const timeoutMs = input.config.timeoutMs ?? NIMIQ_SOURCE_RPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return { ok: false, code: "INVALID_INPUT" };
  const controller = new AbortController();
  // Several sequential reads: bound the whole verification, not each call.
  const timer = setTimeout(() => controller.abort(), timeoutMs * 4);
  const fail = (code: NimiqHtlcReturnFailureCode): NimiqHtlcReturnVerification => {
    clearTimeout(timer);
    return { ok: false, code };
  };
  const send = (method: string, params: unknown): Promise<unknown> =>
    postJson(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), controller.signal);
  const call: RpcCall = async (method, params = []) => rpcResult(await send(method, params));

  try {
    const fundingRecord = transactionRecord(await call("getTransactionByHash", [fundingTxHash]));
    const htlcAddress = fundingRecord ? cleanAddress(fundingRecord["to"] ?? fundingRecord["recipient"]) : null;
    const htlc = fundingRecord ? parseHtlcCreationData(fundingRecord["recipientData"] ?? fundingRecord["recipient_data"]) : null;
    const locked = fundingRecord ? integer(fundingRecord["value"], false) : null;
    if (!fundingRecord || !htlcAddress || !htlc || locked === null) return fail("PROVIDER_MALFORMED");
    if (htlc.sender !== ownerAddress || locked !== expectedLocked) return fail("SOURCE_NOT_VERIFIED");

    // (2) Complete history from two endpoints that must agree.
    const historyQuery = { address: htlcAddress, max: NIMIQ_HTLC_HISTORY_MAX };
    const listed = await call("getTransactionsByAddress", historyQuery);
    const hashes = await call("getTransactionHashesByAddress", historyQuery);
    if (!Array.isArray(listed) || !Array.isArray(hashes)) return fail("PROVIDER_MALFORMED");
    if (listed.length >= NIMIQ_HTLC_HISTORY_MAX || hashes.length >= NIMIQ_HTLC_HISTORY_MAX) return fail("HISTORY_INCOMPLETE");
    const hashSet = hashes.map(normalizeNimiqSourceHash);
    if (hashSet.some((h) => h === null) || new Set(hashSet).size !== hashSet.length) return fail("PROVIDER_MALFORMED");
    const records = listed.map(transactionRecord);
    if (records.some((r) => r === null)) return fail("PROVIDER_MALFORMED");
    const listedHashes = records.map((r) => normalizeNimiqSourceHash(r!["hash"]));
    if (listedHashes.some((h) => h === null) || new Set(listedHashes).size !== listedHashes.length) return fail("PROVIDER_MALFORMED");
    const a = [...(hashSet as string[])].sort();
    const b = [...(listedHashes as string[])].sort();
    if (a.length !== b.length || a.some((h, i) => h !== b[i])) return fail("HISTORY_MISMATCH");
    if (!a.includes(fundingTxHash)) return fail("HISTORY_INCOMPLETE");

    const incoming: string[] = [];
    const outgoing: string[] = [];
    for (const r of records) {
      const from = cleanAddress(r!["from"] ?? r!["sender"]);
      const to = cleanAddress(r!["to"] ?? r!["recipient"]);
      const hash = normalizeNimiqSourceHash(r!["hash"])!;
      if (to === htlcAddress && from !== htlcAddress) incoming.push(hash);
      else if (from === htlcAddress && to !== htlcAddress) outgoing.push(hash);
      else return fail("HISTORY_MISMATCH");
    }
    if (incoming.length !== 1 || incoming[0] !== fundingTxHash) return fail("UNEXPECTED_SPEND");
    if (outgoing.length === 0) return fail("STILL_LOCKED");
    if (outgoing.length > 1) return fail("UNEXPECTED_SPEND");
    const refundTxHash = outgoing[0]!;

    // (3) The single outgoing transaction, re-read in full by hash.
    const spend = transactionRecord(await call("getTransactionByHash", [refundTxHash]));
    if (!spend || normalizeNimiqSourceHash(spend["hash"]) !== refundTxHash) return fail("PROVIDER_MALFORMED");
    const proof = hexBytes(spend["proof"]);
    if (!proof || proof.length === 0) return fail("PROVIDER_MALFORMED");
    // A preimage spend is the one outcome that must never close as a return.
    if (proof[0] === NIMIQ_HTLC_PROOF_REGULAR_TRANSFER) return fail("REDEEMED");
    if (spend["executionResult"] !== true) return fail("UNSUCCESSFUL");
    if (!hasExpectedNetwork(spend["networkId"], input.config.network)) return fail("WRONG_NETWORK");
    const fromType = safeNumber(spend["fromType"] ?? spend["senderType"], true);
    const toType = safeNumber(spend["toType"] ?? spend["recipientType"], true);
    const flags = safeNumber(spend["flags"], true);
    const validityStartHeight = safeNumber(spend["validityStartHeight"] ?? spend["validity_start_height"], true);
    const networkId = safeNumber(spend["networkId"] ?? spend["network_id"], true);
    const sender = cleanAddress(spend["from"] ?? spend["sender"]);
    const destination = cleanAddress(spend["to"] ?? spend["recipient"]);
    const data = hexBytes(spend["recipientData"] ?? spend["recipient_data"] ?? "");
    const senderData = hexBytes(spend["senderData"] ?? spend["sender_data"] ?? "");
    const value = integer(spend["value"], false);
    const fee = integer(spend["fee"], true);
    const blockNumber = safeNumber(spend["blockNumber"], true);
    const confirmations = safeNumber(spend["confirmations"], true);
    const timestamp = integer(spend["timestamp"], false);
    if (
      fromType === null || toType === null || flags === null || validityStartHeight === null || networkId === null ||
      sender === null || destination === null || data === null || senderData === null || value === null || fee === null ||
      blockNumber === null || confirmations === null || timestamp === null
    ) {
      return fail("PROVIDER_MALFORMED");
    }
    if (sender !== htlcAddress || fromType !== NIMIQ_HTLC_ACCOUNT_TYPE || flags !== 0 || data.length !== 0 || senderData.length !== 0) {
      return fail("UNEXPECTED_SPEND");
    }
    if (destination !== ownerAddress) return fail("WRONG_DESTINATION");
    if (value + fee !== locked) return fail("AMOUNT_MISMATCH");

    const destinationBytes = addressBytes(destination);
    const content = destinationBytes
      ? serializeNimiqTransactionContent({
          data,
          senderAddress: sender,
          senderType: fromType,
          recipient: destinationBytes,
          recipientType: toType,
          value,
          fee,
          validityStartHeight,
          networkId,
          flags,
          senderData,
        })
      : null;
    if (!content) return fail("PROVIDER_MALFORMED");
    let resolution: VerifiedNimiqHtlcReturn["resolution"];
    if (proof[0] === NIMIQ_HTLC_PROOF_TIMEOUT_RESOLVE) {
      const ownerProof = parseSimpleEd25519SignatureProof(proof, 1);
      if (
        proof.length !== NIMIQ_TIMEOUT_RESOLVE_PROOF_BYTES ||
        !ownerProof ||
        ownerProof.end !== proof.length ||
        !verifyEd25519Raw(ownerProof.publicKey, content, ownerProof.signature) ||
        deriveNimiqAddress(Buffer.from(ownerProof.publicKey).toString("hex")) !== ownerAddress
      ) {
        return fail("INVALID_PROOF");
      }
      if (timestamp < BigInt(htlc.timeout)) return fail("BEFORE_TIMEOUT");
      resolution = "TIMEOUT_RESOLVE";
    } else if (proof[0] === NIMIQ_HTLC_PROOF_EARLY_RESOLVE) {
      const recipientProof = parseSimpleEd25519SignatureProof(proof, 1);
      if (
        !hasAuthenticatedHtlcOwnerProof(proof, content, ownerAddress) ||
        !recipientProof ||
        deriveNimiqAddress(Buffer.from(recipientProof.publicKey).toString("hex")) !== htlc.recipient
      ) {
        return fail("INVALID_PROOF");
      }
      resolution = "EARLY_RESOLVE";
    } else {
      return fail("INVALID_PROOF");
    }

    if (confirmations < input.config.minConfirmations) return fail("INSUFFICIENT_FINALITY");
    const finality = await macroFinality(call, blockNumber, input.config.network);
    if (!finality.ok) return fail(finality.code);

    // (4) Nothing left behind.
    const balance = balanceOf(await call("getAccountByAddress", [htlcAddress]));
    if (balance === null) return fail("PROVIDER_MALFORMED");
    if (balance !== 0n) return fail("STILL_LOCKED");

    clearTimeout(timer);
    return {
      ok: true,
      evidence: {
        fundingTxHash,
        htlcAddress,
        ownerAddress,
        refundTxHash,
        resolution,
        destination,
        lockedLuna: locked.toString(),
        returnedLuna: value.toString(),
        feeLuna: fee.toString(),
        blockNumber,
        confirmations,
        finalizedByMacroBlock: finality.finalizedByMacroBlock,
        timestampMs: timestamp.toString(),
        htlcTimeout: htlc.timeout,
        historyHashes: a,
        network: input.config.network,
        verifiedAt: new Date().toISOString(),
      },
    };
  } catch {
    return fail("PROVIDER_UNAVAILABLE");
  }
}
