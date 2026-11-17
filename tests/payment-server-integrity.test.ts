/**
 * Server authorization integrity (payment audit).
 *
 * 1. A claim authorization re-checks the settlement terms bound at attach
 *    (SWAP_ATTACHED evidence) against the FRESH provider read. The funding and
 *    lifecycle verifiers take their expectations from that same fresh read, so
 *    without this check a provider that swaps the HTLC address, version,
 *    coordinator, lock token, amount or parties after funding would be
 *    "verified" against its own substituted terms.
 * 2. Swaps bound before term binding existed ("legacy", no record at all) stay
 *    recoverable but are held to the pinned deployment table; a PARTIAL record
 *    is never legacy.
 * 3. ClaimIntent carries the public HTLC facts the browser re-validates.
 * 4. A missing/empty provider status is not "pending" (attach and authorize).
 * 5. An unverified source-hash hint by one owner never blocks another
 *    transfer's independently verified proof.
 *
 * The pure cases run offline. The database cases are live-gated, run inside a
 * rolled-back transaction on the isolated test database, and only read/insert
 * synthetic rows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { transferProofs, transferTransitions, transfers, users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { verifySwapMatch } from "@/lib/handoff";
import { boundHtlcTermsOf } from "@/lib/htlc-preflight";
import { authorizedHtlcFacts, claimBoundTermsProblem, readStoredBoundHtlc, type StoredBoundHtlc } from "@/lib/claim-intent";
import { verifiedSourceHolders } from "@/lib/reconcile";
import { toUserFriendlyAddress } from "@/lib/nimiq";
import { HTLC_DEPLOYMENTS } from "@/lib/settlement";
import type { VerifiedSwapFacts } from "@/lib/satora";
import { LIVE } from "./helpers";
import { LOCK_CLAIM_ADDRESS, LOCK_REFUND_ADDRESS, LOCK_TOKEN_POLYGON } from "./htlc-fixture";

const V7 = HTLC_DEPLOYMENTS[42161]!.find((d) => d.version === 7)!;
const V6 = HTLC_DEPLOYMENTS[42161]!.find((d) => d.version === 6)!;
const ROUTE_TOKEN = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const LOCK = `0x${"ab".repeat(32)}`;
const EVIL = "0x00000000000000000000000000000000000000ee";
const DEST = "0x0000000000000000000000000000000000000001";

function facts(over: Partial<VerifiedSwapFacts> = {}): VerifiedSwapFacts {
  return {
    satoraSwapId: "swap-1",
    direction: "lightning_to_evm",
    bolt11Invoice: "lnbc3930n1psomeinvoice",
    paymentHash: LOCK,
    sourceSats: "393",
    targetAtomic: "300000",
    evmChainId: 42161,
    targetAddress: DEST,
    targetTokenAddress: ROUTE_TOKEN,
    targetTokenChainId: 42161,
    status: "serverfunded",
    invoiceExpiresAt: new Date(Date.now() + 3600_000),
    feeSats: 5,
    evmHtlcAddress: V7.address,
    evmFundTxid: `0x${"cd".repeat(32)}`,
    evmClaimTxid: null,
    evmHtlcTokenAddress: LOCK_TOKEN_POLYGON,
    evmHtlcAmountAtomic: "4000",
    evmHtlcRefundAddress: LOCK_REFUND_ADDRESS,
    evmHtlcClaimAddress: LOCK_CLAIM_ADDRESS,
    evmHtlcVersion: V7.version,
    evmHtlcKind: V7.kind,
    evmCoordinatorAddress: V7.coordinator,
    evmRefundLocktime: Math.floor(Date.now() / 1000) + 7200,
    ...over,
  };
}

const bound = (f = facts()): StoredBoundHtlc => ({ kind: "bound", htlc: boundHtlcTermsOf(f) });
const LEGACY: StoredBoundHtlc = { kind: "legacy" };

describe("claim authorization re-checks the bound settlement terms", () => {
  it("accepts an unchanged read (case-insensitive addresses)", () => {
    expect(claimBoundTermsProblem(bound(), facts())).toBeNull();
    expect(claimBoundTermsProblem(bound(), facts({ evmHtlcRefundAddress: LOCK_REFUND_ADDRESS.toUpperCase().replace("0X", "0x") }))).toBeNull();
    // A re-priced source amount is the repricing guard's concern, never a terms refusal.
    expect(claimBoundTermsProblem(bound(), facts({ sourceSats: "999" }))).toBeNull();
  });

  it("refuses every substituted term the verifiers would otherwise take from the fresh read", () => {
    const cases: Array<[Partial<VerifiedSwapFacts>, string]> = [
      [{ evmHtlcAddress: V6.address, evmHtlcVersion: V6.version, evmCoordinatorAddress: V6.coordinator }, "htlcAddress"],
      [{ evmHtlcVersion: 6 }, "version"],
      [{ evmHtlcKind: "erc20-evil" }, "kind"],
      [{ evmCoordinatorAddress: EVIL }, "coordinator"],
      [{ evmHtlcTokenAddress: EVIL }, "lockToken"],
      [{ evmHtlcAmountAtomic: "1" }, "lockAmount"],
      [{ evmHtlcRefundAddress: EVIL }, "refundAddress"],
      [{ evmHtlcClaimAddress: EVIL }, "claimAddress"],
      [{ targetTokenAddress: EVIL }, "targetToken"],
      [{ evmChainId: 137 }, "chainId"],
    ];
    for (const [over, field] of cases) {
      expect(claimBoundTermsProblem(bound(), facts(over)), field).toMatchObject({ code: "HTLC_TERMS_MISMATCH", field });
    }
  });

  it("treats a fresh read that DROPS a bound term as drift, not as absence of evidence", () => {
    for (const over of [{ evmHtlcAmountAtomic: null }, { evmHtlcClaimAddress: null }, { evmCoordinatorAddress: null }, { evmHtlcVersion: null }] satisfies Partial<VerifiedSwapFacts>[]) {
      expect(claimBoundTermsProblem(bound(), facts(over)), JSON.stringify(over)).toMatchObject({ code: "HTLC_TERMS_MISMATCH" });
    }
  });

  it("never treats a partial or malformed record as legacy", () => {
    const full = boundHtlcTermsOf(facts());
    for (const htlc of [null, "x", [], {}, { ...full, coordinator: "" }, { ...full, lockAmount: null }, { chainId: 42161 }]) {
      expect(claimBoundTermsProblem({ kind: "bound", htlc }, facts()), JSON.stringify(htlc)).toMatchObject({ code: "HTLC_TERMS_INCOMPLETE" });
    }
  });

  it("legacy rows (no record at all) stay recoverable on a pinned deployment, and only there", () => {
    expect(claimBoundTermsProblem(LEGACY, facts())).toBeNull();
    expect(claimBoundTermsProblem(LEGACY, facts({ evmHtlcAddress: V6.address, evmHtlcVersion: 6, evmCoordinatorAddress: V6.coordinator }))).toBeNull();
    // Older reads may not declare version/kind/coordinator at all.
    expect(claimBoundTermsProblem(LEGACY, facts({ evmHtlcVersion: null, evmHtlcKind: null, evmCoordinatorAddress: null }))).toBeNull();
    expect(claimBoundTermsProblem(LEGACY, facts({ evmHtlcAddress: EVIL }))).toMatchObject({ code: "HTLC_TERMS_MISMATCH", field: "htlcAddress" });
    expect(claimBoundTermsProblem(LEGACY, facts({ evmHtlcAddress: null }))).toMatchObject({ code: "HTLC_TERMS_MISMATCH", field: "htlcAddress" });
    expect(claimBoundTermsProblem(LEGACY, facts({ evmHtlcVersion: 6 }))).toMatchObject({ field: "version" });
    expect(claimBoundTermsProblem(LEGACY, facts({ evmHtlcKind: "other" }))).toMatchObject({ field: "kind" });
    expect(claimBoundTermsProblem(LEGACY, facts({ evmCoordinatorAddress: EVIL }))).toMatchObject({ field: "coordinator" });
  });
});

describe("ClaimIntent exposes public authorized HTLC facts for the browser", () => {
  it("carries the bound terms, hash lock, deadline and funding tx, and nothing secret", () => {
    const f = facts();
    const htlc = authorizedHtlcFacts(f, LOCK.toUpperCase().replace("0X", "0x"), f.evmRefundLocktime!, "bound");
    expect(htlc).toEqual({
      ...boundHtlcTermsOf(f),
      hashLock: LOCK,
      refundLocktimeSec: f.evmRefundLocktime,
      fundTxHash: f.evmFundTxid,
      termsBinding: "bound",
    });
    expect(htlc).toMatchObject({ chainId: 42161, htlcAddress: V7.address, version: 7, kind: "erc20", coordinator: V7.coordinator, lockToken: LOCK_TOKEN_POLYGON, lockAmount: "4000", refundAddress: LOCK_REFUND_ADDRESS, claimAddress: LOCK_CLAIM_ADDRESS, targetToken: ROUTE_TOKEN });
    expect(Object.keys(htlc).join(" ")).not.toMatch(/preimage|secret|mnemonic|key|signature|invoice|bolt/i);
    expect(authorizedHtlcFacts(f, LOCK, 1, "legacy-pinned").termsBinding).toBe("legacy-pinned");
  });
});

describe("a missing provider status is not 'pending'", () => {
  const args = { asset: "USDC", network: "Arbitrum", chainId: "42161", tokenAddress: ROUTE_TOKEN, destination: DEST, targetAmountAtomic: "300000" } as const;
  const pending = facts({ status: "pending", evmRefundLocktime: null });

  it("binds only an explicit pending swap", () => {
    expect(() => verifySwapMatch({ ...args, swap: pending })).not.toThrow();
  });

  it.each(["", "serverfunded", "expired"])("refuses status %j before anything is bound", (status) => {
    try {
      verifySwapMatch({ ...args, swap: { ...pending, status } });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("SWAP_STATE_UNEXPECTED");
    }
  });
});

/* ------------------------- live (rolled back) ------------------------- */

