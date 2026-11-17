/**
 * P3 — server-side authorization of ONE owner claim attempt.
 *
 * The claim itself stays in the owner's browser: the preimage lives only in
 * the Satora SDK's IndexedDB and is revealed by the SDK's gasless `claim()`.
 * Thence never sees, stores or releases it. What this module adds is the
 * server half of "verify everything immediately before the claim":
 *
 * Phase A (no lock, no writes) gathers FRESH evidence:
 * - provider read: same swap, direction, hash lock, amount, destination,
 *   chain/token, deadline, still `serverfunded`, no claim/refund tx yet;
 * - chain read: the pinned HTLC's fund event for this hash lock with the
 *   bound deadline, mined, reorg-consistent, confirmed (verifyHtlcFunding).
 * Phase B (short, under the transfer lock) re-reads state, re-checks the
 * deadline against the five-minute unsafe window, takes a per-transfer
 * claim lease (job_leases, so a second tab or device is refused while one
 * attempt is live) and moves SERVER_FUNDED → CLAIMING with an audit row.
 *
 * Never claims, pays, refunds or releases anything. The pilot kill switch
 * deliberately does NOT gate this path: an already-funded payment must stay
 * deliverable, or stopping the pilot would turn funded payments into refunds.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { reconciliationObservations, swapAttachments, transfers, transferTransitions } from "@/db/schema";
import { boundHtlcTermsOf, boundTermsDrift, type BoundHtlcTerms } from "@/lib/htlc-preflight";
import { transition, type TransferStatus } from "@/domain/transfers";
import { CLAIM_UNSAFE_WINDOW_MS } from "@/domain/claim-deadline";
import { lockTransfer } from "@/lib/handoff";
import { getProviderSwap, resolveRoute, SatoraError, type VerifiedSwapFacts } from "@/lib/satora";
import { CLAIM_FUNDING_MIN_CONFIRMATIONS, trustedHtlcDeployment, verifyHtlcFunding, verifyHtlcLifecycle, verifyHtlcUnspent, type HtlcFundingResult, type HtlcLifecycleResult, type HtlcSpendVerdict } from "@/lib/settlement";
import { recordTransition } from "@/lib/transitions";
import { CLAIM_ACTIVITY_STATUSES } from "@/domain/provider-status";

/**
 * One authorized claim attempt holds the lease this long; a retry needs it
 * expired. P7: this is also the PENDING HORIZON. An unspent HTLC does not
 * prove that a relayed claim is not still pending in the mempool, so no
 * re-authorization happens until a claim submitted at the last authorization
 * would have been mined or dropped. (Defence in depth: the HTLC can be
 * redeemed only once, so a duplicate claim can never deliver twice — it can
 * only revert.) A retry additionally needs the provider showing no claim, the
 * chain showing the lock unspent, and the deadline outside the unsafe window.
 */
export const CLAIM_LEASE_MS = 10 * 60_000;
/** Evidence older than this at commit time is refused (the client retries). */
export const CLAIM_EVIDENCE_MAX_AGE_MS = 60_000;

const CLAIMABLE: ReadonlySet<string> = new Set(["SERVER_FUNDED", "CLAIMING"]);

export interface ClaimIntent {
  transferId: string;
  status: TransferStatus;
  satoraSwapId: string;
  paymentHash: string;
  destination: string;
  targetAmountAtomic: string;
  /** Polygon claim deadline (ISO) the server verified on-chain. */
  claimDeadline: string;
  leaseExpiresAt: string;
  fundingConfirmations: number | null;
  /** True when this re-authorizes a CLAIMING transfer whose earlier attempt left no claim on record. */
  retry: boolean;
  /**
   * Public HTLC facts the server authorized this claim against (no secrets: no
   * preimage, key or signature). The browser SDK must compare its own FRESH
   * provider read with these before revealing the preimage and refuse on any
   * difference. Addresses and token ids are lowercase.
   */
  htlc: AuthorizedHtlcFacts;
}

