/**
 * F6 — read-only confirmed NIM balance from a trusted Nimiq JSON-RPC node.
 *
 * Why this exists: `getBalance` on the Nimiq Pay provider is only injected
 * by newer hosts (SDK docs: "Older hosts do not expose this method"). When
 * the installed host can't answer, Thence reads the confirmed on-chain
 * balance of the session's verified address instead.
 *
 * Rules:
 * - Only the address derived from the verified session is ever read; the
 *   client cannot choose an address.
 * - The RPC URL comes from the environment only. Empty = unavailable.
 * - Any transport/RPC/shape problem throws. It is never turned into zero.
 * - Display only. Never used as payment proof or for any decision.
 */
import { getEnv } from "@/lib/env";
import { normalizeNimiqAddress } from "@/lib/nimiq";

export const NIMIQ_RPC_TIMEOUT_MS = 8_000;

export class NimiqBalanceUnavailableError extends Error {
  constructor(message = "Server balance lookup is not configured.") {
    super(message);
    this.name = "NimiqBalanceUnavailableError";
  }
}

export class NimiqBalanceReadError extends Error {
  constructor(message = "The Nimiq network could not be read.") {
    super(message);
    this.name = "NimiqBalanceReadError";
  }
}

export interface ChainBalance {
  /** Exact integer Luna as a decimal string (100,000 Luna = 1 NIM). */
  luna: string;
  network: "mainnet" | "testnet";
  /** Block the node answered at, when reported. */
  blockNumber: number | null;
}

type PostJson = (url: string, body: string, signal: AbortSignal) => Promise<unknown>;

const defaultPostJson: PostJson = async (url, body, signal) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body,
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new NimiqBalanceReadError();
  return response.json();
};

let postJson: PostJson = defaultPostJson;

/** Test seam: replace the RPC transport. */
export function setNimiqRpcTransportForTests(next: PostJson | null): void {
  postJson = next ?? defaultPostJson;
}

/** Parse a `getAccountByAddress` result; accepts the `{ data, metadata }` envelope or a bare account. */
export function parseAccountBalance(result: unknown): { luna: string; blockNumber: number | null } {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new NimiqBalanceReadError("Unreadable account.");
  const record = result as Record<string, unknown>;
  const account = (record["data"] && typeof record["data"] === "object" ? record["data"] : record) as Record<string, unknown>;
  const metadata = record["metadata"] as Record<string, unknown> | undefined;
  const blockNumber = typeof metadata?.["blockNumber"] === "number" && Number.isSafeInteger(metadata["blockNumber"]) ? (metadata["blockNumber"] as number) : null;
  const balance = account["balance"];
  if (typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0) return { luna: String(balance), blockNumber };
  if (typeof balance === "string" && /^\d{1,24}$/.test(balance)) return { luna: BigInt(balance).toString(), blockNumber };
  throw new NimiqBalanceReadError("Unreadable account balance.");
}

export async function readChainBalance(address: string, source: Record<string, string | undefined> = process.env): Promise<ChainBalance> {
  const env = getEnv(source);
  const url = env.THENCE_NIMIQ_RPC_URL.trim();
  if (!url) throw new NimiqBalanceUnavailableError();
  const canonical = normalizeNimiqAddress(address);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NIMIQ_RPC_TIMEOUT_MS);
  let payload: unknown;
  try {
    payload = await postJson(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountByAddress", params: [canonical] }), controller.signal);
  } catch (error) {
    throw error instanceof NimiqBalanceReadError ? error : new NimiqBalanceReadError();
  } finally {
    clearTimeout(timer);
  }
  if (!payload || typeof payload !== "object") throw new NimiqBalanceReadError("Unreadable RPC response.");
  const body = payload as { result?: unknown; error?: unknown };
  if (body.error !== undefined && body.error !== null) throw new NimiqBalanceReadError("The node rejected the lookup.");
  const parsed = parseAccountBalance(body.result);
  return { ...parsed, network: env.THENCE_NIMIQ_NETWORK };
}
