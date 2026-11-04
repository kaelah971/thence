/**
 * Thence backend — canonical transfer state types + tested legal-transition
 * policy (B0). Source: PRD §9 (transfer state machine).
 *
 * Hard invariants (tested in tests/transfer-transitions.test.ts):
 * 1. OUTCOME_UNKNOWN NEVER transitions directly to FAILED (or any terminal
 *    failure). It must go through RECONCILING first.
 * 2. OUTCOME_UNKNOWN NEVER opens a new payment for the same transfer
 *    (no new handoff while unresolved).
 * 3. DELIVERED requires verified destination evidence — enforced by
 *    `assertDeliveredEvidence()` and the `DELIVERED` guard in TRANSITIONS.
 * 4. A stale quote cannot be silently reused (QUOTE_EXPIRED is terminal for
 *    that quote; a fresh QUOTE is required).
 * 5. A single BOLT11 invoice receives one handoff attempt (no re-handoff
 *    edge from LIGHTNING_HANDOFF back to itself or to a new handoff).
 */

export const TRANSFER_STATUSES = [
  "DRAFT",
  "QUOTED",
  "QUOTE_EXPIRED",
  "SWAP_CREATED",
  "AWAITING_NIM_APPROVAL",
  "USER_CANCELLED",
  "LIGHTNING_HANDOFF",
  "OUTCOME_UNKNOWN",
  "RECONCILING",
  "CLIENT_FUNDED",
  "SERVER_FUNDED",
  "CLAIMING",
  "NEEDS_ATTENTION",
  "REFUNDED",
  "DELIVERED",
  "FAILED",
  // P4: authorized payment whose provider swap expired with independently
  // verified evidence that nothing was funded on the provider/EVM side.
  // Says NOTHING about the NIM side (Nimiq Pay refunds its own HTLC).
  "EXPIRED_UNFUNDED",
] as const;

export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Terminal states — no outgoing edges. */
export const TERMINAL_STATUSES: ReadonlySet<TransferStatus> = new Set([
  "QUOTE_EXPIRED",
  "USER_CANCELLED",
  "REFUNDED",
  "DELIVERED",
  "FAILED",
  "EXPIRED_UNFUNDED",
]);

/**
 * Legal transition adjacency. Deliberately narrow:
 * - No edge OUTCOME_UNKNOWN -> FAILED (must reconcile first).
 * - No self-loop on LIGHTNING_HANDOFF (single-handoff rule).
 * - DELIVERED reachable only from CLAIMING or SERVER_FUNDED, and only
 *   with destination evidence (checked by callers via assertDeliveredEvidence).
 * - FAILED reachable only from RECONCILING, NEEDS_ATTENTION, CLAIMING or
 *   AWAITING_NIM_APPROVAL paths that carry explicit operator/evidence
 *   context — never directly from an unknown outcome.
 */
export const TRANSITIONS: Readonly<Record<TransferStatus, ReadonlyArray<TransferStatus>>> = {
  DRAFT: ["QUOTED"],
  // B4.3: quoted-but-unbound transfers may be cancelled pre-handoff
  // (nothing could have moved); bound-but-unauthorized likewise with
  // verified no funding. No other new edges were added.
  QUOTED: ["SWAP_CREATED", "QUOTE_EXPIRED", "DRAFT", "USER_CANCELLED"],
  QUOTE_EXPIRED: [],
  // B4.3: bound-but-unauthorized transfers may be cancelled pre-handoff
  // (verified no funding first). No other new edges were added.
  SWAP_CREATED: ["AWAITING_NIM_APPROVAL", "QUOTE_EXPIRED", "USER_CANCELLED"],
  AWAITING_NIM_APPROVAL: ["LIGHTNING_HANDOFF", "USER_CANCELLED", "QUOTE_EXPIRED"],
  USER_CANCELLED: [],
  LIGHTNING_HANDOFF: ["CLIENT_FUNDED", "OUTCOME_UNKNOWN"],
  OUTCOME_UNKNOWN: ["RECONCILING"],
  // P4: RECONCILING -> EXPIRED_UNFUNDED only through the evidence-gated,
  // audited resolution in src/lib/expiry-resolution.ts (never the planner's
  // automatic advance).
  RECONCILING: ["CLIENT_FUNDED", "SERVER_FUNDED", "NEEDS_ATTENTION", "CLAIMING", "REFUNDED", "OUTCOME_UNKNOWN", "EXPIRED_UNFUNDED"],
  CLIENT_FUNDED: ["SERVER_FUNDED", "OUTCOME_UNKNOWN", "NEEDS_ATTENTION", "REFUNDED"],
  SERVER_FUNDED: ["CLAIMING", "DELIVERED", "OUTCOME_UNKNOWN", "NEEDS_ATTENTION", "REFUNDED"],
  CLAIMING: ["DELIVERED", "OUTCOME_UNKNOWN", "NEEDS_ATTENTION", "REFUNDED", "FAILED"],
  NEEDS_ATTENTION: ["RECONCILING", "REFUNDED", "FAILED"],
  REFUNDED: [],
  DELIVERED: [],
  FAILED: [],
  EXPIRED_UNFUNDED: [],
};

