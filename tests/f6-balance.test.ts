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
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { validateEnv } from "@/lib/env";
import { NimiqBalanceReadError, NimiqBalanceUnavailableError, parseAccountBalance, readChainBalance, setNimiqRpcTransportForTests } from "@/lib/nimiq-balance";
import { readNimBalance, type ChainOutcome } from "@/ui/lib/balance";
import { buildTransferBody } from "@/ui/lib/prepare-flow";
import { HostUnavailableError, type HostProvider } from "@/ui/lib/nimiq-provider";
import { LIVE, loginAs } from "./helpers";
import { GET as balanceGET } from "../app/api/me/balance/route";

const ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const sign: HostProvider["sign"] = async () => ({ publicKey: "", signature: "" });
const chainOk = (luna: bigint, network: "mainnet" | "testnet" = "mainnet") => async (): Promise<ChainOutcome> => ({ ok: true, luna, network });
const chainOff = async (): Promise<ChainOutcome> => ({ ok: false, reason: "not-configured" });
const outdatedHost = async (): Promise<HostProvider> => ({ sign });

describe("client balance: host first, then trusted node", () => {
  it("prefers the host and tags the source", async () => {
    const state = await readNimBalance({ getProvider: async () => ({ sign, getBalance: async () => 35_260_449 }), readChain: chainOk(1n) }, ADDRESS);
    expect(state).toEqual({ status: "loaded", luna: 35_260_449n, source: "host", network: null });
  });

  it("falls back to the trusted node when the host lacks getBalance (the real-device case)", async () => {
    const state = await readNimBalance({ getProvider: outdatedHost, readChain: chainOk(35_260_449n) }, ADDRESS);
    expect(state).toEqual({ status: "loaded", luna: 35_260_449n, source: "chain", network: "mainnet" });
  });

  it("falls back when the host answers UNKNOWN_REQUEST", async () => {
    const getProvider = async (): Promise<HostProvider> => ({
      sign,
      getBalance: async () => {
        throw new NimiqProviderError("UNKNOWN_REQUEST", "Unknown method", 4200);
      },
    });
    expect(await readNimBalance({ getProvider, readChain: chainOk(5n) }, ADDRESS)).toEqual({ status: "loaded", luna: 5n, source: "chain", network: "mainnet" });
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
    expect(state).toEqual({ status: "loaded", luna: 100_000n, source: "host", network: null });
  });

  it("keeps a genuine zero as zero", async () => {
    expect(await readNimBalance({ getProvider: outdatedHost, readChain: chainOk(0n) }, ADDRESS)).toEqual({ status: "loaded", luna: 0n, source: "chain", network: "mainnet" });
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
  afterEach(() => setNimiqRpcTransportForTests(null));

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
      sent = JSON.parse(body) as { method: string; params: string[] };
      return { jsonrpc: "2.0", result: { data: { balance: 35_260_449 }, metadata: { blockNumber: 10 } }, id: 1 };
    });
    const balance = await readChainBalance(ADDRESS.replace(/\s+/g, ""), env);
    expect(sent).toEqual({ jsonrpc: "2.0", id: 1, method: "getAccountByAddress", params: [ADDRESS] });
    expect(balance).toEqual({ luna: "35260449", blockNumber: 10, network: "mainnet" });
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
    expect(await on.json()).toEqual({ balance: { luna: "12345", blockNumber: null, network: "mainnet", source: "chain" } });

    setNimiqRpcTransportForTests(async () => ({ error: { code: -1, message: "down" } }));
    const down = await balanceGET(new Request("http://localhost/api/me/balance", { headers: { cookie: login.cookie } }));
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: string }).error).toBe("BALANCE_READ_FAILED");
  });
});
