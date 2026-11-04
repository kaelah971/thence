/**
 * P7 E2E — SIMULATED external services (test adapter; never production).
 *
 * One local HTTP process standing in for the two external systems Thence
 * talks to over HTTP. Everything here is a simulation and is labelled as such:
 *
 *   /satora/*   Satora API (same paths and JSON shapes as api.satora.io, taken
 *               from captured public responses and the real 2026-11-02 getSwap)
 *               — used by the Thence server (THENCE_SATORA_BASE_URL) AND by the
 *               browser SDK (Playwright routes https://api.satora.io/** here).
 *   /polygon    Polygon JSON-RPC (viem-compatible receipts, blocks, logs).
 *   /__e2e/*    Test control: fund, claim mode, settlement evidence, refund,
 *               and an audit of every claim the browser SDK submitted.
 *
 * The gasless claim endpoint receives the REAL preimage from the REAL browser
 * SDK; it checks sha256(preimage) == hash_lock, so a test can prove the
 * browser revealed exactly this swap's secret, exactly when, and how often.
 * No real Lightning, Satora, Polygon or Nimiq system is ever contacted.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(__dirname, "fixtures");
const tokens = JSON.parse(readFileSync(join(FIXTURES, "satora-tokens.json"), "utf8")) as unknown;
const swapPairs = JSON.parse(readFileSync(join(FIXTURES, "satora-swap-pairs.json"), "utf8")) as unknown;
const networkFees = JSON.parse(readFileSync(join(FIXTURES, "satora-network-fees.json"), "utf8")) as unknown;
const chainConfig = JSON.parse(readFileSync(join(FIXTURES, "satora-chain-config.json"), "utf8")) as unknown;
const dexQuote300k = JSON.parse(readFileSync(join(FIXTURES, "satora-dex-quote-300000.json"), "utf8")) as unknown;
const quote300k = JSON.parse(readFileSync(join(FIXTURES, "satora-quote-300000.json"), "utf8")) as Record<string, unknown>;

/** Real Satora HTLCErc20 v6 and related public addresses (from the 2026-11-02 getSwap). */
export const HTLC = "0xf12A26a6CEfc1F5a0772fAf09F94c5e5662a3948";
const COORDINATOR = "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0";
const SERVER_EVM = "0x5ce278AAec6d9fa67bFcaF98512fE5175dFEebac";
const WBTC = "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6";
export const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const FUND_TOPIC = "0x127ba86dffa89675eb78a2ca7203c29f865789ebec607b9424ed9f8d3d533e9f";
const REFUND_TOPIC = "0xdb5ade4effa253aae9bef95994b76da3fe75eb0d634e715ec4261c6fd55c06f1";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** SIMULATED redeem event topic (any non-fund HTLC event means "spent" to Thence). */
const SIM_REDEEM_TOPIC = "0x" + createHash("sha256").update("thence-e2e-simulated-redeem").digest("hex");

/**
 * Source cost the simulated provider charges for 0.30 USDC: the same
 * composition the SDK uses for exact-output quotes (DEX input + network fee +
 * protocol fee), from the captured fixtures — so the swap matches the quote.
 */
const QUOTED_SOURCE_SATS =
  Number((dexQuote300k as { expected_amount_in: { raw: string } }).expected_amount_in.raw) + Number(quote300k["network_fee"]) + Number(quote300k["protocol_fee"]);

const BASE_BLOCK = 80_000_000;
const BASE_TS = Math.floor(Date.now() / 1000) - 3_600;

type ClaimMode = "ok" | "unknown-landed" | "unknown-lost";

interface SimSwap {
  record: Record<string, unknown>;
  hashLock: string;
  claims: Array<{ at: string; preimageMatches: boolean; executed: boolean }>;
  /** Preimages this SIMULATED provider received (test-only; used to prove they never leak elsewhere). */
  secretsSeen: string[];
}

interface SimLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

