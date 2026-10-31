/**
 * F6 — NIM balance diagnosis and fallback.
 *
 * Real-device finding: on the tested Nimiq Pay install the provider could
 * not answer `getBalance` (SDK docs: older hosts don't expose it), so
 * Thence showed "Update Nimiq Pay…". These tests pin the fix: host first,
 * compact-address retry, then the session address' confirmed on-chain
 * balance from a trusted node — never a fabricated or zero balance.
 * Mocked hosts and RPC only; not real Nimiq Pay evidence.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { validateEnv } from "@/lib/env";
import {
  clearChainBalanceCacheForTests,
  NimiqBalanceReadError,
  NimiqBalanceUnavailableError,
  parseAccountBalance,
  parseRetryAfterMs,
  readChainBalance,
  setNimiqBalanceSleepForTests,
  setNimiqRpcTransportForTests,
} from "@/lib/nimiq-balance";
import { readNimBalance, type ChainOutcome } from "@/ui/lib/balance";
import { buildTransferBody } from "@/ui/lib/prepare-flow";
import { HostUnavailableError, type HostProvider } from "@/ui/lib/nimiq-provider";
import { LIVE, fixtureWallet, loginAs } from "./helpers";
import { GET as balanceGET } from "../app/api/me/balance/route";

const ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const sign: HostProvider["sign"] = async () => ({ publicKey: "", signature: "" });
const chainOk = (
  luna: bigint,
  network: "mainnet" | "testnet" = "mainnet",
  extra: { basicLuna?: bigint; vaults?: { totalLuna: bigint; contracts: number } | null; vaultsUnknown?: boolean } = {},
) =>
async (): Promise<ChainOutcome> => ({
  ok: true,
  luna,
  basicLuna: extra.basicLuna ?? luna,
  vaults: extra.vaults ?? null,
  vaultsUnknown: extra.vaultsUnknown ?? false,
  network,
});
const chainOff = async (): Promise<ChainOutcome> => ({ ok: false, reason: "not-configured" });
const outdatedHost = async (): Promise<HostProvider> => ({ sign });

describe("client balance: host first, then trusted node", () => {
  it("prefers the host and tags the source", async () => {
    const state = await readNimBalance({ getProvider: async () => ({ sign, getBalance: async () => 35_260_449 }), readChain: chainOk(1n) }, ADDRESS);
    expect(state).toEqual({ status: "loaded", luna: 35_260_449n, basicLuna: 35_260_449n, vaultLuna: null, vaultUnknown: false, source: "host", network: null });
  });

  it("falls back to the trusted node when the host lacks getBalance (the real-device case)", async () => {
    const state = await readNimBalance({ getProvider: outdatedHost, readChain: chainOk(35_260_449n) }, ADDRESS);
    expect(state).toEqual({ status: "loaded", luna: 35_260_449n, basicLuna: 35_260_449n, vaultLuna: null, vaultUnknown: false, source: "chain", network: "mainnet" });
  });

  it("falls back when the host answers UNKNOWN_REQUEST", async () => {
    const getProvider = async (): Promise<HostProvider> => ({
      sign,
      getBalance: async () => {
        throw new NimiqProviderError("UNKNOWN_REQUEST", "Unknown method", 4200);
      },
    });
    expect(await readNimBalance({ getProvider, readChain: chainOk(5n) }, ADDRESS)).toEqual({ status: "loaded", luna: 5n, basicLuna: 5n, vaultLuna: null, vaultUnknown: false, source: "chain", network: "mainnet" });
  });

  it("retries the compact spelling only after INVALID_REQUEST", async () => {
    const asked: string[] = [];
    const getProvider = async (): Promise<HostProvider> => ({
      sign,
      getBalance: async (a: string) => {
        asked.push(a);
        if (a.includes(" ")) throw new NimiqProviderError("INVALID_REQUEST", "Invalid address", -32602);
        return 100_000;
      },
    });
    const state = await readNimBalance({ getProvider }, ADDRESS);
    expect(asked).toEqual([ADDRESS, ADDRESS.replace(/\s+/g, "")]);
    expect(state).toEqual({ status: "loaded", luna: 100_000n, basicLuna: 100_000n, vaultLuna: null, vaultUnknown: false, source: "host", network: null });
  });

  it("keeps a genuine zero as zero", async () => {
    expect(await readNimBalance({ getProvider: outdatedHost, readChain: chainOk(0n) }, ADDRESS)).toEqual({ status: "loaded", luna: 0n, basicLuna: 0n, vaultLuna: null, vaultUnknown: false, source: "chain", network: "mainnet" });
  });

  it("is honestly unavailable when neither the host nor a node can answer", async () => {
    expect(await readNimBalance({ getProvider: outdatedHost, readChain: chainOff }, ADDRESS)).toEqual({ status: "unavailable", reason: "host-outdated" });
    const notInHost = async (): Promise<HostProvider> => {
      throw new HostUnavailableError();
    };
    expect(await readNimBalance({ getProvider: notInHost, readChain: chainOff }, ADDRESS)).toEqual({ status: "unavailable", reason: "not-in-host" });
  });

  it("never shows a balance from a different network than Nimiq Pay reports", async () => {
    const state = await readNimBalance({ getProvider: outdatedHost, readChain: chainOk(7n, "mainnet"), hostNetwork: () => "testnet" }, ADDRESS);
    expect(state).toEqual({ status: "unavailable", reason: "network-mismatch" });
  });

  it("F8.4: never consults the chain when the host answers (lazy fallback)", async () => {
    let chainCalls = 0;
    const countingChain = async (): Promise<ChainOutcome> => {
      chainCalls += 1;
      return { ok: true, luna: 1n, basicLuna: 1n, vaults: null, vaultsUnknown: false, network: "mainnet" };
    };
    const state = await readNimBalance(
      { getProvider: async () => ({ sign, getBalance: async () => 35_260_449 }), readChain: countingChain },
      ADDRESS,
    );
    expect(state).toEqual({ status: "loaded", luna: 35_260_449n, basicLuna: 35_260_449n, vaultLuna: null, vaultUnknown: false, source: "host", network: null });
    expect(chainCalls).toBe(0);
  });

  it("F8.4: consults the chain exactly once after a host failure", async () => {
    let chainCalls = 0;
    const countingChain = async (): Promise<ChainOutcome> => {
      chainCalls += 1;
      return { ok: true, luna: 5n, basicLuna: 5n, vaults: null, vaultsUnknown: false, network: "mainnet" };
    };
    const state = await readNimBalance({ getProvider: outdatedHost, readChain: countingChain }, ADDRESS);
    expect(state).toEqual({ status: "loaded", luna: 5n, basicLuna: 5n, vaultLuna: null, vaultUnknown: false, source: "chain", network: "mainnet" });
    expect(chainCalls).toBe(1);
  });

  it("reports node failures as retryable errors, never as zero", async () => {
    const down = async (): Promise<ChainOutcome> => ({ ok: false, reason: "network" });
    expect(await readNimBalance({ getProvider: outdatedHost, readChain: down }, ADDRESS)).toEqual({ status: "error", reason: "network" });
    const throws = async (): Promise<ChainOutcome> => {
      throw new Error("boom");
    };
    expect(await readNimBalance({ getProvider: outdatedHost, readChain: throws }, ADDRESS)).toEqual({ status: "error", reason: "failed" });
  });
});

describe("server chain reader", () => {
  const env = { NODE_ENV: "test", DATABASE_URL: "postgresql://u:p@localhost:5432/x", THENCE_NIMIQ_RPC_URL: "https://rpc.example.test" };
  afterEach(() => {
    setNimiqRpcTransportForTests(null);
    setNimiqBalanceSleepForTests(null);
    clearChainBalanceCacheForTests();
  });

  it("validates the RPC URL as https-only", () => {
    expect(validateEnv({ ...env, THENCE_NIMIQ_RPC_URL: "http://rpc.example.test" }).ok).toBe(false);
    expect(validateEnv({ ...env, THENCE_NIMIQ_NETWORK: "devnet" }).ok).toBe(false);
    expect(validateEnv(env).ok).toBe(true);
  });

  it("parses the observed { data, metadata } envelope and bare accounts", () => {
    expect(parseAccountBalance({ data: { address: ADDRESS, balance: 458803182480, type: "basic" }, metadata: { blockNumber: 65588945 } })).toEqual({ luna: "458803182480", blockNumber: 65588945 });
    expect(parseAccountBalance({ balance: 0 })).toEqual({ luna: "0", blockNumber: null });
    expect(() => parseAccountBalance({ data: { balance: -1 } })).toThrow(NimiqBalanceReadError);
    expect(() => parseAccountBalance({ data: { balance: 1.5 } })).toThrow(NimiqBalanceReadError);
    expect(() => parseAccountBalance(null)).toThrow(NimiqBalanceReadError);
  });

  it("asks for the canonical session address and returns exact Luna", async () => {
    let sent: { method: string; params: string[] } | null = null;
    setNimiqRpcTransportForTests(async (_url, body) => {
      const parsed = JSON.parse(body) as { method: string; params: string[] };
      if (parsed.method === "getTransactionsByAddress") return { jsonrpc: "2.0", result: { data: [] }, id: 1 };
      sent = parsed;
      return { jsonrpc: "2.0", result: { data: { balance: 35_260_449 }, metadata: { blockNumber: 10 } }, id: 1 };
    });
    const balance = await readChainBalance(ADDRESS.replace(/\s+/g, ""), env);
    expect(sent).toEqual({ jsonrpc: "2.0", id: 1, method: "getAccountByAddress", params: [ADDRESS] });
    expect(balance).toEqual({
      luna: "35260449",
      basicLuna: "35260449",
      vaults: null,
      vaultsUnknown: false,
      blockNumber: 10,
      network: "mainnet",
    });
  });

  it("fails closed when unconfigured, on RPC errors and on transport errors", async () => {
    await expect(readChainBalance(ADDRESS, { ...env, THENCE_NIMIQ_RPC_URL: "" })).rejects.toBeInstanceOf(NimiqBalanceUnavailableError);
    setNimiqRpcTransportForTests(async () => ({ jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" }, id: 1 }));
    await expect(readChainBalance(ADDRESS, env)).rejects.toBeInstanceOf(NimiqBalanceReadError);
    setNimiqRpcTransportForTests(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(readChainBalance(ADDRESS, env)).rejects.toBeInstanceOf(NimiqBalanceReadError);
  });

  it("F8.5: recovers from transient 429s with bounded retries (then stops)", async () => {
    const sleeps: number[] = [];
    setNimiqBalanceSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    let basicCalls = 0;
    let totalCalls = 0;
    setNimiqRpcTransportForTests(async (_url, body) => {
      totalCalls += 1;
      if ((JSON.parse(body) as { method: string }).method === "getTransactionsByAddress") {
        return { jsonrpc: "2.0", result: { data: [] }, id: 1 };
      }
      basicCalls += 1;
      if (basicCalls <= 2) throw new NimiqBalanceReadError("busy", { reason: "rate_limited", retryable: true });
      return { jsonrpc: "2.0", result: { data: { balance: 8_837_000_00 } }, id: 1 };
    });
    const balance = await readChainBalance(ADDRESS, env);
    expect(balance.luna).toBe("883700000");
    expect(basicCalls).toBe(3);
    expect(totalCalls).toBe(4); // + vault discovery
    expect(sleeps).toEqual([400, 1_200]);
  });

  it("F8.5: gives up honestly after bounded attempts (never retries forever)", async () => {
    const sleeps: number[] = [];
    setNimiqBalanceSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    let basicCalls = 0;
    let totalCalls = 0;
    setNimiqRpcTransportForTests(async (_url, body) => {
      totalCalls += 1;
      if ((JSON.parse(body) as { method: string }).method === "getTransactionsByAddress") {
        return { jsonrpc: "2.0", result: { data: [] }, id: 1 };
      }
      basicCalls += 1;
      throw new NimiqBalanceReadError("busy", { reason: "rate_limited", retryable: true });
    });
    await expect(readChainBalance(ADDRESS, env)).rejects.toMatchObject({ reason: "rate_limited" });
    expect(basicCalls).toBe(3);
    expect(totalCalls).toBe(3); // basic fails: vault discovery never runs
    expect(sleeps).toEqual([400, 1_200]);
  });

  it("F8.5: honors a capped Retry-After hint", async () => {
    const sleeps: number[] = [];
    setNimiqBalanceSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    let basicCalls = 0;
    let totalCalls = 0;
    setNimiqRpcTransportForTests(async (_url, body) => {
      totalCalls += 1;
      if ((JSON.parse(body) as { method: string }).method === "getTransactionsByAddress") {
        return { jsonrpc: "2.0", result: { data: [] }, id: 1 };
      }
      basicCalls += 1;
      if (basicCalls === 1) throw new NimiqBalanceReadError("busy", { reason: "rate_limited", retryable: true, retryAfterMs: 9_000 });
      return { jsonrpc: "2.0", result: { data: { balance: 1 } }, id: 1 };
    });
    await readChainBalance(ADDRESS, env);
    expect(basicCalls).toBe(2);
    expect(totalCalls).toBe(3); // + vault discovery
    expect(sleeps).toEqual([3_000]);
  });

  it("F8.5: terminal answers fail immediately without retries", async () => {
    const sleeps: number[] = [];
    setNimiqBalanceSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    let calls = 0;
    setNimiqRpcTransportForTests(async (_url, body) => {
      calls += 1;
      if ((JSON.parse(body) as { method: string }).method === "getTransactionsByAddress") {
        return { jsonrpc: "2.0", result: { data: [] }, id: 1 };
      }
      return { jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" }, id: 1 };
    });
    await expect(readChainBalance(ADDRESS, env)).rejects.toBeInstanceOf(NimiqBalanceReadError);
    expect(calls).toBe(1); // terminal basic answer: no vault discovery, no retries
    expect(sleeps).toEqual([]);
  });

  it("F8.5: parses Retry-After delta-seconds and HTTP-dates (bounded)", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("junk")).toBeNull();
    expect(parseRetryAfterMs("2")).toBe(2_000);
    expect(parseRetryAfterMs("120")).toBe(3_000);
    expect(parseRetryAfterMs(new Date(Date.now() + 60_000).toUTCString())).toBe(3_000);
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it("F8.5: caches successes briefly, never failures", async () => {
    let calls = 0;
    const routed = (basic: () => unknown) => async (_url: string, body: string) => {
      calls += 1;
      if ((JSON.parse(body) as { method: string }).method === "getTransactionsByAddress") {
        return { jsonrpc: "2.0", result: { data: [] }, id: 1 };
      }
      return basic();
    };
    setNimiqRpcTransportForTests(routed(() => ({ jsonrpc: "2.0", result: { data: { balance: 7 } }, id: 1 })));
    await readChainBalance(ADDRESS, env);
    expect(calls).toBe(2); // basic + vault discovery
    setNimiqRpcTransportForTests(
      routed(() => {
        throw new NimiqBalanceReadError("down", { reason: "failed", retryable: true });
      }),
    );
    // Same address reads from cache despite the failing transport.
    expect((await readChainBalance(ADDRESS, env)).luna).toBe("7");
    expect(calls).toBe(2);
    // Failures are never cached: a fresh address still reaches the transport
    // (failing basic aborts before discovery: 1 initial + 2 retries), then rejects.
    await expect(readChainBalance(fixtureWallet().address, env)).rejects.toBeInstanceOf(NimiqBalanceReadError);
    expect(calls).toBe(5);
    // After clearing, the next read refetches.
    clearChainBalanceCacheForTests();
    setNimiqRpcTransportForTests(routed(() => ({ jsonrpc: "2.0", result: { data: { balance: 9 } }, id: 1 })));
    expect((await readChainBalance(ADDRESS, env)).luna).toBe("9");
    expect(calls).toBe(7); // basic + vault discovery refetch
  });
});

describe("F8.6 wallet-managed vaults (mocked transport, no network)", () => {
  const env = { NODE_ENV: "test", DATABASE_URL: "postgresql://u:p@localhost:5432/x", THENCE_NIMIQ_RPC_URL: "https://rpc.example.test" };
  const VAULT = fixtureWallet().address;
  const OTHER = fixtureWallet().address;
  const methodOf = (body: string): string => (JSON.parse(body) as { method: string }).method;
  const paramsOf = (body: string): string[] => (JSON.parse(body) as { params: string[] }).params;
  beforeEach(() => clearChainBalanceCacheForTests());

  function mockLedger(opts: { basic: unknown; txs: unknown[]; accounts?: Record<string, unknown>; calls?: { n: number } }): void {
    setNimiqRpcTransportForTests(async (_url, body) => {
      if (opts.calls) opts.calls.n += 1;
      const method = methodOf(body);
      if (method === "getTransactionsByAddress") return { jsonrpc: "2.0", result: { data: opts.txs }, id: 1 };
      const addr = paramsOf(body)[0] ?? "";
      if (opts.accounts && Object.prototype.hasOwnProperty.call(opts.accounts, addr)) {
        const v = opts.accounts[addr];
        if (v instanceof Error) throw v;
        return v;
      }
      return opts.basic;
    });
  }

  const funding = (value: number) => ({ sender: ADDRESS, recipient: VAULT, toType: 2, value });
  const vaultAccount = (balance: number) => ({ jsonrpc: "2.0", result: { data: { balance } }, id: 1 });

  it("aggregates an active session-funded vault into the wallet total", async () => {
    const calls = { n: 0 };
    mockLedger({
      basic: { jsonrpc: "2.0", result: { data: { balance: 0 } }, id: 1 },
      txs: [funding(883734849)],
      accounts: { [VAULT]: vaultAccount(883734849) },
      calls,
    });
    const balance = await readChainBalance(ADDRESS, env);
    expect(balance).toEqual({
      luna: "883734849",
      basicLuna: "0",
      vaults: { totalLuna: "883734849", contracts: 1 },
      vaultsUnknown: false,
      network: "mainnet",
      blockNumber: null,
    });
    expect(calls.n).toBe(3); // basic + history + one vault read
  });

  it("excludes settled contracts without reading them", async () => {
    const calls = { n: 0 };
    mockLedger({
      basic: { jsonrpc: "2.0", result: { data: { balance: 10 } }, id: 1 },
      txs: [funding(100), { sender: VAULT, recipient: ADDRESS, value: 100 }],
      calls,
    });
    const balance = await readChainBalance(ADDRESS, env);
    expect(balance.luna).toBe("10");
    expect(balance.vaults).toBeNull();
    expect(balance.vaultsUnknown).toBe(false);
    expect(calls.n).toBe(2); // basic + history only
  });

  it("excludes contracts funded by other wallets", async () => {
    const calls = { n: 0 };
    mockLedger({
      basic: { jsonrpc: "2.0", result: { data: { balance: 10 } }, id: 1 },
      txs: [{ sender: OTHER, recipient: VAULT, toType: 2, value: 999 }],
      accounts: { [VAULT]: vaultAccount(999) },
      calls,
    });
    const balance = await readChainBalance(ADDRESS, env);
    expect(balance.luna).toBe("10");
    expect(balance.vaults).toBeNull();
    expect(calls.n).toBe(2);
  });

  it("uses the live vault balance, not funding arithmetic (partial returns)", async () => {
    mockLedger({
      basic: { jsonrpc: "2.0", result: { data: { balance: 5 } }, id: 1 },
      txs: [funding(100), { sender: VAULT, recipient: ADDRESS, value: 40 }],
      accounts: { [VAULT]: vaultAccount(60) },
    });
    const balance = await readChainBalance(ADDRESS, env);
    expect(balance.luna).toBe("65");
    expect(balance.vaults).toEqual({ totalLuna: "60", contracts: 1 });
    expect(balance.vaultsUnknown).toBe(false);
  });

  it("flags unknown when a vault read fails, keeping the basic total", async () => {
    mockLedger({
      basic: { jsonrpc: "2.0", result: { data: { balance: 5 } }, id: 1 },
      txs: [funding(100)],
      accounts: { [VAULT]: new Error("down") },
    });
    const balance = await readChainBalance(ADDRESS, env);
    expect(balance.luna).toBe("5");
    expect(balance.basicLuna).toBe("5");
    expect(balance.vaults).toBeNull();
    expect(balance.vaultsUnknown).toBe(true);
  });

  it("caps contract reads and flags unknown beyond the cap", async () => {
    const contracts = Array.from({ length: 11 }, () => fixtureWallet().address);
    const accounts: Record<string, unknown> = {};
    for (const c of contracts) accounts[c] = vaultAccount(7);
    const calls = { n: 0 };
    setNimiqRpcTransportForTests(async (_url, body) => {
      calls.n += 1;
      if (methodOf(body) === "getTransactionsByAddress") {
        return { jsonrpc: "2.0", result: { data: contracts.map((c) => ({ sender: ADDRESS, recipient: c, toType: 2, value: 7 })) }, id: 1 };
      }
      const addr = paramsOf(body)[0] ?? "";
      if (Object.prototype.hasOwnProperty.call(accounts, addr)) return accounts[addr];
      return { jsonrpc: "2.0", result: { data: { balance: 0 } }, id: 1 };
    });
    const balance = await readChainBalance(ADDRESS, env);
    // 1 basic + 1 history + 10 vault reads; the 11th contract flags unknown.
    expect(calls.n).toBe(12);
    expect(balance.luna).toBe("70");
    expect(balance.vaults).toEqual({ totalLuna: "70", contracts: 10 });
    expect(balance.vaultsUnknown).toBe(true);
  });

  it("client surfaces the vault breakdown and the unknown flag", async () => {
    const withVaults = await readNimBalance(
      {
        getProvider: outdatedHost,
        readChain: chainOk(65n, "mainnet", { basicLuna: 5n, vaults: { totalLuna: 60n, contracts: 1 }, vaultsUnknown: false }),
      },
      ADDRESS,
    );
    expect(withVaults).toEqual({
      status: "loaded",
      luna: 65n,
      basicLuna: 5n,
      vaultLuna: 60n,
      vaultUnknown: false,
      source: "chain",
      network: "mainnet",
    });
    // Absent vault fields fail closed to unknown (shape drift can never present a partial total as complete).
    const unknown = await readNimBalance(
      {
        getProvider: outdatedHost,
        readChain: () => Promise.resolve({ ok: true, luna: 0n, network: "mainnet" } as unknown as ChainOutcome),
      },
      ADDRESS,
    );
    expect(unknown).toEqual({
      status: "loaded",
      luna: 0n,
      basicLuna: 0n,
      vaultLuna: null,
      vaultUnknown: true,
      source: "chain",
      network: "mainnet",
    });
  });
});

describe("F6 send to a new recipient without saving", () => {
  const address = "0x1D2e3F4a5B6c7D8e9F0a1B2c3D4e5F6a7B8c9D0e";

  it("pays an unnamed one-off address directly, with no saved recipient or name", () => {
    const body = buildTransferBody({
      payee: { id: null, destinationId: null, routeId: "usdc-polygon", address, name: null },
      fixed: null,
      targetAmountAtomic: "25000000",
      idempotencyKey: "k-f6-direct",
    });
    expect(body).toEqual({ routeId: "usdc-polygon", targetAmountAtomic: "25000000", idempotencyKey: "k-f6-direct", direct: { asset: "USDC", network: "Polygon", address } });
  });

  it("keeps an optional name on the one-off payment for the receipt", () => {
    const body = buildTransferBody({
      payee: { id: null, destinationId: null, routeId: "usdc-polygon", address, name: "Alex" },
      fixed: null,
      targetAmountAtomic: "1",
      idempotencyKey: "k-f6-named",
    });
    expect(body.recipientName).toBe("Alex");
    expect(body.recipientDestinationId).toBeUndefined();
  });
});

const createdUserIds = new Set<string>();
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

describe.skipIf(!LIVE)("GET /api/me/balance (live handler)", () => {
  afterEach(() => {
    setNimiqRpcTransportForTests(null);
    setNimiqBalanceSleepForTests(null);
    clearChainBalanceCacheForTests();
    delete process.env["THENCE_NIMIQ_RPC_URL"];
  });

  it("requires a session", async () => {
    const res = await balanceGET(new Request("http://localhost/api/me/balance"));
    expect(res.status).toBe(401);
  });

  it("reads only the session's own address and is 503 (never zero) when unconfigured", async () => {
    const login = await loginAs({ "x-forwarded-for": "10.66.0.1" }, (id) => createdUserIds.add(id));
    delete process.env["THENCE_NIMIQ_RPC_URL"];
    const off = await balanceGET(new Request("http://localhost/api/me/balance", { headers: { cookie: login.cookie } }));
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: string }).error).toBe("BALANCE_NOT_CONFIGURED");

    process.env["THENCE_NIMIQ_RPC_URL"] = "https://rpc.example.test";
    let asked = "";
    setNimiqRpcTransportForTests(async (_url, body) => {
      asked = (JSON.parse(body) as { params: string[] }).params[0] ?? "";
      return { result: { data: { balance: 12_345 } } };
    });
    const on = await balanceGET(new Request("http://localhost/api/me/balance?address=NQ00", { headers: { cookie: login.cookie } }));
    expect(on.status).toBe(200);
    expect(asked).toBe(login.address);
    expect(await on.json()).toEqual({ balance: { luna: "12345", basicLuna: "12345", vaults: null, vaultsUnknown: false, blockNumber: null, network: "mainnet", source: "chain" } });

    // The previous success is cached: prove the failure path with a fresh read.
    clearChainBalanceCacheForTests();
    setNimiqRpcTransportForTests(async () => ({ error: { code: -1, message: "down" } }));
    const down = await balanceGET(new Request("http://localhost/api/me/balance", { headers: { cookie: login.cookie } }));
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: string }).error).toBe("BALANCE_READ_FAILED");
  });
});
