/**
 * R2 — verifyNimiqHtlcReturn against a simulated Nimiq chain with genuine
 * Ed25519 proofs. Pure (no database). Every refusal must be exact: there is
 * no partial proof of a NIM return.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setNimiqSourceRpcTransportForTests, verifyNimiqHtlcReturn, NIMIQ_HTLC_HISTORY_MAX } from "@/lib/nimiq-source";
import { SimulatedNimiqNode, buildFunding, buildSpend, keypair, txHash, type Funding, type Keypair } from "./fixtures/nimiq-htlc-chain";

const HASH_LOCK = "d3d7213a08bdc478c8c542d98b619f3bd9dbeec40a2f6c673d91ae41890a035c";
const CONFIG = { url: "https://nimiq-proof.fixture.invalid/rpc", network: "mainnet" as const, minConfirmations: 6 };

let node: SimulatedNimiqNode;
let owner: Keypair;
let swapRecipient: Keypair;
let funding: Funding;
const FUND = txHash("funding");
const REFUND = txHash("refund");

function input(over: Partial<Parameters<typeof verifyNimiqHtlcReturn>[0]> = {}) {
  return { fundingTxHash: FUND, ownerAddress: owner.address, lightningPaymentHash: HASH_LOCK, expectedAmountLuna: funding.lockedLuna.toString(), config: CONFIG, ...over };
}

/** Lock only: the incident state before the Nimiq HTLC timeout. */
function locked(): void {
  node.addTx(funding.tx);
  node.balances.set(funding.htlcAddress, funding.lockedLuna);
}

/** Lock + one spend; the HTLC is empty afterwards unless told otherwise. */
function spent(spend: Record<string, unknown>, opts: { final?: boolean; leftover?: bigint } = {}): void {
  node.addTx(funding.tx);
  node.addTx(spend, { final: opts.final });
  node.balances.set(funding.htlcAddress, opts.leftover ?? 0n);
}

beforeEach(() => {
  node = new SimulatedNimiqNode();
  owner = keypair();
  swapRecipient = keypair();
  funding = buildFunding({ owner, htlcRecipient: swapRecipient.address, hashLock: HASH_LOCK, hash: FUND });
  setNimiqSourceRpcTransportForTests(node.transport);
});
afterEach(() => setNimiqSourceRpcTransportForTests(null));

