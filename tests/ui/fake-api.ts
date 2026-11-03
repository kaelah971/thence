/**
 * Fixture-backed fake of the Thence HTTP API for rendered (jsdom) tests.
 *
 * Serves ONLY the read/reconcile contracts the Send settlement screen and
 * Activity use, with response shapes copied from the real route handlers'
 * client types (src/ui/lib/settlement-client.ts, transfers-api.ts,
 * prepare-flow.ts, auth-client.ts). Transfer identities, amounts, swap ids,
 * hash locks and timestamps come from the redacted real incident fixture.
 *
 * Every request is recorded so tests can assert what the UI did — and, as
 * important, what it never did (no claim, no cancel, no new payment).
 */
import { vi } from "vitest";
import fixture from "../fixtures/incidents-2026-11-02.json";
import { USER_FACING_LABEL, type TransferStatus } from "@/domain/transfers";
import { isClaimReady } from "@/lib/reconcile";

export const OWNER_ID = fixture._meta.redactions.ownerUserId;
export const INCIDENT = fixture.incident_077770a1;
export const STALE = fixture.stale_eddaa6de;

type Case = typeof INCIDENT | typeof STALE;

export interface ServerTransferState {
  status: TransferStatus;
  providerStatus: string;
  observedAt: string;
}

export interface RecordedCall {
  method: string;
  path: string;
}

export interface FakeApi {
  state: Record<string, ServerTransferState>;
  calls: RecordedCall[];
  count(method: string, pathSuffix: string): number;
  set(transferId: string, next: Partial<ServerTransferState>): void;
  /**
   * P4: what POST /close-expired answers. "verified" mirrors the server's
   * successful evidence-gated close (status → EXPIRED_UNFUNDED); a refusal
   * mirrors its plain-language 409/503 body and leaves the status untouched.
   */
  closeOutcome: { kind: "verified" } | { kind: "refused"; status: number; error: string; message: string };
  restore(): void;
}

