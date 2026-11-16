/**
 * Provider-declared HTLC deployment fields for Satora swap fixtures.
 *
 * Since the pre-handoff preflight (src/lib/htlc-preflight.ts), a swap can be
 * bound and handed to Nimiq Pay only when it declares a pinned deployment with
 * complete lock terms. Spread these FIRST into a fixture so a test's own
 * fields still override them.
 */
import { HTLC_DEPLOYMENTS } from "@/lib/settlement";

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