describe("R2 verifyNimiqHtlcReturn", () => {
  it("verified TimeoutResolve refund to the owner: complete, final, full amount, zero balance", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner }));
    const r = await verifyNimiqHtlcReturn(input());
    expect(r).toMatchObject({
      ok: true,
      evidence: {
        fundingTxHash: FUND,
        refundTxHash: REFUND,
        resolution: "TIMEOUT_RESOLVE",
        htlcAddress: funding.htlcAddress,
        ownerAddress: owner.address,
        destination: owner.address,
        lockedLuna: "724409383",
        returnedLuna: "724409283",
        feeLuna: "100",
        historyHashes: [FUND, REFUND].sort(),
        network: "mainnet",
      },
    });
    // Both history endpoints were consulted with named params (never positional).
    const history = node.calls.filter((c) => c.method.endsWith("ByAddress") && c.method !== "getAccountByAddress");
    expect(history.map((c) => c.method).sort()).toEqual(["getTransactionHashesByAddress", "getTransactionsByAddress"]);
    for (const c of history) expect(c.params).toEqual({ address: funding.htlcAddress, max: NIMIQ_HTLC_HISTORY_MAX });
  });

  it("verified EarlyResolve return signed by the swap recipient AND the owner", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "early", to: owner.address, owner, recipient: swapRecipient, timestampMs: funding.timeoutMs - 3_600_000n }));
    const r = await verifyNimiqHtlcReturn(input());
    expect(r).toMatchObject({ ok: true, evidence: { resolution: "EARLY_RESOLVE" } });
  });

  it("incident 6f44918d before the timeout: NIM still locked, never a return", async () => {
    locked();
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "STILL_LOCKED" });
  });

  it("redeemed with the preimage (RegularTransfer): REDEEMED, whatever the destination", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "redeem", to: swapRecipient.address, owner, recipient: swapRecipient }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "REDEEMED" });
    node = new SimulatedNimiqNode();
    setNimiqSourceRpcTransportForTests(node.transport);
    spent(buildSpend({ funding, hash: REFUND, kind: "redeem", to: owner.address, owner, recipient: swapRecipient }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "REDEEMED" });
  });

  it("refund to any address other than the authenticated owner: WRONG_DESTINATION", async () => {
    const stranger = keypair();
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: stranger.address, owner }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "WRONG_DESTINATION" });
  });

  it("partial amount (value + fee below the locked amount): AMOUNT_MISMATCH", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner, valueLuna: 700_000_000n }), { leftover: 0n });
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "AMOUNT_MISMATCH" });
  });

  it("incomplete or inconsistent history is refused", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner }));
    node.truncate = true;
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "HISTORY_INCOMPLETE" });
    node.truncate = false;
    node.hashesOverride = [FUND];
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "HISTORY_MISMATCH" });
    node.hashesOverride = [REFUND];
    node.history.set(funding.htlcAddress, [REFUND]);
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "HISTORY_INCOMPLETE" });
  });

  it("a second outgoing spend (partial drain) is refused", async () => {
    const half = funding.lockedLuna / 2n;
    node.addTx(funding.tx);
    node.addTx(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner, valueLuna: half - 100n }));
    node.addTx(buildSpend({ funding, hash: txHash("refund-2"), kind: "timeout", to: owner.address, owner, valueLuna: funding.lockedLuna - half - 100n }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "UNEXPECTED_SPEND" });
  });

  it("chain uncertainty: non-final refund, low confirmations, node down, leftover balance", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner }), { final: false });
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "INSUFFICIENT_FINALITY" });

    node = new SimulatedNimiqNode();
    setNimiqSourceRpcTransportForTests(node.transport);
    spent({ ...buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner }), confirmations: 2 });
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "INSUFFICIENT_FINALITY" });

    node = new SimulatedNimiqNode();
    setNimiqSourceRpcTransportForTests(node.transport);
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner }), { leftover: 5n });
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "STILL_LOCKED" });

    node.down = true;
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
  });

  it("invalid or premature proofs and failed spends are refused", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner, signer: keypair() }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "INVALID_PROOF" });

    node = new SimulatedNimiqNode();
    setNimiqSourceRpcTransportForTests(node.transport);
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner, timestampMs: funding.timeoutMs - 1n }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "BEFORE_TIMEOUT" });

    node = new SimulatedNimiqNode();
    setNimiqSourceRpcTransportForTests(node.transport);
    spent(buildSpend({ funding, hash: REFUND, kind: "early", to: owner.address, owner, recipient: keypair() }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "INVALID_PROOF" });

    node = new SimulatedNimiqNode();
    setNimiqSourceRpcTransportForTests(node.transport);
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner, executionResult: false }));
    expect(await verifyNimiqHtlcReturn(input())).toEqual({ ok: false, code: "UNSUCCESSFUL" });
  });

  it("the original funding must still verify exactly (amount, owner, hash lock)", async () => {
    spent(buildSpend({ funding, hash: REFUND, kind: "timeout", to: owner.address, owner }));
    expect(await verifyNimiqHtlcReturn(input({ expectedAmountLuna: "724409384" }))).toEqual({ ok: false, code: "SOURCE_NOT_VERIFIED" });
    expect(await verifyNimiqHtlcReturn(input({ ownerAddress: keypair().address }))).toEqual({ ok: false, code: "SOURCE_NOT_VERIFIED" });
    expect(await verifyNimiqHtlcReturn(input({ lightningPaymentHash: "ee".repeat(32) }))).toEqual({ ok: false, code: "SOURCE_NOT_VERIFIED" });
    expect(await verifyNimiqHtlcReturn(input({ config: { ...CONFIG, url: "" } }))).toEqual({ ok: false, code: "NOT_CONFIGURED" });
  });
});
