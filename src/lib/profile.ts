/**
 * Thence backend — minimal user profile (F2).
 *
 * Scope: a preferred display name and a one-time onboarding-completion
 * timestamp on the existing `users` row. Identity always comes from the
 * verified session; clients never supply a user id or address.
 *
 * Completion is write-once: `completeOnboarding` only sets the name when
 * onboarding has not completed yet (atomic UPDATE … WHERE
 * onboarding_completed_at IS NULL). A returning account's saved name is
 * never overwritten by temporary name-entry state from a new device.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const PROFILE_NAME_MAX = 32;

/** Control, format (zero-width, bidi override) and line/paragraph separators. */
const DISALLOWED_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const profileNameSchema = z
  .string()
  .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Enter a name or nickname.")
      .max(PROFILE_NAME_MAX, `Use ${PROFILE_NAME_MAX} characters or fewer.`)
      .refine((value) => !DISALLOWED_CHARS.test(value), "Name contains unsupported characters."),
  );

export interface Profile {
  displayName: string | null;
  onboardingCompletedAt: string | null;
}

export function parseProfileName(value: unknown): string {
  if (typeof value !== "string") throw new AuthError(400, "BAD_BODY", "displayName must be a string.");
  const parsed = profileNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new AuthError(400, "INVALID_NAME", parsed.error.issues[0]?.message ?? "Invalid name.");
  }
  return parsed.data;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const rows = await getDb()
    .select({ displayName: users.displayName, onboardingCompletedAt: users.onboardingCompletedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { displayName: row.displayName, onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null };
}

/**
 * Complete onboarding for the session's user. Returns `applied: false` with
 * the existing profile when onboarding had already completed (idempotent,
 * name preserved).
 */
export async function completeOnboarding(userId: string, rawName: unknown): Promise<{ profile: Profile; applied: boolean }> {
  const displayName = parseProfileName(rawName);
  const updated = await getDb()
    .update(users)
    .set({ displayName, onboardingCompletedAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt)))
    .returning({ displayName: users.displayName, onboardingCompletedAt: users.onboardingCompletedAt });
  const row = updated[0];
  if (row) {
    return {
      profile: { displayName: row.displayName, onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null },
      applied: true,
    };
  }
  const existing = await getProfile(userId);
  if (!existing) throw new AuthError(401, "UNAUTHORIZED", "Authentication required.");
  return { profile: existing, applied: false };
}
