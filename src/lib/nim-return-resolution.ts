/**
 * R2 — evidence-gated resolution of a failed Nimiq Pay → Lightning handoff
 * whose locked NIM independently returned to its owner.
 *
 * Problem (incident 6f44918d, 2026-11-13): Nimiq Pay locked the sender's NIM
 * in a native HTLC and returned a hash, but the provider never received the
 * Lightning payment. The transfer stayed in LIGHTNING_HANDOFF forever and kept
 * the owner's single funding-exposure slot. P4's `closeExpiredUnfunded`
 * correctly refuses it: it only accepts RECONCILING and refuses any recorded
 * NIM funding (NIM_FUNDING_RECORDED), because it cannot prove the NIM came back.
 *
 * This sibling does NOT relax P4. It replaces the NIM_FUNDING_RECORDED
 * refusal with POSITIVE proof, and closes as EXPIRED_UNFUNDED only when ALL
 * of the following hold, re-verified at request time:
 *
 * Nimiq (verifyNimiqHtlcReturn, independent of Nimiq Pay and the provider):
 * - the recorded, previously VERIFIED source transaction re-verifies (HTLC
 *   creation, hash lock = bound payment hash, owner-authenticated sender,
 *   exact recorded amount, macro-final);
 * - the HTLC's complete history (two agreeing endpoints, never truncated) is
 *   exactly that funding plus ONE outgoing transaction, which is successful,
 *   macro-final, sent to the authenticated owner for value + fee equal to the
 *   full locked amount, under a TimeoutResolve/EarlyResolve owner proof (never
 *   a preimage RegularTransfer); and the HTLC now holds zero.
 *
 * Provider and Polygon (the exact P4 gates): fresh identity match, terminal
 * `expired`, no EVM fund/claim tx, every invoice copy expired by the settle
 * margin, pinned HTLC, and a finalized Polygon scan with NO activity for this
 * hash lock.
 *
 * Local records: source evidence VERIFIED and attributed to this transfer
 * only; the proof row's NIM hash equals it; the source owner is this user's
 * wallet; no EVM proof, movement, identity mismatch or live reservation.
 *
 * State: only the existing edges LIGHTNING_HANDOFF → OUTCOME_UNKNOWN →
 * RECONCILING → EXPIRED_UNFUNDED (or a suffix of that path) are written, all
 * in ONE transaction under the per-transfer lock, with the terminal-once
 * unique index making repeats and races converge. Exposure is derived from
 * status, so the slot is released exactly when that transaction commits.
 *
 * Never signs, broadcasts, claims or refunds anything.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reconciliationObservations, swapAttachments, transferProofs, transferTransitions, transfers, users } from "@/db/schema";
import { canTransition, type TransferStatus } from "@/domain/transfers";
import { getEnv } from "@/lib/env";
import { lockTransfer } from "@/lib/handoff";
import { getProviderSwap, resolveRoute, SatoraError, type VerifiedSwapFacts } from "@/lib/satora";
import { verifyNoHtlcActivity } from "@/lib/settlement";
import { isUniqueViolation, recordPath } from "@/lib/transitions";
import {
  assessProviderEvidence,
  chainRefusal,
  EVIDENCE_MAX_AGE_MS,
  readLocalEvidence,
  refusal as p4Refusal,
  scanWindow,
  type LocalEvidence,
  type ResolutionRefusal,
  type ResolutionResult,
} from "@/lib/expiry-resolution";
import {
  normalizeNimiqSourceHash,
  verifyNimiqHtlcReturn,
  type NimiqHtlcReturnFailureCode,
  type NimiqHtlcReturnVerification,
  type VerifiedNimiqHtlcReturn,
} from "@/lib/nimiq-source";
import { normalizeNimiqAddress } from "@/lib/nimiq";

import { NIM_RETURN_REASON_CODE, recordedReturn } from "@/lib/nim-return-record";

type Db = ReturnType<typeof getDb>;
type Reader = Pick<Db, "select">;

export { NIM_RETURN_REASON_CODE, recordedReturn };

/** Existing legal edges only; each path ends in EXPIRED_UNFUNDED. */
export const NIM_RETURN_PATHS: Readonly<Partial<Record<TransferStatus, readonly TransferStatus[]>>> = {
  LIGHTNING_HANDOFF: ["OUTCOME_UNKNOWN", "RECONCILING", "EXPIRED_UNFUNDED"],
  OUTCOME_UNKNOWN: ["RECONCILING", "EXPIRED_UNFUNDED"],
  RECONCILING: ["EXPIRED_UNFUNDED"],
};

