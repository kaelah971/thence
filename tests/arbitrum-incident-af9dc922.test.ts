/**
 * Regression suite for live incident af9dc922 (2026-11-15, usdc-arbitrum,
 * 0.30 USDC, Satora swap e2eb54fd…). Deterministic fixtures; no chain or
 * provider contact.
 *
 * What happened: Satora created the swap on its legacy Arbitrum HTLCErc20 v6
 * (declared at creation: evm_htlc_version 6, coordinator v4). Thence trusted
 * only v7 and checked the contract at claim time, so the NIM was committed,
 * every Finish-delivery was refused FUNDING_INVALID, Satora refunded its v6
 * lock after the deadline and reported THAT REFUND in `evm_claim_txid` with
 * status `clientfundedserverrefunded`. The user's NIM stayed in Nimiq Pay's
 * HTLC until its own timeout.
 *
 * The provider record below is the real response's shape and its public
 * on-chain identifiers (contracts, token, provider refund address, amount,
 * deadline, refund tx and block). The hash lock and the SDK claim address are
 * replaced with synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundHtlcTermsOf, boundTermsDrift, htlcPreflight, HANDOFF_MIN_CLAIM_RUNWAY_MS } from "@/lib/htlc-preflight";
import {
  HTLC_DEPLOYMENTS,
  SWAP_REDEEMED_EVENT_TOPIC,
  SWAP_REFUNDED_EVENT_TOPIC,
  computeHtlcSwapKey,
  matchRefundEvent,
  setSettlementChainForTests,
  verifyHtlcRefund,
  type ChainLog,
  type ChainReads,
} from "@/lib/settlement";
import type { VerifiedSwapFacts } from "@/lib/satora";
import { planReconciliation } from "@/lib/reconcile";
import { CLAIM_ACTIVITY_STATUSES, PROVIDER_REFUND_STATUSES, REDEEMED_STATUSES } from "@/domain/provider-status";
import { providerEvidenceDisposition, type ProviderEvidence } from "@/ui/lib/settlement-client";
import { recoveryState } from "@/ui/lib/recovery-state";

const V6 = "0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948";
const V7 = "0x6c38bf44a327bf36bfbefcedc514c0fb3fec6748";
const COORD_V4 = "0xdb76f29f1d04d1202f56a34549869b070dfcbff0";
const COORD_V5 = "0xb79118233552d4b7ed5c8d2d1e2bba7e8eecb71f";
const TBTC_ARBITRUM = "0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40";
const SATORA_REFUND = "0x5ce278aaec6d9fa67bfcaf98512fe5175dfeebac";
const CLAIM = "0x00000000000000000000000000000000000000c1";
const HASH_LOCK = `0x${"d0".repeat(32)}`;
const AMOUNT = 4652143737254n;
const DEADLINE = 1794768886; // 2026-11-15T18:54:46Z
const CREATED_MS = Date.parse("2026-11-15T17:54:47Z");
const REFUND_TX = "0xde61dfbab09d8341dd690f045a27971c63ee441d92af298f2d45957a34df78bc";
const REFUND_BLOCK = 524_539_319n;
const KEY = computeHtlcSwapKey({ hashLock: HASH_LOCK, amount: AMOUNT, token: TBTC_ARBITRUM, refundAddress: SATORA_REFUND, claimAddress: CLAIM, timelock: BigInt(DEADLINE) });

/** The incident's provider facts (as parsed by getProviderSwap), at creation time. */
function incidentFacts(over: Partial<VerifiedSwapFacts> = {}): VerifiedSwapFacts {
  return {
    satoraSwapId: "e2eb54fd-0000-4000-8000-000000000000",
    direction: "lightning_to_evm",
    bolt11Invoice: "lnbc3u1p4incident",
    paymentHash: HASH_LOCK,
    sourceSats: "3004",
    targetAtomic: "300000",
    evmChainId: 42161,
    targetAddress: "0x0000000000000000000000000000000000000001",
    targetTokenAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    targetTokenChainId: 42161,
    status: "pending",
    invoiceExpiresAt: new Date(CREATED_MS + 90 * 60_000),
    feeSats: 6,
    evmHtlcAddress: "0xf12A26a6CEfc1F5a0772fAf09F94c5e5662a3948",
    evmFundTxid: null,
    evmClaimTxid: null,
    evmHtlcTokenAddress: TBTC_ARBITRUM,
    evmHtlcAmountAtomic: AMOUNT.toString(),
    evmHtlcRefundAddress: SATORA_REFUND,
    evmHtlcClaimAddress: CLAIM,
    evmHtlcVersion: 6,
    evmHtlcKind: "erc20",
    evmCoordinatorAddress: "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0",
    evmRefundLocktime: DEADLINE,
    ...over,
  };
}
// f1ca0926: Arbitrum claim paths are unproven and refused by default; these
// cases test the other preflight rules with an explicit owner canary opt-in.
const ARB_CANARY: ReadonlySet<string> = new Set(["137:6", "42161:6", "42161:7"]);
const AT_CREATION = { nowMs: CREATED_MS + 15_000, claimCanary: ARB_CANARY };
const bound = { paymentHash: HASH_LOCK, evmRefundLocktime: new Date(DEADLINE * 1000) };

