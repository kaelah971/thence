import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { deskOrders, inboxState, transfers } from "@/db/schema";
import { listSchedules } from "@/lib/schedules";

/**
 * The owner's notification inbox, derived from what actually happened.
 *
 * There is no push channel: Nimiq Pay's mini-app SDK exposes none. So the app
 * polls this list and shows a dot. Every entry is derived from a committed
 * row — nothing here can announce an event that did not happen.
 */
export type InboxEvent = {
  key: string;
  kind: "delivered" | "attention" | "schedule";
  title: string;
  detail: string;
  at: string;
  href: string;
};

const usdc = (atomic: string) => (Number(atomic) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const NETWORK: Record<string, string> = { "usdc-polygon": "Polygon", "usdc-arbitrum": "Arbitrum", "usdc-base": "Base" };
const short = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

export async function listInbox(userId: string): Promise<{ events: InboxEvent[]; unread: number }> {
  const db = getDb();
  const [delivered, attention, schedules, state] = await Promise.all([
    db.select().from(transfers)
      .where(and(eq(transfers.ownerUserId, userId), eq(transfers.status, "DELIVERED")))
      .orderBy(desc(transfers.updatedAt)).limit(20),
    db.select().from(transfers)
      .where(and(eq(transfers.ownerUserId, userId), inArray(transfers.status, ["NEEDS_ATTENTION", "DESK_REFUND_DUE"])))
      .orderBy(desc(transfers.updatedAt)).limit(10),
    listSchedules(userId),
    db.select().from(inboxState).where(eq(inboxState.userId, userId)).limit(1),
  ]);

  const events: InboxEvent[] = [];
  for (const t of delivered) {
    events.push({
      key: `transfer:${t.id}:delivered`,
      kind: "delivered",
      title: `${usdc(t.targetAmountAtomic)} ${t.targetAsset} delivered`,
      detail: `${NETWORK[t.routeId] ?? t.targetNetwork} · to ${short(t.destination)}`,
      at: t.updatedAt.toISOString(),
      href: "/app/activity",
    });
  }
  for (const t of attention) {
    events.push({
      key: `transfer:${t.id}:attention`,
      kind: "attention",
      title: "A payment needs a look",
      detail: `${usdc(t.targetAmountAtomic)} ${t.targetAsset} · ${t.status === "DESK_REFUND_DUE" ? "refund due" : "needs attention"}`,
      at: t.updatedAt.toISOString(),
      href: "/app/activity",
    });
  }
  for (const s of schedules) {
    if (!s.due) continue;
    events.push({
      key: `schedule:${s.id}:due:${s.nextDueAt}`,
      kind: "schedule",
      title: "A scheduled payment is due",
      detail: `${usdc(s.amountAtomic)} USDC · ${NETWORK[s.routeId] ?? s.routeId} · ${s.cadence}`,
      at: s.nextDueAt,
      href: "/app/home",
    });
  }

  // Desk payouts that are still in flight are deliberately absent: they are
  // not news until the chain finalizes them.
  events.sort((a, b) => b.at.localeCompare(a.at));
  const seenAt = state[0]?.seenAt?.getTime() ?? 0;
  const unread = events.filter((e) => new Date(e.at).getTime() > seenAt).length;
  return { events: events.slice(0, 30), unread };
}

export async function markInboxSeen(userId: string): Promise<void> {
  await getDb().insert(inboxState)
    .values({ userId, seenAt: new Date() })
    .onConflictDoUpdate({ target: inboxState.userId, set: { seenAt: new Date() } });
}