export interface AuthorizedHtlcFacts extends BoundHtlcTerms {
  /** Hash lock (same value as `ClaimIntent.paymentHash`), lowercase 0x-hex. */
  hashLock: string;
  /** Claim deadline, unix seconds (same instant as `ClaimIntent.claimDeadline`). */
  refundLocktimeSec: number;
  /** Provider-declared funding tx the server verified on-chain; null when the provider named none. */
  fundTxHash: string | null;
  /**
   * "bound": every term equals the record written when the swap was bound
   * (before any NIM moved). "legacy-pinned": the swap predates term binding;
   * only the pinned HTLC deployment (address, and declared version / kind /
   * coordinator) could be re-checked, so the browser must treat the terms as
   * provider-asserted and verify the chain itself.
   */
  termsBinding: "bound" | "legacy-pinned";
}

function refuse(status: number, code: string, message: string): never {
  throw new AuthError(status, code, message);
}

/** Pure claim gate mapping; a rehash is never followed automatically. */
export function claimLifecycleProblem(chainId: number, lifecycle: HtlcLifecycleResult | null): string | null {
  if (chainId !== 42161 || lifecycle?.verdict === "ACTIVE") return null;
  return lifecycle?.reason ?? "The Arbitrum HTLC lifecycle could not be verified.";
}

/**
 * The settlement terms bound at attach (SWAP_ATTACHED audit evidence).
 * - "legacy": no SWAP_ATTACHED row or no `htlc` record at all - the swap was
 *   bound before terms were recorded; a historical payment must stay
 *   recoverable, so it is checked against the pinned deployments only.
 * - "bound": a record exists; it must be complete AND equal the fresh read.
 *   A partial/malformed record is NEVER treated as legacy (fail closed).
 */
export type StoredBoundHtlc = { kind: "legacy" } | { kind: "bound"; htlc: unknown };

type ReadDb = Pick<ReturnType<typeof getDb>, "select">;

export async function readStoredBoundHtlc(db: ReadDb, transferId: string): Promise<StoredBoundHtlc> {
  const row = (
    await db
      .select({ evidence: transferTransitions.evidence })
      .from(transferTransitions)
      .where(and(eq(transferTransitions.transferId, transferId), eq(transferTransitions.reasonCode, "SWAP_ATTACHED")))
      .orderBy(desc(transferTransitions.createdAt))
      .limit(1)
  )[0];
  const evidence = row?.evidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return { kind: "legacy" };
  const htlc = (evidence as Record<string, unknown>)["htlc"];
  return htlc === undefined ? { kind: "legacy" } : { kind: "bound", htlc };
}

export interface BoundTermsProblem {
  code: "HTLC_TERMS_INCOMPLETE" | "HTLC_TERMS_MISMATCH";
  field: string;
  message: string;
}

/**
 * Pure: does the fresh provider read still equal what was bound (chain,
 * contract address/version/kind/coordinator, lock token, amount, parties, route
 * token)? Legacy rows (no record) are held to the pinned deployment table.
 */
export function claimBoundTermsProblem(stored: StoredBoundHtlc, facts: VerifiedSwapFacts): BoundTermsProblem | null {
  if (stored.kind === "legacy") {
    const deployment = trustedHtlcDeployment(facts.evmChainId, facts.evmHtlcAddress);
    if (!deployment) return { code: "HTLC_TERMS_MISMATCH", field: "htlcAddress", message: "The provider names a settlement contract Thence does not trust." };
    if (facts.evmHtlcVersion != null && facts.evmHtlcVersion !== deployment.version) return { code: "HTLC_TERMS_MISMATCH", field: "version", message: "The provider's declared contract version differs from the pinned deployment." };
    if (facts.evmHtlcKind != null && facts.evmHtlcKind !== deployment.kind) return { code: "HTLC_TERMS_MISMATCH", field: "kind", message: "The provider's declared contract kind differs from the pinned deployment." };
    if (facts.evmCoordinatorAddress != null && facts.evmCoordinatorAddress.toLowerCase() !== deployment.coordinator) return { code: "HTLC_TERMS_MISMATCH", field: "coordinator", message: "The provider's declared coordinator differs from the pinned deployment." };
    return null;
  }
  const drift = boundTermsDrift(stored.htlc, facts);
  if (drift === null) return null;
  if (drift === "missing") return { code: "HTLC_TERMS_INCOMPLETE", field: "missing", message: "This payment's recorded settlement terms are incomplete, so delivery can't be authorized." };
  return { code: "HTLC_TERMS_MISMATCH", field: drift, message: `The provider changed this payment's settlement terms (${drift}) after it was set up.` };
}

