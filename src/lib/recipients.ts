/**
 * Thence backend — recipients + payment destinations service (B2.1).
 *
 * Ownership: every function takes the session-derived `userId` and scopes
 * all reads/writes to it. Client-supplied owner ids are never accepted
 * (forbidden keys are rejected with 400; cross-user rows resolve to 404).
 *
 * Network guard: asset/network pairs must exist in the canonical registry
 * (src/domain/routes.ts). EVM destinations require 0x syntax plus EIP-55
 * checksum validity when mixed-case. BOLT11 invoices are single-use and
 * can never become saved destinations; reusable Lightning endpoints stay
 * pending until a real validation/resolution contract exists.
 *
 * Verification status is DERIVED server-side only: "added-by-you" unless a
 * completed recipient_verifications row backs the destination, in which
 * case "verified-by-recipient". Clients cannot set it.
 */
import { and, count, desc, eq, ilike, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { recipientDestinations, recipientVerifications, recipients, transfers } from "@/db/schema";
import { SUPPORTED_ASSETS, SUPPORTED_NETWORKS, isSupportedPair } from "@/domain/routes";
import { keccak256 } from "@/lib/keccak";

const EVM_NETWORKS: ReadonlySet<string> = new Set(["Polygon", "Arbitrum", "Ethereum", "Base"]);
const BOLT11_PREFIX_RE = /^(lnbc|lnbcrt|lntb|lntbs)/i;

export const MAX_BODY_BYTES = 8_192;

/* ------------------------------------------------------------------ */
/* request helpers                                                      */
/* ------------------------------------------------------------------ */

/** Read a JSON body with a size cap. 413 when the payload is too large. */
export async function readJsonBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AuthError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  if (!text.trim()) throw new AuthError(400, "BAD_BODY", "Request body must be JSON.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AuthError(400, "BAD_BODY", "Request body must be JSON.");
  }
}

/** Reject client attempts to set server-owned fields (owner, verification). */
const FORBIDDEN_KEYS = new Set([
  "ownerUserId",
  "owner_user_id",
  "verification",
  "verified",
  "isVerified",
  "verificationId",
  "verification_id",
  "verifiedAt",
  "verified_at",
]);