export type NimReturnRefusal =
  | ResolutionRefusal
  | "NIM_SOURCE_NOT_VERIFIED"
  | "NIM_SOURCE_AMBIGUOUS"
  | "NIM_RETURN_NOT_CONFIGURED"
  | "NIM_STILL_LOCKED"
  | "NIM_REDEEMED"
  | "NIM_RETURN_UNPROVEN"
  | "NIM_RETURN_NOT_FINAL"
  | "NIM_RETURN_UNAVAILABLE";

const NIM_COPY: Record<Exclude<NimReturnRefusal, ResolutionRefusal>, { status: number; message: string }> = {
  NIM_SOURCE_NOT_VERIFIED: { status: 409, message: "Thence hasn't verified the NIM payment for this transfer, so it can't confirm a return. It stays open." },
  NIM_SOURCE_AMBIGUOUS: { status: 409, message: "The NIM payment record for this transfer doesn't match. It stays open for review." },
  NIM_RETURN_NOT_CONFIGURED: { status: 503, message: "NIM checks aren't available right now. The payment stays open." },
  NIM_STILL_LOCKED: { status: 409, message: "Your NIM is still locked in Nimiq Pay's swap. Thence can close this only after it is returned to you." },
  NIM_REDEEMED: { status: 409, message: "The NIM lock was spent by the swap provider, not returned. It stays open for review — don't resend." },
  NIM_RETURN_UNPROVEN: { status: 409, message: "Thence couldn't prove your NIM came back in full. It stays open for review." },
  NIM_RETURN_NOT_FINAL: { status: 409, message: "The NIM return isn't final on the network yet. Check again later." },
  NIM_RETURN_UNAVAILABLE: { status: 503, message: "The Nimiq network check is temporarily unavailable. Try again shortly — the payment stays open." },
};

export function nimReturnRefusal(code: NimReturnRefusal): AuthError {
  if (code in NIM_COPY) {
    const { status, message } = NIM_COPY[code as keyof typeof NIM_COPY];
    return new AuthError(status, code, message);
  }
  return p4Refusal(code as ResolutionRefusal);
}

/** Map a Nimiq verifier failure to an owner-facing refusal (never a partial pass). */
export function nimReturnFailureRefusal(code: NimiqHtlcReturnFailureCode): NimReturnRefusal {
  switch (code) {
    case "NOT_CONFIGURED":
      return "NIM_RETURN_NOT_CONFIGURED";
    case "STILL_LOCKED":
    case "BEFORE_TIMEOUT":
      return "NIM_STILL_LOCKED";
    case "REDEEMED":
      return "NIM_REDEEMED";
    case "INSUFFICIENT_FINALITY":
      return "NIM_RETURN_NOT_FINAL";
    case "PROVIDER_UNAVAILABLE":
      return "NIM_RETURN_UNAVAILABLE";
    case "SOURCE_NOT_VERIFIED":
      return "NIM_SOURCE_NOT_VERIFIED";
    default:
      // INVALID_INPUT, PROVIDER_MALFORMED, WRONG_NETWORK, HISTORY_*, UNEXPECTED_SPEND,
      // WRONG_DESTINATION, AMOUNT_MISMATCH, UNSUCCESSFUL, INVALID_PROOF.
      return "NIM_RETURN_UNPROVEN";
  }
}

/** The independently VERIFIED source evidence recorded for this transfer. */
export interface RecordedNimiqSource {
  txHash: string;
  ownerAddress: string;
  amountLuna: string;
}

/**
 * Pure: pick the ONE verified source. Every VERIFIED marker must name the same
 * hash, owner and amount, and the proof row's hash must equal it.
 */
export function recordedVerifiedSource(
  evidenceRows: ReadonlyArray<Record<string, unknown>>,
  proofNimiqTxHash: string | null,
): RecordedNimiqSource | "NONE" | "AMBIGUOUS" {
  const verified = evidenceRows.filter((e) => e["nimiqSourceVerification"] === "VERIFIED");
  if (verified.length === 0) return "NONE";
  const shapes = verified.map((e) => {
    const txHash = normalizeNimiqSourceHash(e["nimiqSourceTxHash"]);
    let ownerAddress: string | null = null;
    try {
      ownerAddress = typeof e["nimiqSourceOwnerAddress"] === "string" ? normalizeNimiqAddress(e["nimiqSourceOwnerAddress"]) : null;
    } catch {
      ownerAddress = null;
    }
    const amountLuna = typeof e["nimiqSourceAmountLuna"] === "string" && /^[1-9]\d*$/.test(e["nimiqSourceAmountLuna"]) ? e["nimiqSourceAmountLuna"] : null;
    return { txHash, ownerAddress, amountLuna };
  });
  const first = shapes[0]!;
  if (!first.txHash || !first.ownerAddress || !first.amountLuna) return "AMBIGUOUS";
  if (shapes.some((s) => s.txHash !== first.txHash || s.ownerAddress !== first.ownerAddress || s.amountLuna !== first.amountLuna)) return "AMBIGUOUS";
  if (normalizeNimiqSourceHash(proofNimiqTxHash) !== first.txHash) return "AMBIGUOUS";
  return { txHash: first.txHash, ownerAddress: first.ownerAddress, amountLuna: first.amountLuna };
}

