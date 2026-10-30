/**
 * F4.1 — browser Satora swap client (client-only custody).
 *
 * - Secrets (mnemonic, preimage, secretKey) are generated with secure
 *   randomness inside the SDK and stay in the SDK's IndexedDB
 *   (`lendaswap-v3`). This module never logs them, never puts them in query
 *   strings, and never sends them to Thence.
 * - Only PUBLIC facts (swap id, invoice, payment hash, amounts, addresses)
 *   leave this module. The backend re-verifies them read-only.
 * - Exact-receive only: `targetAmount` (atomic bigint) is pinned so the
 *   provider must echo the server-approved destination amount.
 */
import type { ClaimResult, StoredSwap } from "@satora/swap";

export interface ExactSwapTerms {
  targetAddress: string;
  tokenAddress: string;
  evmChainId: number;
  targetAmountAtomic: string;
  invoiceDescription?: string;
}

export interface PublicSwapFacts {
  satoraSwapId: string;
  bolt11Invoice: string;
  paymentHash: string;
  sourceSats: string;
  targetAtomic: string;
  invoiceExpiresAt: string | null;
}

export interface SwapReadback {
  ok: boolean;
  satoraSwapId: string;
  hasRecoveryMaterial: boolean;
  paymentHash: string | null;
  reason?: string;
}

type SwapClient = {
  createLightningToEvmSwap: (opts: {
    targetAddress: string;
    tokenAddress: string;
    evmChainId: number;
    targetAmount?: bigint;
    sourceAmount?: number;
    gasless?: boolean;
    invoiceDescription?: string;
  }) => Promise<{ response: Record<string, unknown> }>;
  getStoredSwap: (id: string) => Promise<StoredSwap | null>;
  /**
   * Gasless coordinator claim for Lightning→EVM: reads swap + preimage
   * from SDK storage, reveals the preimage server-side. Verified against
   * lendaswap-sdk-pure client.d.ts: `claim(id, options?)`.
   */
  claim: (id: string) => Promise<ClaimResult>;
};

/** Public claim facts only — secrets stay in SDK storage, never returned. */
export interface ClaimOutcome {
  success: boolean;
  txHash: string | null;
  message: string;
}

let singleton: Promise<SwapClient> | null = null;
let testClient: SwapClient | null = null;

/** Test seam: inject a mock SDK client (no network, no IndexedDB). */
export function setBrowserSwapClientForTests(client: SwapClient | null): void {
  testClient = client;
  singleton = null;
}

