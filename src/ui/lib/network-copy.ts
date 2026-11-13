/**
 * Route-aware wording for the settlement network (Polygon / Arbitrum).
 *
 * Pure copy helpers only: they never decide safety. Every claim and
 * settlement gate stays on the server (claim-intent, settlement verifier).
 *
 * Arbitrum timing: Thence authorizes an Arbitrum claim only after the
 * provider's funding is covered by the RPC's L1-anchored `finalized` block,
 * and records Delivered only after the claim is covered too. Observed on
 * arb1.arbitrum.io (2026-11-13): finalized trails the head by ~20 minutes.
 */
import { pairForRouteId } from "@/domain/routes";

export type SettlementNetwork = "Polygon" | "Arbitrum";

/** Settlement network for a route id; Polygon for anything else (the only live route). */
export function settlementNetworkFor(routeId: string | null | undefined): SettlementNetwork {
  return routeId ? (pairForRouteId(routeId)?.network === "Arbitrum" ? "Arbitrum" : "Polygon") : "Polygon";
}

/** Expected wait for chain verification after the claim, as shown to the owner. */
export function verifyEstimate(network: SettlementNetwork): string {
  return network === "Arbitrum" ? "about 20 minutes (Ethereum finality)" : "about 10 minutes";
}
