/**
 * Phase 1 regressions built from REAL, redacted evidence of 2026-11-02
 * (tests/fixtures/incidents-2026-11-02.json — production DB rows read in
 * READ ONLY transactions, Satora public getSwap responses, Polygon receipts
 * and HTLC log scans from a public RPC).
 *
 * Database-free and network-free: Satora and Polygon reads are served from
 * the fixture through the existing test seams. DATABASE_URL is stubbed to an
 * unroutable `.invalid` host only so env validation passes; nothing connects.
 *
 * Convention for known defects (no fixes in this milestone):
 * - `it(...)` CHARACTERIZES today's behavior and passes.
 * - `it.fails(...)` states the REQUIRED behavior and is expected to fail
 *   until P1–P6 land. When a fix makes it pass, vitest reports it as a
 *   failure, forcing the marker to be removed in the fixing change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/incidents-2026-11-02.json";
import { canTransition } from "@/domain/transfers";
import { assertFundingExposure, getPilotConfig, isActualSpendStatus, isFundingExposureStatus } from "@/lib/pilot";
import { isClaimReady, planReconciliation } from "@/lib/reconcile";
import { getProviderSwap, setSatoraFetchersForTests } from "@/lib/satora";
import {
  SWAP_REFUNDED_EVENT_TOPIC,
  TRANSFER_EVENT_TOPIC,
  matchRefundEvent,
  setSettlementChainForTests,
  verifyEvmRefundEvidence,
  type ChainReads,
  type ChainReceipt,
} from "@/lib/settlement";
import { CLAIM_TIMELOCK_MARGIN_MS, isClaimWindowOpen } from "@/ui/lib/claim-gate";

const INC = fixture.incident_077770a1;
const STALE = fixture.stale_eddaa6de;
const FUND_TX = INC.satora.getSwap.evm_fund_txid as string;
const PROVIDER_CLAIM_TX = INC.satora.getSwap.evm_claim_txid as string;

type RawReceipt = (typeof INC.polygon.receipts)[keyof typeof INC.polygon.receipts];
const receipts = INC.polygon.receipts as Record<string, RawReceipt>;
const blocks = INC.polygon.blocks as Record<string, { number: string; hash: string; timestamp: string }>;

function toChainReceipt(raw: RawReceipt): ChainReceipt {
  return {
    status: raw.status as "success" | "reverted",
    blockNumber: BigInt(raw.blockNumber),
    blockHash: raw.blockHash,
    logs: raw.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })),
  };
}

/** Read-only chain served entirely from the captured public receipts. */
function fixtureChain(): ChainReads {
  return {
    async getTransaction(_chainId, hash) {
      const r = receipts[hash.toLowerCase()];
      return r ? { hash, blockNumber: BigInt(r.blockNumber) } : null;
    },
    async getReceipt(_chainId, hash) {
      const r = receipts[hash.toLowerCase()];
      return r ? toChainReceipt(r) : null;
    },
    async getLatestBlockNumber() {
      return BigInt(fixture._meta.polygonLatestBlockAtCapture);
    },
    async getFinalizedBlockNumber() {
      return BigInt(fixture._meta.polygonLatestBlockAtCapture) - 300n;
    },
    async getBlockHash(_chainId, blockNumber) {
      return blocks[blockNumber.toString()]?.hash ?? null;
    },
  };
}

const at = (iso: string) => new Date(iso).getTime();
const blockTime = (hash: string) => Number(blocks[receipts[hash]!.blockNumber]!.timestamp) * 1000;

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@fixture.invalid:5432/none");
  vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": "https://fixture.invalid" }));
  setSettlementChainForTests(fixtureChain());
  setSatoraFetchersForTests({
    getSwap: async (id: string) => {
      if (id === INC.satora.getSwap.id) return INC.satora.getSwap;
      if (id === STALE.satora.getSwap.id) return STALE.satora.getSwap;
      throw Object.assign(new Error("not found"), { code: 404 });
    },
  });
});

afterEach(() => {
  setSettlementChainForTests(null);
  setSatoraFetchersForTests(null);
  vi.unstubAllEnvs();
});

describe("fixture integrity (real evidence, redacted)", () => {
  it("contains no secrets, invoices or unredacted personal identifiers", () => {
    const text = JSON.stringify({ ...fixture, _meta: { ...fixture._meta, description: "" } });
    expect(text).not.toMatch(/lnbc[0-9]/i);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(text).not.toMatch(/preimage|secret|mnemonic/i);
    expect(INC.satora.getSwap.target_evm_address).toBe(fixture._meta.redactions.destination);
    expect(INC.transfer.owner_user_id).toBe(fixture._meta.redactions.ownerUserId);
  });

  it("the real Satora responses parse through the production swap reader", async () => {
    const inc = await getProviderSwap(INC.satora.getSwap.id);
    expect(inc.status).toBe("clientfundedserverrefunded");
    expect(inc.paymentHash).toBe(INC.attachment.payment_hash);
    expect(inc.evmHtlcAddress?.toLowerCase()).toBe("0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948");
    const stale = await getProviderSwap(STALE.satora.getSwap.id);
    expect(stale.status).toBe("expired");
    expect(stale.evmFundTxid).toBeNull();
    expect(stale.evmClaimTxid).toBeNull();
  });
});

