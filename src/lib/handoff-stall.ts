import { hostSwapIdPrefix } from "@/domain/host-swap-id";
/**
 * R3 — derived "stalled Lightning handoff" condition (no new transfer state).
 *
 * Evidence (read-only production comparison, 2026-11-13): on every genuine
 * delivered Polygon payment the provider saw the Lightning payment 23–34 s
 * after Nimiq Pay locked the NIM. On incident 6f44918d the NIM was locked and
 * verified within a minute, yet the provider stayed `pending` for an hour and
 * expired. The upstream reason is unknown; this module only detects it early.
 *
 * STALLED holds only when ALL of these hold:
 * - the transfer is still LIGHTNING_HANDOFF;
 * - the NIM source was independently VERIFIED on-chain (append-only evidence);
 * - the latest provider read is a successful observation reporting `pending`
 *   (never a provider error, identity mismatch or other status);
 * - that read was taken at least HANDOFF_STALL_MS after the anchor, and is no
 *   older than STALL_EVIDENCE_FRESH_MS (a stale read never proves a stall);
 * - no observation since the anchor reported anything other than `pending`.
 *
 * Anchor: the server's own timestamp of the first LIGHTNING_HANDOFF entry
 * (the moment Nimiq Pay returned the hash that was later verified) when it is
 * not after the verification time; otherwise the verification time. The NIM
 * lock is on-chain no later than either, so the anchor never starts early.
 *
 * Pure and display/alert-only: it never changes state, exposure, deadlines,
 * claims or refunds, and never asserts what happened upstream.
 */

/** Five minutes: ~9x the slowest observed successful handoff (34 s). */
export const HANDOFF_STALL_MS = 5 * 60_000;
/** A provider read older than this cannot establish a stall (reconciler runs every ~2 min). */
export const STALL_EVIDENCE_FRESH_MS = 5 * 60_000;

export interface StallObservation {
  id: string;
  providerStatus: string;
  kind: string;
  observedAt: Date;
}

export interface HandoffStallInput {
  status: string;
  sourceVerifiedAt: Date | null;
  handoffAt: Date | null;
  /** Observations for this transfer, any order. */
  observations: readonly StallObservation[];
  now: number;
}

export type HandoffStallReason =
  | "NOT_IN_HANDOFF"
  | "SOURCE_NOT_VERIFIED"
  | "TOO_EARLY"
  | "NO_PROVIDER_EVIDENCE"
  | "PROVIDER_ERROR"
  | "PROVIDER_NOT_PENDING"
  | "PROVIDER_EVIDENCE_STALE"
  | "STALLED";

export interface HandoffStall {
  stalled: boolean;
  reason: HandoffStallReason;
  /** ISO anchor (handoff or verification time); null when not applicable. */
  anchorAt: string | null;
  /** ISO time of the first pending read past the threshold; null unless stalled. */
  stalledSince: string | null;
  /**
   * True only when the latest observation IS the first pending read past the
   * threshold, i.e. the stall became observable in the cycle that recorded
   * it. Later cycles add newer observations, so this is deterministic across
   * restarts and never repeats for one transfer.
   */
  alertDue: boolean;
}

const none = (reason: HandoffStallReason, anchorAt: string | null = null): HandoffStall => ({
  stalled: false,
  reason,
  anchorAt,
  stalledSince: null,
  alertDue: false,
});

export function stallAnchor(sourceVerifiedAt: Date | null, handoffAt: Date | null): Date | null {
  if (!sourceVerifiedAt) return null;
  if (handoffAt && handoffAt.getTime() <= sourceVerifiedAt.getTime()) return handoffAt;
  return sourceVerifiedAt;
}

export function assessHandoffStall(input: HandoffStallInput): HandoffStall {
  if (input.status !== "LIGHTNING_HANDOFF") return none("NOT_IN_HANDOFF");
  const anchor = stallAnchor(input.sourceVerifiedAt, input.handoffAt);
  if (!anchor) return none("SOURCE_NOT_VERIFIED");
  const anchorAt = anchor.toISOString();
  const threshold = anchor.getTime() + HANDOFF_STALL_MS;
  if (input.now < threshold) return none("TOO_EARLY", anchorAt);

  const ordered = [...input.observations].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const latest = ordered[0];
  if (!latest) return none("NO_PROVIDER_EVIDENCE", anchorAt);
  if (latest.kind !== "observation") return none("PROVIDER_ERROR", anchorAt);
  if (latest.providerStatus !== "pending") return none("PROVIDER_NOT_PENDING", anchorAt);
  if (latest.observedAt.getTime() < threshold || input.now - latest.observedAt.getTime() > STALL_EVIDENCE_FRESH_MS) {
    return none("PROVIDER_EVIDENCE_STALE", anchorAt);
  }
  const sinceAnchor = ordered.filter((o) => o.observedAt.getTime() >= anchor.getTime());
  if (sinceAnchor.some((o) => o.kind === "observation" && o.providerStatus !== "pending")) return none("PROVIDER_NOT_PENDING", anchorAt);

  const pastThreshold = sinceAnchor.filter((o) => o.kind === "observation" && o.observedAt.getTime() >= threshold);
  const first = pastThreshold[pastThreshold.length - 1]!;
  return {
    stalled: true,
    reason: "STALLED",
    anchorAt,
    stalledSince: first.observedAt.toISOString(),
    alertDue: first.id === latest.id,
  };
}

/* ---------------- operator alert (existing logging) ---------------- */

/** In-process guard on top of alertDue: one line per transfer per process. */
const alerted = new Set<string>();
const ALERTED_MAX = 1000;

export type AlertSink = (line: string) => void;
let sink: AlertSink = (line) => console.warn(line);
/** Test seam: capture alert lines (null restores console.warn). */
export function setStallAlertSinkForTests(next: AlertSink | null): void {
  sink = next ?? ((line) => console.warn(line));
  alerted.clear();
}

/**
 * Emit ONE operator alert for a newly stalled handoff through the web journal
 * (same `thence-<topic> {json}` convention as thence-chain-scan). Non-secret:
 * transfer id, swap id prefix and timestamps only. Returns true if emitted.
 */
export function emitHandoffStallAlert(input: { transferId: string; satoraSwapId: string | null; hostSwapId?: string | null; stall: HandoffStall; now?: number }): boolean {
  if (!input.stall.stalled || !input.stall.alertDue || alerted.has(input.transferId)) return false;
  if (alerted.size >= ALERTED_MAX) alerted.clear();
  alerted.add(input.transferId);
  const now = input.now ?? Date.now();
  const minutes = input.stall.anchorAt ? Math.floor((now - Date.parse(input.stall.anchorAt)) / 60_000) : null;
  sink(
    `thence-alert ${JSON.stringify({
      alert: "LIGHTNING_HANDOFF_STALLED",
      transferId: input.transferId,
      swap: input.satoraSwapId ? input.satoraSwapId.slice(0, 8) : null,
      // R4: Fastspot swap id prefix (untrusted host hint). Full id: scripts/fastspot-diag.ts.
      hostSwap: input.hostSwapId ? hostSwapIdPrefix(input.hostSwapId) : null,
      providerStatus: "pending",
      anchorAt: input.stall.anchorAt,
      stalledSince: input.stall.stalledSince,
      minutesSinceHandoff: minutes,
      action: "Verified NIM lock but no Lightning payment at the provider. No automatic action taken.",
    })}`,
  );
  return true;
}