class Rollback extends Error {}
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function seedTransfer(tx: Tx, fill: number): Promise<{ transferId: string; userId: string }> {
  // Synthetic valid-checksum address; owns nothing on chain.
  const [user] = await tx.insert(users).values({ nimiqAddress: toUserFriendlyAddress(new Uint8Array(20).fill(fill)) }).returning({ id: users.id });
  const transferId = randomUUID();
  await tx.insert(transfers).values({
    id: transferId,
    ownerUserId: user!.id,
    routeId: "usdc-polygon",
    targetAsset: "USDC",
    targetNetwork: "Polygon",
    destination: DEST,
    targetAmountAtomic: "300000",
    status: "SERVER_FUNDED",
  });
  return { transferId, userId: user!.id };
}

describe.skipIf(!LIVE)("persisted evidence reads (isolated database, rolled back)", () => {
  it("reads the bound record, treats no row / no htlc key as legacy, and keeps a partial record 'bound'", async () => {
    await inRolledBackTx(async (tx) => {
      const { transferId } = await seedTransfer(tx, 0x31);
      expect(await readStoredBoundHtlc(tx, transferId)).toEqual({ kind: "legacy" });
      await tx.insert(transferTransitions).values({ transferId, fromStatus: "QUOTED", toStatus: "SWAP_CREATED", actor: "owner", reasonCode: "SWAP_ATTACHED", evidence: { attemptId: "x" }, terminal: false });
      expect(await readStoredBoundHtlc(tx, transferId)).toEqual({ kind: "legacy" });
      await tx.insert(transferTransitions).values({ transferId, fromStatus: "QUOTED", toStatus: "SWAP_CREATED", actor: "owner", reasonCode: "SWAP_ATTACHED", evidence: { htlc: { chainId: 42161 } }, terminal: false, createdAt: new Date(Date.now() + 1000) });
      const stored = await readStoredBoundHtlc(tx, transferId);
      expect(stored).toEqual({ kind: "bound", htlc: { chainId: 42161 } });
      expect(claimBoundTermsProblem(stored, facts())).toMatchObject({ code: "HTLC_TERMS_INCOMPLETE" });
    });
  });
});