describe("incident 077770a1 — approval → funded swap → no claim → deadline expiry → refund", () => {
  it("timeline: approved, funded on Polygon within a minute, deadline ~1h after swap CREATION", () => {
    const authorized = at(INC.attempt.handoff_authorized_at!);
    const swapCreated = at(INC.satora.getSwap.created_at);
    const funded = blockTime(FUND_TX);
    const deadline = INC.satora.getSwap.evm_refund_locktime * 1000;
    expect(receipts[FUND_TX]!.status).toBe("success");
    expect(funded - authorized).toBeLessThan(60_000);
    // The refund deadline counts from swap creation, not from funding.
    expect(Math.round((deadline - swapCreated) / 60_000)).toBe(60);
    // Usable claim window from funding to deadline: ~59 minutes.
    expect(Math.floor((deadline - funded) / 60_000)).toBe(59);
  });

  it("missing claim progression: Thence observed funding only once, 17 min after it happened, then nothing until after refund", () => {
    const funded = blockTime(FUND_TX);
    const deadline = INC.satora.getSwap.evm_refund_locktime * 1000;
    const obs = INC.observations.map((o) => ({ status: o.provider_status, t: at(o.observed_at) }));
    expect(obs.map((o) => o.status)).toEqual(["serverfunded", "clientfundedserverrefunded"]);
    expect(Math.round((obs[0]!.t - funded) / 60_000)).toBe(17);
    const duringWindow = obs.filter((o) => o.t > funded && o.t < deadline);
    expect(duringWindow).toHaveLength(1);
    // While funded, the server considered it claim-ready the whole time.
    expect(isClaimReady("SERVER_FUNDED", "serverfunded")).toBe(true);
  });

  it("no claim was ever submitted on-chain: the HTLC emitted only fund and refund for this hash lock", () => {
    const topics = INC.polygonHtlcScan.logs.map((l) => l.topic0);
    expect(topics).toEqual([fixture._meta.htlcEventTopics.fund, fixture._meta.htlcEventTopics.swapRefunded]);
    expect(fixture._meta.htlcEventTopics.swapRefunded).toBe(SWAP_REFUNDED_EVENT_TOPIC);
  });

  it("the client claim gate closed 60 s before the deadline and the refund landed ~4 min after it", () => {
    const lock = INC.satora.getSwap.evm_refund_locktime;
    expect(isClaimWindowOpen(lock, lock * 1000 - CLAIM_TIMELOCK_MARGIN_MS - 1)).toBe(true);
    expect(isClaimWindowOpen(lock, lock * 1000 - CLAIM_TIMELOCK_MARGIN_MS)).toBe(false);
    const refundAt = blockTime(PROVIDER_CLAIM_TX);
    expect(Math.round((refundAt - lock * 1000) / 1000)).toBe(252);
  });

  it("Satora reports the REFUND transaction in evm_claim_txid (empirical; field documented as user claim)", () => {
    const r = receipts[PROVIDER_CLAIM_TX]!;
    expect(r.from.toLowerCase()).toBe(INC.satora.getSwap.server_evm_address.toLowerCase());
    expect(r.input4).toBe("0x36504721");
    expect(matchRefundEvent(toChainReceipt(r).logs, INC.satora.getSwap.evm_htlc_address, INC.attachment.payment_hash).matched).toBe(true);
    // No USDC/ERC20 Transfer to the recipient exists in that receipt.
    const toRecipient = r.logs.filter((l) => l.topics[0] === TRANSFER_EVENT_TOPIC && l.topics[2]?.toLowerCase().endsWith(INC.satora.getSwap.target_evm_address.slice(2).toLowerCase()));
    expect(toRecipient).toHaveLength(0);
  });

  it("deployed refund verification (1f28983) accepts the real refund and rejects mismatches", async () => {
    const base = { chainId: 137, refundTxHash: PROVIDER_CLAIM_TX, htlcAddress: INC.satora.getSwap.evm_htlc_address };
    expect((await verifyEvmRefundEvidence({ ...base, hashLock: INC.attachment.payment_hash })).verdict).toBe("VERIFIED");
    expect((await verifyEvmRefundEvidence({ ...base, hashLock: STALE.attachment.payment_hash })).verdict).toBe("INVALID");
    expect((await verifyEvmRefundEvidence({ ...base, refundTxHash: FUND_TX, hashLock: INC.attachment.payment_hash })).verdict).toBe("INVALID");
  });

  it("planner moves SERVER_FUNDED to REFUNDED on the real provider status, idempotently", () => {
    expect(planReconciliation("SERVER_FUNDED", "clientfundedserverrefunded")).toMatchObject({ action: "advance", path: ["REFUNDED"] });
    expect(planReconciliation("REFUNDED", "clientfundedserverrefunded")).toMatchObject({ action: "advance", path: [] });
    expect(isClaimReady("REFUNDED", "clientfundedserverrefunded")).toBe(false);
    expect(isFundingExposureStatus("REFUNDED")).toBe(false);
  });

  it("characterization: the server-side swap facts carry NO refund deadline (P2 gap)", async () => {
    const facts = await getProviderSwap(INC.satora.getSwap.id);
    expect(Object.keys(facts)).not.toContain("evmRefundLocktime");
  });

  it.fails("REQUIRED (P2): the server knows the claim deadline for a bound swap", async () => {
    const facts = (await getProviderSwap(INC.satora.getSwap.id)) as unknown as { evmRefundLocktime?: number };
    expect(facts.evmRefundLocktime).toBe(INC.satora.getSwap.evm_refund_locktime);
  });
});

