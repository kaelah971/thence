import { afterEach, describe, expect, it, vi } from "vitest";
import type { transferProofs, transfers } from "@/db/schema";
import { toUserFriendlyAddress } from "@/lib/nimiq";
import {
  decodeProofCursor,
  encodeProofCursor,
  getIndependentNimiqSourceProof,
  isPublicProofPublicationEnabled,
  isPublishableGlobalProof,
  liveSourceRpcLabel,
  parseProofFeedQuery,
  PUBLIC_PROOF_SOURCE_FINALITY_CLAIM,
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

  describe("R7 verified short deliveries", () => {
    const source = { sourceVerified: true, sourceVerifiedHash: NIMIQ_TX_HASH, sourceVerifiedEvidence: verifiedSource() };
    const shortEvidence = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      providerStatus: "serverredeemed",
      chainId: 137,
      claimTxHash: CLAIM_TX,
      blockNumber: "123456",
      logIndexes: [279],
      verifiedAmountAtomic: "999556",
      finalityLevel: "confirmations-256",
      requestedAmountAtomic: "1000000",
      shortfallAtomic: "444",
      swapIdentity: "BOUND_REDEEM_MATCH",
      ...overrides,
    });
    const shortRow = (evidence: unknown = shortEvidence(), transfer: Record<string, unknown> = {}, proof: Record<string, unknown> = {}) => ({
      ...row({
        transfer: { status: "DELIVERED_SHORT", targetAmountAtomic: "1000000", ...transfer },
        proof: { nimiqTxHash: NIMIQ_TX_HASH, verifiedAmountAtomic: "999556", ...proof },
      }),
      ...source,
      shortDeliveryEvidence: evidence,
    });

    it("publishes the incident 999556 / 1000000 as DELIVERED_SHORT with the measured amount and exact shortfall", () => {
      const candidate = shortRow();
      expect(isPublishableGlobalProof(candidate, config)).toBe(true);
      const view = toPublicProof(candidate, config);
      expect(view?.status).toBe("DELIVERED_SHORT");
      expect(view?.destination).toMatchObject({
        requestedAmountAtomic: "1000000",
        verifiedAmountAtomic: "999556",
        shortfallAtomic: "444",
        deliveryOutcome: "SHORT",
        transactionHash: CLAIM_TX,
      });
      expect(view?.destination.explorerTxUrl).toContain(CLAIM_TX);
      expect(view?.verification).toEqual({ destination: "VERIFIED", source: "VERIFIED", overall: "VERIFIED" });
    });

    it("never publishes a short delivery without the matching audited bound-swap redeem", () => {
      expect(isPublishableGlobalProof(shortRow(null), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ swapIdentity: undefined })), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ claimTxHash: `0x${"99".repeat(32)}` })), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ verifiedAmountAtomic: "1000000" })), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ requestedAmountAtomic: "999556" })), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ shortfallAtomic: "0" })), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ chainId: 42161 })), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ finalityLevel: "finalized" })), config)).toBe(false);
    });

    it("keeps every other publication gate for short deliveries", () => {
      // No independent source evidence.
      expect(isPublishableGlobalProof({ ...shortRow(), sourceVerified: false, sourceVerifiedEvidence: null }, config)).toBe(false);
      // Wrong token, wrong recipient, unfinalized/other finality, malformed tx.
      expect(isPublishableGlobalProof(shortRow(undefined, {}, { tokenContract: "0x9999999999999999999999999999999999999999" }), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(undefined, {}, { recipient: "0x9999999999999999999999999999999999999999" }), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ finalityLevel: "confirmations-12" }), {}, { finalityLevel: "confirmations-12" }), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ claimTxHash: "0x1234" }), {}, { evmTxHash: "0x1234" }), config)).toBe(false);
      // Zero output, and a status/amount mismatch in either direction.
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ verifiedAmountAtomic: "0", shortfallAtomic: "1000000" }), {}, { verifiedAmountAtomic: "0" }), config)).toBe(false);
      expect(isPublishableGlobalProof(shortRow(shortEvidence({ verifiedAmountAtomic: "1000000", shortfallAtomic: "0" }), {}, { verifiedAmountAtomic: "1000000" }), config)).toBe(false);
      const deliveredBelow = { ...row({ transfer: { targetAmountAtomic: "1000000" }, proof: { nimiqTxHash: NIMIQ_TX_HASH, verifiedAmountAtomic: "999556" } }), ...source, shortDeliveryEvidence: shortEvidence() };
      expect(isPublishableGlobalProof(deliveredBelow, config)).toBe(false);
    });

    it("exact and overpaid deliveries keep the exact pre-R7 public shape", () => {
      for (const amount of ["300000", "300542"]) {
        const view = toPublicProof({ ...row({ proof: { nimiqTxHash: NIMIQ_TX_HASH, verifiedAmountAtomic: amount } }), ...source }, config);
        expect(view?.status).toBe("DELIVERED");
        expect(Object.keys(view?.destination ?? {}).sort()).toEqual(
          ["asset", "blockHash", "blockNumber", "chainId", "decimals", "explorerTxUrl", "finalityLevel", "network", "recipient", "requestedAmountAtomic", "tokenContract", "transactionHash", "verifiedAmountAtomic", "verifiedAt"].sort(),
        );
      }
    });
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

  it("names the live source RPC recorded at verification time and never implies Thence runs a third-party node", async () => {
    const live = (rpcHost?: unknown) => ({
      ...row({ proof: { nimiqTxHash: NIMIQ_TX_HASH } }),
      sourceVerified: true,
      sourceVerifiedHash: NIMIQ_TX_HASH,
      sourceVerifiedEvidence: { ...verifiedSource(), ...(rpcHost === undefined ? {} : { rpcHost }) },
    });
    const nimiqWatch = toPublicProof(live("rpc.nimiqwatch.com"), config)!;
    expect(nimiqWatch.method).toMatchObject({
      kind: "reconciliation",
      sourceRpc: "rpc.nimiqwatch.com (third-party community RPC, not run by Thence)",
      sourceFinality: PUBLIC_PROOF_SOURCE_FINALITY_CLAIM,
    });
    // The BLS caveat is preserved verbatim.
    expect(nimiqWatch.method.sourceFinality).toMatch(/aggregate validator signature was not independently verified/);
    expect(toPublicProof(live("nimiq.example.org"), config)!.method.sourceRpc).toBe("nimiq.example.org");
    expect(toPublicProof(live(), config)!.method.sourceRpc).toBeNull();
    expect(liveSourceRpcLabel("evil host<script>")).toBeNull();
    expect(liveSourceRpcLabel(42)).toBeNull();

    const { toMethodDisplay } = await import("@/ui/lib/proofs-api");
    expect(toMethodDisplay(nimiqWatch.method)!.sourceChecked).toBe("rpc.nimiqwatch.com (third-party community RPC, not run by Thence)");
    const unnamed = toMethodDisplay(toPublicProof(live(), config)!.method)!;
    expect(unnamed.sourceChecked).toBe("A Nimiq RPC configured by Thence (operator not recorded)");
    expect(unnamed.sourceChecked).not.toMatch(/Thence.s configured Nimiq node/);
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
