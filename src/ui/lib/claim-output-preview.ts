/**
 * Preview of the output floor the installed SDK will claim with, read BEFORE
 * claim authorization (no server claim lease is taken, nothing secret is
 * sent): the same public provider endpoints the SDK calls inside `claim()`
 * (lendaswap-sdk-pure 2.7.0 `claimViaGasless`):
 * - Arbitrum hub claim with a DEX leg (chain 42161, locked token != target):
 *   POST /dex-calldata/fund (exact_in of the locked amount, sender = the
 *   coordinator, 100 bps) → `estimated_amount_out` is the SDK's minAmountOut.
 * - Otherwise (Polygon): GET /swap/:id/redeem-and-swap-calldata?destination=
 *   → `min_amount_out`.
 * The disclosure guard (claim-safety.ts) re-checks the value the SDK actually
 * uses; this preview only decides whether the payer must accept a lower
 * minimum first (claim-deadline.ts outputFloorDecision).
 */
import { outputFloorDecision, type OutputFloorDecision } from "@/domain/claim-deadline";

export const SATORA_API_BASE = "https://api.satora.io";

export interface OutputPreview {
  requestedAtomic: string;
  minimumOutAtomic: string;
  decision: OutputFloorDecision;
}

export type OutputPreviewResult = { ok: true; preview: OutputPreview } | { ok: false; code: "PROVIDER_UNAVAILABLE" | "PROVIDER_MALFORMED" };

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC = /^[1-9][0-9]*$/;

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
}

export async function previewClaimOutput(input: { satoraSwapId: string; requestedAtomic: string; destination: string }, fetchFn: FetchLike = fetch as unknown as FetchLike, base = SATORA_API_BASE): Promise<OutputPreviewResult> {
  if (!ATOMIC.test(input.requestedAtomic) || !ADDRESS.test(input.destination)) return { ok: false, code: "PROVIDER_MALFORMED" };
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined;
  const get = async (url: string, init?: Parameters<FetchLike>[1]): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetchFn(url, { ...init, ...(signal ? { signal } : {}) });
      if (!res.ok) return null;
      const body = await res.json();
      return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const swap = await get(`${base}/swap/${encodeURIComponent(input.satoraSwapId)}`);
  if (!swap) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  const chainId = Number(str(swap, "evm_chain_id"));
  const lockToken = str(swap, "wbtc_address");
  const lockAmount = str(swap, "evm_expected_sats");
  const coordinator = str(swap, "evm_coordinator_address");
  const target = swap["target_token"] && typeof swap["target_token"] === "object" ? str(swap["target_token"] as Record<string, unknown>, "token_id") : null;
  if (!lockToken || !ADDRESS.test(lockToken) || !lockAmount || !ATOMIC.test(lockAmount) || !target || !ADDRESS.test(target)) return { ok: false, code: "PROVIDER_MALFORMED" };
  const arbitrumDex = chainId === 42161 && lockToken.toLowerCase() !== target.toLowerCase() && !swap["bridge_target_chain"];
  let minimum: string | null;
  if (arbitrumDex) {
    if (!coordinator || !ADDRESS.test(coordinator)) return { ok: false, code: "PROVIDER_MALFORMED" };
    const dex = await get(`${base}/dex-calldata/fund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { kind: "evm", chain_id: 42161, address: lockToken }, to: { kind: "evm", chain_id: 42161, address: target }, amount: { kind: "exact_in", value: lockAmount }, sender: coordinator, slippage_bps: 100 }),
    });
    if (!dex) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    minimum = str(dex, "estimated_amount_out");
  } else {
    const data = await get(`${base}/swap/${encodeURIComponent(input.satoraSwapId)}/redeem-and-swap-calldata?destination=${encodeURIComponent(input.destination)}`);
    if (!data) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    minimum = str(data, "min_amount_out");
  }
  if (!minimum || !ATOMIC.test(minimum)) return { ok: false, code: "PROVIDER_MALFORMED" };
  return { ok: true, preview: { requestedAtomic: input.requestedAtomic, minimumOutAtomic: minimum, decision: outputFloorDecision(BigInt(input.requestedAtomic), BigInt(minimum)) } };
}

/** "0.29" style display of 6-decimal USDC atomic units (display only). */
export function usdcDisplay(atomic: string): string {
  const v = BigInt(atomic);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}
