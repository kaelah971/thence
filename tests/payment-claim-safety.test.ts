import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runHarness, type Scenario } from "../scripts/arbitrum-claim-harness";
import { claimSafetyGuard } from "@/ui/lib/claim-safety";
import { classifyClaim, installClaimFetchObserver, observeClaimNetwork, type ClaimClassification } from "@/ui/lib/claim-evidence";
import { syntheticClaimIntent } from "./payment-crypto-fixture";

const incident = JSON.parse(readFileSync("tests/fixtures/satora-arbitrum-v6-347deeb2.json", "utf8")) as { swap: Record<string, unknown>; dexCalldataFund: Record<string, unknown> };

async function run(chainId: number, scenario: Scenario = "accept", mutate?: (authorization: ReturnType<typeof syntheticClaimIntent>) => void, minimum = "300000", accepted: bigint | null = null) {
  const swap = { ...incident.swap, evm_chain_id: chainId, evm_refund_locktime: Math.floor(Date.now() / 1000) + 3600, target_token: { ...(incident.swap["target_token"] as object), chain: String(chainId), token_id: chainId === 137 ? "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" : "0xaf88d065e77c8cc2239327c5edb3a432268e5831" } };
  let classification: ClaimClassification | null = null;
  const report = await runHarness({
    fixture: { swap, dexCalldataFund: { ...incident.dexCalldataFund, estimated_amount_out: minimum } }, scenario,
    beforeBuild: () => installClaimFetchObserver(),
    runClaim: async (claim, publicSwap) => {
      const authorized = syntheticClaimIntent(publicSwap);
      mutate?.(authorized);
      const result = await observeClaimNetwork(claim, undefined, claimSafetyGuard(authorized, accepted));
      const value = result.ok ? result.value as { success: boolean; txHash: string } : null;
      classification = classifyClaim({ evidence: result.evidence, ...(value ? { sdkSuccess: value.success, sdkTxHash: value.txHash } : { error: result.ok ? undefined : result.error }) });
      if (!result.ok) throw result.error;
      return result.value;
    },
  });
  return { report, classification };
}

describe.each([137, 42161])("installed SDK safety boundary chain %i", (chainId) => {
  it("executes the actual SDK through local relay or UserOperation acceptance", async () => {
    const { report, classification } = await run(chainId);
    expect(report.outcome.ok, JSON.stringify(report.outcome)).toBe(true);
    expect(classification).toMatchObject({ submission: "submitted" });
    expect(report.steps.filter((step) => step.forwarded)).toEqual([]);
    if (chainId === 137) expect(report.checks).toMatchObject({ "relay destination = recipient": true, "relay preimage matches": true, "relay signature fields present": true });
  });
  it.each(["destination", "amount", "coordinator", "claim-key", "deadline"])("refuses %s drift before secret disclosure", async (field) => {
    const { report, classification } = await run(chainId, "accept", (auth) => {
      if (field === "destination") auth.destination = `0x${"77".repeat(20)}`;
      if (field === "amount") auth.htlc.lockAmount = "1";
      if (field === "coordinator") auth.htlc.coordinator = `0x${"77".repeat(20)}`;
      if (field === "claim-key") auth.htlc.claimAddress = `0x${"77".repeat(20)}`;
      if (field === "deadline") auth.claimDeadline = new Date(Date.now() + 30_000).toISOString();
    });
    expect(report.outcome.ok).toBe(false);
    expect(classification).toMatchObject({ submission: "not-submitted", disclosedToInfrastructure: false });
    expect(report.steps.some((step) => /claim-gasless|Paymaster|estimateUserOperation|sendUserOperation/.test(step.name))).toBe(false);
  });
  // Output floor (src/domain/claim-deadline.ts), exercised through the installed SDK.
  // 297000 = 99%: Satora's minAmountOut in every Thence Polygon delivery (automatic).
  // 296150 / 295446 = Satora's f1ca0926 Arbitrum DEX estimates (consent band).
  it.each(["300000", "297000"])("claims automatically at provider floor %s (>= 99 percent)", async (minimum) => {
    const { report, classification } = await run(chainId, "accept", undefined, minimum);
    expect(report.outcome.ok, JSON.stringify(report.outcome)).toBe(true);
    expect(classification).toMatchObject({ submission: "submitted" });
  });
  it.each(["296999", "296150", "295446", "291000"])("refuses floor %s without the payer's acceptance, before revealing the preimage", async (minimum) => {
    const { report, classification } = await run(chainId, "accept", undefined, minimum);
    expect(report.outcome.ok).toBe(false);
    expect(classification).toMatchObject({ submission: "not-submitted", disclosedToInfrastructure: false });
    expect(report.steps.some((step) => /claim-gasless|Paymaster|estimateUserOperation|sendUserOperation/.test(step.name))).toBe(false);
  });
  it.each([["296150", 296150n], ["295446", 295446n], ["291000", 291000n], ["295600", 296150n]] as const)("claims floor %s once the payer accepted %s (0.25 percent re-quote tolerance)", async (minimum, accepted) => {
    const { report, classification } = await run(chainId, "accept", undefined, minimum, accepted);
    expect(report.outcome.ok, JSON.stringify(report.outcome)).toBe(true);
    expect(classification).toMatchObject({ submission: "submitted" });
  });
  it.each([["295000", 296150n], ["290999", 291000n], ["150000", 291000n], ["1", null]] as const)("refuses floor %s even with acceptance %s (drift beyond tolerance, or below 97 percent)", async (minimum, accepted) => {
    const { report, classification } = await run(chainId, "accept", undefined, minimum, accepted);
    expect(report.outcome.ok).toBe(false);
    expect(classification).toMatchObject({ submission: "not-submitted", disclosedToInfrastructure: false });
    expect(report.steps.some((step) => /claim-gasless|Paymaster|estimateUserOperation|sendUserOperation/.test(step.name))).toBe(false);
  });
  it.each(["send-no-answer", "send-rejected"] as const)("retains precise %s evidence", async (scenario) => {
    const { classification } = await run(chainId, scenario);
    expect(classification).toMatchObject({ submission: scenario === "send-no-answer" ? "unknown" : "not-submitted", disclosedToInfrastructure: true });
  });
});