async function loadClient(): Promise<SwapClient> {
  if (testClient) return testClient;
  if (!singleton) {
    singleton = (async () => {
      const { Client, IdbSwapStorage, IdbWalletStorage } = await import("@satora/swap");
      const client = await Client.builder()
        .withSignerStorage(new IdbWalletStorage())
        .withSwapStorage(new IdbSwapStorage())
        .build();
      return client as unknown as SwapClient;
    })().catch((error: unknown) => {
      singleton = null;
      throw error;
    });
  }
  return singleton;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function assertTerms(terms: ExactSwapTerms): void {
  if (!terms.targetAddress || terms.targetAddress.length > 256) throw new Error("Invalid swap destination.");
  if (!terms.tokenAddress || terms.tokenAddress.length > 128) throw new Error("Invalid swap token.");
  if (!Number.isInteger(terms.evmChainId) || terms.evmChainId <= 0) throw new Error("Invalid swap chain.");
  if (!/^[1-9][0-9]*$/.test(terms.targetAmountAtomic)) throw new Error("Invalid swap amount.");
}

function readString(response: Record<string, unknown>, key: string): string {
  const value = response[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Swap response is missing ${key}.`);
  return value;
}

/**
 * Create the Lightning→EVM swap for the server-approved terms.
 * The SDK derives secrets client-side and persists them to IndexedDB.
 */
export async function createExactReceiveSwap(terms: ExactSwapTerms): Promise<PublicSwapFacts> {
  assertTerms(terms);
  if (!isBrowser() && !testClient) throw new Error("Swaps can only be created in the browser.");
  const client = await loadClient();
  const result = await client.createLightningToEvmSwap({
    targetAddress: terms.targetAddress,
    tokenAddress: terms.tokenAddress,
    evmChainId: terms.evmChainId,
    targetAmount: BigInt(terms.targetAmountAtomic),
    gasless: true,
    ...(terms.invoiceDescription ? { invoiceDescription: terms.invoiceDescription } : {}),
  });
  const response = result.response;
  const satoraSwapId = readString(response, "id");
  const bolt11Invoice = readString(response, "bolt11_invoice");
  const paymentHash = readString(response, "hash_lock");
  const sourceSats = readString(response, "source_amount");
  const targetAtomic = readString(response, "target_amount");
  if (!/^ln(bc|bcrt|tb|tbs)/i.test(bolt11Invoice)) throw new Error("Swap returned an invalid invoice.");
  if (targetAtomic !== terms.targetAmountAtomic) {
    throw new Error("Swap output differs from the approved amount.");
  }
  const addressEcho = response["target_evm_address"];
  if (typeof addressEcho === "string" && addressEcho.toLowerCase() !== terms.targetAddress.toLowerCase()) {
    throw new Error("Swap destination differs from the approved wallet.");
  }
  let invoiceExpiresAt: string | null = null;
  const rawExpiry = response["invoice_expires_at"];
  if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry) && rawExpiry > 0) {
    invoiceExpiresAt = new Date(rawExpiry * 1000).toISOString();
  }
  return { satoraSwapId, bolt11Invoice, paymentHash, sourceSats, targetAtomic, invoiceExpiresAt };
}

/**
 * Read back the SDK-persisted swap and confirm recovery material exists.
 * Returns only public facts — secrets are checked for presence, never returned.
 */
export async function readBackSwap(swapId: string): Promise<SwapReadback> {
  if (!swapId) return { ok: false, satoraSwapId: swapId, hasRecoveryMaterial: false, paymentHash: null, reason: "Missing swap id." };
  let client: SwapClient;
  try {
    client = await loadClient();
  } catch (error) {
    return {
      ok: false,
      satoraSwapId: swapId,
      hasRecoveryMaterial: false,
      paymentHash: null,
      reason: error instanceof Error ? error.message : "Swap storage is unavailable.",
    };
  }
  let stored: StoredSwap | null;
  try {
    stored = await client.getStoredSwap(swapId);
  } catch (error) {
    return {
      ok: false,
      satoraSwapId: swapId,
      hasRecoveryMaterial: false,
      paymentHash: null,
      reason: error instanceof Error ? error.message : "Could not read back the swap.",
    };
  }
  if (!stored) {
    return { ok: false, satoraSwapId: swapId, hasRecoveryMaterial: false, paymentHash: null, reason: "Saved swap was not found." };
  }
  if (stored.swapId !== swapId) {
    return { ok: false, satoraSwapId: swapId, hasRecoveryMaterial: false, paymentHash: null, reason: "Saved swap does not match." };
  }
  const hasSecrets =
    typeof stored.preimage === "string" &&
    stored.preimage.length >= 32 &&
    typeof stored.secretKey === "string" &&
    stored.secretKey.length >= 32 &&
    typeof stored.preimageHash === "string" &&
    stored.preimageHash.length > 0;
  if (!hasSecrets) {
    return { ok: false, satoraSwapId: swapId, hasRecoveryMaterial: false, paymentHash: null, reason: "Recovery material is incomplete." };
  }
  const response = stored.response as unknown as Record<string, unknown>;
  const paymentHash = typeof response["hash_lock"] === "string" ? (response["hash_lock"] as string) : stored.preimageHash;
  return { ok: true, satoraSwapId: swapId, hasRecoveryMaterial: true, paymentHash };
}

/**
 * Claim a funded swap with client-owned recovery material.
 *
 * For Lightning→EVM this is the gasless coordinator path: the SDK reads
 * the swap + preimage from its own storage and reveals it server-side.
 * Only public facts are returned. Throws on transport/SDK failure so
 * callers report unknown and reconcile instead of retrying blindly.
 * Funded execution stays behind the claim gate (OFF in this milestone).
 */
export async function claimStoredSwap(swapId: string): Promise<ClaimOutcome> {
  if (!swapId) throw new Error("Missing swap id.");
  const client = await loadClient();
  const result = await client.claim(swapId);
  const txHash = typeof result.txHash === "string" && result.txHash.length > 0 ? result.txHash : null;
  return {
    success: result.success === true,
    txHash,
    message: typeof result.message === "string" && result.message.length > 0 ? result.message : "No claim message returned.",
  };
}
