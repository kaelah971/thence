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
import { isValidNimiqAddress, normalizeNimiqAddress } from "@/lib/nimiq";

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

export interface VaultSummary {
  /** Summed live balance of active wallet-managed vaults, atomic Luna string. */
  totalLuna: string;
  /** Number of vault contracts holding funds. */
  contracts: number;
}

export interface ChainBalance {
  /**
   * Exact integer Luna as a decimal string (100,000 Luna = 1 NIM).
   * F8.6: the WALLET total the user expects — basic account PLUS active
   * Nimiq Pay-managed vaults (see readManagedVaults). The basic-only
   * figure is in basicLuna; they are equal when no vaults hold funds.
   */
  luna: string;
  /** Basic-account-only Luna (the pre-F8.6 figure). Never a vault sum. */
  basicLuna: string;
  /** Active managed-vault balances, or null when no vault holds funds. */
  vaults: VaultSummary | null;
  /**
   * True when vault discovery or a vault read failed or was capped: the
   * total may be UNDERSTATED. Never treat a vaultUnknown total as complete
   * (in particular, never render "no NIM yet" while unknown is set).
   */
  vaultsUnknown: boolean;
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

/** Max unsettled vault contracts read per lookup (bounded RPC load). */
export const MAX_VAULT_READS = 10;
/** Recent-history window scanned for session-funded vaults. */
export const VAULT_DISCOVERY_LIMIT = 50;
/** Whole vault-phase budget (discovery + parallel contract reads). */
export const VAULT_PHASE_TIMEOUT_MS = 8_000;
/** Contract type for HTLC vaults (mirrors the provider catalogue). */
export const HTLC_CONTRACT_TYPE = 2;

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

/** Minimal funding record for vault discovery (tolerates provider field variants). */
interface FundingRecord {
  sender: string;
  recipient: string;
  toType: number;
  value: bigint;
}

function parseFundingRecord(tx: unknown): FundingRecord | null {
  if (!tx || typeof tx !== "object") return null;
  const r = tx as Record<string, unknown>;
  const sender = typeof r["sender"] === "string" ? r["sender"] : typeof r["from"] === "string" ? r["from"] : null;
  const recipient = typeof r["recipient"] === "string" ? r["recipient"] : typeof r["to"] === "string" ? r["to"] : null;
  if (!sender || !recipient) return null;
  // Only well-formed addresses participate; malformed rows are ignored.
  if (!isValidNimiqAddress(sender) || !isValidNimiqAddress(recipient)) return null;
  const toType = typeof r["toType"] === "number" ? r["toType"] : 0;
  const raw = r["value"];
  const value =
    typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
      ? BigInt(raw)
      : typeof raw === "string" && /^\d{1,24}$/.test(raw) && BigInt(raw) > 0n
        ? BigInt(raw)
        : null;
  if (value === null) return null;
  return { sender, recipient, toType, value };
}

function flatAddress(address: string): string {
  return address.replace(/\s+/g, "").toUpperCase();
}

export interface VaultDiscovery {
  totalLuna: bigint;
  contracts: number;
  unknown: boolean;
}

/**
 * F8.6 — wallet-managed HTLC vaults (Nimiq Pay vault semantics).
 *
 * Nimiq Pay parks wallet NIM in HTLC contracts: the basic account often
 * reads near-zero while the wallet UI aggregates the vaults. A basic-only
 * lookup therefore mistakes managed funds for an empty wallet. Discovery
 * mirrors the verified chain pattern: contracts the session address funded
 * (toType 2 funding leg in its history) whose returns fall short of the
 * funding are read LIVE — the live contract balance (not arithmetic) is
 * ground truth, so rollovers, partial spends, expirations and settled
 * contracts resolve correctly with no extra logic:
 * - settled/emptied contracts read 0/absent and are excluded,
 * - unrelated contracts (never funded by this session) are never read,
 * - recipient-side locks (funds locked FOR the user by others) are
 *   excluded: unilateral spendability is unverifiable from chain data,
 * - anything unreadable or over the read cap marks unknown instead of
 *   silently understating.
 *
 * Best-effort by design: failures resolve to unknown (honest partial),
 * never to zero and never to an exception.
 */
export async function readManagedVaults(
  url: string,
  canonical: string,
  signal: AbortSignal,
): Promise<VaultDiscovery> {
  const done = (totalLuna: bigint, contracts: number, unknown: boolean): VaultDiscovery => ({ totalLuna, contracts, unknown });
  let history: unknown;
  try {
    history = await postJson(
      url,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransactionsByAddress", params: [canonical, VAULT_DISCOVERY_LIMIT, null] }),
      signal,
    );
  } catch {
    return done(0n, 0, true);
  }
  const holder = history as { result?: unknown } | null;
  const rawList = holder && typeof holder === "object" ? (holder.result as { data?: unknown } | unknown[] | null) : null;
  const txs: unknown[] = Array.isArray(rawList) ? rawList : Array.isArray((rawList as { data?: unknown } | null)?.data) ? ((rawList as { data?: unknown[] }).data as unknown[]) : [];
  const own = flatAddress(canonical);
  const funded = new Map<string, bigint>();
  const returned = new Map<string, bigint>();
  for (const tx of txs) {
    const rec = parseFundingRecord(tx);
    if (!rec) continue;
    if (flatAddress(rec.sender) === own && rec.toType === HTLC_CONTRACT_TYPE) {
      const c = flatAddress(rec.recipient);
      funded.set(c, (funded.get(c) ?? 0n) + rec.value);
    }
  }
  for (const tx of txs) {
    const rec = parseFundingRecord(tx);
    if (!rec) continue;
    const s = flatAddress(rec.sender);
    if (flatAddress(rec.recipient) === own && funded.has(s)) {
      returned.set(s, (returned.get(s) ?? 0n) + rec.value);
    }
  }
  const unsettled = [...funded.keys()].filter((c) => (returned.get(c) ?? 0n) < (funded.get(c) ?? 0n));
  const capped = unsettled.length > MAX_VAULT_READS;
  const toRead = unsettled.slice(0, MAX_VAULT_READS);
  let totalLuna = 0n;
  let contracts = 0;
  let unknown = capped;
  await Promise.all(
    toRead.map(async (contract) => {
      // Query in canonical spaced form (flat is compare-only); malformed skips.
      let spaced: string;
      try {
        spaced = normalizeNimiqAddress(contract);
      } catch {
        return;
      }
      let payload: unknown;
      try {
        payload = await postJson(
          url,
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountByAddress", params: [spaced] }),
          signal,
        );
      } catch {
        unknown = true;
        return;
      }
      const response = (payload ?? {}) as { result?: unknown };
      if (response.result === undefined || response.result === null) return; // settled/removed: resolved empty
      try {
        const parsed = parseAccountBalance(response.result);
        const luna = BigInt(parsed.luna);
        if (luna > 0n) {
          totalLuna += luna;
          contracts += 1;
        }
      } catch {
        unknown = true; // present but unreadable: do not silently understate
      }
    }),
  );
  return done(totalLuna, contracts, unknown);
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
      const basicLuna = BigInt(parsed.luna);
      // Managed-vault phase (F8.6): own timeout, best-effort. Basic is
      // already established; vault discovery only ADDS wallet-held funds
      // and can only mark the total unknown, never shrink or zero it.
      let vaults: VaultSummary | null = null;
      let vaultsUnknown = false;
      {
        const vaultController = new AbortController();
        const vaultTimer = setTimeout(() => vaultController.abort(), VAULT_PHASE_TIMEOUT_MS);
        try {
          const vault = await readManagedVaults(url, canonical, vaultController.signal);
          if (vault.contracts > 0) vaults = { totalLuna: vault.totalLuna.toString(), contracts: vault.contracts };
          vaultsUnknown = vault.unknown;
        } catch {
          vaultsUnknown = true;
        } finally {
          clearTimeout(vaultTimer);
        }
      }
      const value: ChainBalance = {
        luna: (basicLuna + (vaults ? BigInt(vaults.totalLuna) : 0n)).toString(),
        basicLuna: basicLuna.toString(),
        vaults,
        vaultsUnknown,
        network: env.THENCE_NIMIQ_NETWORK,
        blockNumber: parsed.blockNumber,
      };
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