describe.skipIf(!LIVE)("source attribution (isolated database, rolled back)", () => {
  const HASH = randomBytes(32).toString("hex");

  it("another owner's UNVERIFIED hint for the same hash is not attribution", async () => {
    await inRolledBackTx(async (tx) => {
      const attacker = await seedTransfer(tx, 0x41);
      const victim = await seedTransfer(tx, 0x42);
      await tx.insert(transferProofs).values({ transferId: attacker.transferId, nimiqTxHash: HASH });
      await tx.insert(transferTransitions).values({
        transferId: attacker.transferId, fromStatus: "SERVER_FUNDED", toStatus: "SERVER_FUNDED", actor: "owner", actorUserId: attacker.userId,
        reasonCode: "SOURCE_EVIDENCE_RECORDED", evidence: { nimiqSourceVerification: "UNVERIFIED", nimiqSourceTxHash: HASH, nimiqSourceFailure: "SENDER_MISMATCH" }, terminal: false,
      });
      expect(await verifiedSourceHolders(tx, victim.transferId, HASH)).toEqual([]);
    });
  });

  it("a VERIFIED attribution elsewhere (audit row, any 0x/case spelling) still blocks", async () => {
    await inRolledBackTx(async (tx) => {
      const holder = await seedTransfer(tx, 0x43);
      const other = await seedTransfer(tx, 0x44);
      await tx.insert(transferTransitions).values({
        transferId: holder.transferId, fromStatus: "SERVER_FUNDED", toStatus: "SERVER_FUNDED", actor: "reconciler", actorUserId: holder.userId,
        reasonCode: "SOURCE_EVIDENCE_RECORDED", evidence: { nimiqSourceVerification: "VERIFIED", nimiqSourceTxHash: `0x${HASH.toUpperCase()}` }, terminal: false,
      });
      expect(await verifiedSourceHolders(tx, other.transferId, HASH)).toEqual([holder.transferId]);
      // The holder itself is never blocked by its own record.
      expect(await verifiedSourceHolders(tx, holder.transferId, HASH)).toEqual([]);
    });
  });
});
