import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { paymentSchedules } from "@/db/schema";
import { AuthError } from "@/lib/auth";
import { isAtomicAmount } from "@/domain/money";

export const CADENCES = ["weekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

/** Weekly adds seven days; monthly keeps the day-of-month, clamped to the last day. */
export function nextDue(from: Date, cadence: Cadence): Date {
  const next = new Date(from.getTime());
  if (cadence === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

export interface ScheduleView {
  id: string;
  routeId: string;
  destination: string;
  recipientName: string | null;
  amountAtomic: string;
  cadence: Cadence;
  nextDueAt: string;
  lastPaidAt: string | null;
  paused: boolean;
  due: boolean;
}

const createSchema = z.object({
  action: z.literal("create"),
  routeId: z.string().min(1).max(32),
  destination: z.string().min(1).max(200),
  recipientName: z.string().max(120).optional(),
  amountAtomic: z.string().max(40),
  cadence: z.enum(CADENCES),
  /** First run; defaults to one cadence from now. */
  startAt: z.string().datetime().optional(),
}).strict();

const actionSchema = z.discriminatedUnion("action", [
  createSchema,
  z.object({ action: z.literal("pause"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("resume"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
]);

function toView(row: typeof paymentSchedules.$inferSelect, now: Date): ScheduleView {
  return {
    id: row.id,
    routeId: row.routeId,
    destination: row.destination,
    recipientName: row.recipientName,
    amountAtomic: row.amountAtomic,
    cadence: row.cadence as Cadence,
    nextDueAt: row.nextDueAt.toISOString(),
    lastPaidAt: row.lastPaidAt?.toISOString() ?? null,
    paused: row.paused,
    due: !row.paused && row.nextDueAt.getTime() <= now.getTime(),
  };
}

export async function listSchedules(userId: string): Promise<ScheduleView[]> {
  const rows = await getDb().select().from(paymentSchedules)
    .where(eq(paymentSchedules.ownerUserId, userId))
    .orderBy(asc(paymentSchedules.nextDueAt))
    .limit(50);
  const now = new Date();
  return rows.map((row) => toView(row, now));
}

export async function createSchedule(userId: string, body: unknown): Promise<ScheduleView> {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new AuthError(400, "BAD_BODY", "Check the schedule details.");
  const { routeId, destination, recipientName, amountAtomic, cadence, startAt } = parsed.data;
  // Only the treasury desk routes can be scheduled; nothing else is live.
  if (!/^usdc-(polygon|arbitrum|base)$/.test(routeId)) throw new AuthError(400, "UNKNOWN_ROUTE", "This route cannot be scheduled.");
  if (!isAtomicAmount(amountAtomic) || BigInt(amountAtomic) <= 0n) throw new AuthError(400, "BAD_BODY", "Enter an amount to send.");
  if (destination.trim().length === 0) throw new AuthError(400, "BAD_BODY", "Enter a destination.");
  // A cap keeps one account from filling the table (and their Home card)
  // through a scripted loop; twenty is far beyond any real use.
  const existing = await getDb().select({ id: paymentSchedules.id })
    .from(paymentSchedules).where(eq(paymentSchedules.ownerUserId, userId)).limit(21);
  if (existing.length >= 20) throw new AuthError(409, "TOO_MANY_SCHEDULES", "You already have 20 scheduled payments. Delete one first.");
  // Duplicates are a mis-tap, not a feature: same recipient and amount is one schedule.
  if (existing.length > 0) {
    const same = await getDb().select({ id: paymentSchedules.id }).from(paymentSchedules).where(and(
      eq(paymentSchedules.ownerUserId, userId),
      eq(paymentSchedules.routeId, routeId),
      eq(paymentSchedules.destination, destination.trim()),
      eq(paymentSchedules.amountAtomic, amountAtomic),
    )).limit(1);
    if (same[0]) throw new AuthError(409, "DUPLICATE_SCHEDULE", "You already have this payment scheduled.");
  }
  const now = new Date();
  const first = startAt ? new Date(startAt) : nextDue(now, cadence);
  if (Number.isNaN(first.getTime())) throw new AuthError(400, "BAD_BODY", "Invalid start date.");
  const rows = await getDb().insert(paymentSchedules).values({
    ownerUserId: userId,
    routeId,
    destination: destination.trim(),
    recipientName: recipientName?.trim() || null,
    amountAtomic,
    cadence,
    nextDueAt: first,
  }).returning();
  return toView(rows[0]!, now);
}

export async function updateSchedule(userId: string, body: unknown): Promise<{ ok: true }> {
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) throw new AuthError(400, "BAD_BODY", "Unknown schedule action.");
  const input = parsed.data;
  if (input.action === "create") throw new AuthError(400, "BAD_BODY", "Use create directly.");
  const patch = input.action === "pause" ? { paused: true } : input.action === "resume" ? { paused: false } : null;
  const where = and(eq(paymentSchedules.id, input.id), eq(paymentSchedules.ownerUserId, userId));
  if (patch === null) {
    const deleted = await getDb().delete(paymentSchedules).where(where).returning({ id: paymentSchedules.id });
    if (!deleted[0]) throw new AuthError(404, "NOT_FOUND", "Schedule not found.");
    return { ok: true };
  }
  const updated = await getDb().update(paymentSchedules)
    .set({ ...patch, updatedAt: new Date() })
    .where(where)
    .returning({ id: paymentSchedules.id });
  if (!updated[0]) throw new AuthError(404, "NOT_FOUND", "Schedule not found.");
  return { ok: true };
}

/**
 * Called when a real payment is created for the same recipient and amount:
 * the schedule's turn is spent, so it moves to the next cadence. This is the
 * only thing that advances a schedule — never the clock alone.
 */
export async function markSchedulesPaid(userId: string, routeId: string, destination: string, amountAtomic: string): Promise<void> {
  const rows = await getDb().select().from(paymentSchedules).where(and(
    eq(paymentSchedules.ownerUserId, userId),
    eq(paymentSchedules.routeId, routeId),
    eq(paymentSchedules.amountAtomic, amountAtomic),
    lte(paymentSchedules.nextDueAt, new Date()),
  ));
  for (const row of rows) {
    if (row.destination.toLowerCase() !== destination.toLowerCase()) continue;
    await getDb().update(paymentSchedules)
      .set({ lastPaidAt: new Date(), nextDueAt: nextDue(row.nextDueAt, row.cadence as Cadence), updatedAt: new Date() })
      .where(eq(paymentSchedules.id, row.id));
  }
}