/** Public, secret-free HTLC facts for the browser's fresh-read comparison. Call only after the gates passed. */
export function authorizedHtlcFacts(
  facts: VerifiedSwapFacts,
  paymentHash: string,
  locktimeSec: number,
  termsBinding: AuthorizedHtlcFacts["termsBinding"],
): AuthorizedHtlcFacts {
  return {
    ...boundHtlcTermsOf(facts),
    hashLock: paymentHash.toLowerCase(),
    refundLocktimeSec: locktimeSec,
    fundTxHash: facts.evmFundTxid,
    termsBinding,
  };
}

type Evidence = { facts: VerifiedSwapFacts; routeMatches: boolean; funding: HtlcFundingResult; lifecycle: HtlcLifecycleResult | null; spend: HtlcSpendVerdict | null; stored: StoredBoundHtlc; gatheredAt: number };

async function gather(transfer: typeof transfers.$inferSelect, attachment: typeof swapAttachments.$inferSelect): Promise<Evidence> {
  let facts: VerifiedSwapFacts;
  try {
    facts = await getProviderSwap(attachment.satoraSwapId);
  } catch (err) {
    const code = err instanceof SatoraError ? err.code : "PROVIDER_UNAVAILABLE";
    refuse(503, code, "The provider can't be checked right now, so delivery can't be confirmed safe yet. Try again shortly.");
  }
  const stored = await readStoredBoundHtlc(getDb(), transfer.id);
  let routeMatches = false;
  try {
    const resolved = await resolveRoute(transfer.targetAsset, transfer.targetNetwork);
    routeMatches = String(resolved.chainId) === String(facts.evmChainId) && resolved.tokenAddress.toLowerCase() === facts.targetTokenAddress.toLowerCase();
  } catch {
    refuse(503, "PROVIDER_UNAVAILABLE", "Route configuration can't be checked right now. Try again shortly.");
  }
  const locktimeSec = attachment.evmRefundLocktime ? Math.floor(attachment.evmRefundLocktime.getTime() / 1000) : null;
  const funding: HtlcFundingResult =
    locktimeSec === null
      ? { verdict: "INCONCLUSIVE", reason: "The claim deadline is not known.", confirmations: null }
      : await verifyHtlcFunding({
          chainId: facts.evmChainId,
          htlcAddress: facts.evmHtlcAddress,
          hashLock: attachment.paymentHash,
          fundTxHash: facts.evmFundTxid,
          expectedLocktimeSec: locktimeSec,
          expectedTokenAddress: facts.evmHtlcTokenAddress,
          expectedAmountAtomic: facts.evmHtlcAmountAtomic,
          expectedRefundAddress: facts.evmHtlcRefundAddress,
          expectedClaimAddress: facts.evmHtlcClaimAddress,
        });
  const lifecycle = facts.evmChainId === 42161
    ? await verifyHtlcLifecycle({
        chainId: facts.evmChainId,
        htlcAddress: facts.evmHtlcAddress,
        hashLock: attachment.paymentHash,
        expectedLocktimeSec: locktimeSec ?? 0,
        expectedTokenAddress: facts.evmHtlcTokenAddress,
        expectedAmountAtomic: facts.evmHtlcAmountAtomic,
        expectedRefundAddress: facts.evmHtlcRefundAddress,
        expectedClaimAddress: facts.evmHtlcClaimAddress,
        fundingVerdict: funding.verdict,
      })
    : null;
  // P7: a re-authorization (earlier attempt's outcome unknown) needs the
  // chain's own word that nothing redeemed or refunded this lock.
  const spend = transfer.status === "CLAIMING" || facts.evmChainId === 137
    ? (await verifyHtlcUnspent({
        chainId: facts.evmChainId,
        htlcAddress: facts.evmHtlcAddress,
        hashLock: attachment.paymentHash,
        fundTxHash: facts.evmFundTxid,
        expectedLocktimeSec: locktimeSec,
        expectedTokenAddress: facts.evmHtlcTokenAddress,
        expectedAmountAtomic: facts.evmHtlcAmountAtomic,
        expectedRefundAddress: facts.evmHtlcRefundAddress,
        expectedClaimAddress: facts.evmHtlcClaimAddress,
        fundingVerdict: funding.verdict,
      })).verdict
    : null;
  return { facts, routeMatches, funding, lifecycle, spend, stored, gatheredAt: Date.now() };
}

