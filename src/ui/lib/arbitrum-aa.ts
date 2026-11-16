/**
 * Arbitrum claim infrastructure (sponsored ERC-4337 UserOperation).
 *
 * Installed SDK path (@satora/swap 1.7.2 → @lendasat/lendaswap-sdk-pure
 * 2.7.0, `Client.claim` → `claimViaGasless`): an Arbitrum swap whose locked
 * token differs from the target token (Satora locks a BTC token and swaps it
 * to USDC with Uniswap v3) is an "Arbitrum hub claim with DEX swap". It is
 * claimed ONLY as a sponsored UserOperation:
 *   1. POST Satora /dex-calldata/fund → approve + Uniswap exactInputSingle calls;
 *   2. sign the HTLC Redeem digest (EIP-712 domain "HTLCErc20", version = the
 *      HTLC's declared version, 6 or 7) with the swap's claim key;
 *   3. EIP-7702 Kernel v3.3 account owned by the claim key, EntryPoint v0.7;
 *   4. Alchemy bundler + Gas Manager policy sponsor and send
 *      coordinator.redeemAndExecute(...);
 *   5. wait for the UserOperation receipt; `success: false` = reverted.
 * Without AA config the SDK refuses before doing anything. The SDK builder
 * falls back to Satora's own defaults (below); Thence passes them EXPLICITLY
 * so a future SDK default change cannot silently change where claims go
 * (tests/arbitrum-claim-execution.test.ts pins them to the installed SDK).
 *
 * Credentials: the bundler URL embeds Satora's PUBLIC client key, shipped in
 * Satora's npm package for exactly this browser use; the policy id is a
 * public identifier. Thence holds no AA secret and none reaches the browser.
 *
 * `arbitrumAaPreflight` is non-financial: chain id, EntryPoint support and a
 * sponsorship STUB for a dummy operation (no signature, no preimage, nothing
 * sent). It proves the infrastructure answers and the policy is active, not
 * that a particular claim will execute.
 */

export const ARBITRUM_CHAIN_ID = 42161;
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const ARBITRUM_AA = {
  bundlerUrl: "https://arb-mainnet.g.alchemy.com/v2/ZaG_75AoAHzPqzmys5jpD",
  paymasterPolicyId: "878b1c90-5b53-4c9c-8892-6d7659dd2e72",
} as const;

export type AaPreflightCode = "AA_OK" | "AA_UNREACHABLE" | "AA_WRONG_CHAIN" | "AA_ENTRYPOINT_UNSUPPORTED" | "AA_SPONSORSHIP_UNAVAILABLE";
export interface AaPreflightResult {
  ok: boolean;
  code: AaPreflightCode;
  paymaster: string | null;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

async function rpc(fetchFn: FetchFn, method: string, params: unknown[], timeoutMs: number): Promise<{ result?: unknown; error?: unknown } | null> {
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetchFn(ARBITRUM_AA.bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as { result?: unknown; error?: unknown };
  } catch {
    return null;
  }
}

const DUMMY_SENDER = "0x000000000000000000000000000000000000dEaD";

/** Non-financial readiness check of the Arbitrum claim infrastructure. */
export async function arbitrumAaPreflight(fetchFn: FetchFn = fetch as unknown as FetchFn, timeoutMs = 8_000): Promise<AaPreflightResult> {
  const chain = await rpc(fetchFn, "eth_chainId", [], timeoutMs);
  if (!chain || typeof chain.result !== "string") return { ok: false, code: "AA_UNREACHABLE", paymaster: null };
  if (Number.parseInt(chain.result, 16) !== ARBITRUM_CHAIN_ID) return { ok: false, code: "AA_WRONG_CHAIN", paymaster: null };
  const eps = await rpc(fetchFn, "eth_supportedEntryPoints", [], timeoutMs);
  if (!eps || !Array.isArray(eps.result)) return { ok: false, code: "AA_UNREACHABLE", paymaster: null };
  if (!eps.result.some((e) => typeof e === "string" && e.toLowerCase() === ENTRY_POINT_V07.toLowerCase())) {
    return { ok: false, code: "AA_ENTRYPOINT_UNSUPPORTED", paymaster: null };
  }
  const dummyOp = { sender: DUMMY_SENDER, nonce: "0x0", callData: "0x", callGasLimit: "0x0", verificationGasLimit: "0x0", preVerificationGas: "0x0", maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x0", signature: "0x" };
  const stub = await rpc(fetchFn, "pm_getPaymasterStubData", [dummyOp, ENTRY_POINT_V07, "0xa4b1", { policyId: ARBITRUM_AA.paymasterPolicyId }], timeoutMs);
  const paymaster = (stub?.result as { paymaster?: unknown } | undefined)?.paymaster;
  if (typeof paymaster !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(paymaster)) return { ok: false, code: "AA_SPONSORSHIP_UNAVAILABLE", paymaster: null };
  return { ok: true, code: "AA_OK", paymaster };
}

export function aaPreflightMessage(code: AaPreflightCode): string {
  return code === "AA_UNREACHABLE"
    ? "The Arbitrum delivery service can't be reached right now. Nothing was sent — try Finish delivery again shortly."
    : "The Arbitrum delivery service isn't ready to deliver right now. Nothing was sent — check again shortly, and don't pay again.";
}