interface SimReceipt {
  hash: string;
  blockNumber: number;
  logs: SimLog[];
}

const state = {
  swaps: new Map<string, SimSwap>(),
  receipts: new Map<string, SimReceipt>(),
  /** Relayed claim txs accepted but NOT yet mined (no receipt; tx has no block). */
  pending: new Map<string, { swapId: string }>(),
  latest: BASE_BLOCK + 10,
  claimMode: "ok" as ClaimMode,
  /** Extra sats the provider asks at swap creation (repricing scenario). */
  repriceSats: 0,
  createdSwaps: 0,
  unhandled: [] as string[],
  /** Every simulated request (method + path), for proving who called what. */
  requests: [] as string[],
};

const hex32 = () => "0x" + randomBytes(32).toString("hex");
const word = (n: bigint | number | string) => BigInt(n).toString(16).padStart(64, "0");
const pad = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2).toLowerCase();
const blockHash = (n: number) => "0x" + createHash("sha256").update(`block-${n}`).digest("hex");
const toHex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
const blockTs = (n: number) => BASE_TS + (n - BASE_BLOCK) * 2;

function addReceipt(logs: Array<Omit<SimLog, "blockNumber" | "transactionHash" | "logIndex">>): SimReceipt {
  state.latest += 1;
  const hash = hex32();
  const receipt: SimReceipt = { hash, blockNumber: state.latest, logs: logs.map((l, i) => ({ ...l, blockNumber: state.latest, transactionHash: hash, logIndex: i })) };
  state.receipts.set(hash, receipt);
  return receipt;
}

/* -------------------------------- Satora -------------------------------- */

function createSwap(body: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const id = `e2e-${randomBytes(8).toString("hex")}`;
  const hashLock = String(body["hash_lock"]).toLowerCase();
  const amountOut = String(body["amount_out"] ?? "");
  const record: Record<string, unknown> = {
    direction: "lightning_to_evm",
    id,
    status: "pending",
    fee_sats: 6,
    hash_lock: hashLock,
    // SIMULATED hold invoice: well-formed prefix, not payable anywhere.
    bolt11_invoice: `lnbc3880n1pe2esimulated${randomBytes(20).toString("hex")}`,
    invoice_expires_at: now + 5_400,
    evm_fund_txid: null,
    evm_claim_txid: null,
    network: "bitcoin",
    created_at: new Date().toISOString(),
    chain: "POLYGON",
    evm_chain_id: Number(body["evm_chain_id"] ?? 137),
    client_evm_address: String(body["claiming_address"] ?? ""),
    target_evm_address: String(body["target_address"] ?? ""),
    evm_htlc_address: HTLC,
    evm_htlc_version: 6,
    evm_htlc_kind: "erc20",
    evm_coordinator_address: COORDINATOR,
    server_evm_address: SERVER_EVM,
    evm_refund_locktime: now + 3_600,
    wbtc_address: WBTC,
    evm_expected_sats: "392",
    source_token: { token_id: "btc", symbol: "BTC", chain: "Lightning", name: "Bitcoin (Lightning)", decimals: 8 },
    target_token: { token_id: String(body["token_address"] ?? USDC_POLYGON).toLowerCase(), symbol: "USDC", chain: "137", name: USDC_POLYGON, decimals: 6 },
    target_amount: amountOut,
    source_amount: String(QUOTED_SOURCE_SATS + state.repriceSats),
  };
  state.swaps.set(id, { record, hashLock, claims: [], secretsSeen: [] });
  state.createdSwaps += 1;
  return record;
}

