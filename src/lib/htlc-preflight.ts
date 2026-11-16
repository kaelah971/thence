/**
 * Pre-handoff HTLC preflight: the last check before Nimiq Pay is asked to
 * commit NIM.
 *
 * Incident af9dc922 (2026-11-15): Satora created the Arbitrum swap on its
 * legacy HTLCErc20 v6 and DECLARED that at creation (`evm_htlc_version: 6`),
 * but Thence only checked the HTLC at claim time. NIM was locked, the claim
 * was refused FUNDING_INVALID, the provider refunded its side, and the NIM
 * stayed locked until the Nimiq HTLC timeout.
 *
 * Every field a later stage needs to verify, claim or refund this swap must
 * be present and match the pinned deployment table BEFORE the invoice is
 * released, otherwise the handoff is refused and nothing is paid:
 * - HTLC address, declared version, kind and coordinator: one pinned tuple
 *   for this chain (src/lib/settlement.ts HTLC_DEPLOYMENTS);
 * - locked token, amount, refund and claim addresses are present (the SwapKey
 *   that binds them is re-derived and checked on-chain at funding);
 * - the hash lock and claim deadline equal what was bound at attach;
 * - enough time remains before the deadline to fund, reach finality and claim.
 *
 * Pure: no I/O. Missing evidence is a refusal, never a pass.
 */
import { CLAIM_UNSAFE_WINDOW_MS } from "@/domain/claim-deadline";
import { trustedHtlcDeployment, type HtlcDeployment } from "@/lib/settlement";
import type { VerifiedSwapFacts } from "@/lib/satora";

export type HtlcPreflightCode = "HTLC_UNSUPPORTED" | "HTLC_TERMS_INCOMPLETE" | "HTLC_TERMS_MISMATCH" | "HTLC_DEADLINE_TOO_CLOSE";

export type HtlcPreflightResult =
  | { ok: true; deployment: HtlcDeployment }
  | { ok: false; code: HtlcPreflightCode; reason: string };

/**
 * Minimum time left before the EVM claim deadline when the invoice is
 * released: Lightning settlement and provider funding, the chain's funding
 * finality (Polygon 32 confirmations ≈ 1–2 min; Arbitrum L1 finality ≈ 20 min),
 * the claim itself, and the unsafe window in which no claim is offered.
 */
export const HANDOFF_MIN_CLAIM_RUNWAY_MS: Readonly<Record<number, number>> = {
  137: CLAIM_UNSAFE_WINDOW_MS + 10 * 60_000,
  42161: CLAIM_UNSAFE_WINDOW_MS + 30 * 60_000,
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_LOCK_RE = /^0x[0-9a-fA-F]{64}$/;

export function htlcPreflight(
  facts: VerifiedSwapFacts,
  opts: { nowMs: number; bound?: { paymentHash: string; evmRefundLocktime: Date | null } },
): HtlcPreflightResult {
  const no = (code: HtlcPreflightCode, reason: string): HtlcPreflightResult => ({ ok: false, code, reason });
  if (!facts.evmHtlcAddress) return no("HTLC_TERMS_INCOMPLETE", "The provider did not name its settlement contract.");
  const deployment = trustedHtlcDeployment(facts.evmChainId, facts.evmHtlcAddress);
  if (!deployment) return no("HTLC_UNSUPPORTED", "The provider chose a settlement contract Thence does not trust on this network.");
  if (facts.evmHtlcVersion === null || facts.evmHtlcVersion === undefined) return no("HTLC_TERMS_INCOMPLETE", "The provider did not declare its settlement contract version.");
  if (facts.evmHtlcVersion !== deployment.version) return no("HTLC_UNSUPPORTED", "The provider's declared contract version does not match the pinned deployment.");
  if (!facts.evmHtlcKind) return no("HTLC_TERMS_INCOMPLETE", "The provider did not declare its settlement contract kind.");
  if (facts.evmHtlcKind !== deployment.kind) return no("HTLC_UNSUPPORTED", "The provider's settlement contract kind is not supported.");
  if (!facts.evmCoordinatorAddress) return no("HTLC_TERMS_INCOMPLETE", "The provider did not name its settlement coordinator.");
  if (facts.evmCoordinatorAddress.toLowerCase() !== deployment.coordinator) return no("HTLC_UNSUPPORTED", "The provider's settlement coordinator is not the one paired with its contract.");
  if (!facts.evmHtlcTokenAddress || !ADDRESS_RE.test(facts.evmHtlcTokenAddress)) return no("HTLC_TERMS_INCOMPLETE", "The provider did not name the token it will lock.");
  if (!facts.evmHtlcAmountAtomic || !/^[0-9]+$/.test(facts.evmHtlcAmountAtomic) || BigInt(facts.evmHtlcAmountAtomic) <= 0n) {
    return no("HTLC_TERMS_INCOMPLETE", "The provider did not state a valid locked amount.");
  }
  const refund = facts.evmHtlcRefundAddress;
  const claim = facts.evmHtlcClaimAddress;
  if (!refund || !ADDRESS_RE.test(refund) || !claim || !ADDRESS_RE.test(claim)) return no("HTLC_TERMS_INCOMPLETE", "The provider did not state both lock parties.");
  if (refund.toLowerCase() === claim.toLowerCase()) return no("HTLC_TERMS_MISMATCH", "The lock's refund and claim parties are the same address.");
  if (!HASH_LOCK_RE.test(facts.paymentHash)) return no("HTLC_TERMS_INCOMPLETE", "The provider did not state a valid hash lock.");
  const locktime = facts.evmRefundLocktime;
  if (locktime === null) return no("HTLC_TERMS_INCOMPLETE", "The provider did not state the delivery deadline.");
  if (opts.bound) {
    if (opts.bound.paymentHash.toLowerCase() !== facts.paymentHash.toLowerCase()) return no("HTLC_TERMS_MISMATCH", "The hash lock differs from the bound swap.");
    const boundSec = opts.bound.evmRefundLocktime ? Math.floor(opts.bound.evmRefundLocktime.getTime() / 1000) : null;
    if (boundSec === null || boundSec !== locktime) return no("HTLC_TERMS_MISMATCH", "The delivery deadline differs from the bound swap.");
  }
  const runway = HANDOFF_MIN_CLAIM_RUNWAY_MS[facts.evmChainId];
  if (runway === undefined) return no("HTLC_UNSUPPORTED", "This network has no verified claim runway.");
  if (locktime * 1000 - opts.nowMs < runway) return no("HTLC_DEADLINE_TOO_CLOSE", "Too little time would remain to finish delivery after paying.");
  return { ok: true, deployment };
}
