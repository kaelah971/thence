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

/** Static failure class for ops logs (never an address, URL, or body). */
export type NimiqBalanceFailureReason = "rate_limited" | "timeout" | "failed";

export class NimiqBalanceReadError extends Error {
  /** Machine-readable failure class for privacy-safe server logs. */
  readonly reason: NimiqBalanceFailureReason;
  /** Whether a bounded retry may help (429, 5xx, timeout, transport reset). */
  readonly retryable: boolean;
  /** Server-hinted wait from a Retry-After header, ms, already capped. Null when absent. */
  readonly retryAfterMs: number | null;
  constructor(
    message = "The Nimiq network could not be read.",
    opts: { reason?: NimiqBalanceFailureReason; retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "NimiqBalanceReadError";
    this.reason = opts.reason ?? "failed";
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
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

/** Cap for a server-hinted Retry-After wait (bounded retries only). */
export const MAX_RETRY_AFTER_MS = 3_000;

/** Parse a Retry-After header (delta-seconds or HTTP-date) to bounded ms. Null when absent/unparseable. */
export function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS));
  return null;
}

const defaultPostJson: PostJson = async (url, body, signal) => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new NimiqBalanceReadError("The Nimiq network timed out.", { reason: "timeout", retryable: true });
    }
    throw new NimiqBalanceReadError("The Nimiq network could not be reached.", { reason: "failed", retryable: true });
  }
  if (response.status === 429) {
    throw new NimiqBalanceReadError("The Nimiq network is busy.", {
      reason: "rate_limited",
      retryable: true,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    });
  }
  if (response.status >= 500) {
    throw new NimiqBalanceReadError("The Nimiq network could not be read.", { reason: "failed", retryable: true });
  }
  if (!response.ok) throw new NimiqBalanceReadError();
  return response.json();
};

let postJson: PostJson = defaultPostJson;

/** Test seam: replace the RPC transport. */
export function setNimiqRpcTransportForTests(next: PostJson | null): void {
  postJson = next ?? defaultPostJson;
}

/** Retry waits between attempts (bounded; tests replace the sleeper). */
export const BALANCE_RETRY_DELAYS_MS = [400, 1_200] as const;

type Sleeper = (ms: number) => Promise<void>;
let sleepImpl: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: replace the retry sleeper (production uses real timers). */
export function setNimiqBalanceSleepForTests(next: Sleeper | null): void {
  sleepImpl = next ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** Short-lived success cache: key = canonical address, memory only, never logged. */
const CHAIN_BALANCE_TTL_MS = 60_000;
const chainBalanceCache = new Map<string, { expiresAt: number; value: ChainBalance }>();

/** Test seam: drop cached balances. */
export function clearChainBalanceCacheForTests(): void {
  chainBalanceCache.clear();
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
  // Short-lived success cache (F8.5): the public fallback RPC is tightly
  // IP-rate-limited behind shared serverless egress, so repeated Home loads
  // must not re-spend the shared throttle budget. Display data only, 60s
  // TTL, memory-only, keyed by the session-bound address (the server never
  // accepts a client-chosen address). Failures are never cached.
  const cached = chainBalanceCache.get(canonical);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountByAddress", params: [canonical] });
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NIMIQ_RPC_TIMEOUT_MS);
    try {
      const payload = await postJson(url, body, controller.signal);
      clearTimeout(timer);
      if (!payload || typeof payload !== "object") throw new NimiqBalanceReadError("Unreadable RPC response.");
      const response = payload as { result?: unknown; error?: unknown };
      if (response.error !== undefined && response.error !== null) throw new NimiqBalanceReadError("The node rejected the lookup.");
      const parsed = parseAccountBalance(response.result);
      const value: ChainBalance = { ...parsed, network: env.THENCE_NIMIQ_NETWORK };
      chainBalanceCache.set(canonical, { expiresAt: Date.now() + CHAIN_BALANCE_TTL_MS, value });
      return value;
    } catch (error) {
      clearTimeout(timer);
      // Bounded retries (F8.5): transient 429s, 5xx, timeouts and transport
      // resets are worth one or two more attempts with backoff — then the
      // failure stays honest (503, never zero). Terminal answers (HTTP 4xx
      // other than 429, JSON-RPC errors, malformed shapes) fail immediately.
      const classified =
        error instanceof NimiqBalanceReadError
          ? error
          : error instanceof DOMException && error.name === "AbortError"
            ? new NimiqBalanceReadError("The Nimiq network timed out.", { reason: "timeout", retryable: true })
            : error instanceof TypeError
              ? new NimiqBalanceReadError("The Nimiq network could not be reached.", { reason: "failed", retryable: true })
              : new NimiqBalanceReadError();
      const wait =
        classified.retryable && attempt < BALANCE_RETRY_DELAYS_MS.length
          ? Math.min(classified.retryAfterMs ?? BALANCE_RETRY_DELAYS_MS[attempt]!, MAX_RETRY_AFTER_MS)
          : null;
      if (wait === null) throw classified;
      attempt += 1;
      await sleepImpl(wait);
    }
  }
}
