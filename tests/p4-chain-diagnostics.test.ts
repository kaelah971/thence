/**
 * P4 production closure failure (2026-11-04, eddaa6de): "The network check is
 * temporarily unavailable" (CHAIN_UNAVAILABLE) with NO logged cause, because
 * verifyNoHtlcActivity swallowed every chain-read error.
 *
 * These tests pin the fix: the verdict and every P4 gate are unchanged (a
 * failed read is still UNAVAILABLE, never "no activity"), but the failing
 * operation and a SANITIZED cause are returned and logged — never the RPC URL
 * or an API key embedded in it. Pure: injected chain reads, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeChainError,
  sanitizeChainDetail,
  setSettlementChainForTests,
  verifyNoHtlcActivity,
  type ChainReads,
} from "@/lib/settlement";
import { chainRefusal } from "@/lib/expiry-resolution";

const SECRET_URL = "https://polygon-mainnet.example-rpc.io/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HTLC = "0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948";
const LOCK = "0x" + "ab".repeat(32);
const GENESIS_TS = 1_590_000_000;
const LATEST = 100_000n;
const ts = (n: bigint) => GENESIS_TS + Number(n) * 2;
// Window well inside history and > 256 confirmations deep.
const windowStart = new Date(ts(50_000n) * 1000);
const windowEnd = new Date(ts(52_000n) * 1000);

/** Shape of viem's HttpRequestError → wrapped by the RPC layer (URL embedded). */
function viemHttpError(status: number, details: string): Error {
  const inner = Object.assign(new Error(`HTTP request failed.\n\nStatus: ${status}\nURL: ${SECRET_URL}\nRequest body: {"method":"eth_getLogs"}\n\nDetails: ${details}`), {
    name: "HttpRequestError",
    status,
    url: SECRET_URL,
    details,
    shortMessage: "HTTP request failed.",
  });
  return Object.assign(new Error(`HTTP request failed.\nURL: ${SECRET_URL}`), { name: "UnknownRpcError", shortMessage: "An unknown RPC error occurred.", cause: inner });
}

function viemRpcError(code: number, details: string): Error {
  return Object.assign(new Error(`RPC Request failed.\nURL: ${SECRET_URL}\nDetails: ${details}`), { name: "RpcRequestError", code, details, shortMessage: "RPC Request failed." });
}

function chain(over: Partial<ChainReads> = {}): ChainReads {
  return {
    async getTransaction() {
      return null;
    },
    async getReceipt() {
      return null;
    },
    async getLatestBlockNumber() {
      return LATEST;
    },
    async getFinalizedBlockNumber() {
      return LATEST - 300n;
    },
    async getBlockHash() {
      return null;
    },
    async getBlockTimestamp(_c, n) {
      return ts(n);
    },
    async getLogsByTopic1() {
      return [];
    },
    ...over,
  };
}

const scan = () => verifyNoHtlcActivity({ chainId: 137, htlcAddress: HTLC, hashLock: LOCK, windowStart, windowEnd });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@fixture.invalid:5432/none");
  vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": SECRET_URL }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  setSettlementChainForTests(null);
  vi.unstubAllEnvs();
  warn.mockRestore();
});

const logged = (): string => warn.mock.calls.map((c) => String(c[0])).join("\n");

describe("P4 chain scan: strict verdicts unchanged", () => {
  it("a healthy chain with no events is still NO_ACTIVITY and logs nothing", async () => {
    setSettlementChainForTests(chain());
    const r = await scan();
    expect(r.verdict).toBe("NO_ACTIVITY");
    expect(r.failure).toBeUndefined();
    expect(chainRefusal(r)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a failed read is UNAVAILABLE → CHAIN_UNAVAILABLE refusal (never treated as no activity)", async () => {
    setSettlementChainForTests(chain({ getLogsByTopic1: async () => Promise.reject(viemHttpError(400, "Log response size exceeded / block range too large")) }));
    const r = await scan();
    expect(r.verdict).toBe("UNAVAILABLE");
    expect(chainRefusal(r)).toBe("CHAIN_UNAVAILABLE");
  });
});

describe("P4 chain scan: failing operation and cause are reported, sanitized", () => {
  it("getLogs HTTP rejection: op, status and reason — no URL, no key", async () => {
    setSettlementChainForTests(chain({ getLogsByTopic1: async () => Promise.reject(viemHttpError(400, "block range too large")) }));
    const r = await scan();
    expect(r.failure).toMatchObject({ op: "getLogs(2000 blocks)", kind: "http", httpStatus: 400 });
    expect(r.failure!.detail).toMatch(/block range too large/);
    for (const text of [JSON.stringify(r), logged()]) {
      expect(text).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
      expect(text).not.toContain("example-rpc.io");
      expect(text).not.toMatch(/https?:\/\//);
    }
    expect(logged()).toMatch(/^thence-chain-scan \{.*"op":"getLogs\(2000 blocks\)".*"httpStatus":400/);
  });

  it("endpoint refusing every call (e.g. 401/403 key problem) is reported at getBlockNumber", async () => {
    setSettlementChainForTests(chain({ getLatestBlockNumber: async () => Promise.reject(viemHttpError(403, "API key disabled")) }));
    const r = await scan();
    expect(r.failure).toMatchObject({ op: "getBlockNumber", kind: "http", httpStatus: 403 });
    expect(r.failure!.detail).toMatch(/API key disabled/);
  });

  it("JSON-RPC errors during the block search keep their code (e.g. rate limit -32005)", async () => {
    let calls = 0;
    setSettlementChainForTests(
      chain({
        getBlockTimestamp: async (_c, n) => {
          calls++;
          if (calls > 5) throw viemRpcError(-32005, "rate limit exceeded");
          return ts(n);
        },
      }),
    );
    const r = await scan();
    expect(r.failure).toMatchObject({ op: "blockSearch(windowStart)", kind: "rpc", rpcCode: -32005 });
    expect(r.failure!.detail).toMatch(/rate limit exceeded/);
    expect(JSON.stringify(r)).not.toContain("AbCdEf");
  });

  it("timeouts are classified as timeout", async () => {
    setSettlementChainForTests(chain({ getLogsByTopic1: async () => Promise.reject(new Error("getLogs timed out.")) }));
    const r = await scan();
    expect(r.failure).toMatchObject({ kind: "timeout", httpStatus: null, rpcCode: null });
  });
});

describe("sanitizer", () => {
  it("removes URLs and long opaque tokens but keeps hex values and short words", () => {
    const out = sanitizeChainDetail(`failed at ${SECRET_URL}?key=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz token=${"Q".repeat(40)} block 0x${"f".repeat(64)} ok`);
    expect(out).not.toMatch(/https?:|example-rpc|AbCdEf|zzzzzzzz|QQQQQQ/);
    expect(out).toContain(`0x${"f".repeat(64)}`);
    expect(out.length).toBeLessThanOrEqual(160);
  });

  it("describeChainError never surfaces a url property", () => {
    const f = describeChainError(viemHttpError(429, "Too Many Requests"), "getLogs(2000 blocks)");
    expect(JSON.stringify(f)).not.toMatch(/https?:|AbCdEf/);
    expect(f.httpStatus).toBe(429);
  });
});