describe("stale eddaa6de — expired, never funded, still RECONCILING and occupying capacity", () => {
  const OWNER = fixture._meta.redactions.ownerUserId;
  const armed = getPilotConfig({
    NODE_ENV: "production",
    THENCE_PILOT_ENABLED: "1",
    THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
    THENCE_PILOT_MAX_TRANSFERS: "1",
    THENCE_PILOT_MAX_SPEND_ATOMIC: "300000",
  });

  /** Minimal read-only stand-in for the drizzle select chain, fed by fixture rows. */
  function fixtureDb(statusOverride?: string) {
    const transferRows = [
      { id: STALE.transfer.id, amount: STALE.transfer.target_amount_atomic, status: statusOverride ?? STALE.transfer.status, routeId: STALE.transfer.route_id },
      { id: INC.transfer.id, amount: INC.transfer.target_amount_atomic, status: INC.transfer.status, routeId: INC.transfer.route_id },
    ];
    let call = 0;
    return {
      select: () => ({
        from: () => ({
          where: async () => (call++ === 0 ? transferRows : []),
        }),
      }),
    } as unknown as Parameters<typeof assertFundingExposure>[3];
  }

  it("independent evidence says it was never funded", () => {
    expect(STALE.satora.getSwap.status).toBe("expired");
    expect(STALE.satora.getSwap.evm_fund_txid).toBeNull();
    expect(STALE.satora.getSwap.evm_claim_txid).toBeNull();
    expect(at(STALE.attachment.invoice_expires_at!)).toBeLessThan(at(fixture._meta.dbCapturedAt));
    expect(STALE.observations.every((o) => o.provider_status === "expired" && o.evm_fund_txid === null)).toBe(true);
    // Polygon: no HTLC event for this hash lock from before creation to hours past the deadline.
    expect(at(STALE.polygonHtlcScan.fromTime)).toBeLessThan(at(STALE.satora.getSwap.created_at));
    expect(at(STALE.polygonHtlcScan.toTime)).toBeGreaterThan(STALE.satora.getSwap.evm_refund_locktime * 1000 + 2 * 3600_000);
    expect(STALE.polygonHtlcScan.logs).toHaveLength(0);
  });

  it("characterization: RECONCILING is counted as funding exposure (not as spend)", () => {
    expect(STALE.transfer.status).toBe("RECONCILING");
    expect(isFundingExposureStatus("RECONCILING")).toBe(true);
    expect(isActualSpendStatus("RECONCILING")).toBe(false);
  });

  it("characterization: there is no path out — planner does nothing and no terminal edge exists", () => {
    expect(planReconciliation("RECONCILING", "expired").action).toBe("none");
    expect(canTransition("RECONCILING", "USER_CANCELLED")).toBe(false);
    expect(canTransition("RECONCILING", "FAILED")).toBe(false);
  });

  it("characterization: it blocks a new payment under the armed pilot cap (PILOT_EXPOSURE_LIMIT)", async () => {
    await expect(assertFundingExposure(OWNER, "300000", armed, fixtureDb())).rejects.toMatchObject({ code: "PILOT_EXPOSURE_LIMIT" });
    // Control: the same owner with that row resolved is not blocked by exposure.
    await expect(assertFundingExposure(OWNER, "300000", armed, fixtureDb("USER_CANCELLED"))).resolves.toBeUndefined();
  });

  it.fails("REQUIRED (P4): an evidence-proven expired-unfunded RECONCILING transfer has a safe terminal exit", () => {
    const decision = planReconciliation("RECONCILING", "expired");
    expect(decision.action).not.toBe("none");
  });

  it.fails("REQUIRED (P4): once retired on that evidence it no longer occupies financial capacity", async () => {
    // Today the only state it can sit in is RECONCILING, so the cap stays occupied.
    await expect(assertFundingExposure(OWNER, "300000", armed, fixtureDb())).resolves.toBeUndefined();
  });
});