export function rejectForbiddenKeys(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new AuthError(400, "FIELD_FORBIDDEN", `Field "${key}" cannot be set by clients.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* validation                                                           */
/* ------------------------------------------------------------------ */

export const displayNameSchema = z.string().trim().min(1, "Display name is required.").max(120);
export const labelSchema = z.string().trim().max(120).nullable().optional();

const assetSchema = z.enum(SUPPORTED_ASSETS as unknown as [string, ...string[]]);
const networkSchema = z.enum(SUPPORTED_NETWORKS as unknown as [string, ...string[]]);

export const destinationInputSchema = z.object({
  asset: assetSchema,
  network: networkSchema,
  address: z.string().trim().min(1, "Address is required.").max(256),
  label: z.string().trim().max(120).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export type DestinationInput = z.infer<typeof destinationInputSchema>;

export const destinationPatchSchema = destinationInputSchema.partial();
export type DestinationPatch = z.infer<typeof destinationPatchSchema>;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 checksum validation. All-lower/all-upper (non-checksummed) accepted; mixed-case must checksum. */
export function isValidEvmAddress(address: string): boolean {
  if (!EVM_ADDRESS_RE.test(address)) return false;
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = keccak256(Buffer.from(hex.toLowerCase(), "utf8")).toString("hex");
  for (let i = 0; i < 40; i++) {
    const ch = hex[i] as string;
    if (ch >= "0" && ch <= "9") continue; // digits carry no checksum bit
    const nibble = parseInt(hash[i] as string, 16);
    const shouldUpper = nibble >= 8;
    const isUpper = ch !== ch.toLowerCase();
    if (isUpper !== shouldUpper) return false;
  }
  return true;
}

export type DestinationCheck =
  | { ok: true }
  | { ok: false; code: "UNSUPPORTED_ROUTE" | "INVALID_ADDRESS" | "BOLT11_NOT_REUSABLE" | "LIGHTNING_DESTINATION_PENDING"; message: string };

/** Network guard for a destination triple. Never treats validity as ownership proof. */
export function checkDestination(network: string, asset: string, address: string): DestinationCheck {
  if (!isSupportedPair(asset, network)) {
    return { ok: false, code: "UNSUPPORTED_ROUTE", message: `Asset/network pair ${asset} on ${network} is not supported.` };
  }
  if (network === "Lightning") {
    if (BOLT11_PREFIX_RE.test(address.trim())) {
      return {
        ok: false,
        code: "BOLT11_NOT_REUSABLE",
        message: "BOLT11 invoices are single-use and expire; they cannot be saved as reusable destinations.",
      };
    }
    return {
      ok: false,
      code: "LIGHTNING_DESTINATION_PENDING",
      message: "Reusable Lightning destinations are pending a real validation/resolution contract.",
    };
  }
  if (EVM_NETWORKS.has(network)) {
    if (!isValidEvmAddress(address.trim())) {
      return { ok: false, code: "INVALID_ADDRESS", message: `Address is not a valid EVM address for ${network}.` };
    }
    return { ok: true };
  }
  return { ok: false, code: "UNSUPPORTED_ROUTE", message: `Network ${network} has no address validator yet.` };
}

function badBody(message: string): AuthError {
  return new AuthError(400, "BAD_BODY", message);
}

/** Zod parse that reports 400 instead of leaking a raw ZodError (which maps to 500). */
function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badBody(parsed.error.issues[0]?.message ?? "Invalid input.");
  return parsed.data;
}

export function parseDestinationInput(body: unknown): DestinationInput {
  rejectForbiddenKeys(body);
  const parsed = destinationInputSchema.safeParse(body);
  if (!parsed.success) throw badBody(parsed.error.issues[0]?.message ?? "Invalid destination.");
  const check = checkDestination(parsed.data.network, parsed.data.asset, parsed.data.address);
  if (!check.ok) throw new AuthError(400, check.code, check.message);
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* types                                                                */
/* ------------------------------------------------------------------ */

export type VerificationStatus =
  | { status: "added-by-you" }
  | { status: "verified-by-recipient"; verifiedAt: string };

export interface DestinationView {
  id: string;
  asset: string;
  network: string;
  address: string;
  label: string | null;
  isDefault: boolean;
  verification: VerificationStatus;
  createdAt: string;
}

export interface DefaultDestinationView {
  id: string;
  asset: string;
  network: string;
  address: string;
  label: string | null;
  verification: VerificationStatus;
}

export interface RecipientSummary {
  id: string;
  displayName: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  defaultDestination: DefaultDestinationView | null;
  destinationCount: number;
  transferCount: number;
  lastPaidAt: string | null;
}

export interface RecipientDetail extends Omit<RecipientSummary, "defaultDestination"> {
  destinations: DestinationView[];
}

/* ------------------------------------------------------------------ */
/* internals                                                              */
/* ------------------------------------------------------------------ */

type Db = ReturnType<typeof getDb>;
/** Structural minimum for helpers that must also run inside transactions. */
type Queryable = Pick<Db, "select" | "execute">;

async function findRecipient(db: Queryable, userId: string, recipientId: string) {
  const rows = await db
    .select()
    .from(recipients)
    .where(and(eq(recipients.id, recipientId), eq(recipients.ownerUserId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function verificationMap(db: Queryable, verificationIds: (string | null)[]): Promise<Map<string, { verifiedAt: Date | null }>> {
  const ids = [...new Set(verificationIds.filter((v): v is string => v !== null))];
  const map = new Map<string, { verifiedAt: Date | null }>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: recipientVerifications.id, verifiedAt: recipientVerifications.verifiedAt })
    .from(recipientVerifications)
    .where(inArray(recipientVerifications.id, ids));
  for (const row of rows) map.set(row.id, { verifiedAt: row.verifiedAt });
  return map;
}

function verificationStatus(
  verificationId: string | null,
  verifications: Map<string, { verifiedAt: Date | null }>,
): VerificationStatus {
  const entry = verificationId ? verifications.get(verificationId) : undefined;
  if (entry?.verifiedAt) {
    return { status: "verified-by-recipient", verifiedAt: entry.verifiedAt.toISOString() };
  }
  return { status: "added-by-you" };
}

function toDestinationView(
  row: typeof recipientDestinations.$inferSelect,
  verifications: Map<string, { verifiedAt: Date | null }>,
): DestinationView {
  return {
    id: row.id,
    asset: row.asset,
    network: row.network,
    address: row.address,
    label: row.label,
    isDefault: row.isDefault,
    verification: verificationStatus(row.verificationId, verifications),
    createdAt: row.createdAt.toISOString(),
  };
}

function requireActive<T extends { archivedAt: Date | null }>(row: T): void {
  if (row.archivedAt) {
    throw new AuthError(409, "RECIPIENT_ARCHIVED", "Recipient is archived. Unarchive it before making changes.");
  }
}

/**
 * Serialize destination writes per recipient with a transaction-scoped
 * PostgreSQL advisory lock (works across processes/instances; released at
 * COMMIT/ROLLBACK). Concurrent default switches that still collide on the
 * single-default unique index are retried by the caller (see
 * withUniqueRetry) instead of surfacing a 500.
 */
export async function lockRecipient(tx: Queryable, recipientId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"recipient:" + recipientId}))`);
}

