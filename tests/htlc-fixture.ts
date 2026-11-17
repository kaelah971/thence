/**
 * Provider-declared HTLC deployment fields for Satora swap fixtures.
 *
 * Since the pre-handoff preflight (src/lib/htlc-preflight.ts), a swap can be
 * bound and handed to Nimiq Pay only when it declares a pinned deployment with
 * complete lock terms. Spread these FIRST into a fixture so a test's own
 * fields still override them.
 */
import { computeHtlcSwapKey, HTLC_DEPLOYMENTS, SWAP_REDEEMED_EVENT_TOPIC } from "@/lib/settlement";

export const LOCK_TOKEN_POLYGON = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";
export const LOCK_REFUND_ADDRESS = "0x00000000000000000000000000000000000000a1";
export const LOCK_CLAIM_ADDRESS = "0x00000000000000000000000000000000000000b2";

/** Declared fields for a pinned deployment (default: the chain's first entry, or the given version). */
export function declaredHtlc(chainId: 137 | 42161, version?: 6 | 7): Record<string, unknown> {
  const deps = HTLC_DEPLOYMENTS[chainId] ?? [];
  const dep = version === undefined ? deps[0] : deps.find((d) => d.version === version);
  if (!dep) throw new Error(`no pinned HTLC v${version} on ${chainId}`);
  return {
    evm_htlc_address: dep.address,
    evm_htlc_version: dep.version,
    evm_htlc_kind: dep.kind,
    evm_coordinator_address: dep.coordinator,
    wbtc_address: LOCK_TOKEN_POLYGON,
    evm_expected_sats: "4000",
    server_evm_address: LOCK_REFUND_ADDRESS,
    client_evm_address: LOCK_CLAIM_ADDRESS,
  };
}

/**
 * The SwapRedeemed log a legitimate claim receipt carries for THIS swap
 * fixture: emitted by the fixture's pinned HTLC, topic[1] its hash lock and
 * topic[2] the complete SwapKey from its declared terms and locktime. Delivery
 * (exact or short) is verified only with this log present. `data` would be the
 * preimage on-chain; the fixture uses a dummy and nothing may read it.
 */
export function boundRedeemLog(
  swap: Record<string, unknown>,
  overrides: { logIndex?: number; address?: string; keyLocktimeSec?: number } = {},
): { address: string; topics: string[]; data: string; logIndex: number } {
  const text = (k: string): string => {
    const v = swap[k];
    if (typeof v !== "string" || v.length === 0) throw new Error(`swap fixture lacks ${k}`);
    return v;
  };
  const lock = swap["evm_refund_locktime"];
  if (typeof lock !== "number") throw new Error("swap fixture lacks a numeric evm_refund_locktime");
  const hashLock = text("hash_lock");
  const key = computeHtlcSwapKey({
    hashLock,
    amount: BigInt(text("evm_expected_sats")),
    token: text("wbtc_address"),
    refundAddress: text("server_evm_address"),
    claimAddress: text("client_evm_address"),
    timelock: BigInt(overrides.keyLocktimeSec ?? Math.floor(lock)),
  });
  return {
    address: overrides.address ?? text("evm_htlc_address"),
    topics: [SWAP_REDEEMED_EVENT_TOPIC, hashLock, key],
    data: `0x${"00".repeat(32)}`,
    logIndex: overrides.logIndex ?? 4,
  };
}
