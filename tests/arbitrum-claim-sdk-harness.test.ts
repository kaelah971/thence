// @vitest-environment node
/**
 * Incident f1ca0926 — tests that run the INSTALLED SDK's real `Client.claim()`
 * (@satora/swap 1.7.2 → @lendasat/lendaswap-sdk-pure 2.7.0) on the incident's
 * real provider response shape, for HTLC v6 (as in the incident) and v7,
 * with Thence's claim observer installed in production order (before the
 * SDK client is built). Throwaway keys and preimages only; every request is
 * answered in-process; nothing reaches any network.
 *
 * Unlike tests/arbitrum-claim-execution.test.ts (which scripts the request
 * sequence by hand), these exercise the SDK's own storage lookup, signing-key
 * selection, DEX-calldata handling, Redeem digest + EIP-712 signature,
 * EIP-7702 Kernel v3.3 account, UserOperation construction, sponsorship and
 * gas-estimation parsing, submission and receipt handling, and its error
 * propagation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runHarness, type Scenario } from "../scripts/arbitrum-claim-harness";
import { classifyClaim, installClaimFetchObserver, observeClaimNetwork, sanitizeClaimError, type ClaimClassification } from "@/ui/lib/claim-evidence";

const V6 = JSON.parse(readFileSync("tests/fixtures/satora-arbitrum-v6-347deeb2.json", "utf8")) as { swap: Record<string, unknown>; dexCalldataFund: Record<string, unknown> };
// v7 variant: same swap shape on the v7 HTLC and its coordinator (both pinned in settlement.ts).
const V7 = { ...V6, swap: { ...V6.swap, evm_htlc_address: "0x6C38bF44A327bf36BfbeFcedc514c0FB3Fec6748", evm_htlc_version: 7, evm_coordinator_address: "0xb79118233552d4b7ed5c8d2d1e2bba7e8eecb71f" } };

async function claimWith(fixture: typeof V6, scenario: Scenario): Promise<{ c: ClaimClassification; report: Awaited<ReturnType<typeof runHarness>>; errorText: string | null }> {
  let c: ClaimClassification | null = null;
  let errorText: string | null = null;
  const report = await runHarness({
    fixture,
    scenario,
    // Production order: install the observer, THEN build the SDK client.
    beforeBuild: () => installClaimFetchObserver(),
    runClaim: async (fn) => {
      const r = await observeClaimNetwork(fn);
      if (r.ok) {
        const v = r.value as { success?: boolean; txHash?: string; message?: string };
        // Same mapping as src/ui/lib/satora-browser.ts claimStoredSwap.
        const success = v.success === true;
        c = classifyClaim({ evidence: r.evidence, sdkSuccess: success, sdkTxHash: v.txHash ?? null, ...(success ? {} : { error: new Error(String(v.message ?? "")) }) });
        return r.value;
      }
      c = classifyClaim({ evidence: r.evidence, error: r.error });
      errorText = sanitizeClaimError(r.error);
      throw r.error;
    },
  });
  if (!c) throw new Error("claim was never classified");
  return { c, report, errorText };
}

describe.each([
  ["v6 (incident)", V6],
  ["v7", V7],
] as const)("installed SDK claim path — HTLC %s", (_label, fixture) => {
  it("builds a correct sponsored EIP-7702 UserOperation and classifies it CONFIRMED with hashes", async () => {
    const { c, report } = await claimWith(fixture, "accept");
    expect(c).toMatchObject({ submission: "submitted", code: "CONFIRMED", userOpHash: `0x${"ab".repeat(32)}`, txHash: `0x${"cd".repeat(32)}`, disclosedToInfrastructure: true });
    // The SDK's own steps, observed through the production observer (including
    // the Satora calls made by the API client that captured fetch at build).
    const steps = report.steps.map((s) => s.name);
    expect(steps.slice(0, 2)).toEqual(["GET /swap/:id", "POST /dex-calldata/fund"]);
    expect(steps).toEqual(expect.arrayContaining(["pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData", "eth_sendUserOperation", "eth_getUserOperationReceipt"]));
    expect(report.checks).toMatchObject({
      "sender = claim EOA (EIP-7702)": true,
      "eip7702Auth present": true,
      "eip7702Auth.chainId": "0xa4b1",
      "eip7702Auth.address (Kernel impl)": "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28",
      "callData targets coordinator": true,
      "Redeem signature recovers to claim EOA": true,
      "redeem amount = evm_expected_sats": true,
      "redeem token = locked token": true,
      "redeem sender = HTLC refund party": true,
      "redeem timelock = evm_refund_locktime": true,
      "destination = recipient": true,
      "sweepToken = target token": true,
    });
    expect(c.stage).toBe("eth_getUserOperationReceipt");
    expect(c.failure).toBeNull();
  });

  it.each([
    ["missing-recovery", "not-submitted", "RECOVERY_MATERIAL_MISSING", false, null],
    ["dex-fail", "not-submitted", "DEX_CALLDATA_FAILED", false, "satora:POST /dex-calldata/fund"],
    ["bundler-down", "not-submitted", "AA_UNREACHABLE", false, "eth_getCode"],
    ["sponsor-reject", "not-submitted", "AA_SPONSORSHIP_REJECTED", true, "pm_getPaymasterStubData"],
    ["sponsor-data-reject", "not-submitted", "AA_SPONSORSHIP_REJECTED", true, "pm_getPaymasterData"],
    ["estimate-revert", "not-submitted", "AA_ESTIMATE_FAILED", true, "eth_estimateUserOperationGas"],
    ["rate-limited", "not-submitted", "RATE_LIMITED", true, "eth_estimateUserOperationGas"],
    ["send-rejected", "not-submitted", "SEND_REJECTED", true, "eth_sendUserOperation"],
    ["send-no-answer", "unknown", "SEND_NO_ANSWER", true, "eth_sendUserOperation"],
    ["receipt-reverted", "submitted", "USEROP_REVERTED", true, null],
  ] as const)("%s → %s / %s (classified by the failing request, not the error text)", async (scenario, submission, code, disclosed, failingStep) => {
    const { c, errorText } = await claimWith(fixture, scenario);
    expect(c.submission).toBe(submission);
    expect(c.code).toBe(code);
    expect(c.disclosedToInfrastructure).toBe(disclosed);
    if (failingStep) expect(c.failure?.step).toBe(failingStep);
    // The SDK's errors embed the request body (claim calldata incl. the
    // preimage): the forwarded text must never carry it.
    if (errorText) {
      expect(errorText).not.toMatch(/[0-9a-fA-F]{40,}/);
      expect(errorText.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("observer placement (f1ca0926 instrumentation defect)", () => {
  it("an observer installed only AROUND claim() misses the SDK's Satora calls; the production order sees them", async () => {
    let late: ClaimClassification | null = null;
    // Late order: build first (the API client captures the plain fetch), observe after.
    await runHarness({
      fixture: V6,
      scenario: "dex-fail",
      runClaim: async (fn) => {
        const r = await observeClaimNetwork(fn);
        late = r.ok ? null : classifyClaim({ evidence: r.evidence, error: r.error });
        if (!r.ok) throw r.error;
        return r.value;
      },
    });
    const { c: early } = await claimWith(V6, "dex-fail");
    expect(late).not.toBeNull();
    // Without the build-time observer the DEX failure is invisible (no Satora step recorded).
    expect((late as unknown as ClaimClassification).failure).toBeNull();
    expect(early.failure).toMatchObject({ step: "satora:POST /dex-calldata/fund", kind: "http", httpStatus: 500 });
  });
});
