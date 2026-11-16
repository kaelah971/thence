/**
 * Incident f1ca0926 (2026-11-16) — Arbitrum claim EXECUTION, not just funding.
 *
 * The second live Arbitrum payment passed every funding gate, the server
 * authorized the claim, and the browser claim then failed without any
 * UserOperation, transaction or provider claim. The UI still said
 * "Delivery submitted — verifying on Arbitrum" (and "Polygon" in Activity).
 *
 * Covered here, for both pinned Arbitrum HTLC versions (v6 + coordinator v4,
 * v7 + coordinator v5):
 * - fail closed: no new Arbitrum payment while the claim path is unproven;
 *   owner canary opt-in is explicit and malformed values never open it;
 * - the AA infrastructure Thence pins is the installed SDK's own default;
 * - non-financial AA preflight outcomes;
 * - claim outcome classification from observed network evidence:
 *   valid sponsored claim, missing AA config, rejected sponsorship, bundler
 *   timeout, submission uncertainty, explicit refusal, receipt timeout,
 *   reverted UserOperation, Polygon relay accept/refuse;
 * - owner wording: "Delivery submitted" only with evidence; network names;
 * - finality wait survives transient refusals; refund wording per network;
 * - claim-report validation and redaction.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAIM_PATHS, canaryClaimPaths, isChainClaimExecutable, isClaimPathExecutable, isNetworkClaimExecutable } from "@/lib/claim-execution";
import { htlcPreflight } from "@/lib/htlc-preflight";
import type { VerifiedSwapFacts } from "@/lib/satora";
import { ARBITRUM_AA, ENTRY_POINT_V07, arbitrumAaPreflight } from "@/ui/lib/arbitrum-aa";
import { classifyClaim, notSubmittedMessage, observeClaimNetwork, sanitizeClaimError } from "@/ui/lib/claim-evidence";
import { paymentProgress, verifyingHeadline } from "@/ui/lib/payment-progress";
import { timelineFor } from "@/ui/lib/status";
import { nextFundingRetry, claimSubmissionOf, type ClaimRecord } from "@/ui/screens/send/useSettlement";
import { claimReportSchema, redactClaimText } from "@/lib/claim-report";

const V6 = { htlc: "0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948", coordinator: "0xdb76f29f1d04d1202f56a34549869b070dfcbff0", version: 6 } as const;
const V7 = { htlc: "0x6c38bf44a327bf36bfbefcedc514c0fb3fec6748", coordinator: "0xb79118233552d4b7ed5c8d2d1e2bba7e8eecb71f", version: 7 } as const;
const DEADLINE = 1_794_855_301;

function facts(v: typeof V6 | typeof V7, chainId = 42161): VerifiedSwapFacts {
  return {
    satoraSwapId: "347deeb2-e5ec-42ed-a846-d835b1a4eea1",
    direction: "lightning_to_evm",
    bolt11Invoice: "lnbc1fixture",
    paymentHash: `0x${"81".repeat(32)}`,
    sourceSats: "473",
    targetAtomic: "300000",
    evmChainId: chainId,
    targetAddress: "0x15451254A70e5bD6FEcA12447c42DCc9B26f3947",
    targetTokenAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    targetTokenChainId: chainId,
    status: "pending",
    invoiceExpiresAt: new Date((DEADLINE + 1800) * 1000),
    feeSats: 9,
    evmHtlcAddress: v.htlc,
    evmFundTxid: null,
    evmClaimTxid: null,
    evmHtlcTokenAddress: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
    evmHtlcAmountAtomic: "4640216898491",
    evmHtlcRefundAddress: "0x5ce278AAec6d9fa67bFcaF98512fE5175dFEebac",
    evmHtlcClaimAddress: "0xaE3Dd68638C7326Ad3fD2C4c9201b6437f4DfCe7",
    evmHtlcVersion: v.version,
    evmHtlcKind: "erc20",
    evmCoordinatorAddress: v.coordinator,
    evmRefundLocktime: DEADLINE,
  };
}
const EARLY = { nowMs: (DEADLINE - 3600) * 1000 };

describe("fail closed: Arbitrum claim paths are unproven (f1ca0926)", () => {
  it("records Polygon v6 as proven and both Arbitrum versions as unproven sponsored-UserOp paths", () => {
    expect(CLAIM_PATHS["137:6"]).toMatchObject({ proven: true, mechanism: "satora-gasless-relay" });
    expect(CLAIM_PATHS["42161:6"]).toMatchObject({ proven: false, mechanism: "sponsored-userop-7702" });
    expect(CLAIM_PATHS["42161:7"]).toMatchObject({ proven: false, mechanism: "sponsored-userop-7702" });
  });

  it.each([V6, V7])("refuses a new Arbitrum v$version payment before NIM is committed", (v) => {
    const none = new Set<string>();
    expect(htlcPreflight(facts(v), { ...EARLY, claimCanary: none })).toMatchObject({ ok: false, code: "CLAIM_PATH_UNPROVEN" });
    expect(isClaimPathExecutable(42161, v.version, none)).toBe(false);
  });

  it("closes the Arbitrum network for new payments and keeps Polygon open", () => {
    const none = new Set<string>();
    expect(isChainClaimExecutable(42161, none)).toBe(false);
    expect(isNetworkClaimExecutable("Arbitrum", none)).toBe(false);
    expect(isNetworkClaimExecutable("Polygon", none)).toBe(true);
    expect(isNetworkClaimExecutable("Lightning", none)).toBe(true); // non-EVM: not this gate
  });

  it("opens only the exact canary path the owner names; malformed or unknown entries never open anything", () => {
    expect(canaryClaimPaths("42161:7")).toEqual(new Set(["42161:7"]));
    expect(isClaimPathExecutable(42161, 7, canaryClaimPaths("42161:7"))).toBe(true);
    expect(isClaimPathExecutable(42161, 6, canaryClaimPaths("42161:7"))).toBe(false);
    for (const raw of ["", "42161", "42161:*", "all", "42161:8", " ; drop", "1:1"]) {
      expect(canaryClaimPaths(raw).size, raw).toBe(0);
    }
    expect(isClaimPathExecutable(42161, null, canaryClaimPaths("42161:6,42161:7"))).toBe(false);
  });

  it("reads the canary from the environment (default: closed)", () => {
    const prev = process.env.THENCE_CLAIM_EXECUTION_CANARY;
    try {
      delete process.env.THENCE_CLAIM_EXECUTION_CANARY;
      expect(htlcPreflight(facts(V6), EARLY)).toMatchObject({ ok: false, code: "CLAIM_PATH_UNPROVEN" });
      process.env.THENCE_CLAIM_EXECUTION_CANARY = "42161:6";
      expect(htlcPreflight(facts(V6), EARLY)).toMatchObject({ ok: true });
      expect(htlcPreflight(facts(V7), EARLY)).toMatchObject({ ok: false, code: "CLAIM_PATH_UNPROVEN" });
    } finally {
      if (prev === undefined) delete process.env.THENCE_CLAIM_EXECUTION_CANARY;
      else process.env.THENCE_CLAIM_EXECUTION_CANARY = prev;
    }
  });
});

describe("AA infrastructure pinned to the installed SDK", () => {
  const require = createRequire(import.meta.url);
  const sdkDir = dirname(require.resolve("@lendasat/lendaswap-sdk-pure"));
  const chunks = (name: RegExp) =>
    (require("node:fs") as typeof import("node:fs")).readdirSync(sdkDir).filter((f: string) => name.test(f)).map((f: string) => readFileSync(join(sdkDir, f), "utf8")).join("\n");
  const all = chunks(/\.js$/);

  it("bundler URL and gas policy equal the SDK's own defaults (drift on an SDK upgrade fails here)", () => {
    expect(all).toContain(`DEFAULT_AA_BUNDLER_URL = "${ARBITRUM_AA.bundlerUrl}"`);
    expect(all).toContain(`DEFAULT_AA_POLICY_ID = "${ARBITRUM_AA.paymasterPolicyId}"`);
  });

  it("the SDK claims Arbitrum DEX swaps only via a sponsored UserOperation on EntryPoint v0.7 with Kernel v3.3 (EIP-7702)", () => {
    expect(all).toMatch(/Claiming an Arbitrum EVM DEX\/CCTP swap requires AA config/);
    expect(all).toMatch(/getEntryPoint\("0\.7"\)/);
    expect(all).toMatch(/eip7702Account: kernelOwner/);
    expect(all).toMatch(/kernelVersion: KERNEL_V3_3/);
    expect(all).toContain(ENTRY_POINT_V07);
  });
});

describe("non-financial AA preflight", () => {
  type Reply = Record<string, unknown> | null;
  const fake = (replies: Record<string, Reply>) =>
    vi.fn(async (_url: string, init: { body: string }) => {
      const method = (JSON.parse(init.body) as { method: string }).method;
      const reply = replies[method];
      if (reply === undefined) throw new Error("unreachable");
      return { ok: reply !== null, json: async () => reply };
    });
  const healthy = {
    eth_chainId: { result: "0xa4b1" },
    eth_supportedEntryPoints: { result: [ENTRY_POINT_V07] },
    pm_getPaymasterStubData: { result: { paymaster: "0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633", paymasterData: "0x" } },
  };

  it("passes when the bundler is on Arbitrum, supports EntryPoint v0.7 and the policy returns sponsorship stub data", async () => {
    const f = fake(healthy);
    await expect(arbitrumAaPreflight(f as never)).resolves.toMatchObject({ ok: true, code: "AA_OK" });
    // Only read/stub methods — never a signature, calldata or a send.
    const methods = f.mock.calls.map((c) => (JSON.parse(c[1].body) as { method: string }).method);
    expect(methods).toEqual(["eth_chainId", "eth_supportedEntryPoints", "pm_getPaymasterStubData"]);
  });

  it.each([
    ["unreachable", { ...healthy, eth_chainId: undefined as unknown as Reply }, "AA_UNREACHABLE"],
    ["wrong chain", { ...healthy, eth_chainId: { result: "0x89" } }, "AA_WRONG_CHAIN"],
    ["EntryPoint unsupported", { ...healthy, eth_supportedEntryPoints: { result: ["0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"] } }, "AA_ENTRYPOINT_UNSUPPORTED"],
    ["sponsorship rejected", { ...healthy, pm_getPaymasterStubData: { error: { code: -32602, message: "policy not active" } } }, "AA_SPONSORSHIP_UNAVAILABLE"],
  ])("fails closed when %s", async (_label, replies, code) => {
    const clean = Object.fromEntries(Object.entries(replies).filter(([, v]) => v !== undefined)) as Record<string, Reply>;
    await expect(arbitrumAaPreflight(fake(clean) as never)).resolves.toMatchObject({ ok: false, code });
  });
});

// ---- scripted claim flows (the SDK's real request sequence) ----
const USEROP_HASH = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const PREIMAGE = `0x${"9f".repeat(32)}`;
type Scope = { fetch: (input: unknown, init?: { method?: string; body?: unknown }) => Promise<Response> };

function rpcResponse(id: unknown, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { status: 200, headers: { "content-type": "application/json" } });
}
/** A bundler that answers each method from `script` (a thrown Error = no answer). */
function bundler(script: Record<string, Record<string, unknown> | Error>): Scope {
  return {
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
      const step = script[body.method];
      if (step instanceof Error) throw step;
      return rpcResponse(body.id, step ?? { result: null });
    },
  };
}
/** Mimics claimViaUserOp: estimate → sponsor → send → wait for receipt (calldata carries the preimage). */
async function sdkUserOpClaim(scope: Scope, v: typeof V6 | typeof V7): Promise<{ success: true; txHash: string; message: string }> {
  const call = async (method: string, params: unknown[]) => {
    const res = await scope.fetch(ARBITRUM_AA.bundlerUrl, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) });
    const j = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method} failed: ${j.error.message}`);
    return j.result;
  };
  const op = { sender: facts(v).evmHtlcClaimAddress, callData: `0xee2837cf${PREIMAGE.slice(2)}${v.coordinator.slice(2)}` };
  await call("eth_estimateUserOperationGas", [op, ENTRY_POINT_V07]);
  await call("pm_getPaymasterData", [op, ENTRY_POINT_V07, "0xa4b1", { policyId: ARBITRUM_AA.paymasterPolicyId }]);
  const hash = (await call("eth_sendUserOperation", [op, ENTRY_POINT_V07])) as string;
  const receipt = (await call("eth_getUserOperationReceipt", [hash])) as { success: boolean; receipt: { transactionHash: string } } | null;
  if (!receipt) throw new Error("WaitForUserOperationReceiptTimeoutError: Timed out while waiting for User Operation with hash");
  if (!receipt.success) throw new Error(`redeemAndExecute UserOp ${hash} reverted on-chain (tx ${receipt.receipt.transactionHash})`);
  return { success: true, txHash: receipt.receipt.transactionHash, message: "redeemAndExecute published via sponsored UserOp" };
}

describe.each([V6, V7])("Arbitrum v$version claim outcome classification", (v) => {
  const ok = { result: {} };
  const run = async (scope: Scope, fn: () => Promise<{ success: true; txHash: string; message: string }>) => {
    const r = await observeClaimNetwork(fn, scope as never);
    return r.ok ? classifyClaim({ evidence: r.evidence, sdkSuccess: r.value.success, sdkTxHash: r.value.txHash }) : classifyClaim({ evidence: r.evidence, error: r.error });
  };

  it("valid sponsored claim: submitted and confirmed with UserOperation and transaction hashes", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: ok, pm_getPaymasterData: ok, eth_sendUserOperation: { result: USEROP_HASH }, eth_getUserOperationReceipt: { result: { success: true, receipt: { transactionHash: TX_HASH } } } });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "submitted", code: "CONFIRMED", disclosedToInfrastructure: true, userOpHash: USEROP_HASH, txHash: TX_HASH, failure: null });
  });

  it("missing AA config: refused before any request — NOT submitted, nothing disclosed", async () => {
    const scope = bundler({});
    const c = await run(scope, async () => {
      throw new Error("Claiming an Arbitrum EVM DEX/CCTP swap requires AA config for the sponsored UserOp. Call `.withAa({ bundlerUrl, paymasterPolicyId })`");
    });
    expect(c).toMatchObject({ submission: "not-submitted", code: "AA_CONFIG_MISSING", disclosedToInfrastructure: false, userOpHash: null });
  });

  it("rejected sponsorship: NOT submitted, but the calldata reached the AA provider (disclosed)", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: ok, pm_getPaymasterData: { error: { code: -32500, message: "Gas Manager policy rejected the operation" } } });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "not-submitted", code: "AA_SPONSORSHIP_REJECTED", disclosedToInfrastructure: true });
  });

  it("bundler timeout before submission: NOT submitted", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: new TypeError("Failed to fetch") });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "not-submitted", code: "AA_UNREACHABLE" });
  });

  it("submission uncertainty: eth_sendUserOperation sent, no answer — UNKNOWN, never 'not sent'", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: ok, pm_getPaymasterData: ok, eth_sendUserOperation: new TypeError("Failed to fetch") });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "unknown", code: "SEND_NO_ANSWER", userOpHash: null });
  });

  it("explicit bundler refusal of the send: NOT submitted", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: ok, pm_getPaymasterData: ok, eth_sendUserOperation: { error: { code: -32602, message: "AA21 didn't pay prefund" } } });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "not-submitted", code: "SEND_REJECTED" });
  });

  it("accepted, then the receipt wait times out: SUBMITTED (the chain decides), hash kept", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: ok, pm_getPaymasterData: ok, eth_sendUserOperation: { result: USEROP_HASH }, eth_getUserOperationReceipt: { result: null } });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "submitted", code: "RECEIPT_TIMEOUT", userOpHash: USEROP_HASH });
  });

  it("included but reverted: SUBMITTED with USEROP_REVERTED (published on-chain; never offered as 'not sent')", async () => {
    const scope = bundler({ eth_estimateUserOperationGas: ok, pm_getPaymasterData: ok, eth_sendUserOperation: { result: USEROP_HASH }, eth_getUserOperationReceipt: { result: { success: false, receipt: { transactionHash: TX_HASH } } } });
    expect(await run(scope, () => sdkUserOpClaim(scope, v))).toMatchObject({ submission: "submitted", code: "USEROP_REVERTED", userOpHash: USEROP_HASH, txHash: TX_HASH });
  });

  it("restores the original fetch even when the claim throws", async () => {
    const scope = bundler({});
    const original = scope.fetch;
    await observeClaimNetwork(async () => { throw new Error("boom"); }, scope as never);
    expect(scope.fetch).toBe(original);
  });
});

describe("Polygon gasless relay classification", () => {
  const relay = (status: number, body: Record<string, unknown>): Scope => ({ fetch: async () => new Response(JSON.stringify(body), { status }) });
  const post = (scope: Scope) => scope.fetch("https://api.satora.io/swap/s1/claim-gasless", { method: "POST", body: JSON.stringify({ secret: PREIMAGE }) });
  it("2xx = submitted (tx hash kept)", async () => {
    const scope = relay(200, { id: "s1", status: "clientredeeming", tx_hash: TX_HASH });
    const r = await observeClaimNetwork(async () => { await post(scope); return { success: true, txHash: TX_HASH, message: "" }; }, scope as never);
    expect(r.ok && classifyClaim({ evidence: r.evidence, sdkSuccess: true, sdkTxHash: TX_HASH })).toMatchObject({ submission: "submitted", txHash: TX_HASH });
  });
  it("4xx = explicitly refused = NOT submitted", async () => {
    const scope = relay(400, { error: "bad signature" });
    const r = await observeClaimNetwork(async () => { await post(scope); throw new Error("Gasless claim failed (400): bad signature"); }, scope as never);
    expect(!r.ok && classifyClaim({ evidence: r.evidence, error: r.error })).toMatchObject({ submission: "not-submitted", code: "SEND_REJECTED" });
  });
  it("5xx = may have been accepted = UNKNOWN", async () => {
    const scope = relay(502, {});
    const r = await observeClaimNetwork(async () => { await post(scope); throw new Error("Gasless claim failed (502)"); }, scope as never);
    expect(!r.ok && classifyClaim({ evidence: r.evidence, error: r.error })).toMatchObject({ submission: "unknown" });
  });
});

describe("secret-free reporting", () => {
  it("redacts calldata, signatures and preimages from error text, client and server side", () => {
    const msg = `UserOperation reverted: callData ${PREIMAGE}${"00".repeat(40)} sig 0x${"1b".repeat(65)}`;
    for (const out of [sanitizeClaimError(new Error(msg)), redactClaimText(msg) ?? ""]) {
      expect(out).not.toMatch(/9f9f9f9f|1b1b1b1b/);
      expect(out.length).toBeLessThanOrEqual(160);
    }
  });
  it("the report schema accepts only codes, booleans and public hashes", () => {
    const good = { submission: "not-submitted", code: "AA_SPONSORSHIP_REJECTED", disclosedToInfrastructure: true, userOpHash: null, txHash: null, errorText: "policy rejected" };
    expect(claimReportSchema.safeParse(good).success).toBe(true);
    expect(claimReportSchema.safeParse({ ...good, preimage: PREIMAGE }).success).toBe(false);
    expect(claimReportSchema.safeParse({ ...good, code: "lower case" }).success).toBe(false);
    expect(claimReportSchema.safeParse({ ...good, userOpHash: "0x1234" }).success).toBe(false);
  });
  it("the owner message for an unsent claim is honest about disclosure and refund", () => {
    const m = notSubmittedMessage("AA_SPONSORSHIP_REJECTED", "Arbitrum", true);
    expect(m).toMatch(/^Delivery wasn't sent/);
    expect(m).toMatch(/Nothing reached Arbitrum/);
    expect(m).toMatch(/shared with the Arbitrum delivery service/);
    expect(m).not.toMatch(/Polygon|submitted —/);
  });
});

describe("owner wording: 'Delivery submitted' only with submission evidence", () => {
  const base = { phase: "finishing", transferStatus: "CLAIMING", providerStatus: "serverfunded", claimReady: false, receiptReady: false, network: "Arbitrum" as const };

  it("f1ca0926 state (authorized, nothing sent) says it wasn't sent and keeps Finish delivery not-done", () => {
    const v = paymentProgress({ ...base, phase: "attention", claimSubmission: "not-submitted", message: notSubmittedMessage("SDK_ERROR", "Arbitrum", false) });
    expect(v.headline).toBe("Delivery wasn't sent");
    expect(JSON.stringify(v)).not.toMatch(/Delivery submitted|Polygon/);
    expect(v.steps?.find((s) => s.key === "finish")).toMatchObject({ state: "current", detail: "Not sent — nothing reached Arbitrum." });
  });

  it("CLAIMING with no local evidence (other device / unknown) never claims a submission", () => {
    for (const claimSubmission of [null, "unknown"] as const) {
      const v = paymentProgress({ ...base, claimSubmission });
      expect(v.headline).toBe("Checking whether delivery reached Arbitrum");
      expect(JSON.stringify(v)).not.toMatch(/Delivery submitted|Polygon/);
    }
  });

  it("with a submission hash (or the provider reporting the claim) it says submitted, on Arbitrum", () => {
    expect(paymentProgress({ ...base, claimPending: true, claimSubmission: "submitted" }).headline).toBe(verifyingHeadline("Arbitrum"));
    expect(paymentProgress({ ...base, providerStatus: "clientredeemed" }).headline).toBe("Delivery submitted — verifying on Arbitrum");
  });

  it("Activity's timeline names the payment's own network (was always Polygon)", () => {
    const steps = timelineFor("CLAIMING", { network: "Arbitrum" });
    expect(JSON.stringify(steps)).not.toMatch(/Polygon/);
    expect(steps.find((s) => s.key === "verify")?.label).toBe("Checking Arbitrum");
  });

  it("refund wording names Arbitrum", () => {
    expect(paymentProgress({ ...base, phase: "refunded", transferStatus: "REFUNDED" }).headline).toBe("Not delivered — Arbitrum lock refunded");
  });

  it("local claim records map to evidence", () => {
    const r = (o: Partial<ClaimRecord>): ClaimRecord => ({ transferId: "t", ownerUserId: "u", satoraSwapId: "s", txHash: null, unknownAt: null, verifyCompletedSinceClaim: false, ...o });
    expect(claimSubmissionOf(null)).toBeNull();
    expect(claimSubmissionOf(r({ notSubmittedAt: "x" }))).toBe("not-submitted");
    expect(claimSubmissionOf(r({ unknownAt: "x" }))).toBe("unknown");
    expect(claimSubmissionOf(r({ submittedAt: "x", userOpHash: USEROP_HASH }))).toBe("submitted");
  });
});

describe("finality wait survives transient refusals", () => {
  const t0 = 1_000_000;
  it("a transient provider/chain refusal during an Arbitrum finality wait keeps waiting (17:56Z/17:57Z case)", () => {
    for (const code of ["PROVIDER_UNAVAILABLE", "CHAIN_UNAVAILABLE", "RATE_LIMITED", "AA_UNREACHABLE"]) {
      expect(nextFundingRetry({ code, startedAtMs: t0, nowMs: t0 + 60_000, active: true, finality: "l1", waitingForFunding: true }), code).toEqual({ retry: true, delayMs: 30_000 });
    }
  });
  it("but not before any funding wait began, not for real refusals, and not past the budget", () => {
    expect(nextFundingRetry({ code: "PROVIDER_UNAVAILABLE", startedAtMs: t0, nowMs: t0, active: true, finality: "l1", waitingForFunding: false })).toEqual({ retry: false });
    for (const code of ["DEADLINE_TOO_CLOSE", "SWAP_MISMATCH", "CLAIM_IN_PROGRESS", "HTLC_NOT_ACTIVE"]) {
      expect(nextFundingRetry({ code, startedAtMs: t0, nowMs: t0, active: true, finality: "l1", waitingForFunding: true }), code).toEqual({ retry: false });
    }
    expect(nextFundingRetry({ code: "PROVIDER_UNAVAILABLE", startedAtMs: t0, nowMs: t0 + 45 * 60_000, active: true, finality: "l1", waitingForFunding: true })).toEqual({ retry: false });
  });
});

afterEach(() => vi.restoreAllMocks());