/**
 * Bounded retry for the single-default unique backstop (B5.1).
 *
 * Concurrent same-recipient default switches can collide on
 * `recipient_destinations_single_default_uidx` when two writers overlap
 * (demonstrated under real Neon/pooler latency: the advisory lock
 * serializes the common case, but the unique index remains the arbiter
 * under interleavings the lock cannot exclude). The whole operation is
 * idempotent and convergent — a single atomic UPDATE that always leaves
 * exactly one default — so a retry re-reads fresh committed state and
 * converges instead of surfacing a 500. Only Postgres unique violations
 * (23505) are retried; every other error propagates untouched.
 */
async function withUniqueRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      last = err;
    }
  }
  throw last;
}

/**
 * Single atomic statement: exactly the target row becomes the default.
 * Runs under the recipient advisory lock; the partial unique index
 * underneath is a backstop. Concurrent same-recipient switches retry
 * on 23505 via withUniqueRetry instead of surfacing a 500.
 */
async function setDefaultAtomic(db: Queryable, recipientId: string, destinationId: string): Promise<void> {
  await db.execute(sql`
    UPDATE recipient_destinations
    SET is_default = (id = ${destinationId}::uuid)
    WHERE recipient_id = ${recipientId}::uuid
  `);
}

async function summarize(db: Queryable, userId: string, row: typeof recipients.$inferSelect): Promise<RecipientSummary> {
  const destinations = await db
    .select()
    .from(recipientDestinations)
    .where(eq(recipientDestinations.recipientId, row.id));
  const verifications = await verificationMap(
    db,
    destinations.map((d) => d.verificationId),
  );
  const def = destinations.find((d) => d.isDefault) ?? null;
  const statRows = await db
    .select({ transferCount: sql<number>`count(*)::int`, lastPaidAt: max(transfers.createdAt) })
    .from(transfers)
    .where(and(eq(transfers.ownerUserId, userId), eq(transfers.recipientId, row.id)));
  const stat = statRows[0];
  return {
    id: row.id,
    displayName: row.displayName,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    defaultDestination: def
      ? {
          id: def.id,
          asset: def.asset,
          network: def.network,
          address: def.address,
          label: def.label,
          verification: verificationStatus(def.verificationId, verifications),
        }
      : null,
    destinationCount: destinations.length,
    transferCount: stat?.transferCount ?? 0,
    lastPaidAt: stat?.lastPaidAt ? (stat.lastPaidAt as Date).toISOString() : null,
  };
}

/* ------------------------------------------------------------------ */
/* recipients                                                             */
/* ------------------------------------------------------------------ */

export async function createRecipient(userId: string, displayName: string): Promise<RecipientSummary> {
  const name = parseOr400(displayNameSchema, displayName);
  const db = getDb();
  const inserted = await db.insert(recipients).values({ ownerUserId: userId, displayName: name }).returning();
  const row = inserted[0];
  if (!row) throw new AuthError(500, "RECIPIENT_FAILED", "Could not create recipient.");
  return summarize(db, userId, row);
}

