/**
 * Browser build of the Arbitrum claim harness: the INSTALLED SDK's real
 * `Client.claim()` with the PRODUCTION storage classes (IdbSwapStorage /
 * IdbWalletStorage, i.e. IndexedDB via Dexie) and the production builder
 * chain from src/ui/lib/satora-browser.ts. Throwaway secrets only; every
 * request is answered in-page; eth_sendUserOperation is answered locally and
 * never leaves the page. The Playwright runner additionally aborts any
 * request that reaches the network.
 */
import { Client, IdbSwapStorage, IdbWalletStorage, SWAP_STORAGE_VERSION } from "@satora/swap";
import { privateKeyToAccount } from "viem/accounts";

type Fixture = { swap: Record<string, unknown>; dexCalldataFund: Record<string, unknown> };
type Scenario = "accept" | "sponsor-reject" | "estimate-revert" | "bundler-down" | "send-no-answer";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const json = (id: unknown, body: Record<string, unknown>) => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { status: 200, headers: { "content-type": "application/json" } });

async function run(fixture: Fixture, scenario: Scenario = "accept", explicitAa = true): Promise<Record<string, unknown>> {
  const steps: string[] = [];
  let sent: Record<string, unknown> | null = null;
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  const preimage = crypto.getRandomValues(new Uint8Array(32));
  const preimageHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", preimage)));
  const claim = privateKeyToAccount(`0x${hex(secretKey)}`);
  const swapId = String(fixture.swap["id"]);
  const swap: Record<string, unknown> = { ...fixture.swap, status: "serverfunded", evm_claim_txid: null, client_evm_address: claim.address, hash_lock: `0x${preimageHash}` };

  const answer = async (b: { id: unknown; method: string; params: unknown[] }): Promise<Response> => {
    steps.push(b.method);
    if (scenario === "bundler-down" && b.method !== "eth_chainId") throw new TypeError("Failed to fetch");
    switch (b.method) {
      case "eth_chainId": return json(b.id, { result: "0xa4b1" });
      case "eth_getCode": return json(b.id, { result: "0x" });
      case "eth_getTransactionCount": return json(b.id, { result: "0x0" });
      case "eth_call": return json(b.id, { result: `0x${"0".repeat(64)}` });
      case "eth_gasPrice": case "eth_maxPriorityFeePerGas": case "rundler_maxPriorityFeePerGas": return json(b.id, { result: "0x989680" });
      case "eth_getBlockByNumber": return json(b.id, { result: { number: "0x1f48b7c0", baseFeePerGas: "0x989680", timestamp: "0x6a0f0000", hash: `0x${"11".repeat(32)}`, transactions: [] } });
      case "pm_getPaymasterStubData":
        if (scenario === "sponsor-reject") return json(b.id, { error: { code: -32500, message: "policy rejected (harness)" } });
        return json(b.id, { result: { paymaster: "0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633", paymasterData: "0x", paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" } });
      case "eth_estimateUserOperationGas":
        if (scenario === "estimate-revert") return json(b.id, { error: { code: -32521, message: "execution reverted (harness)" } });
        return json(b.id, { result: { preVerificationGas: "0x10000", verificationGasLimit: "0x60000", callGasLimit: "0x100000", paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" } });
      case "pm_getPaymasterData":
        return json(b.id, { result: { paymaster: "0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633", paymasterData: `0x${"00".repeat(65)}`, paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" } });
      case "eth_sendUserOperation":
        sent = (b.params?.[0] as Record<string, unknown>) ?? null;
        if (scenario === "send-no-answer") throw new TypeError("Failed to fetch");
        return json(b.id, { result: `0x${"ab".repeat(32)}` });
      case "eth_getUserOperationReceipt":
        return json(b.id, { result: { success: true, userOpHash: `0x${"ab".repeat(32)}`, receipt: { transactionHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status: "0x1", logs: [] }, logs: [], actualGasCost: "0x0", actualGasUsed: "0x0", sender: claim.address, nonce: "0x0", entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" } });
      default: return json(b.id, { error: { code: -32601, message: `harness: ${b.method}` } });
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    if (url.startsWith("https://api.satora.io")) {
      const path = new URL(url).pathname;
      steps.push(`satora ${method} ${path.replace(swapId, ":id")}`);
      if (method === "GET" && path === `/swap/${swapId}`) return new Response(JSON.stringify(swap), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "POST" && path === "/dex-calldata/fund") return new Response(JSON.stringify(fixture.dexCalldataFund), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404 });
    }
    const raw = req ? await req.clone().text() : String(init?.body ?? "");
    const body = JSON.parse(raw) as { id: unknown; method: string; params: unknown[] };
    return answer(body);
  }) as typeof fetch;
  try {
    const swapStorage = new IdbSwapStorage();
    const walletStorage = new IdbWalletStorage();
    await swapStorage.store({ version: SWAP_STORAGE_VERSION, swapId, keyIndex: 0, response: swap as never, publicKey: "", preimage: hex(preimage), preimageHash, secretKey: hex(secretKey), storedAt: Date.now(), updatedAt: Date.now(), targetAddress: String(swap["target_evm_address"]) });
    let builder = Client.builder().withSignerStorage(walletStorage).withSwapStorage(swapStorage);
    if (explicitAa) builder = builder.withAa({ bundlerUrl: "https://arb-mainnet.g.alchemy.com/v2/ZaG_75AoAHzPqzmys5jpD", paymasterPolicyId: "878b1c90-5b53-4c9c-8892-6d7659dd2e72" });
    const client = await builder.build();
    const value = await (client as unknown as { claim: (id: string) => Promise<unknown> }).claim(swapId);
    return { ok: true, value, steps, sentSender: sent ? (sent as Record<string, unknown>)["sender"] : null, claimAddress: claim.address, sentHasAuth: Boolean(sent && (sent as Record<string, unknown>)["eip7702Auth"]) };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, error: msg.replace(/0x[0-9a-fA-F]{40,}/g, "0x…").slice(0, 500), steps };
  } finally {
    globalThis.fetch = realFetch;
  }
}

(globalThis as unknown as { runClaimHarness: typeof run }).runClaimHarness = run;
