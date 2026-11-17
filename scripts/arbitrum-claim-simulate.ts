/**
 * Non-financial simulation of the Arbitrum claim the INSTALLED SDK builds,
 * using throwaway secrets (see arbitrum-claim-harness.ts). Nothing is sent:
 * no eth_sendUserOperation, no transaction, no real preimage.
 *
 * A. eth_call coordinator.redeemAndExecute on the public Arbitrum RPC, with a
 *    state override marking the throwaway swap key ACTIVE in the HTLC
 *    (swapState mapping, slot 2). Proves redeem signature/digest, HTLC
 *    redemption, the Uniswap leg and the minAmountOut sweep at the current
 *    chain state.
 * B. (--bundler) Alchemy pm_getPaymasterStubData + eth_estimateUserOperationGas
 *    with the same override: proves the bundler accepts the EIP-7702 Kernel
 *    v3.3 operation shape, validation and execution gas. Throwaway data only.
 *
 * Usage: npx tsx scripts/arbitrum-claim-simulate.ts --fixture <json> [--bundler]
 */
import { readFileSync } from "node:fs";
import { createPublicClient, encodeAbiParameters, http, keccak256, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import { runHarness } from "./arbitrum-claim-harness";
import { computeHtlcSwapKey } from "../src/lib/settlement";
import { ARBITRUM_AA, ENTRY_POINT_V07 } from "../src/ui/lib/arbitrum-aa";

const PUBLIC_RPC = "https://arb1.arbitrum.io/rpc";
const SWAP_STATE_SLOT = 2n;

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code?: number; message?: string; data?: unknown } }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  return (await r.json()) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
}

async function main(): Promise<void> {
  const fixture = JSON.parse(readFileSync(arg("--fixture") ?? "", "utf8")) as { swap: Record<string, unknown>; dexCalldataFund: Record<string, unknown> };
  const report = await runHarness({ fixture, liveReads: true });
  if (!report.estimateOp) throw new Error(`the SDK never reached gas estimation: ${JSON.stringify(report.outcome)}`);
  const op = report.estimateOp;
  const s = report.sim.swap;
  const key = computeHtlcSwapKey({
    hashLock: `0x${report.sim.preimageHash}`,
    amount: BigInt(String(s["evm_expected_sats"])),
    token: String(s["wbtc_address"]),
    refundAddress: String(s["server_evm_address"]),
    claimAddress: report.sim.claimAddress,
    timelock: BigInt(String(s["evm_refund_locktime"])),
  }) as Hex;
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, SWAP_STATE_SLOT]));
  const htlc = String(s["evm_htlc_address"]) as Hex;
  const override = { [htlc]: { stateDiff: { [slot]: `0x${"0".repeat(63)}1` } } };
  const callData = String(op["callData"]).toLowerCase();
  const at = callData.indexOf("ee2837cf");
  const inner = `0x${callData.slice(at)}` as Hex;

  // A — inner execution at current chain state.
  const arb = createPublicClient({ chain: arbitrum, transport: http(PUBLIC_RPC) });
  const block = await arb.getBlock();
  const a = await rpc(PUBLIC_RPC, "eth_call", [{ from: report.sim.claimAddress, to: String(s["evm_coordinator_address"]), data: inner }, "latest", override]);
  console.log(`A. redeemAndExecute eth_call @${block.number} (${new Date(Number(block.timestamp) * 1000).toISOString()}):`, a.error ? `REVERT ${a.error.message ?? ""} ${typeof a.error.data === "string" ? a.error.data.slice(0, 74) : ""}` : `OK ${String(a.result).slice(0, 66)}`);
  const noOverride = await rpc(PUBLIC_RPC, "eth_call", [{ from: report.sim.claimAddress, to: String(s["evm_coordinator_address"]), data: inner }, "latest"]);
  console.log("   control without the ACTIVE override:", noOverride.error ? `REVERT (expected) ${noOverride.error.message ?? ""}` : "OK (unexpected)");

  if (!process.argv.includes("--bundler")) return;
  // B — the bundler's own view of the exact operation shape (throwaway data, never sent).
  const base = { ...op };
  const stub = await rpc(ARBITRUM_AA.bundlerUrl, "pm_getPaymasterStubData", [base, ENTRY_POINT_V07, "0xa4b1", { policyId: ARBITRUM_AA.paymasterPolicyId }]);
  console.log("B1. pm_getPaymasterStubData:", stub.error ? `ERROR ${stub.error.code} ${stub.error.message}` : `OK paymaster=${(stub.result as { paymaster?: string }).paymaster}`);
  const withStub = { ...base, ...(stub.result as Record<string, unknown> | undefined) };
  delete (withStub as Record<string, unknown>)["isFinal"];
  delete (withStub as Record<string, unknown>)["sponsor"];
  const est = await rpc(ARBITRUM_AA.bundlerUrl, "eth_estimateUserOperationGas", [withStub, ENTRY_POINT_V07, override]);
  console.log("B2. eth_estimateUserOperationGas (+override):", est.error ? `ERROR ${est.error.code} ${est.error.message}` : `OK ${JSON.stringify(est.result)}`);
  const estNo = await rpc(ARBITRUM_AA.bundlerUrl, "eth_estimateUserOperationGas", [withStub, ENTRY_POINT_V07]);
  console.log("    control without override:", estNo.error ? `ERROR ${estNo.error.code} ${(estNo.error.message ?? "").slice(0, 160)}` : "OK (unexpected)");
}

main().then(() => process.exit(0), (e) => { console.error("simulate failed:", e instanceof Error ? e.message.replace(/0x[0-9a-fA-F]{40,}/g, "0x…").slice(0, 400) : e); process.exit(1); });
