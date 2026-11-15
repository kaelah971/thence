/**
 * Payment reliability milestone — regression guards for the failures Thence
 * actually hit (2026-11-02 … 2026-11-15). Each case names the incident shape
 * it protects. Offline: no DB, no network, no provider calls.
 *
 * What these lock in:
 * - Host failures (wallet not ready, Fastspot swap creation, unknown outcome)
 *   stay "unknown" — never a client-side claim that nothing moved.
 * - The recovery screen has ONE kind and ONE primary action per payment.
 * - Close actions surface only from the server's close-gate preview, which
 *   runs the SAME pure gates as the close actions themselves.
 */
import { describe, expect, it } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { payAuthorizedInvoice, type LightningCapableProvider, type PaymentDiagnostics } from "@/ui/lib/nimiq-pay";
import { mapHostResultToServerOutcome } from "@/ui/lib/handoff-client";
import { closeActionFor, recoveryState, UNCERTAIN_TITLE, type RecoveryInput } from "@/ui/lib/recovery-state";
import type { ProviderEvidence } from "@/ui/lib/settlement-client";
import { paymentProgress } from "@/ui/lib/payment-progress";
import { friendlyMessage } from "@/ui/lib/api";
import { assessCloseEligibility, CLOSE_PREVIEW_UNAVAILABLE } from "@/lib/close-eligibility";
import { EXPIRY_SETTLE_MARGIN_MS, type LocalEvidence } from "@/lib/expiry-resolution";
import { TRUSTED_HTLC_CONTRACTS } from "@/lib/settlement";
import type { VerifiedSwapFacts } from "@/lib/satora";
import type { swapAttachments, transfers } from "@/db/schema";
import { TRANSFER_STATUSES, type TransferStatus } from "@/domain/transfers";

const INVOICE = "lnbc13720n1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq";
const NOW = Date.parse("2026-11-15T06:00:00.000Z");
const DEST = "0x00000000000000000000000000000000000000aa";
const TOKEN = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const HASH = "cd".repeat(32);
const HTLC = TRUSTED_HTLC_CONTRACTS[137]![0]!;

/* ------------------------------------------------------------------ */
/* Host failures stay unknown (client evidence is never proof)          */
/* ------------------------------------------------------------------ */

function hostThrows(error: unknown): LightningCapableProvider {
  return {
    payLightningInvoice: (async () => {
      throw NimiqProviderError.from(error) ?? error;
    }) as LightningCapableProvider["payLightningInvoice"],
  };
}

async function pay(error: unknown): Promise<{ kind: string; diag: PaymentDiagnostics }> {
  let diag: PaymentDiagnostics | null = null;
  const res = await payAuthorizedInvoice(hostThrows(error), INVOICE, { onDiagnostics: (d) => (diag = d) });
  return { kind: res.kind, diag: diag! };
}

