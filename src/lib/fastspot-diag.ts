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

export interface FastspotSwapSnapshot {
  ok: true;
  swapStatus: string | null;
  contracts: Array<{ asset: string | null; status: string | null }>;
  hasPreimage: boolean;
  expiry: number | null;
}

export type FastspotDiagResult = FastspotSwapSnapshot | { ok: false; code: "NOT_CONFIGURED" | "BAD_SWAP_ID" | "HTTP_ERROR" | "TIMEOUT" | "BAD_RESPONSE"; httpStatus?: number };

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const token = (v: unknown): string | null => (typeof v === "string" && SAFE_TOKEN.test(v) ? v : null);

/** Reduce a raw Fastspot swap to the allowlisted, non-secret snapshot. */
export function summarizeFastspotSwap(raw: unknown): FastspotDiagResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "BAD_RESPONSE" };
  const r = raw as Record<string, unknown>;
  const contracts = Array.isArray(r["contracts"]) ? (r["contracts"] as unknown[]).slice(0, 4) : [];
  return {
    ok: true,
    swapStatus: token(r["status"]),
    contracts: contracts.map((c) => {
      const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
      return { asset: token(o["asset"]), status: token(o["status"]) };
    }),
    hasPreimage: typeof r["preimage"] === "string" && r["preimage"].length > 0,
    expiry: typeof r["expiry"] === "number" && Number.isFinite(r["expiry"]) ? Math.floor(r["expiry"]) : null,
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