function caseFor(id: string): Case {
  if (id === INCIDENT.transfer.id) return INCIDENT;
  if (id === STALE.transfer.id) return STALE;
  throw new Error(`fake-api: unknown transfer ${id}`);
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function transferRecord(c: Case, s: ServerTransferState) {
  return {
    id: c.transfer.id,
    status: s.status,
    statusLabel: USER_FACING_LABEL[s.status],
    routeId: c.transfer.route_id,
    recipientName: c.transfer.recipient_name,
    asset: c.transfer.target_asset,
    network: c.transfer.target_network,
    destination: c.transfer.destination,
    targetAmountAtomic: c.transfer.target_amount_atomic,
    recipientDestinationId: null,
    createdAt: c.transfer.created_at,
    updatedAt: s.observedAt,
  };
}

function latest(c: Case, s: ServerTransferState, now: number) {
  return {
    transferId: c.transfer.id,
    status: s.status,
    statusLabel: USER_FACING_LABEL[s.status],
    providerStatus: s.providerStatus,
    observedAt: s.observedAt,
    claimReady: isClaimReady(s.status, s.providerStatus),
    ambiguous: false,
    ambiguityReasons: [],
    invoiceExpired: new Date(c.attachment.invoice_expires_at!).getTime() <= now,
    unknownProviderState: false,
    lastError: null,
  };
}

function reconciliationView(c: Case, s: ServerTransferState, now: number) {
  return {
    transfer: {
      id: c.transfer.id,
      status: s.status,
      statusLabel: USER_FACING_LABEL[s.status],
      routeId: c.transfer.route_id,
      asset: c.transfer.target_asset,
      network: c.transfer.target_network,
      destination: c.transfer.destination,
      targetAmountAtomic: c.transfer.target_amount_atomic,
    },
    attempt: {
      id: c.attempt.id,
      status: c.attempt.status,
      quoteRevision: c.attempt.quote_revision,
      handoffAuthorizedAt: c.attempt.handoff_authorized_at,
      expiresAt: c.attempt.expires_at,
    },
    swap: {
      satoraSwapId: c.attachment.satora_swap_id,
      sourceSats: c.attachment.source_sats,
      targetAtomic: c.attachment.target_atomic,
      paymentHash: c.attachment.payment_hash,
      invoiceBolt11: "lnbc-REDACTED",
      invoiceExpiresAt: c.attachment.invoice_expires_at,
      providerStatus: s.providerStatus,
      verifiedAt: c.attachment.verified_at,
    },
    latest: latest(c, s, now),
  };
}

function providerEvidence(c: Case, s: ServerTransferState, now: number) {
  const swap = c.satora.getSwap;
  return {
    transferId: c.transfer.id,
    transferStatus: s.status,
    providerStatus: swap.status,
    invoiceExpired: new Date(c.attachment.invoice_expires_at!).getTime() <= now,
    invoiceExpiresAt: c.attachment.invoice_expires_at,
    sourceSats: c.attachment.source_sats,
    targetAtomic: c.attachment.target_atomic,
    identityMatch: true,
    hasEvmFundingTx: swap.evm_fund_txid !== null,
    hasEvmClaimTx: swap.evm_claim_txid !== null,
    observedAt: c.satora.fetchedAt,
  };
}

/** Install the fake as global fetch. `initial` maps transfer id → server state. */
export function installFakeApi(initial: Record<string, ServerTransferState>): FakeApi {
  const state: Record<string, ServerTransferState> = { ...initial };
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://thence.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    calls.push({ method, path });
    const now = Date.now();
    if (path === "/api/me") {
      return json(200, {
        user: { id: OWNER_ID, nimiqAddress: "NQ00 REDA CTED 0000 0000 0000 0000 0000 0000", createdAt: "2026-10-30T00:00:00.000Z" },
        profile: { displayName: "Owner", onboardingCompletedAt: "2026-10-30T00:00:00.000Z" },
      });
    }
    if (path === "/api/transfers" && method === "GET") {
      const transfers = Object.entries(state).map(([id, s]) => transferRecord(caseFor(id), s));
      return json(200, { transfers, total: transfers.length, page: 1, pageSize: 50 });
    }
    const m = path.match(/^\/api\/transfers\/([^/]+)(?:\/([a-z-]+))?$/);
    if (!m) return json(404, { error: "NOT_FOUND" });
    const id = decodeURIComponent(m[1]!);
    const sub = m[2] ?? "";
    const s = state[id];
    if (!s) return json(404, { error: "NOT_FOUND" });
    const c = caseFor(id);
    if (sub === "" && method === "GET") return json(200, { transfer: transferRecord(c, s) });
    if (sub === "reconciliation" && method === "GET") return json(200, reconciliationView(c, s, now));
    if (sub === "reconcile" && method === "POST") {
      return json(200, { reconciliation: { ...latest(c, s, now), advanced: false, advancedPath: [] } });
    }
    if (sub === "provider-evidence" && method === "GET") return json(200, { evidence: providerEvidence(c, s, now) });
    if (sub === "receipt") return json(409, { error: "NOT_DELIVERED" });
    if (sub === "close-expired" && method === "POST") {
      const outcome = api.closeOutcome;
      if (outcome.kind === "refused") return json(outcome.status, { error: outcome.error, message: outcome.message });
      if (s.status === "EXPIRED_UNFUNDED") return json(200, { resolution: { transferId: id, status: "EXPIRED_UNFUNDED", deduplicated: true } });
      if (s.status !== "RECONCILING") return json(409, { error: "NOT_RESOLVABLE", message: "This payment can't be closed this way. Check its status in Activity." });
      state[id] = { ...s, status: "EXPIRED_UNFUNDED", observedAt: new Date(now).toISOString() };
      return json(200, { resolution: { transferId: id, status: "EXPIRED_UNFUNDED", deduplicated: false } });
    }
    // Anything else (claims, cancels, new payments) is outside what these
    // lifecycle tests allow: record it and refuse.
    return json(403, { error: "FORBIDDEN_IN_TEST" });
  };
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
  const api: FakeApi = {
    state,
    calls,
    closeOutcome: { kind: "verified" },
    count: (method, suffix) => calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length,
    set: (id, next) => {
      state[id] = { ...state[id]!, ...next };
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
  return api;
}