function claimGasless(id: string, body: Record<string, unknown>): { status: number; body: unknown } {
  const swap = state.swaps.get(id);
  if (!swap) return { status: 404, body: { error: "swap not found" } };
  const secret = String(body["secret"] ?? "");
  swap.secretsSeen.push(secret.replace(/^0x/, "").toLowerCase());
  const preimageMatches = "0x" + createHash("sha256").update(Buffer.from(secret.replace(/^0x/, ""), "hex")).digest("hex") === swap.hashLock;
  const status = String(swap.record["status"]);
  if (status !== "serverfunded") {
    swap.claims.push({ at: new Date().toISOString(), preimageMatches, executed: false });
    return { status: 400, body: { error: `cannot claim a swap in ${status === "clientredeemed" ? "client_redeemed" : "client_redeeming"}` } };
  }
  const executes = state.claimMode !== "unknown-lost";
  swap.claims.push({ at: new Date().toISOString(), preimageMatches, executed: executes && preimageMatches });
  if (!preimageMatches) return { status: 400, body: { error: "invalid preimage" } };
  let txHash = "";
  if (executes) {
    // SIMULATED relayer: the redeem tx is accepted but PENDING (in the
    // mempool) — no receipt, no HTLC event yet. Like a real chain, it is mined
    // exactly once by /__e2e/settle, with the redeem event and the USDC
    // Transfer in the same immutable receipt.
    txHash = hex32();
    state.pending.set(txHash, { swapId: id });
    swap.record["status"] = "clientredeeming";
    swap.record["evm_claim_txid"] = txHash;
  }
  if (state.claimMode !== "ok") return { status: 502, body: { error: "upstream connection reset (simulated)" } };
  return { status: 200, body: { id, status: "clientredeeming", tx_hash: txHash, message: "Simulated gasless claim accepted (pending)." } };
}

function satora(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): { status: number; body: unknown } | null {
  if (method === "GET" && path === "/tokens") return { status: 200, body: tokens };
  if (method === "GET" && path === "/swap-pairs") return { status: 200, body: swapPairs };
  if (method === "GET" && path === "/network-fees") return { status: 200, body: networkFees };
  if (method === "GET" && path === "/chain-config") return { status: 200, body: chainConfig };
  if (method === "GET" && path === "/quote") {
    const target = query.get("target_amount");
    if (target !== "300000") return { status: 400, body: { error: "E2E simulator quotes only 300000 (0.30 USDC)" } };
    return { status: 200, body: quote300k };
  }
  if (method === "POST" && path === "/dex-quote") {
    const amount = (body["amount"] ?? {}) as Record<string, unknown>;
    if (amount["value"] !== "300000") return { status: 400, body: { error: "E2E simulator DEX-quotes only 300000 (0.30 USDC)" } };
    return { status: 200, body: dexQuote300k };
  }
  if (method === "POST" && path === "/swap/lightning/evm") return { status: 200, body: createSwap(body) };
  let m = path.match(/^\/swap\/([^/]+)$/);
  if (method === "GET" && m) {
    const swap = state.swaps.get(decodeURIComponent(m[1]!));
    return swap ? { status: 200, body: swap.record } : { status: 404, body: { error: "swap not found" } };
  }
  m = path.match(/^\/swap\/([^/]+)\/redeem-and-swap-calldata$/);
  if (method === "GET" && m) {
    const swap = state.swaps.get(decodeURIComponent(m[1]!));
    if (!swap) return { status: 404, body: { error: "swap not found" } };
    // SIMULATED DEX leg (WBTC→USDC): the SDK signs over these values; nothing
    // here is ever executed. min_amount_out = the exact target amount.
    return {
      status: 200,
      body: {
        dex_calldata: { to: "0x" + "e2e5".repeat(10), data: "0x" + "00".repeat(4), value: "0" },
        calls_hash: "0x" + createHash("sha256").update(`calls-${String(swap.record["id"])}`).digest("hex"),
        min_amount_out: String(swap.record["target_amount"]),
      },
    };
  }
  m = path.match(/^\/swap\/([^/]+)\/claim-gasless$/);
  if (method === "POST" && m) return claimGasless(decodeURIComponent(m[1]!), body);
  return null;
}

/* -------------------------------- Polygon -------------------------------- */

