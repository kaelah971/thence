/**
 * F4.2 — handoff result reporting (existing backend contract).
 *
 * POST /api/transfers/:id/handoff-result accepts one of the three client
 * outcomes plus optional bounded, non-secret handoff diagnostics.
 * The backend rejects funded/claimed/delivered/refunded/paid/success with
 * CLIENT_CANNOT_ATTEST — this module can never produce those strings
 * (typed union, plus a runtime guard).
 *
 * Idempotent: the backend returns `{ handoff: { status, deduplicated } }`;
 * duplicate reports converge without a second native payment.
 */
import { apiRequest, type ApiOptions, type ApiResult } from "./api";
import { kickPaymentTracker } from "./payment-tracker";
import type { HostPaymentResult, PaymentDiagnostics } from "./nimiq-pay";

export type ServerHandoffOutcome = "cancelled" | "initiated" | "unknown";

export interface HandoffReport {
  transferId: string;
  status: string;
  deduplicated: boolean;
}

type Opts = Pick<ApiOptions, "signal" | "fetch"> & {
  diagnostics?: PaymentDiagnostics | undefined;
  /** Host-reported hash only; the backend verifies it independently. */
  sourceTxHash?: string | undefined;
};

/** Map a host result onto the only outcomes the backend accepts. */
export function mapHostResultToServerOutcome(result: HostPaymentResult): ServerHandoffOutcome {
  switch (result.kind) {
    case "initiated":
      return "initiated";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** Report exactly one of cancelled/initiated/unknown. Anything else throws client-side. */
export async function reportHandoffResult(
  transferId: string,
  outcome: ServerHandoffOutcome,
  opts: Opts = {},
): Promise<ApiResult<{ handoff: HandoffReport }>> {
  if (outcome !== "cancelled" && outcome !== "initiated" && outcome !== "unknown") {
    throw new Error("Invalid handoff outcome.");
  }
  const { diagnostics, sourceTxHash, ...requestOpts } = opts;
  if (sourceTxHash !== undefined && !/^(?:0x)?[0-9a-fA-F]{64}$/.test(sourceTxHash)) {
    throw new Error("Invalid source transaction hash.");
  }
  if (outcome === "cancelled" && sourceTxHash !== undefined) {
    throw new Error("A cancelled handoff cannot include a source transaction hash.");
  }
  const body = {
    outcome,
    ...(diagnostics ? { diagnostics } : {}),
    ...(sourceTxHash ? { sourceTxHash } : {}),
  };
  try {
    return await apiRequest<{ handoff: HandoffReport }>(`/api/transfers/${encodeURIComponent(transferId)}/handoff-result`, {
      ...requestOpts,
      method: "POST",
      body,
    });
  } finally {
    // P1: back from the Nimiq Pay host (any outcome, even a lost report):
    // wake the shared lifecycle driver so approval/funding surface promptly.
    // Read-only refresh; never retries the native payment.
    kickPaymentTracker(transferId);
  }
}