export interface ListRecipientsOptions {
  q?: string | undefined;
  includeArchived?: boolean | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function listRecipients(
  userId: string,
  options: ListRecipientsOptions = {},
): Promise<{ recipients: RecipientSummary[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
  const db = getDb();
  const conditions = [eq(recipients.ownerUserId, userId)];
  if (!options.includeArchived) conditions.push(isNull(recipients.archivedAt));
  const q = options.q?.trim();
  if (q) conditions.push(ilike(recipients.displayName, `%${q.replace(/[%_]/g, "")}%`));
  const where = and(...conditions);
  const totalRows = await db.select({ n: count() }).from(recipients).where(where);
  const total = totalRows[0]?.n ?? 0;
  const rows = await db
    .select()
    .from(recipients)
    .where(where)
    .orderBy(desc(recipients.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const items: RecipientSummary[] = [];
  for (const row of rows) {
    items.push(await summarize(db, userId, row));
  }
  return { recipients: items, total, page, pageSize };
}

export async function getRecipientDetail(userId: string, recipientId: string): Promise<RecipientDetail | null> {
  const db = getDb();
  const row = await findRecipient(db, userId, recipientId);
  if (!row) return null;
  const summary = await summarize(db, userId, row);
  const destinations = await db
    .select()
    .from(recipientDestinations)
    .where(eq(recipientDestinations.recipientId, row.id))
    .orderBy(desc(recipientDestinations.isDefault), desc(recipientDestinations.createdAt));
  const verifications = await verificationMap(
    db,
    destinations.map((d) => d.verificationId),
  );
  const { defaultDestination: _default, ...rest } = summary;
  void _default;
  return { ...rest, destinations: destinations.map((d) => toDestinationView(d, verifications)) };
}

export async function updateRecipient(
  userId: string,
  recipientId: string,
  patch: { displayName?: string; archived?: boolean },
): Promise<RecipientSummary | null> {
  const db = getDb();
  const row = await findRecipient(db, userId, recipientId);
  if (!row) return null;
  const updates: Partial<{ displayName: string; archivedAt: Date | null }> = {};
  if (patch.displayName !== undefined) {
    if (row.archivedAt) requireActive(row);
    updates.displayName = parseOr400(displayNameSchema, patch.displayName);
  }
  if (patch.archived !== undefined) {
    updates.archivedAt = patch.archived ? new Date() : null;
  }
  if (Object.keys(updates).length === 0) {
    throw new AuthError(400, "BAD_BODY", "Nothing to update.");
  }
  const updated = await db
    .update(recipients)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(recipients.id, row.id))
    .returning();
  const next = updated[0];
  if (!next) return null;
  return summarize(db, userId, next);
}

/* ------------------------------------------------------------------ */
/* destinations                                                           */
/* ------------------------------------------------------------------ */

export async function createDestination(
  userId: string,
  recipientId: string,
  input: DestinationInput,
): Promise<DestinationView> {
  const db = getDb();
  const owner = await findRecipient(db, userId, recipientId);
  if (!owner) throw new AuthError(404, "NOT_FOUND", "Recipient not found.");
  requireActive(owner);
  return db.transaction(async (tx) => {
    await lockRecipient(tx, owner.id);
    const inserted = await tx
      .insert(recipientDestinations)
      .values({
        recipientId: owner.id,
        asset: input.asset,
        network: input.network,
        address: input.address.trim(),
        label: input.label?.trim() ? input.label.trim() : null,
        isDefault: false,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new AuthError(500, "DESTINATION_FAILED", "Could not add destination.");
    const existingDefault = await tx
      .select({ id: recipientDestinations.id })
      .from(recipientDestinations)
      .where(
        and(
          eq(recipientDestinations.recipientId, owner.id),
          eq(recipientDestinations.isDefault, true),
          ne(recipientDestinations.id, row.id),
        ),
      )
      .limit(1);
    let isDefault = false;
    if (input.isDefault === true || existingDefault.length === 0) {
      await setDefaultAtomic(tx, owner.id, row.id);
      isDefault = true;
    }
    return toDestinationView({ ...row, isDefault }, await verificationMap(tx, [row.verificationId]));
  });
}

export async function updateDestination(
  userId: string,
  recipientId: string,
  destinationId: string,
  patch: DestinationPatch,
): Promise<DestinationView | null> {
  const db = getDb();
  const owner = await findRecipient(db, userId, recipientId);
  if (!owner) throw new AuthError(404, "NOT_FOUND", "Recipient not found.");
  requireActive(owner);
  const run = (): Promise<DestinationView | null> =>
    db.transaction(async (tx) => {
      await lockRecipient(tx, owner.id);
      const rows = await tx
      .select()
      .from(recipientDestinations)
      .where(
        and(eq(recipientDestinations.id, destinationId), eq(recipientDestinations.recipientId, owner.id)),
      )
      .limit(1);
    const current = rows[0];
    if (!current) return null;
    const next = {
      asset: patch.asset ?? current.asset,
      network: patch.network ?? current.network,
      address: (patch.address ?? current.address).trim(),
    };
    if (patch.asset !== undefined || patch.network !== undefined || patch.address !== undefined) {
      const parsed = destinationInputSchema
        .pick({ asset: true, network: true, address: true })
        .safeParse(next);
      if (!parsed.success) throw badBody(parsed.error.issues[0]?.message ?? "Invalid destination.");
      const check = checkDestination(parsed.data.network, parsed.data.asset, parsed.data.address);
      if (!check.ok) throw new AuthError(400, check.code, check.message);
    }
    const updates: Partial<{ asset: string; network: string; address: string; label: string | null }> = {
      asset: next.asset,
      network: next.network,
      address: next.address,
    };
    if (patch.label !== undefined) {
      const label = parseOr400(labelSchema, patch.label ?? undefined);
      updates.label = label?.trim() ? label.trim() : null;
    }
    await tx
      .update(recipientDestinations)
      .set(updates)
      .where(eq(recipientDestinations.id, current.id));
    // A changed triple invalidates prior proof: the old signature must not
    // verify the new destination. Re-read the badge AFTER the write (under
    // the advisory + row locks this txn holds) so a concurrently committed
    // verification cannot slip a badge onto the new triple.
    const tripleChanged =
      next.asset !== current.asset || next.network !== current.network || next.address.trim() !== current.address;
    if (tripleChanged) {
      const reread = await tx
        .select({ verificationId: recipientDestinations.verificationId })
        .from(recipientDestinations)
        .where(eq(recipientDestinations.id, current.id))
        .limit(1);
      const badgeId = reread[0]?.verificationId ?? null;
      if (badgeId) {
        await tx
          .update(recipientDestinations)
          .set({ verificationId: null })
          .where(eq(recipientDestinations.id, current.id));
        const stillReferenced = await tx
          .select({ id: recipientDestinations.id })
          .from(recipientDestinations)
          .where(eq(recipientDestinations.verificationId, badgeId))
          .limit(1);
        if (stillReferenced.length === 0) {
          await tx.delete(recipientVerifications).where(eq(recipientVerifications.id, badgeId));
        }
      }
    }
    if (patch.isDefault === true) {
      await setDefaultAtomic(tx, owner.id, current.id);
      current.isDefault = true;
    } else if (patch.isDefault === false && current.isDefault) {
      // Unsetting the only default would orphan Pay-Again; promote the
      // most recent sibling instead, or leave it if none remain.
      const siblings = await tx
        .select()
        .from(recipientDestinations)
        .where(
          and(eq(recipientDestinations.recipientId, owner.id), ne(recipientDestinations.id, current.id)),
        )
        .orderBy(desc(recipientDestinations.createdAt))
        .limit(1);
      const replacement = siblings[0];
      if (replacement) {
        await setDefaultAtomic(tx, owner.id, replacement.id);
        current.isDefault = false;
      }
    }
    const refreshed = await tx
      .select()
      .from(recipientDestinations)
      .where(eq(recipientDestinations.id, current.id))
      .limit(1);
    const final = refreshed[0];
    if (!final) return null;
    return toDestinationView(final, await verificationMap(tx, [final.verificationId]));
    });
  return withUniqueRetry(run);
}

export async function deleteDestination(
  userId: string,
  recipientId: string,
  destinationId: string,
): Promise<{ deleted: true } | null> {
  const db = getDb();
  const owner = await findRecipient(db, userId, recipientId);
  if (!owner) throw new AuthError(404, "NOT_FOUND", "Recipient not found.");
  requireActive(owner);
  return db.transaction(async (tx) => {
    await lockRecipient(tx, owner.id);
    const rows = await tx
      .select()
      .from(recipientDestinations)
      .where(
        and(eq(recipientDestinations.id, destinationId), eq(recipientDestinations.recipientId, owner.id)),
      )
      .limit(1);
    const current = rows[0];
    if (!current) return null;
    await tx.delete(recipientDestinations).where(eq(recipientDestinations.id, current.id));
    // App-level cascade (no FK by design — see schema): proofs bound to a
    // deleted destination must not linger as misleading verified state.
    await tx.delete(recipientVerifications).where(eq(recipientVerifications.destinationId, current.id));
    if (current.isDefault) {
      // Promote the most recent sibling so Pay-Again keeps working.
      const siblings = await tx
        .select()
        .from(recipientDestinations)
        .where(eq(recipientDestinations.recipientId, owner.id))
        .orderBy(desc(recipientDestinations.createdAt))
        .limit(1);
      const replacement = siblings[0];
      if (replacement) {
        await setDefaultAtomic(tx, owner.id, replacement.id);
      }
    }
    return { deleted: true as const };
  });
}