export function isTerminal(status: TransferStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Legal-transition predicate (evidence for DELIVERED checked separately). */
export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  const next = TRANSITIONS[from];
  return next !== undefined && (next as readonly TransferStatus[]).includes(to);
}

export interface DestinationEvidence {
  /** EVM destination tx hash or Lightning settlement reference — required. */
  destinationTxHash?: string | null;
  /** Satora swap id or equivalent route proof — recommended alongside destination hash. */
  swapId?: string | null;
  /** Whether the destination amount was verified against the requested amount. */
  amountVerified?: boolean;
}

/**
 * Enforce the "Delivered requires verified destination evidence" rule.
 * Throws when evidence is insufficient. Call before persisting DELIVERED.
 */
export function assertDeliveredEvidence(evidence: DestinationEvidence): void {
  if (!evidence.destinationTxHash || evidence.destinationTxHash.trim().length === 0) {
    throw new Error("DELIVERED requires verified destination evidence (destinationTxHash)");
  }
  if (evidence.amountVerified !== true) {
    throw new Error("DELIVERED requires amount verification (amountVerified: true)");
  }
}

/**
 * Attempt a transition, returning the next state or throwing with a safe
 * message (no secrets). For `to === "DELIVERED"`, `evidence` is mandatory
 * and verified via assertDeliveredEvidence.
 */
export function transition(
  from: TransferStatus,
  to: TransferStatus,
  opts?: { evidence?: DestinationEvidence },
): TransferStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transfer transition: ${from} -> ${to}`);
  }
  if (to === "DELIVERED") {
    assertDeliveredEvidence(opts?.evidence ?? {});
  }
  return to;
}

/** User-facing label mapping (PRD §9.2 + messaging §13). */
export const USER_FACING_LABEL: Record<TransferStatus, string> = {
  DRAFT: "Ready to pay",
  QUOTED: "Ready to pay",
  QUOTE_EXPIRED: "Quote expired",
  SWAP_CREATED: "Ready to pay",
  AWAITING_NIM_APPROVAL: "Approve in Nimiq Pay",
  USER_CANCELLED: "Payment cancelled",
  LIGHTNING_HANDOFF: "Nimiq Pay submission — checking",
  OUTCOME_UNKNOWN: "Checking payment — do not resend",
  RECONCILING: "Checking payment — do not resend",
  CLIENT_FUNDED: "Converting",
  // P3: funded on Polygon = the OWNER must act (Finish delivery), never "on its way".
  SERVER_FUNDED: "Action needed — finish delivery",
  CLAIMING: "Finishing delivery",
  NEEDS_ATTENTION: "Needs attention",
  REFUNDED: "Not delivered — Polygon lock refunded",
  DELIVERED: "Delivered",
  FAILED: "Needs attention",
  EXPIRED_UNFUNDED: "Expired — not delivered",
};
