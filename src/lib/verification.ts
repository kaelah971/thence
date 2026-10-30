/**
 * Thence backend — recipient wallet verification, EVM EOAs (B2.3).
 *
 * A payer (“Thence user”) saves a beneficiary destination; the recipient —
 * who needs NO Thence account — proves control of that EVM address by
 * signing a bound challenge with their own wallet (EIP-191 personal_sign).
 *
 * Cryptography (official EIP-191 + maintained viem, never the Nimiq
 * Ed25519 verifier for EVM addresses):
 * - The wallet signs the EXACT stored message; EIP-191 prefixes
 *   "\x19Ethereum Signed Message:\n" + len + message inside the wallet.
 * - The backend recovers the signer with viem `recoverMessageAddress` and
 *   requires equality with the bound destination address.
 * - Only EOAs can pass: contract wallets cannot produce an ECDSA signature
 *   that recovers to their own address (no ERC-1271 in this slice).
 *
 * Binding + lifecycle:
 * - Challenge binds: app, purpose, initiating payer, destination record,
 *   exact address/asset/network, nonce, expiry. One-time, short-lived,
 *   atomic single-use consumption (concurrent completion → one winner).
 * - Public tokens are 128-bit bearer secrets: only SHA-256 hashes stored.
 * - Proof attaches to the specific saved destination; changing the triple
 *   clears it (see recipients.ts). Deleting a destination cascades its
 *   proofs. Archiving freezes records; completion requires an active one.
 * - Verification attests wallet control ONLY — not name or legal identity.
 * - No session is ever created for the signer.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recoverMessageAddress } from "viem";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { lockRecipient } from "@/lib/recipients";
import { recipientDestinations, recipientVerifications, recipients } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { checkDestination } from "@/lib/recipients";

const EVM_NETWORKS: ReadonlySet<string> = new Set(["Polygon", "Arbitrum", "Ethereum", "Base"]);
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export type VerificationStatus = "active" | "used" | "expired";

export function verificationStatus(row: { consumedAt: Date | null; expiresAt: Date | null }): VerificationStatus {
  if (row.consumedAt) return "used";
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newVerificationToken(): string {
  return randomBytes(16).toString("base64url");
}

/** Exact bound message the recipient wallet must personal_sign. */
export function buildVerificationMessage(args: {
  recipientName: string;
  address: string;
  asset: string;
  network: string;
  nonceHex: string;
  expiresAt: Date;
}): string {
  return (
    `Verify receiving address for Thence\n\n` +
    `You are proving control of the address below so ${args.recipientName} can pay you. ` +
    `Signing does NOT authorize any payment or move any funds.\n\n` +
    `Recipient: ${args.recipientName}\n` +
    `Address: ${args.address}\n` +
    `Asset: ${args.asset}\n` +
    `Network: ${args.network}\n` +
    `Nonce: ${args.nonceHex}\n` +
    `Expires: ${args.expiresAt.toISOString()}`
  );
}

export function verificationUrl(token: string): string {
  const origin = getEnv().THENCE_APP_ORIGIN.trim().replace(/\/+$/, "");
  const path = `/v/${token}`;
  return origin === "" ? path : `${origin}${path}`;
}

type Db = ReturnType<typeof getDb>;

export interface StartedVerification {
  token: string;
  url: string;
  message: string;
  address: string;
  asset: string;
  network: string;
  expiresAt: string;
}

export interface PublicVerificationView {
  status: VerificationStatus;
  recipientName: string | null;
  address: string;
  asset: string;
  network: string;
  /** Present only while active (what the wallet must sign). */
  message: string | null;
  expiresAt: string | null;
}

/**
 * Start verification for an owned destination. The destination must be a
 * currently-valid EVM address on an unarchived recipient.
 */
