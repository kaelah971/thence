/**
 * R4 — bounded, read-only Fastspot swap lookup for operator diagnostics.
 *
 * Exactly one request shape exists here: `GET {base}/swap/{id}`. There is no
 * code path for PATCH/POST/DELETE, so this module can never submit a funding
 * proof, pay an invoice, refund, claim or change a swap.
 *
 * - Off by default. It runs only when an operator passes a base URL and an
 *   API key that Thence is authorized to use. Thence ships no key. Nimiq Pay's
 *   embedded key is Nimiq's, not Thence's, and must not be used without
 *   their permission.
 * - The result is a diagnostic snapshot. It is never independent proof of NIM
 *   funding or settlement: only the Nimiq chain verifies the source.
 * - The response is reduced to an allowlisted summary. The preimage, if any,
 *   is reported only as a boolean and never stored or printed.
 */
import { normalizeHostSwapId } from "@/domain/host-swap-id";

export const FASTSPOT_DIAG_TIMEOUT_MS = 10_000;

export interface FastspotDiagConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * What a contract status can and cannot show. In the pinned SDK
 * (@nimiq/fastspot-api@2.0.0-beta.2, `FastspotContract.status`) a contract is
 * only PENDING or REDEEMED: there is no "funded" state, so a PENDING NIM
 * contract does NOT show whether Fastspot received or accepted the funding
 * proof. Only Fastspot's own records establish that.
 */
export const CONTRACT_STATUS_LIMITATION =
  "Contract status is PENDING or REDEEMED only; it does not show whether Fastspot received or accepted the NIM funding proof.";

export interface FastspotContractSnapshot {
  status: string | null;
}

export interface FastspotSwapSnapshot {
  ok: true;
  swapStatus: string | null;
  /** NIM HTLC contract (the user's locked NIM). Null when absent from the response. */
  nim: FastspotContractSnapshot | null;
  /** Lightning contract (`BTC_LN`, Fastspot paying the invoice). Null when absent. */
  lightning: FastspotContractSnapshot | null;
  /** Count of other contracts; their contents are never reported. */
  otherContracts: number;
  /** Whether a preimage (v2 `preimage`, v1 `secret`) is present. The value is never returned. */
  hasPreimage: boolean;
  expiry: number | null;
  limitation: typeof CONTRACT_STATUS_LIMITATION;
}

export type FastspotDiagResult = FastspotSwapSnapshot | { ok: false; code: "NOT_CONFIGURED" | "BAD_SWAP_ID" | "HTTP_ERROR" | "TIMEOUT" | "BAD_RESPONSE"; httpStatus?: number };

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const token = (v: unknown): string | null => (typeof v === "string" && SAFE_TOKEN.test(v) ? v : null);
const MAX_CONTRACTS = 8;

/**
 * Contracts as (asset, status) pairs. The REST response (v2 `FastspotSwap`)
 * is an ARRAY of `{ id, asset, amount, status, refundTarget, recipient,
 * expiry, data }`. The v1 SDK re-keys it by asset (`swap.contracts.NIM`),
 * which is the shape Nimiq Pay code reads; that keyed shape is accepted too.
 * Only `asset` and `status` are read: ids, amounts, addresses, refund targets
 * and HTLC data are never copied.
 */
function contractPairs(raw: unknown): Array<{ asset: string | null; status: string | null }> | null {
  if (Array.isArray(raw)) {
    return raw.slice(0, MAX_CONTRACTS).map((c) => {
      const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
      return { asset: token(o["asset"]), status: token(o["status"]) };
    });
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw as Record<string, unknown>)
      .slice(0, MAX_CONTRACTS)
      .map(([key, c]) => {
        const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
        return { asset: token(o["asset"]) ?? token(key), status: token(o["status"]) };
      });
  }
  return null;
}

/** Reduce a raw Fastspot swap to the allowlisted, non-secret snapshot. */
export function summarizeFastspotSwap(raw: unknown): FastspotDiagResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, code: "BAD_RESPONSE" };
  const r = raw as Record<string, unknown>;
  const pairs = contractPairs(r["contracts"]) ?? [];
  const pick = (asset: string): FastspotContractSnapshot | null => {
    const c = pairs.find((x) => x.asset === asset);
    return c ? { status: c.status } : null;
  };
  const secret = r["preimage"] ?? r["secret"];
  return {
    ok: true,
    swapStatus: token(r["status"]),
    nim: pick("NIM"),
    lightning: pick("BTC_LN"),
    otherContracts: pairs.filter((x) => x.asset !== "NIM" && x.asset !== "BTC_LN").length,
    hasPreimage: typeof secret === "string" && secret.length > 0,
    expiry: typeof r["expiry"] === "number" && Number.isFinite(r["expiry"]) ? Math.floor(r["expiry"]) : null,
    limitation: CONTRACT_STATUS_LIMITATION,
  };
}

/** One read-only GET. Never retries, never writes. */
export async function lookupFastspotSwap(hostSwapId: string, config: FastspotDiagConfig | null): Promise<FastspotDiagResult> {
  if (!config || !config.baseUrl || !config.apiKey) return { ok: false, code: "NOT_CONFIGURED" };
  const id = normalizeHostSwapId(hostSwapId);
  if (!id) return { ok: false, code: "BAD_SWAP_ID" };
  const doFetch = config.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? FASTSPOT_DIAG_TIMEOUT_MS);
  try {
    const res = await doFetch(`${config.baseUrl.replace(/\/+$/, "")}/swap/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Accept: "application/json", "X-FAST-ApiKey": config.apiKey },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, code: "HTTP_ERROR", httpStatus: res.status };
    return summarizeFastspotSwap(await res.json());
  } catch (err) {
    return { ok: false, code: (err as { name?: string })?.name === "AbortError" ? "TIMEOUT" : "BAD_RESPONSE" };
  } finally {
    clearTimeout(timer);
  }
}