function rpcReceipt(r: SimReceipt) {
  return {
    transactionHash: r.hash,
    transactionIndex: "0x0",
    blockHash: blockHash(r.blockNumber),
    blockNumber: toHex(r.blockNumber),
    from: SERVER_EVM.toLowerCase(),
    to: HTLC.toLowerCase(),
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logsBloom: "0x" + "00".repeat(256),
    status: "0x1",
    type: "0x2",
    logs: r.logs.map(rpcLog),
  };
}

function rpcLog(l: SimLog) {
  return {
    address: l.address.toLowerCase(),
    topics: l.topics,
    data: l.data,
    blockNumber: toHex(l.blockNumber),
    blockHash: blockHash(l.blockNumber),
    transactionHash: l.transactionHash,
    transactionIndex: "0x0",
    logIndex: toHex(l.logIndex),
    removed: false,
  };
}

function rpcBlock(n: number) {
  return {
    number: toHex(n),
    hash: blockHash(n),
    parentHash: blockHash(n - 1),
    timestamp: toHex(blockTs(n)),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    miner: "0x0000000000000000000000000000000000000000",
    extraData: "0x",
    baseFeePerGas: "0x1",
    logsBloom: "0x" + "00".repeat(256),
    transactionsRoot: blockHash(n),
    stateRoot: blockHash(n),
    receiptsRoot: blockHash(n),
    sha3Uncles: blockHash(n),
    size: "0x1",
    totalDifficulty: "0x0",
    mixHash: blockHash(n),
    transactions: [],
    uncles: [],
  };
}

function polygon(rpc: { id: unknown; method: string; params?: unknown[] }): unknown {
  const p = rpc.params ?? [];
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id, result });
  switch (rpc.method) {
    case "eth_chainId":
      return ok("0x89");
    case "eth_blockNumber":
      return ok(toHex(state.latest));
    case "eth_getBlockByNumber": {
      const tag = String(p[0]);
      const n = tag === "latest" ? state.latest : tag === "finalized" || tag === "safe" ? state.latest - 300 : Number(BigInt(tag));
      return ok(n > state.latest ? null : rpcBlock(n));
    }
    case "eth_getTransactionReceipt": {
      const r = state.receipts.get(String(p[0]).toLowerCase());
      return ok(r ? rpcReceipt(r) : null);
    }
    case "eth_getTransactionByHash": {
      const hash = String(p[0]).toLowerCase();
      const r = state.receipts.get(hash);
      if (!r && state.pending.has(hash)) {
        // In the mempool: known transaction, not in any block.
        return ok({ hash, blockHash: null, blockNumber: null, from: COORDINATOR.toLowerCase(), to: HTLC.toLowerCase(), input: "0x", value: "0x0", gas: "0x5208", gasPrice: "0x1", nonce: "0x0", transactionIndex: null, type: "0x0", v: "0x0", r: "0x0", s: "0x0", chainId: "0x89" });
      }
      return ok(
        r
          ? { hash: r.hash, blockHash: blockHash(r.blockNumber), blockNumber: toHex(r.blockNumber), from: SERVER_EVM.toLowerCase(), to: HTLC.toLowerCase(), input: "0x", value: "0x0", gas: "0x5208", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x0", r: "0x0", s: "0x0", chainId: "0x89" }
          : null,
      );
    }
    case "eth_getLogs": {
      const f = (p[0] ?? {}) as { address?: string; fromBlock?: string; toBlock?: string; topics?: Array<string | null> };
      const from = Number(BigInt(f.fromBlock ?? "0x0"));
      const to = Number(BigInt(f.toBlock ?? toHex(state.latest)));
      const t1 = f.topics?.[1]?.toLowerCase() ?? null;
      const logs = [...state.receipts.values()]
        .flatMap((r) => r.logs)
        .filter((l) => (!f.address || l.address.toLowerCase() === f.address.toLowerCase()) && l.blockNumber >= from && l.blockNumber <= to && (t1 === null || l.topics[1]?.toLowerCase() === t1));
      return ok(logs.map(rpcLog));
    }
    default:
      state.unhandled.push(`polygon ${rpc.method}`);
      return { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `E2E simulator: unsupported ${rpc.method}` } };
  }
}

