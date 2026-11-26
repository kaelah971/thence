"use client";

import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { repeatHref } from "@/ui/lib/send-navigation";
import { formatLuna } from "@/ui/lib/luna";
import styles from "./scheduled.module.css";

export interface ScheduleView {
  id: string;
  routeId: string;
  destination: string;
  recipientName: string | null;
  amountAtomic: string;
  cadence: "weekly" | "monthly";
  nextDueAt: string;
  lastPaidAt: string | null;
  paused: boolean;
  due: boolean;
}

const NETWORK: Record<string, string> = { "usdc-polygon": "Polygon", "usdc-arbitrum": "Arbitrum", "usdc-base": "Base" };
const usdc = (atomic: string) => (Number(atomic) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

function whenLabel(schedule: ScheduleView, now: number): string {
  if (schedule.paused) return "Paused";
  const at = new Date(schedule.nextDueAt).getTime();
  const days = Math.round((at - now) / 86_400_000);
  if (at <= now) return "Due now";
  if (days === 1) return "Tomorrow";
  if (days < 7) return `In ${days} days`;
  return new Date(schedule.nextDueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Scheduled payments: intents that come due. They never move money by
 * themselves — the button opens the normal send flow, prefilled.
 */
export function ScheduledCard({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetch("/api/schedules", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && Array.isArray(body?.schedules)) setSchedules(body.schedules); })
      .catch(() => { /* the card is optional */ });
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled]);

  if (!enabled || !schedules || schedules.length === 0) return null;

  const act = async (id: string, action: "pause" | "resume" | "delete") => {
    setBusy(id);
    try {
      await fetch("/api/schedules", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const next = await fetch("/api/schedules", { cache: "no-store", credentials: "same-origin" }).then((r) => r.json());
      if (Array.isArray(next?.schedules)) setSchedules(next.schedules);
    } finally { setBusy(null); }
  };

  return (
    <section className={styles.card} aria-label="Scheduled payments">
      <div className={styles.head}>
        <p className={styles.title}>Scheduled</p>
        <span className={styles.hint}>You approve each one</span>
      </div>
      <ul className={styles.list}>
        {schedules.map((s) => (
          <li key={s.id} className={styles.row}>
            <div className={styles.who}>
              <Icon name="clock" size={16} />
              <span className={styles.name}>{s.recipientName || "Recipient"}</span>
              <span className={styles.meta}>
                {usdc(s.amountAtomic)} USDC · {NETWORK[s.routeId] ?? s.routeId} · {s.cadence}
              </span>
            </div>
            <div className={styles.state}>
              <span className={s.due && !s.paused ? styles.due : styles.when}>{whenLabel(s, now)}</span>
              {s.due && !s.paused ? (
                <ButtonLink href={repeatHref({ routeId: s.routeId, address: s.destination, name: s.recipientName, amount: usdc(s.amountAtomic) })} variant="ink" size="sm">
                  Send now
                </ButtonLink>
              ) : (
                <Button variant="soft" size="sm" disabled={busy === s.id} onClick={() => void act(s.id, s.paused ? "resume" : "pause")}>
                  {s.paused ? "Resume" : "Pause"}
                </Button>
              )}
              <button type="button" className={styles.remove} disabled={busy === s.id} onClick={() => void act(s.id, "delete")} aria-label="Delete schedule">
                <Icon name="close" size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className={styles.foot}>Nothing sends on its own. When one is due, you review and approve it in Nimiq Pay.</p>
    </section>
  );
}