/** Pure local gates for R2 (P4's, except NIM funding must be PRESENT, not absent). */
export function assessLocalForNimReturn(status: string, local: LocalEvidence): NimReturnRefusal | null {
  if (!NIM_RETURN_PATHS[status as TransferStatus]) return "NOT_RESOLVABLE";
  if (!local.nimiqFundingRecorded) return "NIM_SOURCE_NOT_VERIFIED";
  if (local.evmProofRecorded) return "EVM_PROOF_RECORDED";
  if (local.identityMismatchObservations > 0) return "LOCAL_IDENTITY_MISMATCH_RECORDED";
  if (local.movementObservations > 0) return "LOCAL_MOVEMENT_RECORDED";
  if (local.activeReservations > 0) return "ATTEMPT_STILL_RESERVED";
  return null;
}

async function readRecordedSource(db: Reader, transferId: string): Promise<RecordedNimiqSource | "NONE" | "AMBIGUOUS"> {
  const rows = await db
    .select({ evidence: transferTransitions.evidence })
    .from(transferTransitions)
    .where(and(eq(transferTransitions.transferId, transferId), sql`${transferTransitions.evidence}->>'nimiqSourceVerification' = 'VERIFIED'`))
    .orderBy(asc(transferTransitions.createdAt));
  const proof = await db.select({ nimiqTxHash: transferProofs.nimiqTxHash }).from(transferProofs).where(eq(transferProofs.transferId, transferId)).limit(1);
  return recordedVerifiedSource(rows.map((r) => (r.evidence ?? {}) as Record<string, unknown>), proof[0]?.nimiqTxHash ?? null);
}

/** No other transfer may own this source hash (mirrors R1 attribution). */
async function sourceAttributedElsewhere(db: Reader, transferId: string, txHash: string): Promise<boolean> {
  const rows = await db.select({ transferId: transferProofs.transferId, nimiqTxHash: transferProofs.nimiqTxHash }).from(transferProofs);
  return rows.some((r) => r.transferId !== transferId && normalizeNimiqSourceHash(r.nimiqTxHash) === txHash);
}

/** Non-secret evidence persisted with every hop of the audited path. */
export interface NimReturnEvidence {
  version: 1;
  gatheredAt: string;
  provider: { satoraSwapId: string; status: string; invoiceExpiresAt: string | null; attachInvoiceExpiresAt: string | null; evmFundTxid: null; evmClaimTxid: null; identityMatch: true };
  chain: { chainId: number; htlcAddress: string; hashLock: string; windowStart: string; windowEnd: string; verdict: "NO_ACTIVITY"; fromBlock: string | null; toBlock: string | null; latestBlock: string | null };
  nimiq: { refundProof: "VERIFIED_ON_CHAIN"; rpcHost: string } & VerifiedNimiqHtlcReturn;
}

function rpcHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** Test seam: replace the Nimiq return verifier (null restores the real one). */
let returnVerifier: typeof verifyNimiqHtlcReturn = verifyNimiqHtlcReturn;
export function setNimReturnVerifierForTests(next: typeof verifyNimiqHtlcReturn | null): void {
  returnVerifier = next ?? verifyNimiqHtlcReturn;
}

export interface NimReturnResult extends ResolutionResult {
  nimReturn: { refundTxHash: string; returnedLuna: string; feeLuna: string } | null;
}

/**
 * Owner-initiated R2 close. Throws AuthError with a plain-language refusal on
 * any doubt; the payment then stays open and keeps its exposure slot.
 */
