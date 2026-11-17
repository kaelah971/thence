/**
 * Arbitrum claim harness — drives the INSTALLED SDK's real `Client.claim()`
 * (@satora/swap → @lendasat/lendaswap-sdk-pure) for the f1ca0926 swap shape,
 * WITHOUT moving money or revealing anything real.
 *
 * Safety:
 * - The preimage and claim key are freshly generated throwaway values; the
 *   incident's real secrets never exist here (they live only on the owner's
 *   device and are never read).
 * - Global fetch is replaced BEFORE the SDK client is built (openapi-fetch
 *   captures fetch at construction). Every request is routed here:
 *   * Satora `GET /swap/:id` → the captured public response, status patched
 *     to `serverfunded` (the state at 18:17:53Z), claim party = throwaway key;
 *   * Satora `POST /dex-calldata/fund` → captured public response;
 *   * bundler / RPC JSON-RPC → answered locally (`--live-reads` forwards
 *     ONLY read methods without calldata to the public Arbitrum RPC);
 *   * `eth_sendUserOperation` is ALWAYS refused locally: nothing is sent.
 * - Any other URL is refused and reported.
 *
 * Usage:
 *   npx tsx scripts/arbitrum-claim-harness.ts --fixture <satora-public-responses.json> [--live-reads] [--scenario <name>]
 */
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { decodeFunctionData, parseAbi, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Scenario = "accept" | "sponsor-reject" | "sponsor-data-reject" | "estimate-revert" | "bundler-down" | "send-no-answer" | "send-rejected" | "dex-fail" | "rate-limited" | "receipt-reverted" | "missing-recovery";

export interface HarnessStep {
  kind: "satora" | "rpc" | "refused";
  name: string;
  forwarded?: boolean;
  note?: string;
}

export interface HarnessReport {
  steps: HarnessStep[];
  outcome: { ok: true; value: unknown } | { ok: false; error: string };
  sentUserOp: Record<string, unknown> | null;
  /** The exact operation the SDK asked the bundler to estimate (throwaway data). */
  estimateOp: Record<string, unknown> | null;
  /** Throwaway claim facts needed to simulate it (never real). */
  sim: { claimAddress: string; preimageHash: string; swap: Record<string, unknown> };
  checks: Record<string, boolean | string>;
}

const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const PUBLIC_ARB_RPC = "https://arb1.arbitrum.io/rpc";
/** Read-only methods that carry no calldata and may be forwarded with --live-reads. */
const READ_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"]);

function json(id: unknown, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), { status: 200, headers: { "content-type": "application/json" } });
}