describe("pre-handoff HTLC preflight (before Nimiq Pay commits NIM)", () => {
  it("pins exactly the verified deployment pairings per chain", () => {
    expect(HTLC_DEPLOYMENTS[137]).toEqual([{ address: V6, version: 6, kind: "erc20", coordinator: COORD_V4 }]);
    expect(HTLC_DEPLOYMENTS[42161]).toEqual([
      { address: V7, version: 7, kind: "erc20", coordinator: COORD_V5 },
      { address: V6, version: 6, kind: "erc20", coordinator: COORD_V4 },
    ]);
  });

  it("accepts the incident's declared v6 deployment now that v6 is pinned on Arbitrum", () => {
    expect(htlcPreflight(incidentFacts(), AT_CREATION)).toMatchObject({ ok: true, deployment: { address: V6, version: 6 } });
    expect(htlcPreflight(incidentFacts(), { ...AT_CREATION, bound })).toMatchObject({ ok: true });
  });

  it("accepts current v7 with its own coordinator", () => {
    expect(htlcPreflight(incidentFacts({ evmHtlcAddress: V7, evmHtlcVersion: 7, evmCoordinatorAddress: COORD_V5 }), AT_CREATION)).toMatchObject({ ok: true });
  });

  it("refuses an unknown contract: the incident's failure mode now stops BEFORE payment", () => {
    expect(htlcPreflight(incidentFacts({ evmHtlcAddress: "0x0000000000000000000000000000000000000bad" }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
  });

  it("refuses mixed or misdeclared pairings", () => {
    // v6 address declared as v7, v7 address declared as v6.
    expect(htlcPreflight(incidentFacts({ evmHtlcVersion: 7 }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
    expect(htlcPreflight(incidentFacts({ evmHtlcAddress: V7, evmHtlcVersion: 6, evmCoordinatorAddress: COORD_V5 }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
    // A real coordinator paired with the wrong HTLC.
    expect(htlcPreflight(incidentFacts({ evmCoordinatorAddress: COORD_V5 }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
    expect(htlcPreflight(incidentFacts({ evmHtlcKind: "native" }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
  });

  it("keeps chain identity: Polygon still trusts only v6, so a Polygon v7 swap is refused before payment", () => {
    const polygon = { evmChainId: 137, targetTokenChainId: 137 };
    expect(htlcPreflight(incidentFacts(polygon), AT_CREATION)).toMatchObject({ ok: true });
    expect(htlcPreflight(incidentFacts({ ...polygon, evmHtlcAddress: V7, evmHtlcVersion: 7, evmCoordinatorAddress: COORD_V5 }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
    expect(htlcPreflight(incidentFacts({ evmChainId: 1 }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_UNSUPPORTED" });
  });

  it("refuses missing evidence instead of passing it", () => {
    for (const over of [
      { evmHtlcAddress: null },
      { evmHtlcVersion: null },
      { evmHtlcKind: null },
      { evmCoordinatorAddress: null },
      { evmHtlcTokenAddress: null },
      { evmHtlcAmountAtomic: "0" },
      { evmHtlcRefundAddress: null },
      { evmHtlcClaimAddress: null },
      { evmRefundLocktime: null },
    ] satisfies Partial<VerifiedSwapFacts>[]) {
      expect(htlcPreflight(incidentFacts(over), AT_CREATION), JSON.stringify(over)).toMatchObject({ ok: false, code: "HTLC_TERMS_INCOMPLETE" });
    }
    expect(htlcPreflight(incidentFacts({ evmHtlcClaimAddress: SATORA_REFUND }), AT_CREATION)).toMatchObject({ ok: false, code: "HTLC_TERMS_MISMATCH" });
  });

  it("at authorization, the fresh provider read must equal the bound hash lock and deadline", () => {
    expect(htlcPreflight(incidentFacts({ evmRefundLocktime: DEADLINE + 1 }), { ...AT_CREATION, bound })).toMatchObject({ ok: false, code: "HTLC_TERMS_MISMATCH" });
    expect(htlcPreflight(incidentFacts({ paymentHash: `0x${"d1".repeat(32)}` }), { ...AT_CREATION, bound })).toMatchObject({ ok: false, code: "HTLC_TERMS_MISMATCH" });
    expect(htlcPreflight(incidentFacts(), { ...AT_CREATION, bound: { ...bound, evmRefundLocktime: null } })).toMatchObject({ ok: false, code: "HTLC_TERMS_MISMATCH" });
  });

  it("binds every settlement term at attach and reports the first one that drifts by authorize", () => {
    const bound = boundHtlcTermsOf(incidentFacts());
    expect(bound).toMatchObject({ chainId: 42161, htlcAddress: V6, version: 6, kind: "erc20", coordinator: COORD_V4, lockToken: TBTC_ARBITRUM, refundAddress: SATORA_REFUND });
    expect(boundTermsDrift(bound, incidentFacts())).toBeNull();
    // Same terms, different letter case from the provider: not drift.
    expect(boundTermsDrift(bound, incidentFacts({ evmHtlcRefundAddress: SATORA_REFUND.toUpperCase().replace("0X", "0x") }))).toBeNull();
    // Both deployments are trusted on Arbitrum, yet a switch after binding is refused.
    expect(boundTermsDrift(bound, incidentFacts({ evmHtlcAddress: V7, evmHtlcVersion: 7, evmCoordinatorAddress: COORD_V5 }))).toBe("htlcAddress");
    expect(boundTermsDrift(bound, incidentFacts({ evmHtlcAmountAtomic: "1" }))).toBe("lockAmount");
    expect(boundTermsDrift(bound, incidentFacts({ evmHtlcClaimAddress: "0x00000000000000000000000000000000000000c2" }))).toBe("claimAddress");
    // A price change is the repricing guard's decision, not a terms refusal.
    expect(boundTermsDrift(bound, incidentFacts({ sourceSats: "3005" }))).toBeNull();
    expect(boundTermsDrift(bound, incidentFacts({ targetTokenAddress: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8" }))).toBe("targetToken");
    // No bound record (bound before this check, or tampered): never authorizes.
    expect(boundTermsDrift(undefined, incidentFacts())).toBe("missing");
    expect(boundTermsDrift({ ...bound, coordinator: "" }, incidentFacts())).toBe("missing");
  });

  it("requires a claim runway that covers Arbitrum's L1 finality", () => {
    const left = (ms: number) => ({ nowMs: DEADLINE * 1000 - ms, claimCanary: ARB_CANARY });
    expect(htlcPreflight(incidentFacts(), left(HANDOFF_MIN_CLAIM_RUNWAY_MS[42161]!))).toMatchObject({ ok: true });
    expect(htlcPreflight(incidentFacts(), left(HANDOFF_MIN_CLAIM_RUNWAY_MS[42161]! - 1))).toMatchObject({ ok: false, code: "HTLC_DEADLINE_TOO_CLOSE" });
    // Polygon's shorter finality keeps its shorter runway.
    expect(htlcPreflight(incidentFacts({ evmChainId: 137 }), left(20 * 60_000))).toMatchObject({ ok: true });
  });
});

/* ------------------------ refund vs claim classification ------------------------ */

function refundLog(htlc = V6): ChainLog {
  return { address: htlc, topics: [SWAP_REFUNDED_EVENT_TOPIC, HASH_LOCK, KEY], data: "0x", logIndex: 3, transactionHash: REFUND_TX };
}
function redeemLog(): ChainLog {
  return { address: V6, topics: [SWAP_REDEEMED_EVENT_TOPIC, HASH_LOCK, KEY], data: `0x${"ab".repeat(32)}`, logIndex: 3, transactionHash: REFUND_TX };
}
function chain(logs: ChainLog[], finalized: bigint): ChainReads {
  return {
    async getTransaction() { return null; },
    async getReceipt(_c, h) { return h.toLowerCase() === REFUND_TX ? { status: "success", blockNumber: REFUND_BLOCK, blockHash: `0x${"e1".repeat(32)}`, logs } : null; },
    async getLatestBlockNumber() { return REFUND_BLOCK + 5_000n; },
    async getFinalizedBlockNumber() { return finalized; },
    async getBlockHash(_c, n) { return n === REFUND_BLOCK ? `0x${"e1".repeat(32)}` : `0x${"f1".repeat(32)}`; },
  };
}
const refundInput = (pointer: string | null) => ({
  chainId: 42161,
  htlcAddress: V6,
  hashLock: HASH_LOCK,
  providerRefundTxHash: pointer,
  earliestRefundAt: new Date(DEADLINE * 1000),
  expectedLocktimeSec: DEADLINE,
  expectedTokenAddress: TBTC_ARBITRUM,
  expectedAmountAtomic: AMOUNT.toString(),
  expectedRefundAddress: SATORA_REFUND,
  expectedClaimAddress: CLAIM,
});

let savedRpcs: string | undefined;
beforeEach(() => {
  savedRpcs = process.env["THENCE_EVM_RPCS_JSON"];
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "137": "https://polygon.example", "42161": "https://arbitrum.example" });
});
afterEach(() => {
  setSettlementChainForTests(null);
  if (savedRpcs === undefined) delete process.env["THENCE_EVM_RPCS_JSON"];
  else process.env["THENCE_EVM_RPCS_JSON"] = savedRpcs;
});

describe("incident refund recognition (claim field holding a refund tx)", () => {
  it("recognises the genuine v6 SwapRefunded via Satora's evm_claim_txid pointer, once L1-finalized", async () => {
    setSettlementChainForTests(chain([refundLog()], REFUND_BLOCK));
    await expect(verifyHtlcRefund(refundInput(REFUND_TX))).resolves.toMatchObject({ verdict: "VERIFIED", refundTxHash: REFUND_TX, source: "provider_pointer" });
  });

  it("is not yet a refund before Arbitrum finality covers it", async () => {
    setSettlementChainForTests(chain([refundLog()], REFUND_BLOCK - 1n));
    await expect(verifyHtlcRefund(refundInput(REFUND_TX))).resolves.toMatchObject({ verdict: "INSUFFICIENT_CONFIRMATIONS" });
  });

  it("a SwapRedeemed (a real claim) is never accepted as a refund", () => {
    expect(matchRefundEvent([redeemLog()], V6, HASH_LOCK, KEY).matched).toBe(false);
    expect(matchRefundEvent([refundLog()], V6, HASH_LOCK, KEY).matched).toBe(true);
    // Same event from the OTHER pinned contract is not this swap's refund.
    expect(matchRefundEvent([refundLog(V7)], V6, HASH_LOCK, KEY).matched).toBe(false);
  });

  it("refund status + populated claim field is never claim activity, delivery or 'settlement detected'", () => {
    expect(CLAIM_ACTIVITY_STATUSES.has("clientfundedserverrefunded")).toBe(false);
    expect(PROVIDER_REFUND_STATUSES.has("clientfundedserverrefunded")).toBe(true);
    const plan = planReconciliation("SERVER_FUNDED", "clientfundedserverrefunded");
    expect(plan).toMatchObject({ action: "advance", path: ["REFUNDED"] });
    const ev = evidence({ providerStatus: "clientfundedserverrefunded", hasEvmClaimTx: true });
    expect(providerEvidenceDisposition(ev)).toBe("REFUNDED");
  });

  it("clientredeemedandclientrefunded is claim activity (EVM redeemed), never a refund", () => {
    expect(CLAIM_ACTIVITY_STATUSES.has("clientredeemedandclientrefunded")).toBe(true);
    expect(REDEEMED_STATUSES.has("clientredeemedandclientrefunded")).toBe(true);
    expect(PROVIDER_REFUND_STATUSES.has("clientredeemedandclientrefunded")).toBe(false);
    // Provider word moves it toward CLAIMING only; DELIVERED still needs on-chain proof.
    expect(planReconciliation("SERVER_FUNDED", "clientredeemedandclientrefunded")).toMatchObject({ action: "advance", path: ["CLAIMING"] });
    expect(providerEvidenceDisposition(evidence({ providerStatus: "clientredeemedandclientrefunded", hasEvmClaimTx: true }))).toBe("SETTLEMENT_DETECTED");
  });
});

function evidence(over: Partial<ProviderEvidence>): ProviderEvidence {
  return {
    transferId: "af9dc922-0000-4000-8000-000000000000",
    transferStatus: "SERVER_FUNDED",
    providerStatus: "serverfunded",
    invoiceExpired: true,
    invoiceExpiresAt: null,
    sourceSats: "3004",
    targetAtomic: "300000",
    identityMatch: true,
    hasEvmFundingTx: true,
    hasEvmClaimTx: false,
    observedAt: new Date().toISOString(),
    ...over,
  } as ProviderEvidence;
}

describe("incident recovery copy: provider refund is not a NIM return", () => {
  it("a SERVER_FUNDED transfer with a provider refund never reads as funded, names Arbitrum and the NIM step", () => {
    const view = recoveryState({ status: "SERVER_FUNDED", evidence: evidence({ providerStatus: "clientfundedserverrefunded", hasEvmClaimTx: true }), network: "Arbitrum" });
    expect(view.kind).toBe("uncertain");
    expect(view.title).toMatch(/refund/i);
    expect(view.body).toMatch(/Arbitrum lock was refunded to the provider/);
    expect(view.body).toMatch(/not a refund of your NIM/);
    expect(view.body).toMatch(/Nimiq Pay/);
    expect(view.body).not.toMatch(/Polygon/);
  });

  it("provider-reported funding is not called verified; terminal copy is route-specific", () => {
    const funded = recoveryState({ status: "SERVER_FUNDED", evidence: null, network: "Arbitrum" });
    expect(funded.body).toMatch(/provider reports this payment is funded on Arbitrum/);
    expect(funded.body).not.toMatch(/verified/i);
    const refunded = recoveryState({ status: "REFUNDED", evidence: null, network: "Arbitrum" });
    expect(refunded.title).toBe("Not delivered — Arbitrum lock refunded");
    expect(refunded.body).toMatch(/Nimiq Pay/);
    expect(recoveryState({ status: "DELIVERED", evidence: null }).body).toMatch(/Polygon/);
  });
});
