import { afterEach, describe, expect, it, vi } from "vitest";
import type { transferProofs, transfers } from "@/db/schema";
import { toUserFriendlyAddress } from "@/lib/nimiq";
import {
  decodeProofCursor,
  encodeProofCursor,
  getIndependentNimiqSourceProof,
  isPublicProofPublicationEnabled,
  isPublishableGlobalProof,
  parseProofFeedQuery,
  publicProofConfig,
  toPublicProof,
  type PublicProofRow,
} from "@/lib/global-proofs";

const POLYGON_TOKEN = "0x1111111111111111111111111111111111111111";
const ARBITRUM_NATIVE_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const DESTINATION = "0x2222222222222222222222222222222222222222";
const CLAIM_TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const NIMIQ_TX_HASH = "12".repeat(32);
const NIMIQ_SENDER = toUserFriendlyAddress(Buffer.from("00112233445566778899aabbccddeeff00112233", "hex"));
const PROOF_ID = "11111111-1111-4111-8111-111111111111";

const config = publicProofConfig({
  routeTokens: { "usdc-polygon": POLYGON_TOKEN, "usdc-arbitrum": ARBITRUM_NATIVE_USDC },
  finalityPolicies: {},
});

function row(overrides: { transfer?: Record<string, unknown>; proof?: Record<string, unknown> } = {}): PublicProofRow {
  return {
    transfer: {
      id: "22222222-2222-4222-8222-222222222222",
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      recipientId: null,
      requestId: null,
      routeId: "usdc-polygon",
      recipientDestinationId: null,
      targetAsset: "USDC",
      targetNetwork: "Polygon",
      destination: DESTINATION,
      targetAmountAtomic: "300000",
      recipientName: "Private label must not publish",
      quoteProvider: "satora",
      quoteRevision: 1,
      quotedAt: null,
      quotedNetTargetAtomic: "300000",
      quotedSourceSats: "1234",
      quotedFeesJson: null,
      quotedLimitsJson: null,
      status: "DELIVERED",
      idempotencyKey: "private-idempotency-key",
      quoteExpiresAt: null,
      createdAt: new Date("2026-11-10T12:00:00.000Z"),
      updatedAt: new Date("2026-11-10T12:10:00.000Z"),
      ...overrides.transfer,
    } as typeof transfers.$inferSelect,
    proof: {
      id: PROOF_ID,
      transferId: "22222222-2222-4222-8222-222222222222",
      nimiqTxHash: null,
      lightningHash: `0x${"ef".repeat(32)}`,
      satoraSwapId: "private-satora-id",
      evmTxHash: CLAIM_TX,
      evidenceSource: "evm_erc20_transfer",
      chainId: 137,
      tokenContract: POLYGON_TOKEN,
      recipient: DESTINATION.toLowerCase(),
      verifiedAmountAtomic: "300000",
      blockNumber: 123456,
      blockHash: BLOCK_HASH,
      logIndexes: "[1]",
      finalityLevel: "confirmations-256",
      verifiedAt: new Date("2026-11-10T12:10:00.000Z"),
      createdAt: new Date("2026-11-10T12:10:00.000Z"),
      ...overrides.proof,
    } as typeof transferProofs.$inferSelect,
  };
}

function verifiedSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: NIMIQ_TX_HASH,
    sender: NIMIQ_SENDER,
    amountLuna: "100000",
    feeLuna: "100",
    totalDebitLuna: "100100",
    blockNumber: "123",
    confirmations: "12",
    macroBlockNumber: "180",
    network: "mainnet",
    verifiedAt: "2026-11-10T12:09:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("A3c.1 global proof publication", () => {
  it("keeps publication disabled unless the server-only gate is exactly 1", () => {
    expect(isPublicProofPublicationEnabled({})).toBe(false);
    expect(isPublicProofPublicationEnabled({ THENCE_PUBLIC_PROOFS_ENABLED: "0" })).toBe(false);
    expect(isPublicProofPublicationEnabled({ THENCE_PUBLIC_PROOFS_ENABLED: "true" })).toBe(false);
    expect(isPublicProofPublicationEnabled({ THENCE_PUBLIC_PROOFS_ENABLED: "1" })).toBe(true);
  });

  it("refuses a complete destination proof while independent NIM evidence is unavailable", () => {
    const candidate = row();
    expect(getIndependentNimiqSourceProof(candidate)).toBeNull();
    expect(isPublishableGlobalProof(candidate, config)).toBe(false);
    expect(toPublicProof(candidate, config)).toBeNull();
  });

  it("does not upgrade a host-reported NIM identifier into source proof", () => {
    const candidate = row({ proof: { nimiqTxHash: `0x${"12".repeat(32)}` } });
    expect(getIndependentNimiqSourceProof(candidate)).toBeNull();
    expect(isPublishableGlobalProof(candidate, config)).toBe(false);
    expect(toPublicProof(candidate, config)).toBeNull();
  });

  it("publishes both independently verified source and destination proof fields", () => {
    const candidate = {
      ...row({ proof: { nimiqTxHash: NIMIQ_TX_HASH } }),
      sourceVerified: true,
      sourceVerifiedHash: NIMIQ_TX_HASH,
      sourceVerifiedEvidence: verifiedSource(),
    };
    expect(getIndependentNimiqSourceProof(candidate)).toEqual({ transactionHash: NIMIQ_TX_HASH });
    expect(isPublishableGlobalProof(candidate, config)).toBe(true);
    expect(toPublicProof(candidate, config)).toMatchObject({
      verification: { destination: "VERIFIED", source: "VERIFIED", overall: "VERIFIED" },
      source: {
        asset: "NIM",
        network: "mainnet",
        sender: NIMIQ_SENDER,
        amountLuna: "100000",
        transactionHash: NIMIQ_TX_HASH,
        explorerTxUrl: `https://nimiq.watch/#${NIMIQ_TX_HASH}`,
        evidence: "VERIFIED",
        verification: "VERIFIED",
      },
      destination: {
        asset: "USDC",
        network: "Polygon",
        recipient: DESTINATION.toLowerCase(),
        verifiedAmountAtomic: "300000",
        transactionHash: CLAIM_TX,
        explorerTxUrl: `https://polygonscan.com/tx/${CLAIM_TX}`,
      },
    });
    const serialized = JSON.stringify(toPublicProof(candidate, config));
    expect(serialized).toContain(NIMIQ_TX_HASH);
    expect(serialized).toContain("100000");
    expect(serialized).toContain("300000");
    expect(serialized).not.toContain("private-satora-id");
    expect(serialized).not.toContain("ef".repeat(32));
  });

  it("fails closed when the verified-source audit marker is missing required proof fields", () => {
    const candidate = {
      ...row({ proof: { nimiqTxHash: NIMIQ_TX_HASH } }),
      sourceVerified: true,
      sourceVerifiedHash: NIMIQ_TX_HASH,
      sourceVerifiedEvidence: verifiedSource({ sender: "not-a-nimiq-address" }),
    };
    expect(isPublishableGlobalProof(candidate, config)).toBe(false);
    expect(toPublicProof(candidate, config)).toBeNull();

    const missingMacro = {
      ...row({ proof: { nimiqTxHash: NIMIQ_TX_HASH } }),
      sourceVerified: true,
      sourceVerifiedHash: NIMIQ_TX_HASH,
      sourceVerifiedEvidence: verifiedSource({ macroBlockNumber: undefined }),
    };
    expect(isPublishableGlobalProof(missingMacro, config)).toBe(false);
    expect(toPublicProof(missingMacro, config)).toBeNull();
  });

  it("never publishes testnet NIM evidence alongside a mainnet destination", () => {
    const candidate = {
      ...row({ proof: { nimiqTxHash: NIMIQ_TX_HASH } }),
      sourceVerified: true,
      sourceVerifiedHash: NIMIQ_TX_HASH,
      sourceVerifiedEvidence: verifiedSource({ network: "testnet" }),
    };
    expect(isPublishableGlobalProof(candidate, config)).toBe(false);
    expect(toPublicProof(candidate, config)).toBeNull();
  });

  it.each([
    [{ transfer: { status: "CLAIMING" } }, "non-delivered transfer"],
    [{ proof: { evidenceSource: "provider_claim_pointer" } }, "provider-only evidence"],
    [{ transfer: { destination: "0x3333333333333333333333333333333333333333" } }, "destination mismatch"],
    [{ proof: { verifiedAmountAtomic: "299999" } }, "short destination amount"],
    [{ proof: { finalityLevel: "confirmations-1" } }, "insufficient Polygon finality"],
    [{ transfer: { routeId: "usdc-arbitrum", targetNetwork: "Arbitrum" }, proof: { chainId: 42161, tokenContract: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", finalityLevel: "finalized" } }, "Arbitrum USDC.e"],
  ] as const)("rejects %s", (overrides, _label) => {
    const overrideProof = "proof" in overrides ? overrides.proof : undefined;
    const candidate = row(overrides);
    candidate.proof = { ...candidate.proof, nimiqTxHash: NIMIQ_TX_HASH, ...(overrideProof ?? {}) };
    candidate.sourceVerified = true;
    candidate.sourceVerifiedHash = NIMIQ_TX_HASH;
    candidate.sourceVerifiedEvidence = verifiedSource();
    expect(isPublishableGlobalProof(candidate, config)).toBe(false);
    expect(toPublicProof(candidate, config)).toBeNull();
  });

  it("round-trips stable cursors and rejects malformed pagination input", () => {
    const cursor = encodeProofCursor({ verifiedAt: "2026-11-10T12:10:00.000Z", proofId: PROOF_ID });
    expect(decodeProofCursor(cursor)).toEqual({ verifiedAt: "2026-11-10T12:10:00.000Z", proofId: PROOF_ID });
    expect(decodeProofCursor("not-a-cursor")).toBeNull();
    expect(() => parseProofFeedQuery("https://thence.test/api/proofs?limit=0")).toThrow(/limit/);
    expect(() => parseProofFeedQuery("https://thence.test/api/proofs?cursor=bad")).toThrow(/cursor/);
    expect(parseProofFeedQuery(`https://thence.test/api/proofs?limit=2&cursor=${cursor}`)).toEqual({ limit: 2, cursor: { verifiedAt: "2026-11-10T12:10:00.000Z", proofId: PROOF_ID } });
  });

  it("does not touch the database while the publication gate is off", async () => {
    vi.stubEnv("THENCE_PUBLIC_PROOFS_ENABLED", "0");
    const { GET } = await import("../app/api/proofs/route");
    const response = await GET(new Request("https://thence.test/api/proofs"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "PUBLIC_PROOFS_DISABLED", message: "Public proof publication is not enabled." });
  });
});