/** Pure: every identity fact the claim depends on, against the bound swap and transfer terms. */
export function claimIdentityProblem(
  transfer: Pick<typeof transfers.$inferSelect, "targetAmountAtomic" | "destination">,
  attachment: Pick<typeof swapAttachments.$inferSelect, "satoraSwapId" | "paymentHash" | "evmRefundLocktime">,
  facts: VerifiedSwapFacts,
  routeMatches: boolean,
): string | null {
  const storedLock = attachment.evmRefundLocktime ? Math.floor(attachment.evmRefundLocktime.getTime() / 1000) : null;
  if (facts.satoraSwapId !== attachment.satoraSwapId) return "Provider returned a different swap.";
  if (facts.direction !== "lightning_to_evm") return "Provider swap is not a Lightning to Polygon swap.";
  if (facts.paymentHash.toLowerCase() !== attachment.paymentHash.toLowerCase()) return "Payment hash differs from the bound swap.";
  if (facts.targetAtomic !== transfer.targetAmountAtomic) return "Amount differs from the requested exact amount.";
  if (facts.targetAddress.trim().toLowerCase() !== transfer.destination.trim().toLowerCase()) return "Destination differs from the recipient wallet.";
  if (!routeMatches) return "Chain or token differs from the payment route.";
  if (storedLock === null || facts.evmRefundLocktime !== storedLock) return "Claim deadline differs from the bound swap.";
  return null;
}

/**
 * Authorize one explicit Finish-delivery attempt for the owner.
 * Refusals are AuthErrors with a customer-safe message.
 */
