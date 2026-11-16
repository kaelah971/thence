/**
 * Claim-execution evidence: which (chain, HTLC version) claim paths have been
 * PROVEN to deliver, end to end, in production.
 *
 * Incident f1ca0926 (2026-11-16): the second live Arbitrum payment passed
 * every funding gate (pinned v6 HTLC, finalized funding, ACTIVE lifecycle),
 * the server authorized the claim, and the owner's browser claim then failed
 * without leaving a UserOperation, transaction or provider claim anywhere.
 * Arbitrum claims use a different mechanism from Polygon: the SDK sends a
 * sponsored ERC-4337 UserOperation (EIP-7702 Kernel v3.3 account,
 * EntryPoint v0.7, Satora's Alchemy bundler + gas policy) that runs
 * coordinator.redeemAndExecute plus a Uniswap v3 swap of the locked BTC token
 * to USDC. Polygon uses Satora's server-submitted gasless claim. Funding
 * verification proved nothing about that mechanism.
 *
 * Rule: a new payment may commit NIM only on a claim path listed here as
 * proven. Anything else fails closed BEFORE Nimiq Pay is asked to pay.
 * Existing transfers are never gated here: their claim, verify and refund
 * paths stay available (stopping them would turn funded payments into
 * refunds).
 *
 * A path is promoted only by a reviewed code change citing a verified live
 * delivery. An owner-approved canary can opt a path in temporarily with
 * THENCE_CLAIM_EXECUTION_CANARY ("42161:7" or "42161:6,42161:7").
 */
import { getEnv } from "@/lib/env";

export interface ClaimPathEvidence {
  readonly proven: boolean;
  readonly mechanism: "satora-gasless-relay" | "sponsored-userop-7702";
  readonly evidence: string;
}

/** Keyed `${chainId}:${htlcVersion}`. Missing = unproven. */
export const CLAIM_PATHS: Readonly<Record<string, ClaimPathEvidence>> = {
  "137:6": {
    proven: true,
    mechanism: "satora-gasless-relay",
    evidence: "Delivered in production since 2026-11-06 (NOV6/NOV7 public proofs; DELIVERED_SHORT 2b24ca8f).",
  },
  "42161:6": {
    proven: false,
    mechanism: "sponsored-userop-7702",
    evidence: "f1ca0926 (2026-11-16): claim authorized, browser claim failed before any UserOperation landed. Never delivered.",
  },
  "42161:7": {
    proven: false,
    mechanism: "sponsored-userop-7702",
    evidence: "No production claim has been attempted on v7.",
  },
};

const PATH_RE = /^\d{1,7}:\d{1,4}$/;

/** Canary opt-ins from the environment; malformed entries are ignored (fail closed). */
export function canaryClaimPaths(raw: string | undefined = getEnv().THENCE_CLAIM_EXECUTION_CANARY): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim()).filter((s) => PATH_RE.test(s) && s in CLAIM_PATHS));
}

export function isClaimPathExecutable(chainId: number, htlcVersion: number | null | undefined, canary: ReadonlySet<string> = canaryClaimPaths()): boolean {
  if (htlcVersion === null || htlcVersion === undefined) return false;
  const key = `${chainId}:${htlcVersion}`;
  return CLAIM_PATHS[key]?.proven === true || canary.has(key);
}

/**
 * Route-level gate before any quote or swap exists: the provider picks the
 * HTLC version only at swap creation, so a chain is open for new payments
 * only when at least one of its claim paths is executable. The per-version
 * check in the HTLC preflight still refuses an unproven version at bind and
 * again at authorize.
 */
export function isChainClaimExecutable(chainId: number, canary: ReadonlySet<string> = canaryClaimPaths()): boolean {
  return Object.keys(CLAIM_PATHS).some((key) => key.startsWith(`${chainId}:`) && isClaimPathExecutable(chainId, Number(key.split(":")[1]), canary));
}

/** EVM chain id for a route network name; null for non-EVM networks. */
export const EVM_NETWORK_CHAIN_IDS: Readonly<Record<string, number>> = { Ethereum: 1, Polygon: 137, Arbitrum: 42161, Base: 8453 };

/** True when a new payment to this route network may proceed (non-EVM networks are not gated here). */
export function isNetworkClaimExecutable(network: string, canary: ReadonlySet<string> = canaryClaimPaths()): boolean {
  const chainId = EVM_NETWORK_CHAIN_IDS[network];
  return chainId === undefined ? true : isChainClaimExecutable(chainId, canary);
}

export const CLAIM_PATH_UNPROVEN_MESSAGE =
  "Delivery on this network is paused while its claim path is verified. Nothing was sent to Nimiq Pay and no NIM was spent.";