export async function startDestinationVerification(
  userId: string,
  recipientId: string,
  destinationId: string,
): Promise<StartedVerification> {
  const db = getDb();
  return db.transaction(async (tx) => {
    // Serialize with destination edits (same advisory lock B2.1 uses).
    await lockRecipient(tx, recipientId);
    const owners = await tx
      .select({
        destId: recipientDestinations.id,
        address: recipientDestinations.address,
        asset: recipientDestinations.asset,
        network: recipientDestinations.network,
        recipientName: recipients.displayName,
        archivedAt: recipients.archivedAt,
      })
      .from(recipientDestinations)
      .innerJoin(recipients, eq(recipients.id, recipientDestinations.recipientId))
      .where(and(eq(recipientDestinations.id, destinationId), eq(recipientDestinations.recipientId, recipientId), eq(recipients.ownerUserId, userId)))
      .limit(1);
    const target = owners[0];
    if (!target) throw new AuthError(404, "NOT_FOUND", "Recipient destination not found.");
    if (target.archivedAt) {
      throw new AuthError(409, "RECIPIENT_ARCHIVED", "Recipient is archived. Unarchive it before starting verification.");
    }
    if (!EVM_NETWORKS.has(target.network)) {
      const guard = checkDestination(target.network, target.asset, target.address);
      if (!guard.ok) throw new AuthError(400, guard.code, guard.message);
      throw new AuthError(400, "UNSUPPORTED_ROUTE", "Only EVM destinations can be verified in this slice.");
    }
    const guard = checkDestination(target.network, target.asset, target.address);
    if (!guard.ok) throw new AuthError(400, guard.code, guard.message);
    // Supersede earlier pending links: one active process per destination.
    await tx
      .update(recipientVerifications)
      .set({ consumedAt: new Date() })
      .where(and(eq(recipientVerifications.destinationId, target.destId), isNull(recipientVerifications.consumedAt)));

    const env = getEnv();
    const nonceHex = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + env.THENCE_VERIFICATION_TTL_SECONDS * 1000);
    const message = buildVerificationMessage({
      recipientName: target.recipientName,
      address: target.address,
      asset: target.asset,
      network: target.network,
      nonceHex,
      expiresAt,
    });
    // Nonce/token are 256/128-bit; retry loop is near-theoretical.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const token = newVerificationToken();
        await tx.insert(recipientVerifications).values({
          address: target.address,
          network: target.network,
          asset: target.asset,
          challenge: message,
          tokenHash: hashVerificationToken(token),
          destinationId: target.destId,
          initiatedByUserId: userId,
          expiresAt,
        });
        return {
          token,
          url: verificationUrl(token),
          message,
          address: target.address,
          asset: target.asset,
          network: target.network,
          expiresAt: expiresAt.toISOString(),
        };
      } catch (err) {
        if ((err as { code?: string }).code === "23505" && attempt < 4) continue;
        throw new AuthError(500, "VERIFY_START_FAILED", "Could not start verification.");
      }
    }
    throw new AuthError(500, "VERIFY_START_FAILED", "Could not start verification.");
  });
}