/* ------------------------------ test control ------------------------------ */

function swapOrThrow(id: unknown): SimSwap {
  const swap = state.swaps.get(String(id));
  if (!swap) throw new Error(`unknown swap ${String(id)}`);
  return swap;
}

function control(action: string, body: Record<string, unknown>): unknown {
  switch (action) {
    case "reset":
      state.swaps.clear();
      state.receipts.clear();
      state.pending.clear();
      state.latest = BASE_BLOCK + 10;
      state.claimMode = "ok";
      state.repriceSats = 0;
      state.createdSwaps = 0;
      state.unhandled = [];
      state.requests = [];
      return { ok: true };
    case "state":
      return {
        latest: state.latest,
        claimMode: state.claimMode,
        createdSwaps: state.createdSwaps,
        unhandled: state.unhandled,
        requests: state.requests,
        swaps: [...state.swaps.values()].map((s) => ({ id: s.record["id"], status: s.record["status"], claims: s.claims, secretsSeen: s.secretsSeen, hashLock: s.hashLock, targetAddress: s.record["target_evm_address"], targetAmount: s.record["target_amount"], deadline: s.record["evm_refund_locktime"] })),
      };
    case "latest-swap": {
      const last = [...state.swaps.values()].at(-1);
      return last ? { id: last.record["id"], deadline: last.record["evm_refund_locktime"], hashLock: last.hashLock } : { id: null };
    }
    case "fund": {
      // SIMULATED: Nimiq Pay paid the hold invoice; Satora locks the USDC
      // route's WBTC in the pinned HTLC with this swap's hash lock + deadline.
      const swap = swapOrThrow(body["swapId"]);
      const r = addReceipt([{ address: HTLC, topics: [FUND_TOPIC, swap.hashLock, pad(SERVER_EVM), pad(COORDINATOR)], data: "0x" + word(BigInt(WBTC)) + word(392) + word(Number(swap.record["evm_refund_locktime"])) + "9d".repeat(32) }]);
      swap.record["status"] = "serverfunded";
      swap.record["evm_fund_txid"] = r.hash;
      state.latest += Number(body["confirmations"] ?? 40);
      return { fundTx: r.hash };
    }
    case "reprice":
      state.repriceSats = Number(body["sats"] ?? 0);
      return { ok: true, repriceSats: state.repriceSats, quotedSourceSats: QUOTED_SOURCE_SATS };
    case "claim-mode":
      state.claimMode = body["mode"] as ClaimMode;
      return { ok: true, mode: state.claimMode };
    case "settle": {
      // SIMULATED mining of the pending claim tx, exactly once: one immutable
      // receipt with the HTLC redeem event AND the ERC20 Transfer of `token`
      // to `to` for `amount` (defaults: canonical USDC, recipient, exact amount).
      const swap = swapOrThrow(body["swapId"]);
      const claimTx = String(swap.record["evm_claim_txid"] ?? "").toLowerCase();
      if (!state.pending.has(claimTx)) throw new Error("swap has no pending claim to mine (a mined receipt is immutable)");
      state.pending.delete(claimTx);
      const to = String(body["to"] ?? swap.record["target_evm_address"]);
      const amount = String(body["amount"] ?? swap.record["target_amount"]);
      const token = String(body["token"] ?? USDC_POLYGON);
      state.latest += 1;
      const n = state.latest;
      state.receipts.set(claimTx, {
        hash: claimTx,
        blockNumber: n,
        logs: [
          { address: HTLC, topics: [SIM_REDEEM_TOPIC, swap.hashLock, pad(COORDINATOR)], data: "0x", blockNumber: n, transactionHash: claimTx, logIndex: 0 },
          { address: token, topics: [TRANSFER_TOPIC, pad(COORDINATOR), pad(to)], data: "0x" + word(amount), blockNumber: n, transactionHash: claimTx, logIndex: 1 },
        ],
      });
      swap.record["status"] = "clientredeemed";
      state.latest += Number(body["confirmations"] ?? 300);
      return { claimTx };
    }
    case "refund": {
      // SIMULATED: the deadline passed unclaimed; Satora refunds its HTLC lock.
      const swap = swapOrThrow(body["swapId"]);
      const r = addReceipt([{ address: HTLC, topics: [REFUND_TOPIC, swap.hashLock, "0x" + "00".repeat(32)], data: "0x" }]);
      swap.record["status"] = "clientfundedserverrefunded";
      swap.record["evm_claim_txid"] = r.hash;
      state.latest += 300;
      return { refundTx: r.hash };
    }
    case "drift": {
      // SIMULATED provider inconsistency: the reported deadline changes after binding.
      const swap = swapOrThrow(body["swapId"]);
      swap.record["evm_refund_locktime"] = Number(swap.record["evm_refund_locktime"]) + Number(body["deadlineDeltaSeconds"] ?? 600);
      return { deadline: swap.record["evm_refund_locktime"] };
    }
    case "advance":
      state.latest += Number(body["blocks"] ?? 1);
      return { latest: state.latest };
    default:
      throw new Error(`unknown control action ${action}`);
  }
}