export async function runHarness(opts: {
  fixture: { swap: Record<string, unknown>; dexCalldataFund: Record<string, unknown> };
  scenario?: Scenario;
  liveReads?: boolean;
  /** Runs after the harness fetch is installed and BEFORE the SDK client is built (production observer order). */
  beforeBuild?: () => void;
  /** Wraps the claim call (e.g. Thence's observeClaimNetwork). */
  runClaim?: (fn: () => Promise<unknown>, swap: Record<string, unknown>) => Promise<unknown>;
}): Promise<HarnessReport> {
  const scenario = opts.scenario ?? "accept";
  const steps: HarnessStep[] = [];
  let sentUserOp: Record<string, unknown> | null = null;
  let estimateOp: Record<string, unknown> | null = null;
  const realFetch = globalThis.fetch;

  // Throwaway secrets (never real).
  const secretKey = randomBytes(32);
  const preimage = randomBytes(32);
  const preimageHash = createHash("sha256").update(preimage).digest("hex");
  const claimAccount = privateKeyToAccount(`0x${secretKey.toString("hex")}`);
  const swapId = String(opts.fixture.swap["id"]);
  const swap: Record<string, unknown> = {
    ...opts.fixture.swap,
    status: "serverfunded",
    evm_claim_txid: null,
    client_evm_address: claimAccount.address,
    hash_lock: `0x${preimageHash}`,
  };

  const router = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    if (url.startsWith("https://api.satora.io")) {
      const path = new URL(url).pathname;
      if (method === "GET" && path === `/swap/${swapId}`) {
        steps.push({ kind: "satora", name: "GET /swap/:id" });
        return new Response(JSON.stringify(swap), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST" && path === "/dex-calldata/fund") {
        if (scenario === "dex-fail") {
          steps.push({ kind: "satora", name: "POST /dex-calldata/fund", note: "500 (scenario)" });
          return new Response(JSON.stringify({ error: "no route" }), { status: 500 });
        }
        steps.push({ kind: "satora", name: "POST /dex-calldata/fund" });
        return new Response(JSON.stringify(opts.fixture.dexCalldataFund), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && path === `/swap/${swapId}/redeem-and-swap-calldata`) {
        steps.push({ kind: "satora", name: "GET /swap/:id/redeem-and-swap-calldata" });
        if (scenario === "dex-fail") return new Response(JSON.stringify({ error: "no route" }), { status: 500 });
        return Response.json({ min_amount_out: opts.fixture.dexCalldataFund["estimated_amount_out"], calls_hash: `0x${"ef".repeat(32)}`, dex_calldata: { to: "0x0000000000000000000000000000000000000009", data: "0x12345678", value: "0" } });
      }
      if (method === "POST" && path === `/swap/${swapId}/claim-gasless`) {
        steps.push({ kind: "satora", name: "POST /swap/:id/claim-gasless" });
        const body = JSON.parse(req ? await req.clone().text() : String(init?.body)) as Record<string, unknown>;
        checks["relay destination = recipient"] = body["destination"] === swap["target_evm_address"];
        checks["relay preimage matches"] = typeof body["secret"] === "string" && createHash("sha256").update(Buffer.from(body["secret"].replace(/^0x/, ""), "hex")).digest("hex") === preimageHash;
        checks["relay signature fields present"] = ["r", "s", "v"].every((field) => body[field] !== undefined);
        if (scenario === "send-no-answer") throw new TypeError("Synthetic relay response lost");
        if (scenario === "send-rejected") return new Response(JSON.stringify({ error: "bad signature" }), { status: 400 });
        return Response.json({ id: swapId, status: "clientredeeming", tx_hash: `0x${"cd".repeat(32)}`, message: "Synthetic relay acceptance" });
      }
      steps.push({ kind: "refused", name: `${method} ${path}` });
      return new Response(JSON.stringify({ error: "harness: not routed" }), { status: 404 });
    }
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    let body: { id: unknown; method: string; params: unknown[] } | Array<{ id: unknown; method: string; params: unknown[] }>;
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      steps.push({ kind: "refused", name: `${method} ${url.slice(0, 60)}` });
      return new Response("harness: not routed", { status: 404 });
    }
    if (Array.isArray(body)) {
      const parts = await Promise.all(body.map(async (b) => (await answer(b)).json()));
      return new Response(JSON.stringify(parts), { status: 200, headers: { "content-type": "application/json" } });
    }
    return answer(body);
  };

  const answer = async (b: { id: unknown; method: string; params: unknown[] }): Promise<Response> => {
    const m = b.method;
    if (scenario === "bundler-down" && m !== "eth_chainId") {
      steps.push({ kind: "rpc", name: m, note: "network failure (scenario)" });
      throw new TypeError("Failed to fetch");
    }
    if (opts.liveReads && READ_METHODS.has(m)) {
      steps.push({ kind: "rpc", name: m, forwarded: true });
      const r = await realFetch(PUBLIC_ARB_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: b.id, method: m, params: b.params }) });
      return new Response(await r.text(), { status: 200, headers: { "content-type": "application/json" } });
    }
    steps.push({ kind: "rpc", name: m });
    switch (m) {
      case "eth_chainId":
        return json(b.id, { result: "0xa4b1" });
      case "eth_blockNumber":
        return json(b.id, { result: "0x1f48b7c0" });
      case "eth_getCode":
        return json(b.id, { result: "0x" });
      case "eth_getTransactionCount":
        return json(b.id, { result: "0x0" });
      case "eth_call":
        // EntryPoint.getNonce(sender, key) and other view calls: zero word.
        return json(b.id, { result: `0x${"0".repeat(64)}` });
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
      case "rundler_maxPriorityFeePerGas":
        return json(b.id, { result: "0x989680" });
      case "eth_getBlockByNumber":
        return json(b.id, { result: { number: "0x1f48b7c0", baseFeePerGas: "0x989680", timestamp: "0x6a0f0000", hash: `0x${"11".repeat(32)}`, transactions: [] } });
      case "eth_feeHistory":
        return json(b.id, { result: { oldestBlock: "0x1", baseFeePerGas: ["0x989680", "0x989680"], gasUsedRatio: [0.5], reward: [["0x0"]] } });
      case "pm_getPaymasterStubData":
        if (scenario === "sponsor-reject") return json(b.id, { error: { code: -32500, message: "Gas Manager policy rejected the user operation (harness)" } });
        return json(b.id, { result: { paymaster: "0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633", paymasterData: "0x", paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0", isFinal: false } });
      case "eth_estimateUserOperationGas":
        estimateOp = (b.params?.[0] as Record<string, unknown>) ?? null;
        if (scenario === "estimate-revert") return json(b.id, { error: { code: -32521, message: "execution reverted (harness)" } });
        if (scenario === "rate-limited") return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: 429, message: "Your app has exceeded its compute units per second capacity (harness)" } }), { status: 429, headers: { "content-type": "application/json" } });
        return json(b.id, { result: { preVerificationGas: "0x10000", verificationGasLimit: "0x60000", callGasLimit: "0x100000", paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" } });
      case "pm_getPaymasterData":
        if ((scenario === "sponsor-reject" || scenario === "sponsor-data-reject")) return json(b.id, { error: { code: -32500, message: "Gas Manager policy rejected the user operation (harness)" } });
        return json(b.id, { result: { paymaster: "0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633", paymasterData: `0x${"00".repeat(65)}`, paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" } });
      case "eth_sendUserOperation":
        sentUserOp = (b.params?.[0] as Record<string, unknown>) ?? null;
        if (scenario === "send-no-answer") throw new TypeError("Failed to fetch");
        if (scenario === "send-rejected") return json(b.id, { error: { code: -32602, message: "AA21 didn't pay prefund (harness)" } });
        // NEVER forwarded. A well-formed op reaching this point is recorded and
        // answered with a synthetic hash so the receipt step is exercised too.
        return json(b.id, { result: `0x${"ab".repeat(32)}` });
      case "eth_getUserOperationReceipt":
        return json(b.id, { result: { success: scenario !== "receipt-reverted", userOpHash: `0x${"ab".repeat(32)}`, receipt: { transactionHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", status: "0x1", logs: [] }, logs: [], actualGasCost: "0x0", actualGasUsed: "0x0", sender: claimAccount.address, nonce: "0x0", entryPoint: ENTRY_POINT_V07 } });
      default:
        steps.push({ kind: "refused", name: m });
        return json(b.id, { error: { code: -32601, message: `harness: ${m} not routed` } });
    }
  };

  globalThis.fetch = router as typeof fetch;
  let outcome: HarnessReport["outcome"];
  const checks: HarnessReport["checks"] = {};
  try {
    const sdk = await import("@satora/swap");
    const swapStorage = new sdk.InMemorySwapStorage();
    const walletStorage = new sdk.InMemoryWalletStorage();
    if (scenario !== "missing-recovery") await swapStorage.store({
      version: sdk.SWAP_STORAGE_VERSION,
      swapId,
      keyIndex: 0,
      response: swap as never,
      publicKey: "",
      preimage: preimage.toString("hex"),
      preimageHash,
      secretKey: secretKey.toString("hex"),
      storedAt: Date.now(),
      updatedAt: Date.now(),
      targetAddress: String(swap["target_evm_address"]),
    });
    // Same builder chain as src/ui/lib/satora-browser.ts (AA defaults left to the SDK).
    opts.beforeBuild?.();
    const client = await sdk.Client.builder().withSignerStorage(walletStorage).withSwapStorage(swapStorage).build();
    const doClaim = () => (client as unknown as { claim: (id: string) => Promise<unknown> }).claim(swapId);
    const value = await (opts.runClaim ? opts.runClaim(doClaim, swap) : doClaim());
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}`.replace(/0x[0-9a-fA-F]{40,}/g, "0x…").slice(0, 600) : String(error) };
  } finally {
    globalThis.fetch = realFetch;
  }

  // ---- independent checks of what WOULD have been sent ----
  const op = sentUserOp as Record<string, unknown> | null;
  if (op) {
    checks["sender = claim EOA (EIP-7702)"] = String(op["sender"]).toLowerCase() === claimAccount.address.toLowerCase();
    const auth = op["eip7702Auth"] as Record<string, unknown> | undefined;
    checks["eip7702Auth present"] = Boolean(auth);
    if (auth) checks["eip7702Auth.chainId"] = String(auth["chainId"]);
    if (auth) checks["eip7702Auth.address (Kernel impl)"] = String(auth["address"]);
    checks["paymaster set"] = typeof op["paymaster"] === "string" && String(op["paymaster"]).length === 42;
    const callData = String(op["callData"] ?? "");
    checks["callData targets coordinator"] = callData.toLowerCase().includes(String(swap["evm_coordinator_address"]).toLowerCase().slice(2));
    checks["callData has redeemAndExecute selector (ee2837cf)"] = callData.toLowerCase().includes("ee2837cf");
    checks["callData carries the (throwaway) preimage"] = callData.toLowerCase().includes(preimage.toString("hex"));
    // Decode redeemAndExecute and verify its EIP-712 Redeem signature recovers to the claim key.
    const idx = callData.toLowerCase().indexOf("ee2837cf");
    if (idx >= 0) {
      try {
        const inner = `0x${callData.slice(idx)}` as Hex;
        const abi = parseAbi(["function redeemAndExecute(bytes32 preimage,uint256 amount,address token,address sender,uint256 timelock,(address target,uint256 value,bytes data)[] calls,address sweepToken,uint256 minAmountOut,address destination,uint8 v,bytes32 r,bytes32 s)"]);
        const { args } = decodeFunctionData({ abi, data: inner });
        const [pre, amount, token, sender, timelock, calls, sweepToken, minAmountOut, destination, v, r, s] = args;
        const { keccak256, encodeAbiParameters } = await import("viem");
        const callsHash = keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }], [calls as never]));
        const signer = await recoverTypedDataAddress({
          domain: { name: "HTLCErc20", version: String(swap["evm_htlc_version"]), chainId: 42161, verifyingContract: String(swap["evm_htlc_address"]) as Hex },
          types: { Redeem: [{ name: "preimage", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "token", type: "address" }, { name: "sender", type: "address" }, { name: "timelock", type: "uint256" }, { name: "caller", type: "address" }, { name: "destination", type: "address" }, { name: "sweepToken", type: "address" }, { name: "minAmountOut", type: "uint256" }, { name: "callsHash", type: "bytes32" }] },
          primaryType: "Redeem",
          message: { preimage: pre, amount, token, sender, timelock, caller: String(swap["evm_coordinator_address"]) as Hex, destination, sweepToken, minAmountOut, callsHash },
          signature: { v: BigInt(v), r, s },
        });
        checks["Redeem signature recovers to claim EOA"] = signer.toLowerCase() === claimAccount.address.toLowerCase();
        checks["redeem amount = evm_expected_sats"] = String(amount) === String(swap["evm_expected_sats"]);
        checks["redeem token = locked token"] = String(token).toLowerCase() === String(swap["wbtc_address"]).toLowerCase();
        checks["redeem sender = HTLC refund party"] = String(sender).toLowerCase() === String(swap["server_evm_address"]).toLowerCase();
        checks["redeem timelock = evm_refund_locktime"] = String(timelock) === String(swap["evm_refund_locktime"]);
        checks["destination = recipient"] = String(destination).toLowerCase() === String(swap["target_evm_address"]).toLowerCase();
        checks["sweepToken = target token"] = String(sweepToken).toLowerCase() === String((swap["target_token"] as Record<string, unknown>)["token_id"]).toLowerCase();
        checks["minAmountOut"] = String(minAmountOut);
        checks["dex calls"] = (calls as unknown as Array<{ target: string }>).map((c) => c.target).join(",");
      } catch (e) {
        checks["redeemAndExecute decode"] = `failed: ${(e as Error).message.slice(0, 160)}`;
      }
    }
  }
  return { estimateOp, sim: { claimAddress: claimAccount.address, preimageHash, swap }, steps, outcome, sentUserOp: op ? { sender: op["sender"], hasAuth: Boolean(op["eip7702Auth"]), keys: Object.keys(op).sort().join(",") } : null, checks };
}

// CLI
if (process.argv[1] && /arbitrum-claim-harness\.ts$/.test(process.argv[1])) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const fixture = JSON.parse(readFileSync(arg("--fixture") ?? "", "utf8")) as { swap: Record<string, unknown>; dexCalldataFund: Record<string, unknown> };
  runHarness({ fixture, scenario: (arg("--scenario") as Scenario | undefined) ?? "accept", liveReads: process.argv.includes("--live-reads") }).then(
    (r) => {
      console.log("STEPS:", r.steps.map((s) => `${s.kind}:${s.name}${s.forwarded ? "(live)" : ""}${s.note ? `[${s.note}]` : ""}`).join(" → "));
      console.log("OUTCOME:", JSON.stringify(r.outcome));
      console.log("SENT OP:", JSON.stringify(r.sentUserOp));
      console.log("CHECKS:", JSON.stringify(r.checks, null, 1));
      process.exit(0);
    },
    (e) => {
      console.error("harness crashed:", e);
      process.exit(1);
    },
  );
}
