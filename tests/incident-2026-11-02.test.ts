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
import { USER_FACING_LABEL, canTransition, isTerminal } from "@/domain/transfers";
import { assessNonChainEvidence, chainRefusal, scanWindow } from "@/lib/expiry-resolution";
import { EXPIRED_UNFUNDED_BODY } from "@/ui/lib/settlement-client";
import { assertFundingExposure, getPilotConfig, isActualSpendStatus, isFundingExposureStatus } from "@/lib/pilot";
import { claimReadyNow, isClaimReady, planReconciliation } from "@/lib/reconcile";
import { CLAIM_UNSAFE_WINDOW_MS, claimActionAllowed, claimWindowAt, validateLocktime } from "@/domain/claim-deadline";
import { getProviderSwap, setSatoraFetchersForTests } from "@/lib/satora";
import {
  SWAP_REFUNDED_EVENT_TOPIC,
  TRANSFER_EVENT_TOPIC,
  matchRefundEvent,
  setSettlementChainForTests,
  verifyEvmRefundEvidence,
  verifyNoHtlcActivity,
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

  it("the client claim gate closes 5 min before the deadline (P2: was 60 s) and the refund landed ~4 min after it", () => {
    const lock = INC.satora.getSwap.evm_refund_locktime;
    expect(CLAIM_TIMELOCK_MARGIN_MS).toBe(CLAIM_UNSAFE_WINDOW_MS);
    expect(CLAIM_UNSAFE_WINDOW_MS).toBe(5 * 60_000);
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

  // P2 (was it.fails): the server knows the claim deadline for a bound swap.
  it("P2: the server knows the claim deadline for a bound swap", async () => {
    const facts = (await getProviderSwap(INC.satora.getSwap.id)) as unknown as { evmRefundLocktime?: number };
    expect(facts.evmRefundLocktime).toBe(INC.satora.getSwap.evm_refund_locktime);
  });

  it("P2: the real deadline is plausible at bind time and is accepted for persistence", async () => {
    const facts = await getProviderSwap(INC.satora.getSwap.id);
    const bindMs = at(INC.attachment.created_at);
    const validated = validateLocktime(facts.evmRefundLocktime, bindMs, facts.invoiceExpiresAt);
    expect(validated).toBeInstanceOf(Date);
    expect((validated as Date).toISOString()).toBe("2026-11-02T22:12:42.000Z");
    // Implausible values are refused as identity anomalies, not stored.
    expect(validateLocktime(facts.evmRefundLocktime! + 3600, bindMs, facts.invoiceExpiresAt)).toBe("implausible"); // after invoice expiry
    expect(validateLocktime(Math.floor(bindMs / 1000) + 60, bindMs, facts.invoiceExpiresAt)).toBe("implausible"); // 1 min after bind
    expect(validateLocktime(null, bindMs, facts.invoiceExpiresAt)).toBeNull();
  });

  it("P2: the deadline counts from swap CREATION, not funding, and is not the invoice or NIM timer", () => {
    const deadline = INC.satora.getSwap.evm_refund_locktime * 1000;
    const created = at(INC.satora.getSwap.created_at);
    const funded = blockTime(FUND_TX);
    expect(Math.round((deadline - created) / 60_000)).toBe(60);
    // Funding 43 s after creation already consumed claim time: 59 min left, not 60.
    expect(Math.floor((deadline - funded) / 60_000)).toBe(59);
    expect(claimWindowAt(deadline, funded)).toBe("open");
    // When Thence first observed funding (21:30:26) only 42 min remained.
    expect(Math.floor((deadline - at(INC.observations[0]!.observed_at)) / 60_000)).toBe(42);
    // The Lightning invoice expiry is 30 min LATER: using it would overstate the window.
    expect(at(INC.attachment.invoice_expires_at!) - deadline).toBe(30 * 60_000);
  });

  it("P2: the window is time-aware — open, closing, unsafe, passed", () => {
    const d = INC.satora.getSwap.evm_refund_locktime * 1000;
    expect(claimWindowAt(d, d - 42 * 60_000)).toBe("open");
    expect(claimWindowAt(d, d - 10 * 60_000)).toBe("closing");
    expect(claimWindowAt(d, d - 4 * 60_000)).toBe("unsafe");
    expect(claimWindowAt(d, d + 1)).toBe("passed");
    expect(claimWindowAt(null, d)).toBe("unknown");
    expect(claimActionAllowed("open") && claimActionAllowed("closing")).toBe(true);
    expect(["unknown", "unsafe", "passed"].some((w) => claimActionAllowed(w as never))).toBe(false);
  });

  it("P2: no claim action when refunded, expired, identity-mismatched or inside the unsafe window", () => {
    const funded = { transferStatus: "SERVER_FUNDED" as const, providerStatus: "serverfunded", latestKind: "observation" };
    expect(claimReadyNow({ ...funded, claimWindow: "open" })).toBe(true);
    expect(claimReadyNow({ ...funded, claimWindow: "closing" })).toBe(true);
    expect(claimReadyNow({ ...funded, claimWindow: "unsafe" })).toBe(false);
    expect(claimReadyNow({ ...funded, claimWindow: "passed" })).toBe(false);
    expect(claimReadyNow({ ...funded, latestKind: "identity_mismatch", claimWindow: "open" })).toBe(false);
    expect(claimReadyNow({ ...funded, latestKind: "provider_error", claimWindow: "open" })).toBe(false);
    expect(claimReadyNow({ transferStatus: "REFUNDED", providerStatus: "clientfundedserverrefunded", latestKind: "observation", claimWindow: "open" })).toBe(false);
    expect(claimReadyNow({ transferStatus: "RECONCILING", providerStatus: "expired", latestKind: "observation", claimWindow: "open" })).toBe(false);
    expect(claimReadyNow({ transferStatus: "EXPIRED_UNFUNDED", providerStatus: "expired", latestKind: "observation", claimWindow: "open" })).toBe(false);
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

  it("the exit is narrow: only the evidence-gated EXPIRED_UNFUNDED edge, never cancel/fail, never applied by the planner itself", () => {
    expect(canTransition("RECONCILING", "EXPIRED_UNFUNDED")).toBe(true);
    expect(canTransition("RECONCILING", "USER_CANCELLED")).toBe(false);
    expect(canTransition("RECONCILING", "FAILED")).toBe(false);
    // Expiry alone never auto-closes outside RECONCILING.
    expect(planReconciliation("AWAITING_NIM_APPROVAL", "expired").action).toBe("none");
    expect(planReconciliation("LIGHTNING_HANDOFF", "expired").action).toBe("none");
    expect(isTerminal("EXPIRED_UNFUNDED")).toBe(true);
  });

  it("while unresolved it still blocks a new payment under the armed pilot cap (PILOT_EXPOSURE_LIMIT)", async () => {
    await expect(assertFundingExposure(OWNER, "300000", armed, fixtureDb())).rejects.toMatchObject({ code: "PILOT_EXPOSURE_LIMIT" });
    // Control: the same owner with that row resolved is not blocked by exposure.
    await expect(assertFundingExposure(OWNER, "300000", armed, fixtureDb("USER_CANCELLED"))).resolves.toBeUndefined();
  });

  // P4 (was it.fails): an evidence-proven expired-unfunded RECONCILING transfer has a safe terminal exit.
  it("P4: an evidence-proven expired-unfunded RECONCILING transfer has a safe terminal exit", () => {
    const decision = planReconciliation("RECONCILING", "expired");
    expect(decision.action).not.toBe("none");
    expect(decision).toMatchObject({ action: "evidence-gated-close", path: ["EXPIRED_UNFUNDED"] });
  });

  // P4 (was it.fails): once retired on that evidence it no longer occupies financial capacity.
  it("P4: once retired on that evidence it no longer occupies financial capacity", async () => {
    expect(isFundingExposureStatus("EXPIRED_UNFUNDED")).toBe(false);
    expect(isActualSpendStatus("EXPIRED_UNFUNDED")).toBe(false);
    await expect(assertFundingExposure(OWNER, "300000", armed, fixtureDb("EXPIRED_UNFUNDED"))).resolves.toBeUndefined();
  });
});

/**
 * P4 evidence gates replayed on the REAL captured evidence. The fixture
 * chain answers only inside the block ranges that were actually scanned on
 * Polygon (outside them it throws → UNAVAILABLE), and maps block numbers to
 * time with the linear fit of the two captured block timestamps (1.5 s/block).
 */
describe("P4 evidence gates on real evidence", () => {
  const HTLC = INC.satora.getSwap.evm_htlc_address;
  const anchor = blocks[INC.polygon.receipts[FUND_TX as keyof typeof INC.polygon.receipts].blockNumber]!;
  const ts = (n: bigint) => Number(anchor.timestamp) + Math.floor((Number(n) - Number(anchor.number)) * 1.5);
  const scans = [INC.polygonHtlcScan, STALE.polygonHtlcScan];

  function scanningChain(): ChainReads {
    return {
      ...fixtureChain(),
      async getBlockTimestamp(_chainId, n) {
        return ts(n);
      },
      async getLogsByTopic1(_chainId, address, topic1, from, to) {
        const scan = scans.find((s) => s.hashLock.toLowerCase() === topic1.toLowerCase());
        if (!scan || from < BigInt(scan.fromBlock) || to > BigInt(scan.toBlock)) throw new Error("outside captured evidence");
        return scan.logs
          .filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to)
          .map((l) => ({ address, topics: [l.topic0, topic1, "0x" + "00".repeat(32)], data: "0x", logIndex: l.logIndex }));
      },
    };
  }

  function rows(c: typeof STALE | typeof INC, status: string) {
    const transfer = { ...c.transfer, status, targetAmountAtomic: c.transfer.target_amount_atomic, destination: c.transfer.destination } as never;
    const attachment = {
      satoraSwapId: c.attachment.satora_swap_id,
      paymentHash: c.attachment.payment_hash,
      createdAt: new Date(c.attachment.created_at),
      invoiceExpiresAt: new Date(c.attachment.invoice_expires_at!),
    } as never;
    return { transfer, attachment };
  }
  const cleanLocal = { movementObservations: 0, identityMismatchObservations: 0, evmProofRecorded: false, nimiqFundingRecorded: false, activeReservations: 0 };

  it("eddaa6de: real provider + local evidence passes every non-chain gate; the chain scan finds NO_ACTIVITY", async () => {
    setSettlementChainForTests(scanningChain());
    const facts = await getProviderSwap(STALE.satora.getSwap.id);
    const { transfer, attachment } = rows(STALE, "RECONCILING");
    const local = { ...cleanLocal, movementObservations: STALE.observations.filter((o) => o.provider_status !== "expired").length };
    expect(assessNonChainEvidence({ transfer, attachment, facts, routeMatches: true, local, now: at(fixture._meta.dbCapturedAt) })).toBeNull();
    const window = scanWindow(attachment, facts)!;
    expect(window.start.toISOString()).toBe("2026-11-02T12:49:27.671Z");
    expect(window.end.toISOString()).toBe("2026-11-02T15:24:26.000Z");
    const chain = await verifyNoHtlcActivity({ chainId: 137, htlcAddress: facts.evmHtlcAddress, hashLock: STALE.attachment.payment_hash, windowStart: window.start, windowEnd: window.end });
    expect(chain.verdict).toBe("NO_ACTIVITY");
    expect(chainRefusal(chain)).toBeNull();
  });

  it("077770a1: the same scan over its window finds the real fund + refund events (ACTIVITY_FOUND)", async () => {
    setSettlementChainForTests(scanningChain());
    const chain = await verifyNoHtlcActivity({
      chainId: 137,
      htlcAddress: HTLC,
      hashLock: INC.attachment.payment_hash,
      windowStart: new Date("2026-11-02T21:07:44.000Z"),
      windowEnd: new Date("2026-11-02T22:40:00.000Z"),
    });
    expect(chain.verdict).toBe("ACTIVITY_FOUND");
    expect(chain.eventTopics).toEqual([fixture._meta.htlcEventTopics.fund, fixture._meta.htlcEventTopics.swapRefunded]);
    expect(chainRefusal(chain)).toBe("CHAIN_ACTIVITY_FOUND");
  });

  it("077770a1: provider and local gates refuse a funded/refunded swap before any chain scan", async () => {
    const facts = await getProviderSwap(INC.satora.getSwap.id);
    const { transfer, attachment } = rows(INC, "RECONCILING");
    expect(assessNonChainEvidence({ transfer, attachment, facts, routeMatches: true, local: cleanLocal, now: at(fixture._meta.dbCapturedAt) })).toBe("PROVIDER_REPORTS_EVM_TX");
    expect(assessNonChainEvidence({ transfer, attachment, facts, routeMatches: true, local: { ...cleanLocal, movementObservations: 1 }, now: at(fixture._meta.dbCapturedAt) })).toBe("LOCAL_MOVEMENT_RECORDED");
  });

  it("refuses on any doubt: NIM funding recorded, too-recent expiry, untrusted HTLC, unreadable or unfinalized chain", async () => {
    const facts = await getProviderSwap(STALE.satora.getSwap.id);
    const { transfer, attachment } = rows(STALE, "RECONCILING");
    const now = at(fixture._meta.dbCapturedAt);
    expect(assessNonChainEvidence({ transfer, attachment, facts, routeMatches: true, local: { ...cleanLocal, nimiqFundingRecorded: true }, now })).toBe("NIM_FUNDING_RECORDED");
    expect(assessNonChainEvidence({ transfer, attachment, facts, routeMatches: true, local: cleanLocal, now: at(STALE.attachment.invoice_expires_at!) + 60_000 })).toBe("INVOICE_NOT_SETTLED");
    expect(assessNonChainEvidence({ transfer, attachment, facts: { ...facts, evmHtlcAddress: "0x" + "11".repeat(20) }, routeMatches: true, local: cleanLocal, now })).toBe("HTLC_UNTRUSTED");
    expect(assessNonChainEvidence({ transfer, attachment, facts, routeMatches: false, local: cleanLocal, now })).toBe("PROVIDER_IDENTITY_MISMATCH");
    expect(assessNonChainEvidence({ ...rows(STALE, "AWAITING_NIM_APPROVAL"), facts, routeMatches: true, local: cleanLocal, now })).toBe("NOT_RESOLVABLE");
    // Chain outside the captured evidence is unreadable → never NO_ACTIVITY.
    setSettlementChainForTests(scanningChain());
    const outside = await verifyNoHtlcActivity({ chainId: 137, htlcAddress: facts.evmHtlcAddress, hashLock: STALE.attachment.payment_hash, windowStart: new Date("2026-11-02T10:00:00Z"), windowEnd: new Date("2026-11-02T15:00:00Z") });
    expect(outside.verdict).toBe("UNAVAILABLE");
    // A reader without scan capability is inconclusive, not "no activity".
    setSettlementChainForTests(fixtureChain());
    const blind = await verifyNoHtlcActivity({ chainId: 137, htlcAddress: facts.evmHtlcAddress, hashLock: STALE.attachment.payment_hash, windowStart: new Date("2026-11-02T12:50:00Z"), windowEnd: new Date("2026-11-02T15:00:00Z") });
    expect(blind.verdict).toBe("INCONCLUSIVE");
    // A window ending in the future (not final) is refused.
    setSettlementChainForTests(scanningChain());
    const unfinal = await verifyNoHtlcActivity({ chainId: 137, htlcAddress: facts.evmHtlcAddress, hashLock: STALE.attachment.payment_hash, windowStart: new Date("2026-11-02T12:50:00Z"), windowEnd: new Date("2099-01-01T00:00:00Z") });
    expect(unfinal.verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
  });

  it("the owner copy for the closed state never claims a NIM refund", () => {
    expect(EXPIRED_UNFUNDED_BODY).not.toMatch(/refund(ed)?/i);
    expect(EXPIRED_UNFUNDED_BODY).toMatch(/Nimiq Pay/);
    expect(USER_FACING_LABEL.EXPIRED_UNFUNDED).toBe("Expired — not delivered");
  });
});