/* --------------------------------- server --------------------------------- */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

/**
 * Plain HTTP for the test runner and the browser routes; optional HTTPS (a
 * run-only self-signed certificate) for the Thence server, whose env schema
 * requires https RPC URLs — that production guard is not weakened for E2E.
 */
export async function startMockServices(port: number, tls?: { port: number; key: string; cert: string }): Promise<() => Promise<void>> {
  const handler: RequestListener = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/__e2e/")) state.requests.push(`${"encrypted" in req.socket ? "https" : "http"} ${req.method} ${url.pathname}`);
      if (req.method === "OPTIONS") return send(res, 204, {});
      const raw = req.method === "POST" ? await readBody(req) : "";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (url.pathname.startsWith("/__e2e/")) return send(res, 200, control(url.pathname.slice(7), body));
      if (url.pathname === "/polygon") {
        return send(res, 200, Array.isArray(body) ? (body as unknown as Array<{ id: unknown; method: string; params?: unknown[] }>).map((b) => polygon(b)) : polygon(body as never));
      }
      if (url.pathname === "/nimiq") {
        // SIMULATED Nimiq RPC: display-only balance is reported unavailable
        // (the host's getBalance supplies the wallet balance in the UI).
        return send(res, 200, { jsonrpc: "2.0", id: (body as { id?: unknown }).id ?? 1, error: { code: -32000, message: "E2E simulator: balance unavailable" } });
      }
      if (url.pathname.startsWith("/satora/")) {
        const path = url.pathname.slice("/satora".length);
        const out = satora(req.method ?? "GET", path, url.searchParams, body);
        if (out) return send(res, out.status, out.body);
        state.unhandled.push(`satora ${req.method} ${path}${raw ? ` ${raw.slice(0, 400)}` : ""}`);
        return send(res, 404, { error: `E2E simulator: unhandled ${req.method} ${path}` });
      }
      state.unhandled.push(`other ${req.method} ${url.pathname}`);
      return send(res, 404, { error: "not found" });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : "simulator error" });
    }
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  const secure = tls ? createTlsServer({ key: tls.key, cert: tls.cert }, handler) : null;
  if (secure && tls) await new Promise<void>((resolve) => secure.listen(tls.port, "127.0.0.1", () => resolve()));
  return async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (secure) await new Promise<void>((r) => secure.close(() => r()));
  };
}

if (require.main === module) {
  const port = Number(process.env["E2E_MOCK_PORT"] ?? 4311);
  void startMockServices(port).then(() => console.log(`thence e2e SIMULATED services on http://127.0.0.1:${port}`));
}
