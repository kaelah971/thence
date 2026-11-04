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
import { claimReadyNow } from "@/lib/reconcile";
import { CLAIM_UNSAFE_WINDOW_MS, claimWindowAt } from "@/domain/claim-deadline";

export const OWNER_ID = fixture._meta.redactions.ownerUserId;
export const INCIDENT = fixture.incident_077770a1;
export const STALE = fixture.stale_eddaa6de;
/** P3: synthetic claim tx for the delivered path (Nov 2 never had a claim; clearly not real). */
export const SYNTHETIC_CLAIM_TX = `0x${"5c".repeat(32)}`;

type Case = typeof INCIDENT | typeof STALE;

export interface ServerTransferState {
  status: TransferStatus;
  providerStatus: string;
  observedAt: string;
  /** P2: latest provider read diverged from the bound identity (server records identity_mismatch). */
  identityMismatch?: boolean;
  /** P1/P2: override the persisted claim deadline (ms epoch); null = not yet known (pre-backfill). */
  claimDeadlineMs?: number | null;
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
  /** P1: simulated network latency per request (fake timers advance it). */
  latencyMs: number;
  /** P1: answer POST /reconcile with 429 (shared write budget exhausted). */
  rateLimitReconcile: boolean;
  /** P1: highest number of concurrent in-flight requests observed. */
  maxInFlight: number;
  /** P1: requests whose AbortSignal fired before they completed. */
  aborted: number;
  /**
   * P3: POST /claim-intent. "server" mirrors src/lib/claim-intent.ts rules
   * (funded status, provider serverfunded, outside the 5-min unsafe window,
   * one live lease per transfer, SERVER_FUNDED → CLAIMING); a refusal returns
   * the given plain-language body unchanged.
   */
  claimIntentOutcome: { kind: "server" } | { kind: "refused"; status: number; error: string; message: string };
  /** P3: what POST /verify-settlement finds on chain next ("VERIFIED" moves the transfer to DELIVERED). */
  settlementVerdict: "VERIFIED" | "PENDING" | "INSUFFICIENT_CONFIRMATIONS" | "INVALID" | "UNAVAILABLE";
  /** P3: server claim lease expiry (ms epoch) per transfer. */
  claimLeaseUntil: Record<string, number>;
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

/** P2: the persisted Polygon claim deadline = Satora evm_refund_locktime from the real fixture. */
function claimDeadline(c: Case, s?: ServerTransferState): string | null {
  if (s && s.claimDeadlineMs !== undefined) return s.claimDeadlineMs === null ? null : new Date(s.claimDeadlineMs).toISOString();
  return new Date(c.satora.getSwap.evm_refund_locktime * 1000).toISOString();
}

function latest(c: Case, s: ServerTransferState, now: number) {
  const deadline = claimDeadline(c, s);
  const claimWindow = claimWindowAt(deadline === null ? null : Date.parse(deadline), now);
  return {
    transferId: c.transfer.id,
    status: s.status,
    statusLabel: USER_FACING_LABEL[s.status],
    providerStatus: s.providerStatus,
    observedAt: s.observedAt,
    claimReady: claimReadyNow({ transferStatus: s.status, providerStatus: s.providerStatus, latestKind: s.identityMismatch ? "identity_mismatch" : "observation", claimWindow }),
    ambiguous: false,
    ambiguityReasons: [],
    invoiceExpired: new Date(c.attachment.invoice_expires_at!).getTime() <= now,
    unknownProviderState: false,
    lastError: null,
    claimDeadlineAt: deadline,
    claimWindow,
    identityMismatch: s.identityMismatch === true,
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
      claimDeadline: claimDeadline(c, s),
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
  let inFlight = 0;
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://thence.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    calls.push({ method, path });
    inFlight += 1;
    api.maxInFlight = Math.max(api.maxInFlight, inFlight);
    try {
      if (api.latencyMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, api.latencyMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            api.aborted += 1;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return route(url, method, path);
    } finally {
      inFlight -= 1;
    }
  };
  const route = (url: URL, method: string, path: string): Response => {
    void url;
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
    if (sub === "handoff-result" && method === "POST") {
      return json(200, { handoff: { transferId: id, status: s.status, deduplicated: true } });
    }
    if (sub === "reconcile" && method === "POST") {
      if (api.rateLimitReconcile) return json(429, { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." });
      return json(200, { reconciliation: { ...latest(c, s, now), advanced: false, advancedPath: [] } });
    }
    if (sub === "provider-evidence" && method === "GET") return json(200, { evidence: providerEvidence(c, s, now) });
    if (sub === "receipt") {
      if (s.status !== "DELIVERED") return json(409, { error: "NOT_DELIVERED" });
      return json(200, {
        receipt: {
          transferId: id,
          recipientName: c.transfer.recipient_name,
          asset: c.transfer.target_asset,
          network: c.transfer.target_network,
          destination: c.transfer.destination,
          requestedAmountAtomic: c.transfer.target_amount_atomic,
          verifiedAmountAtomic: c.transfer.target_amount_atomic,
          provider: "satora",
          satoraSwapId: c.attachment.satora_swap_id,
          settlementTxHash: SYNTHETIC_CLAIM_TX,
          chainId: 137,
          blockNumber: "96634100",
          blockHash: `0x${"c1".repeat(32)}`,
          logIndexes: [7],
          finalityLevel: "confirmations-256",
          verifiedAt: new Date(now).toISOString(),
          explorerTxUrl: `https://polygonscan.com/tx/${SYNTHETIC_CLAIM_TX}`,
          quotedSourceSatsEstimate: c.attachment.source_sats,
          actualFundingProven: false,
        },
      });
    }
    if (sub === "claim-intent" && method === "POST") {
      const outcome = api.claimIntentOutcome;
      if (outcome.kind === "refused") return json(outcome.status, { error: outcome.error, message: outcome.message });
      if (s.status !== "SERVER_FUNDED" && s.status !== "CLAIMING") return json(409, { error: "NOT_CLAIMABLE", message: "This payment isn't funded and waiting to be finished." });
      if (s.providerStatus !== "serverfunded") return json(409, { error: "CLAIM_ALREADY_SUBMITTED", message: "A delivery attempt is already on record. Wait while Thence confirms it — don't try again." });
      const deadline = claimDeadline(c, s);
      if (deadline === null) return json(409, { error: "DEADLINE_UNKNOWN", message: "The delivery deadline isn't confirmed yet, so finishing stays unavailable." });
      if (Date.parse(deadline) - now <= CLAIM_UNSAFE_WINDOW_MS) return json(409, { error: "DEADLINE_TOO_CLOSE", message: "There isn't enough time left to finish delivery safely." });
      if ((api.claimLeaseUntil[id] ?? 0) > now) return json(409, { error: "CLAIM_IN_PROGRESS", message: "A delivery attempt was authorized for this payment in the last 10 minutes and may still be confirming. Wait while Thence checks it — don't try again." });
      api.claimLeaseUntil[id] = now + 10 * 60_000;
      const retry = s.status === "CLAIMING";
      state[id] = { ...s, status: "CLAIMING" };
      return json(200, {
        claim: {
          transferId: id,
          status: "CLAIMING",
          satoraSwapId: c.attachment.satora_swap_id,
          paymentHash: c.attachment.payment_hash,
          destination: c.transfer.destination,
          targetAmountAtomic: c.transfer.target_amount_atomic,
          claimDeadline: deadline,
          leaseExpiresAt: new Date(api.claimLeaseUntil[id]!).toISOString(),
          fundingConfirmations: 1200,
          retry,
        },
      });
    }
    if (sub === "verify-settlement" && method === "POST") {
      const verdict = api.settlementVerdict;
      if (verdict === "VERIFIED" && (s.status === "CLAIMING" || s.status === "SERVER_FUNDED" || s.status === "DELIVERED")) {
        state[id] = { ...s, status: "DELIVERED", providerStatus: s.providerStatus };
      }
      const after = state[id]!;
      return json(verdict === "UNAVAILABLE" ? 503 : verdict === "INVALID" ? 422 : 200, {
        settlement: {
          verdict,
          reason: verdict,
          transferId: id,
          status: after.status,
          providerStatus: after.providerStatus,
          claimTxHash: after.providerStatus === "serverfunded" ? null : SYNTHETIC_CLAIM_TX,
          proof: null,
          confirmations: verdict === "VERIFIED" ? 300 : 10,
        },
      });
    }
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
    latencyMs: 0,
    rateLimitReconcile: false,
    claimIntentOutcome: { kind: "server" },
    settlementVerdict: "PENDING",
    claimLeaseUntil: {},
    maxInFlight: 0,
    aborted: 0,
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