export async function authorizeClaim(userId: string, transferId: string): Promise<ClaimIntent> {
  const db = getDb();
  const ownerScope = and(eq(transfers.id, transferId), eq(transfers.ownerUserId, userId));

  // ---- phase A: fresh evidence, no lock ----
  const pre = (await db.select().from(transfers).where(ownerScope).limit(1))[0];
  if (!pre) refuse(404, "NOT_FOUND", "Transfer not found.");
  if (!CLAIMABLE.has(pre.status)) refuse(409, "NOT_CLAIMABLE", "This payment isn't funded and waiting to be finished.");
  const preBound = (await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, pre.id)).limit(1))[0];
  if (!preBound) refuse(409, "NOT_CLAIMABLE", "This payment has no bound swap.");
  if (!preBound.evmRefundLocktime) refuse(409, "DEADLINE_UNKNOWN", "The delivery deadline isn't confirmed yet, so finishing stays unavailable.");
  if (preBound.evmRefundLocktime.getTime() - Date.now() <= CLAIM_UNSAFE_WINDOW_MS) {
    refuse(409, "DEADLINE_TOO_CLOSE", "There isn't enough time left to finish delivery safely.");
  }
  const ev = await gather(pre, preBound);
  const identity = claimIdentityProblem(pre, preBound, ev.facts, ev.routeMatches);
  if (identity) refuse(409, "SWAP_MISMATCH", `${identity} Do not continue.`);
  // Every settlement term the claim will trust (contract, version, coordinator,
  // lock token, amount, parties, route token) must still equal what was bound
  // BEFORE any NIM moved; the funding/lifecycle checks below take their
  // expectations from this same fresh read, so they cannot catch a swap.
  const termsProblem = claimBoundTermsProblem(ev.stored, ev.facts);
  if (termsProblem) refuse(409, termsProblem.code, `${termsProblem.message} Do not continue.`);
  if (CLAIM_ACTIVITY_STATUSES.has(ev.facts.status) || ev.facts.evmClaimTxid !== null) {
    refuse(409, "CLAIM_ALREADY_SUBMITTED", "A delivery attempt is already on record. Wait while Thence confirms it — don't try again.");
  }
  if (ev.facts.status !== "serverfunded") refuse(409, "NOT_CLAIMABLE", "The provider no longer reports this payment as funded and waiting.");
  if (ev.funding.verdict === "INVALID") refuse(409, "FUNDING_INVALID", `${ev.funding.reason} Do not continue.`);
  if (ev.funding.verdict === "PENDING") {
    // Arbitrum: only L1-finalized funding authorizes a claim (~20 min), so a
    // confirmation count would mislead. The client keeps waiting on
    // `finality: "l1"`; the deadline gates above still end the wait.
    if (ev.facts.evmChainId === 42161) {
      throw new AuthError(409, "FUNDING_NOT_CONFIRMED", "The Arbitrum funding is waiting for Ethereum finality, usually about 20 minutes. Keep this screen open.", {
        finality: "l1",
        network: "Arbitrum",
      });
    }
    // F9.1: progress figures (public chain counts only) let the app show
    // "N of 32" while one tap waits for the funding to settle.
    const seen = ev.funding.confirmations;
    throw new AuthError(409, "FUNDING_NOT_CONFIRMED", "The Polygon funding needs a few more confirmations. Try again in a minute.", {
      ...(typeof seen === "number" && Number.isSafeInteger(seen) && seen >= 0 ? { confirmations: String(seen) } : {}),
      required: String(CLAIM_FUNDING_MIN_CONFIRMATIONS),
    });
  }
  if (ev.funding.verdict !== "VERIFIED") refuse(503, "CHAIN_UNAVAILABLE", ev.facts.evmChainId === 42161 ? "Arbitrum funding can't be checked right now. Try again shortly." : "Polygon can't be checked right now. Try again shortly.");
  const lifecycleProblem = claimLifecycleProblem(ev.facts.evmChainId, ev.lifecycle);
  if (lifecycleProblem) {
    if (ev.lifecycle?.verdict === "REJECTED") refuse(409, "HTLC_NOT_ACTIVE", `${lifecycleProblem} Do not continue.`);
    refuse(503, "CHAIN_UNAVAILABLE", "The Arbitrum HTLC lifecycle can't be checked right now. Try again shortly.");
  }
  if (pre.status === "CLAIMING" || ev.facts.evmChainId === 137) {
    if (ev.spend === "SPENT") refuse(409, "CLAIM_ALREADY_SUBMITTED", "The payment's settlement lock has already been spent. Wait while Thence confirms its outcome — don't try again.");
    if (ev.spend !== "UNSPENT") refuse(503, "CLAIM_OUTCOME_UNRESOLVED", "Thence cannot verify that the settlement lock is still unspent, so no claim can start. Check again shortly.");
  }

  // ---- phase B: short commit under the lock ----
  return db.transaction(async (tx) => {
    await lockTransfer(tx, transferId);
    const transfer = (await tx.select().from(transfers).where(ownerScope).limit(1))[0];
    if (!transfer) refuse(404, "NOT_FOUND", "Transfer not found.");
    const current = transfer.status as TransferStatus;
    if (current !== pre.status) refuse(409, "VERSION_CONFLICT", "The payment changed while it was being checked. Re-read it before finishing.");
    const attachment = (await tx.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1))[0];
    if (!attachment || attachment.satoraSwapId !== preBound.satoraSwapId || attachment.evmRefundLocktime?.getTime() !== preBound.evmRefundLocktime!.getTime()) {
      refuse(409, "VERSION_CONFLICT", "The payment changed while it was being checked. Re-read it before finishing.");
    }
    const now = Date.now();
    if (now - ev.gatheredAt > CLAIM_EVIDENCE_MAX_AGE_MS) refuse(409, "VERSION_CONFLICT", "The check took too long. Try again.");
    const deadlineMs = attachment.evmRefundLocktime!.getTime();
    if (deadlineMs - now <= CLAIM_UNSAFE_WINDOW_MS) refuse(409, "DEADLINE_TOO_CLOSE", "There isn't enough time left to finish delivery safely.");
    // A reconcile that committed meanwhile may have recorded claim/refund activity or a mismatch.
    const latest = (await tx.select().from(reconciliationObservations).where(eq(reconciliationObservations.transferId, transfer.id)).orderBy(desc(reconciliationObservations.observedAt)).limit(1))[0];
    if (latest?.kind === "identity_mismatch") refuse(409, "SWAP_MISMATCH", "The provider's record for this payment doesn't match. Do not continue.");
    if (latest && latest.kind === "observation" && latest.providerStatus !== "serverfunded" && latest.observedAt.getTime() > ev.gatheredAt - 5_000) {
      refuse(409, "VERSION_CONFLICT", "The payment changed while it was being checked. Re-read it before finishing.");
    }
    // One live attempt per transfer across tabs and devices.
    const leaseName = `claim:${transfer.id}`;
    const holder = `${userId.slice(0, 8)}:${now}`;
    const expires = new Date(now + CLAIM_LEASE_MS);
    const nowDate = new Date(now);
    const acquired = (await tx.execute(sql`
      INSERT INTO job_leases (name, holder, acquired_at, expires_at, last_started_at)
      VALUES (${leaseName}, ${holder}, ${nowDate}, ${expires}, ${nowDate})
      ON CONFLICT (name) DO UPDATE
        SET holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at,
            expires_at = EXCLUDED.expires_at, last_started_at = EXCLUDED.last_started_at
        WHERE job_leases.expires_at <= ${nowDate}
      RETURNING holder
    `)) as unknown as { rows: Array<{ holder: string }> };
    if (acquired.rows[0]?.holder !== holder) {
      refuse(409, "CLAIM_IN_PROGRESS", "A delivery attempt was authorized for this payment in the last 10 minutes and may still be confirming. Wait while Thence checks it — don't try again.");
    }
    let status = current;
    const evidence = {
      providerStatus: ev.facts.status,
      claimDeadline: new Date(deadlineMs).toISOString(),
      fundTxHash: ev.facts.evmFundTxid,
      fundingConfirmations: ev.funding.confirmations,
      secondsBeforeDeadline: Math.floor((deadlineMs - now) / 1000),
    };
    if (current === "SERVER_FUNDED") {
      status = transition("SERVER_FUNDED", "CLAIMING");
      await tx.update(transfers).set({ status, updatedAt: new Date() }).where(eq(transfers.id, transfer.id));
      await recordTransition(tx, { transferId: transfer.id, from: current, to: status, actor: "owner", actorUserId: userId, reasonCode: "CLAIM_AUTHORIZED", evidence });
    }
    return {
      transferId: transfer.id,
      status,
      satoraSwapId: attachment.satoraSwapId,
      paymentHash: attachment.paymentHash,
      destination: transfer.destination,
      targetAmountAtomic: transfer.targetAmountAtomic,
      claimDeadline: new Date(deadlineMs).toISOString(),
      leaseExpiresAt: expires.toISOString(),
      fundingConfirmations: ev.funding.confirmations,
      retry: current === "CLAIMING",
      htlc: authorizedHtlcFacts(ev.facts, attachment.paymentHash, Math.floor(deadlineMs / 1000), ev.stored.kind === "bound" ? "bound" : "legacy-pinned"),
    };
  });
}
