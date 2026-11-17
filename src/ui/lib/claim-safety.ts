import type { ClaimIntentView } from "@/ui/lib/settlement-client";
import type { ClaimNetworkGuard } from "@/ui/lib/claim-evidence";
import { CLAIM_UNSAFE_WINDOW_MS, requiredClaimMinimum } from "@/domain/claim-deadline";
import { decodeFunctionData, parseAbi, sha256, sliceHex, type Hex } from "viem";

const KERNEL_EXECUTE = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);
const REDEEM = parseAbi(["function redeemAndExecute(bytes32 preimage,uint256 amount,address token,address sender,uint256 timelock,(address target,uint256 value,bytes data)[] calls,address sweepToken,uint256 minAmountOut,address destination,uint8 v,bytes32 r,bytes32 s)"]);

/**
 * acceptedMinimumAtomic: the minimum the payer explicitly accepted in the app
 * (consent band, see claim-deadline.ts). Absent = the automatic 99% floor.
 */
export function claimSafetyGuard(authorized: ClaimIntentView, acceptedMinimumAtomic?: bigint | null): ClaimNetworkGuard {
  const floor = requiredClaimMinimum(BigInt(authorized.targetAmountAtomic), acceptedMinimumAtomic);
  let swapChecked = false;
  let calldataChecked = false;
  const refuse = (): never => { throw new Error("Claim safety validation failed. No claim secret was sent."); };
  const equal = (actual: unknown, expected: string | number): boolean => typeof actual === "string" || typeof actual === "number" ? String(actual).toLowerCase() === String(expected).toLowerCase() : false;
  const safeWindow = () => {
    if (!Number.isFinite(Date.parse(authorized.claimDeadline)) || Date.parse(authorized.claimDeadline) - Date.now() <= CLAIM_UNSAFE_WINDOW_MS) refuse();
  };
  const pathOf = (url: string) => {
    try { return new URL(url).pathname; } catch { return ""; }
  };
  const disclosureMethods = new Set(["eth_estimateUserOperationGas", "pm_getPaymasterStubData", "pm_getPaymasterData", "alchemy_requestGasAndPaymasterAndData", "eth_sendUserOperation"]);
  const checkPreimage = (value: unknown) => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || sha256(value as Hex).toLowerCase() !== authorized.paymentHash.toLowerCase()) refuse();
  };
  const checkOperation = (operation: { sender?: unknown; callData?: unknown } | undefined) => {
    if (!operation || !equal(operation.sender, authorized.htlc.claimAddress) || typeof operation.callData !== "string") refuse();
    try {
      const { args: [mode, execution] } = decodeFunctionData({ abi: KERNEL_EXECUTE, data: operation!.callData as Hex });
      if (BigInt(mode) !== 0n || !equal(sliceHex(execution, 0, 20), authorized.htlc.coordinator) || BigInt(sliceHex(execution, 20, 52)) !== 0n) refuse();
      const { args } = decodeFunctionData({ abi: REDEEM, data: sliceHex(execution, 52) });
      const [preimage, amount, token, sender, timelock, , sweepToken, minimum, destination] = args;
      checkPreimage(preimage);
      if (amount !== BigInt(authorized.htlc.lockAmount) || !equal(token, authorized.htlc.lockToken) || !equal(sender, authorized.htlc.refundAddress) || timelock !== BigInt(Date.parse(authorized.claimDeadline) / 1000) || !equal(sweepToken, authorized.htlc.targetToken) || minimum < floor || !equal(destination, authorized.destination)) refuse();
    } catch { refuse(); }
  };
  return {
    beforeRequest(url, method, body) {
      let disclosure = method === "POST" && pathOf(url).endsWith("/claim-gasless");
      if (body) {
        try {
          const parsed = JSON.parse(body);
          disclosure ||= (Array.isArray(parsed) ? parsed : [parsed]).some((entry: { method?: string } | null) => entry && disclosureMethods.has(entry.method ?? ""));
          if (method === "POST" && pathOf(url).endsWith("/claim-gasless")) {
            if (!equal(parsed.destination, authorized.destination)) refuse();
            checkPreimage(parsed.secret);
          }
          for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
            if (disclosureMethods.has(entry?.method ?? "")) checkOperation(entry.params?.[0]);
          }
        } catch { refuse(); }
      }
      if (disclosure) {
        safeWindow();
        if (!swapChecked || !calldataChecked) refuse();
      }
    },
    async afterResponse(url, response) {
      if (!response.ok) return;
      const path = pathOf(url);
      if (path === `/swap/${authorized.satoraSwapId}`) {
        const facts = await response.clone().json() as Record<string, unknown>;
        const terms = authorized.htlc;
        if (!terms) refuse();
        const expected: Record<string, string | number> = {
          id: authorized.satoraSwapId, direction: "lightning_to_evm", hash_lock: authorized.paymentHash,
          target_evm_address: authorized.destination, target_amount: authorized.targetAmountAtomic,
          evm_chain_id: terms.chainId, evm_htlc_address: terms.htlcAddress, evm_htlc_version: terms.version,
          evm_htlc_kind: terms.kind, evm_coordinator_address: terms.coordinator, wbtc_address: terms.lockToken,
          evm_expected_sats: terms.lockAmount, server_evm_address: terms.refundAddress, client_evm_address: terms.claimAddress,
          evm_refund_locktime: Date.parse(authorized.claimDeadline) / 1000,
        };
        for (const [field, value] of Object.entries(expected)) if (!equal(facts[field], value)) refuse();
        const token = facts["target_token"] as Record<string, unknown> | null;
        if (!token || !equal(token["token_id"], terms.targetToken) || !equal(token["chain"], terms.chainId) || token["decimals"] !== 6) refuse();
        if (facts["status"] !== "serverfunded" || facts["evm_claim_txid"] || facts["bridge_target_chain"]) refuse();
        safeWindow();
        swapChecked = true;
        return;
      }
      if (path.endsWith("/redeem-and-swap-calldata") || path === "/dex-calldata/fund") {
        if (!swapChecked) refuse();
        const data = await response.clone().json() as Record<string, unknown>;
        const amount = path === "/dex-calldata/fund" ? data["estimated_amount_out"] : data["min_amount_out"];
        if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) || BigInt(amount) < floor) refuse();
        safeWindow();
        calldataChecked = true;
      }
    },
  };
}