describe("host failures never become a 'nothing moved' claim", () => {
  it("Nimiq Pay wallet not ready (2026-11-14 c24a4971/b7f3682f: NETWORK_ERROR -32000, no hash/swap) → unknown", async () => {
    const { kind, diag } = await pay({ code: -32000, type: "NETWORK_ERROR", message: "NIM wallet is not ready" });
    expect(kind).toBe("unknown");
    expect(mapHostResultToServerOutcome({ kind: "unknown", reason: "x" })).toBe("unknown");
    expect(diag).toMatchObject({ normalizedOutcome: "unknown", hasHash: false, hasSwapId: false });
  });

  it("Fastspot swap-creation failure (821ae86c shape: 'Cannot create swap') → unknown, reason code only", async () => {
    const { kind, diag } = await pay({ code: -32602, type: "INVALID_TRANSACTION", message: "Cannot create swap" });
    expect(kind).toBe("unknown");
    expect(diag.providerReason).toBe("SWAP_CREATE_FAILED");
    expect(JSON.stringify(diag)).not.toContain("Cannot create swap");
  });

  it("Fastspot gateway timeout text (504) is not on the allowlist → still unknown, UNRECOGNIZED", async () => {
    const { kind, diag } = await pay({ code: -32602, type: "INVALID_TRANSACTION", message: "Cannot create swap: 504 Gateway Time-out" });
    expect(kind).toBe("unknown");
    expect(diag.providerReason).toBe("UNRECOGNIZED");
  });

  it("unknown outcome after attempted submission (TRANSACTION_OUTCOME_UNKNOWN) → unknown", async () => {
    const { kind } = await pay({ code: -32603, type: "TRANSACTION_OUTCOME_UNKNOWN", message: "Transaction outcome unknown" });
    expect(kind).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* Client recovery classification                                       */
/* ------------------------------------------------------------------ */

function evidence(status: TransferStatus, over: Partial<ProviderEvidence> = {}): ProviderEvidence {
  return {
    transferId: "t1",
    transferStatus: status,
    providerStatus: "expired",
    invoiceExpired: true,
    invoiceExpiresAt: "2026-11-15T05:00:00.000Z",
    sourceSats: "1372",
    targetAtomic: "1000000",
    identityMatch: true,
    hasEvmFundingTx: false,
    hasEvmClaimTx: false,
    observedAt: "2026-11-15T05:59:00.000Z",
    closeEligibility: {
      expiredUnfunded: { eligible: false, reason: "NOT_RESOLVABLE", message: "This payment can't be closed this way. Check its status in Activity." },
      nimReturn: { eligible: false, reason: "NIM_SOURCE_NOT_VERIFIED", message: "x" },
    },
    ...over,
  };
}
const gate = (eligible: boolean, reason: string | null = null, message: string | null = null) => ({ eligible, reason, message });
const view = (input: RecoveryInput) => recoveryState(input);

describe("ONE recovery kind and ONE primary action per payment", () => {
  it("every status maps to exactly one kind and a single primary action", () => {
    for (const status of TRANSFER_STATUSES) {
      const v = view({ status, evidence: null });
      expect(["preparation", "uncertain", "funds-moved", "expired-closable", "closed"]).toContain(v.kind);
      expect(typeof v.primary).toBe("string");
      // Without server evidence nothing is ever closable.
      expect(v.kind).not.toBe("expired-closable");
    }
  });

  it("1. preparation that never completed: resume, no movement claimed", () => {
    for (const status of ["QUOTED", "SWAP_CREATED"] as const) {
      const v = view({ status, evidence: null });
      expect(v).toMatchObject({ kind: "preparation", primary: "resume" });
    }
    expect(view({ status: "AWAITING_NIM_APPROVAL", evidence: null })).toMatchObject({ kind: "preparation", primary: "resume" });
  });

  it("1. swap expired before approval (provider expired, identity match): cancel-unpaid is primary", () => {
    const v = view({ status: "AWAITING_NIM_APPROVAL", evidence: evidence("AWAITING_NIM_APPROVAL") });
    expect(v).toMatchObject({ kind: "preparation", primary: "cancel-unpaid" });
  });

  it("2. unknown outcome after submission (OUTCOME_UNKNOWN / RECONCILING): uncertain + the single status check", () => {
    for (const status of ["OUTCOME_UNKNOWN", "RECONCILING"] as const) {
      const v = view({ status, evidence: null });
      expect(v).toMatchObject({ kind: "uncertain", primary: "check-status", title: UNCERTAIN_TITLE });
      expect(v.body).toMatch(/not proof that funds moved, and it is not proof that they stayed put/);
      expect(v.body).not.toMatch(/locked|refunded|returned|delivered|no money moved|nothing (was )?paid/i);
    }
  });

  it("2. missing/delayed NIM source verification: LIGHTNING_HANDOFF stays uncertain until the server verifies it", () => {
    expect(view({ status: "LIGHTNING_HANDOFF", evidence: null, sourceVerified: false })).toMatchObject({ kind: "uncertain", primary: "check-status" });
    expect(view({ status: "LIGHTNING_HANDOFF", evidence: null, sourceVerified: true })).toMatchObject({ kind: "funds-moved", primary: "live" });
  });

  it("2. invoice expiry alone (expired but unverified) never surfaces a close", () => {
    // Provider says expired, but the server's gate refused (e.g. invoice only just expired).
    const ev = evidence("RECONCILING", {
      closeEligibility: { expiredUnfunded: gate(false, "INVOICE_NOT_SETTLED", "This payment only just expired. Check again in a few minutes."), nimReturn: gate(false, "NIM_SOURCE_NOT_VERIFIED") },
    });
    const v = view({ status: "RECONCILING", evidence: ev });
    expect(v).toMatchObject({ kind: "uncertain", primary: "check-status" });
    expect(v.body).toContain("This payment only just expired.");
    // An older server without the gate preview: never closable either.
    const legacy = evidence("RECONCILING");
    delete legacy.closeEligibility;
    expect(view({ status: "RECONCILING", evidence: legacy }).primary).toBe("check-status");
  });

  it("2. provider-reported funding is not independent verification: stays uncertain, no close", () => {
    const v = view({ status: "RECONCILING", evidence: evidence("RECONCILING", { providerStatus: "serverfunded", hasEvmFundingTx: true }) });
    expect(v).toMatchObject({ kind: "uncertain", primary: "check-status" });
    expect(v.body).toMatch(/hasn't independently verified/);
  });

  it("3. funds verified as moved (CLIENT_FUNDED / SERVER_FUNDED / CLAIMING): the live card owns the action", () => {
    for (const status of ["CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"] as const) {
      expect(view({ status, evidence: null })).toMatchObject({ kind: "funds-moved", primary: "live" });
    }
  });

  it("4. verified expired and unfunded (server P4 gate passes): Close expired payment is the one action", () => {
    const ev = evidence("RECONCILING", { closeEligibility: { expiredUnfunded: gate(true), nimReturn: gate(false, "NIM_SOURCE_NOT_VERIFIED") } });
    const v = view({ status: "RECONCILING", evidence: ev });
    expect(v).toMatchObject({ kind: "expired-closable", primary: "close-expired" });
    // It names what is and isn't known; never a NIM refund claim.
    expect(v.body).not.toMatch(/NIM (was|has been) (refunded|returned)/i);
  });

  it("4. the server gate must be for THIS status: a stale read from before a status change never closes", () => {
    const ev = evidence("RECONCILING", { closeEligibility: { expiredUnfunded: gate(true), nimReturn: gate(false) } });
    expect(closeActionFor("CLIENT_FUNDED", ev)).toBeNull();
    expect(view({ status: "CLIENT_FUNDED", evidence: ev }).kind).toBe("funds-moved");
  });

  it("4. NIM funded but Lightning handoff stalled + expired (6f44918d): only the R2 NIM-return check, server-gated", () => {
    const stalled = evidence("LIGHTNING_HANDOFF", { closeEligibility: { expiredUnfunded: gate(false, "NOT_RESOLVABLE"), nimReturn: gate(true) } });
    expect(view({ status: "LIGHTNING_HANDOFF", evidence: stalled, sourceVerified: true })).toMatchObject({ kind: "expired-closable", primary: "check-nim-return" });
    // Before the provider reports expiry the gate refuses: the payment keeps tracking live.
    const live = evidence("LIGHTNING_HANDOFF", { providerStatus: "pending", closeEligibility: { expiredUnfunded: gate(false, "NOT_RESOLVABLE"), nimReturn: gate(false, "PROVIDER_NOT_EXPIRED") } });
    expect(view({ status: "LIGHTNING_HANDOFF", evidence: live, sourceVerified: true })).toMatchObject({ kind: "funds-moved", primary: "live" });
  });

  it("5. delivered short (R7, 2b24ca8f): closed with the receipt, never plain 'Delivered'", () => {
    const v = view({ status: "DELIVERED_SHORT", evidence: null });
    expect(v).toMatchObject({ kind: "closed", primary: "receipt", title: "Delivered — less than requested", tone: "warn" });
  });

  it("5. normal successful delivery: closed with the receipt", () => {
    expect(view({ status: "DELIVERED", evidence: null })).toMatchObject({ kind: "closed", primary: "receipt", title: "Delivered", tone: "done" });
  });

  it("5. refunded / expired / cancelled / failed are closed with no action, even with a stale 'eligible' read", () => {
    const eligible = (status: TransferStatus) => evidence(status, { closeEligibility: { expiredUnfunded: gate(true), nimReturn: gate(true) } });
    for (const status of ["REFUNDED", "EXPIRED_UNFUNDED", "USER_CANCELLED", "QUOTE_EXPIRED", "FAILED"] as const) {
      expect(view({ status, evidence: eligible(status) })).toMatchObject({ kind: "closed", primary: "none" });
    }
  });

  it("preview/read-only screens never offer actions", () => {
    const ev = evidence("RECONCILING", { closeEligibility: { expiredUnfunded: gate(true), nimReturn: gate(false) } });
    expect(view({ status: "RECONCILING", evidence: ev, readOnly: true }).primary).toBe("none");
  });
});

/* ------------------------------------------------------------------ */
/* Rate-limit / backoff messaging stays visible                         */
/* ------------------------------------------------------------------ */

describe("rate-limit messaging", () => {
  it("a 429 has its own wording (never 'unavailable' or a payment verdict)", () => {
    expect(friendlyMessage({ kind: "rate-limited", code: "RATE_LIMITED" })).toBe("That's a lot of requests at once. Wait a moment, then try again.");
  });

  it("PR #80: the tracker's rate-limit message stays visible in the uncertain payment view", () => {
    const v = paymentProgress({
      phase: "checking",
      transferStatus: "RECONCILING",
      providerStatus: null,
      claimReady: false,
      receiptReady: false,
      message: "Too many checks at once — Thence will retry automatically.",
      sourceVerifiedAtMs: null,
    });
    expect(v.headline).toBe("Payment status still being verified");
    expect(v.body.startsWith("Too many checks at once")).toBe(true);
    expect(v.body).toMatch(/not proof that funds moved/);
  });
});

/* ------------------------------------------------------------------ */
/* Server close-gate preview = the close actions' own pure gates        */
/* ------------------------------------------------------------------ */

function transferRow(status: TransferStatus): typeof transfers.$inferSelect {
  return { id: "t1", status, targetAmountAtomic: "1000000", destination: DEST } as unknown as typeof transfers.$inferSelect;
}
function attachmentRow(): typeof swapAttachments.$inferSelect {
  return { satoraSwapId: "swap-1", paymentHash: HASH, invoiceExpiresAt: new Date(NOW - EXPIRY_SETTLE_MARGIN_MS - 60_000), createdAt: new Date(NOW - 3_600_000) } as unknown as typeof swapAttachments.$inferSelect;
}
function facts(over: Partial<VerifiedSwapFacts> = {}): VerifiedSwapFacts {
  return {
    satoraSwapId: "swap-1",
    direction: "lightning_to_evm",
    bolt11Invoice: INVOICE,
    paymentHash: HASH,
    sourceSats: "1372",
    targetAtomic: "1000000",
    evmChainId: 137,
    targetAddress: DEST,
    targetTokenAddress: TOKEN,
    targetTokenChainId: 137,
    status: "expired",
    invoiceExpiresAt: new Date(NOW - EXPIRY_SETTLE_MARGIN_MS - 60_000),
    feeSats: 0,
    evmHtlcAddress: HTLC,
    evmFundTxid: null,
    evmClaimTxid: null,
    ...over,
  } as VerifiedSwapFacts;
}
const NO_LOCAL: LocalEvidence = { movementObservations: 0, identityMismatchObservations: 0, evmProofRecorded: false, nimiqFundingRecorded: false, activeReservations: 0 };
const assess = (status: TransferStatus, over: { facts?: Partial<VerifiedSwapFacts>; local?: Partial<LocalEvidence>; routeMatches?: boolean; now?: number } = {}) =>
  assessCloseEligibility({
    transfer: transferRow(status),
    attachment: attachmentRow(),
    facts: facts(over.facts),
    routeMatches: over.routeMatches ?? true,
    local: { ...NO_LOCAL, ...over.local },
    now: over.now ?? NOW,
  });

describe("server close-gate preview", () => {
  it("verified expired + unfunded RECONCILING: P4 eligible; R2 refused (no NIM recorded)", () => {
    const g = assess("RECONCILING");
    expect(g.expiredUnfunded).toEqual({ eligible: true, reason: null, message: null });
    expect(g.nimReturn).toMatchObject({ eligible: false, reason: "NIM_SOURCE_NOT_VERIFIED" });
  });

  it("NIM funding recorded (stalled handoff): P4 refuses with its own copy; R2 is the only path", () => {
    const g = assess("RECONCILING", { local: { nimiqFundingRecorded: true } });
    expect(g.expiredUnfunded).toMatchObject({ eligible: false, reason: "NIM_FUNDING_RECORDED" });
    expect(g.expiredUnfunded.message).toMatch(/can't confirm it came back/);
    expect(g.nimReturn.eligible).toBe(true);
    expect(assess("LIGHTNING_HANDOFF", { local: { nimiqFundingRecorded: true } }).nimReturn.eligible).toBe(true);
  });

  it("expired but not yet settled (inside the settle margin): neither gate passes", () => {
    const g = assess("RECONCILING", { facts: { invoiceExpiresAt: new Date(NOW - 60_000) }, now: NOW });
    expect(g.expiredUnfunded.reason).toBe("INVOICE_NOT_SETTLED");
  });

  it("provider still pending, or reporting an EVM tx, or a route/identity mismatch: never eligible", () => {
    expect(assess("RECONCILING", { facts: { status: "pending" } }).expiredUnfunded.reason).toBe("PROVIDER_NOT_EXPIRED");
    expect(assess("RECONCILING", { facts: { evmFundTxid: "0x" + "11".repeat(32) } }).expiredUnfunded.reason).toBe("PROVIDER_REPORTS_EVM_TX");
    expect(assess("RECONCILING", { routeMatches: false }).expiredUnfunded.reason).toBe("PROVIDER_IDENTITY_MISMATCH");
    expect(assess("RECONCILING", { facts: { paymentHash: "ef".repeat(32) } }).expiredUnfunded.reason).toBe("PROVIDER_IDENTITY_MISMATCH");
  });

  it("local history blocks a close (movement seen, EVM proof, reservation still live)", () => {
    expect(assess("RECONCILING", { local: { movementObservations: 1 } }).expiredUnfunded.reason).toBe("LOCAL_MOVEMENT_RECORDED");
    expect(assess("RECONCILING", { local: { evmProofRecorded: true } }).expiredUnfunded.reason).toBe("EVM_PROOF_RECORDED");
    expect(assess("RECONCILING", { local: { activeReservations: 1 } }).expiredUnfunded.reason).toBe("ATTEMPT_STILL_RESERVED");
  });

  it("fails closed: an unreadable gate preview offers no close and stays uncertain", () => {
    const ev = evidence("RECONCILING", { closeEligibility: CLOSE_PREVIEW_UNAVAILABLE });
    expect(closeActionFor("RECONCILING", ev)).toBeNull();
    expect(view({ status: "RECONCILING", evidence: ev })).toMatchObject({ kind: "uncertain", primary: "check-status" });
  });

  it("P4 only from RECONCILING; terminal statuses are never eligible for either gate", () => {
    expect(assess("LIGHTNING_HANDOFF").expiredUnfunded.reason).toBe("NOT_RESOLVABLE");
    for (const status of ["DELIVERED", "DELIVERED_SHORT", "REFUNDED", "EXPIRED_UNFUNDED"] as const) {
      const g = assess(status, { local: { nimiqFundingRecorded: true } });
      expect(g.expiredUnfunded.eligible).toBe(false);
      expect(g.nimReturn.eligible).toBe(false);
    }
  });
});