export async function getPublicVerification(token: string): Promise<PublicVerificationView | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 64) return null;
  const db = getDb();
  const rows = await db
    .select({
      challenge: recipientVerifications.challenge,
      consumedAt: recipientVerifications.consumedAt,
      expiresAt: recipientVerifications.expiresAt,
      address: recipientVerifications.address,
      asset: recipientVerifications.asset,
      network: recipientVerifications.network,
      recipientName: recipients.displayName,
    })
    .from(recipientVerifications)
    .leftJoin(recipientDestinations, eq(recipientDestinations.id, recipientVerifications.destinationId))
    .leftJoin(recipients, eq(recipients.id, recipientDestinations.recipientId))
    .where(eq(recipientVerifications.tokenHash, hashVerificationToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const status = verificationStatus(row);
  return {
    status,
    recipientName: row.recipientName,
    address: row.address,
    asset: row.asset ?? proofMessageAsset(row.challenge),
    network: row.network,
    message: status === "active" ? row.challenge : null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export interface CompletedVerification {
  address: string;
  verifiedAt: string;
}

/**
 * Complete verification: consume the challenge atomically, recover the EIP-191
 * signer, bind proof to the destination. Exactly one concurrent caller wins.
 * No session is created for the signer.
 */
export async function completeVerification(token: string, signature: string): Promise<CompletedVerification> {
  if (typeof token !== "string" || token.length === 0 || token.length > 64) {
    throw new AuthError(404, "NOT_FOUND", "Verification request not found.");
  }
  if (typeof signature !== "string" || !SIGNATURE_RE.test(signature.trim())) {
    throw new AuthError(401, "SIGNATURE_INVALID", "Signature verification failed.");
  }
  const db: Db = getDb();
  const tokenHash = hashVerificationToken(token);
  const existing = await db
    .select()
    .from(recipientVerifications)
    .where(eq(recipientVerifications.tokenHash, tokenHash))
    .limit(1);
  const proof = existing[0];
  if (!proof) throw new AuthError(404, "NOT_FOUND", "Verification request not found.");
  if (proof.consumedAt) throw new AuthError(410, "CHALLENGE_USED", "This verification link has already been used.");
  if (proof.expiresAt && proof.expiresAt.getTime() <= Date.now()) {
    throw new AuthError(410, "CHALLENGE_EXPIRED", "This verification link has expired.");
  }

  // Resolve the owning recipient for lock ordering (lock key only; every
  // decision below is re-read inside the transaction).
  const ownerRows = await db
    .select({ recipientId: recipientDestinations.recipientId })
    .from(recipientDestinations)
    .where(eq(recipientDestinations.id, proof.destinationId ?? "00000000-0000-0000-0000-000000000000"))
    .limit(1);
  const ownerRecipientId = ownerRows[0]?.recipientId;

  // EIP-191 recovery against the EXACT stored message (never client input).
  // Runs before consumption so wrong-signer attempts never burn the link.
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: proof.challenge, signature: signature.trim() as `0x${string}` });
  } catch {
    throw new AuthError(401, "SIGNATURE_INVALID", "Signature verification failed.");
  }
  if (signer.toLowerCase() !== proof.address.toLowerCase()) {
    throw new AuthError(401, "SIGNER_MISMATCH", "Signature does not match the bound destination address.");
  }

  return db.transaction(async (tx) => {
    // Same serialization point as destination edits: no update can slip a
    // triple change between our check and our badge write.
    if (ownerRecipientId) await lockRecipient(tx, ownerRecipientId);
    // Lock the bound rows: the destination must still exist, be active,
    // and match the bound triple — validated atomically, nothing consumed
    // on the way out.
    const dests = await tx.execute(sql`
      SELECT d.id AS id, d.address AS address, d.asset AS asset,
             d.network AS network, r.archived_at AS "archivedAt",
             r.id AS "recipientId"
        FROM recipient_destinations d
        JOIN recipients r ON r.id = d.recipient_id
       WHERE d.id = ${proof.destinationId ?? "00000000-0000-0000-0000-000000000000"}::uuid
       FOR UPDATE OF d, r
    `);
    const dest = (dests as unknown as { rows: Array<{ id: string; address: string; asset: string; network: string; archivedAt: Date | null; recipientId: string }> }).rows[0];
    if (!dest) throw new AuthError(404, "NOT_FOUND", "The verified destination no longer exists.");
    if (dest.archivedAt) {
      throw new AuthError(409, "RECIPIENT_ARCHIVED", "The recipient is archived; ask the payer to unarchive and restart verification.");
    }
    if (
      dest.address.toLowerCase() !== proof.address.toLowerCase() ||
      (proof.asset ?? proofMessageAsset(proof.challenge)) !== dest.asset ||
      dest.network !== proof.network
    ) {
      throw new AuthError(409, "DESTINATION_CHANGED", "The destination changed since verification started; ask the payer to restart verification.");
    }
    // Atomic single-use consumption: only an unconsumed, unexpired row wins.
    const consumed = await tx
      .update(recipientVerifications)
      .set({ consumedAt: new Date(), signature: signature.trim(), verifiedAt: new Date() })
      .where(
        and(
          eq(recipientVerifications.tokenHash, tokenHash),
          isNull(recipientVerifications.consumedAt),
          sql`${recipientVerifications.expiresAt} > NOW()`,
        ),
      )
      .returning({ id: recipientVerifications.id });
    const won = consumed[0];
    if (!won) throw new AuthError(410, "CHALLENGE_USED", "This verification link has already been used.");
    // Conditional badge write: the triple is re-asserted in the same
    // statement, so no interleaving edit can plant a badge on new terms.
    const badged = await tx.execute(sql`
      UPDATE recipient_destinations
         SET verification_id = ${won.id}::uuid
       WHERE id = ${dest.id}::uuid
         AND lower(address) = lower(${proof.address})
         AND asset = ${proof.asset ?? proofMessageAsset(proof.challenge)}
         AND network = ${proof.network}
    `);
    if ((badged as unknown as { rowCount: number | null }).rowCount !== 1) {
      throw new AuthError(409, "DESTINATION_CHANGED", "The destination changed since verification started; ask the payer to restart verification.");
    }
    const verifiedAt = new Date();
    return { address: proof.address, verifiedAt: verifiedAt.toISOString() };
  });
}

/** Legacy fallback: asset bound inside the stored challenge message. */
function proofMessageAsset(challenge: string): string {
  return /Asset: ([^\n]+)/.exec(challenge)?.[1]?.trim() ?? "";
}