export async function closeExpiredNimReturned(userId: string, transferId: string): Promise<NimReturnResult> {
  const db = getDb();

  // ---- Phase A: gather evidence (no lock held during network I/O) ----
  const rows = await db.select().from(transfers).where(and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId))).limit(1);
  const transfer = rows[0];
  if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
  if (transfer.status === "EXPIRED_UNFUNDED") return { transferId, status: "EXPIRED_UNFUNDED", deduplicated: true, nimReturn: await recordedReturn(db, transferId) };
  if (!NIM_RETURN_PATHS[transfer.status as TransferStatus]) throw nimReturnRefusal("NOT_RESOLVABLE");
  const attachment = (await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1))[0];
  if (!attachment) throw nimReturnRefusal("NOT_BOUND");

  const gatheredAt = Date.now();
  const localA = await readLocalEvidence(db, transfer.id, gatheredAt);
  const localRefusal = assessLocalForNimReturn(transfer.status, localA);
  if (localRefusal) throw nimReturnRefusal(localRefusal);
  const source = await readRecordedSource(db, transfer.id);
  if (source === "NONE") throw nimReturnRefusal("NIM_SOURCE_NOT_VERIFIED");
  if (source === "AMBIGUOUS") throw nimReturnRefusal("NIM_SOURCE_AMBIGUOUS");
  const owner = (await db.select({ nimiqAddress: users.nimiqAddress }).from(users).where(eq(users.id, userId)).limit(1))[0];
  let walletAddress: string | null = null;
  try {
    walletAddress = owner ? normalizeNimiqAddress(owner.nimiqAddress) : null;
  } catch {
    walletAddress = null;
  }
  if (!walletAddress || walletAddress !== source.ownerAddress) throw nimReturnRefusal("NIM_SOURCE_AMBIGUOUS");
  if (await sourceAttributedElsewhere(db, transfer.id, source.txHash)) throw nimReturnRefusal("NIM_SOURCE_AMBIGUOUS");

  let facts: VerifiedSwapFacts;
  try {
    facts = await getProviderSwap(attachment.satoraSwapId);
  } catch (err) {
    if (err instanceof SatoraError && err.code === "SWAP_NOT_FOUND") throw nimReturnRefusal("PROVIDER_IDENTITY_MISMATCH");
    throw nimReturnRefusal("PROVIDER_UNAVAILABLE");
  }
  let routeMatches = false;
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    routeMatches = String(resolved.chainId) === String(facts.evmChainId) && resolved.tokenAddress.toLowerCase() === facts.targetTokenAddress.toLowerCase();
  } catch {
    throw nimReturnRefusal("PROVIDER_UNAVAILABLE");
  }
  const providerRefusal = assessProviderEvidence({ transfer, attachment, facts, routeMatches, now: gatheredAt });
  if (providerRefusal) throw nimReturnRefusal(providerRefusal);
  const window = scanWindow(attachment, facts);
  if (!window) throw nimReturnRefusal("INVOICE_NOT_SETTLED");
  const chain = await verifyNoHtlcActivity({
    chainId: facts.evmChainId,
    htlcAddress: facts.evmHtlcAddress,
    hashLock: attachment.paymentHash,
    windowStart: window.start,
    windowEnd: window.end,
  });
  const chainBlock = chainRefusal(chain);
  if (chainBlock) throw nimReturnRefusal(chainBlock);

  const env = getEnv();
  const url = env.THENCE_NIMIQ_PROOF_RPC_URL.trim();
  if (!url) throw nimReturnRefusal("NIM_RETURN_NOT_CONFIGURED");
  let verified: NimiqHtlcReturnVerification;
  try {
    verified = await returnVerifier({
      fundingTxHash: source.txHash,
      ownerAddress: source.ownerAddress,
      lightningPaymentHash: attachment.paymentHash,
      expectedAmountLuna: source.amountLuna,
      config: { url, network: env.THENCE_NIMIQ_NETWORK, minConfirmations: env.THENCE_NIMIQ_PROOF_MIN_CONFIRMATIONS },
    });
  } catch {
    throw nimReturnRefusal("NIM_RETURN_UNAVAILABLE");
  }
  if (!verified.ok) {
    console.warn(`thence-r2-close-refused ${JSON.stringify({ transfer: transfer.id.slice(0, 8), nimiq: verified.code })}`);
    throw nimReturnRefusal(nimReturnFailureRefusal(verified.code));
  }
  // Defense in depth: the verifier's evidence must describe exactly this source.
  const r = verified.evidence;
  if (r.fundingTxHash !== source.txHash || r.ownerAddress !== source.ownerAddress || r.destination !== source.ownerAddress || r.lockedLuna !== source.amountLuna) {
    throw nimReturnRefusal("NIM_RETURN_UNPROVEN");
  }
  if ((BigInt(r.returnedLuna) + BigInt(r.feeLuna)).toString() !== r.lockedLuna) throw nimReturnRefusal("NIM_RETURN_UNPROVEN");

  const evidence: NimReturnEvidence = {
    version: 1,
    gatheredAt: new Date(gatheredAt).toISOString(),
    provider: {
      satoraSwapId: facts.satoraSwapId,
      status: facts.status,
      invoiceExpiresAt: facts.invoiceExpiresAt?.toISOString() ?? null,
      attachInvoiceExpiresAt: attachment.invoiceExpiresAt?.toISOString() ?? null,
      evmFundTxid: null,
      evmClaimTxid: null,
      identityMatch: true,
    },
    chain: {
      chainId: facts.evmChainId,
      htlcAddress: (facts.evmHtlcAddress ?? "").toLowerCase(),
      hashLock: attachment.paymentHash.toLowerCase(),
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      verdict: "NO_ACTIVITY",
      fromBlock: chain.fromBlock,
      toBlock: chain.toBlock,
      latestBlock: chain.latestBlock,
    },
    nimiq: { refundProof: "VERIFIED_ON_CHAIN", rpcHost: rpcHostOf(url), ...r },
  };

  // ---- Phase B: commit under the per-transfer lock, re-verifying locally ----
  try {
    return await db.transaction(async (tx) => {
      await lockTransfer(tx, transfer.id);
      const current = (await tx.select().from(transfers).where(and(eq(transfers.id, transfer.id), eq(transfers.ownerUserId, userId))).limit(1))[0];
      if (!current) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
      if (current.status === "EXPIRED_UNFUNDED") return { transferId, status: "EXPIRED_UNFUNDED" as const, deduplicated: true, nimReturn: await recordedReturn(tx, transferId) };
      if (current.status !== transfer.status) throw nimReturnRefusal("NOT_RESOLVABLE");
      const path = NIM_RETURN_PATHS[current.status as TransferStatus];
      if (!path) throw nimReturnRefusal("NOT_RESOLVABLE");
      let from = current.status as TransferStatus;
      for (const to of path) {
        if (!canTransition(from, to)) throw nimReturnRefusal("NOT_RESOLVABLE");
        from = to;
      }
      const now = Date.now();
      if (now - gatheredAt > EVIDENCE_MAX_AGE_MS) throw nimReturnRefusal("EVIDENCE_STALE");
      const localB = await readLocalEvidence(tx, transfer.id, now);
      const againLocal = assessLocalForNimReturn(current.status, localB);
      if (againLocal) throw nimReturnRefusal(againLocal);
      const sourceB = await readRecordedSource(tx, transfer.id);
      if (sourceB === "NONE" || sourceB === "AMBIGUOUS" || sourceB.txHash !== source.txHash) throw nimReturnRefusal("NIM_SOURCE_AMBIGUOUS");
      if (await sourceAttributedElsewhere(tx, transfer.id, source.txHash)) throw nimReturnRefusal("NIM_SOURCE_AMBIGUOUS");
      const againProvider = assessProviderEvidence({ transfer: current, attachment, facts, routeMatches, now });
      if (againProvider) throw nimReturnRefusal(againProvider);

      await tx.update(transfers).set({ status: "EXPIRED_UNFUNDED", updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
      await recordPath(
        tx,
        { transferId: transfer.id, actor: "owner", actorUserId: userId, reasonCode: NIM_RETURN_REASON_CODE, evidence: evidence as unknown as Record<string, unknown> },
        current.status as TransferStatus,
        path,
      );
      await tx.insert(reconciliationObservations).values({
        transferId: transfer.id,
        satoraSwapId: attachment.satoraSwapId,
        providerStatus: facts.status,
        kind: "observation",
        errorCode: null,
        evmFundTxid: null,
        evmClaimTxid: null,
      });
      return {
        transferId,
        status: "EXPIRED_UNFUNDED" as const,
        deduplicated: false,
        nimReturn: { refundTxHash: r.refundTxHash, returnedLuna: r.returnedLuna, feeLuna: r.feeLuna },
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const settled = await db.select({ status: transfers.status }).from(transfers).where(eq(transfers.id, transfer.id)).limit(1);
      if (settled[0]?.status === "EXPIRED_UNFUNDED") return { transferId, status: "EXPIRED_UNFUNDED", deduplicated: true, nimReturn: await recordedReturn(db, transferId) };
    }
    throw err;
  }
}

