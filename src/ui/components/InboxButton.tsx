"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/ui/components/Icon";
import { Sheet } from "@/ui/components/Sheet";
import styles from "./inbox.module.css";

interface InboxEvent { key: string; kind: "delivered" | "attention" | "schedule"; title: string; detail: string; at: string; href: string }

/** Bell with an unread dot. Polls only while the mini-app is visible. */
export function InboxButton({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const body = await fetch("/api/inbox", { cache: "no-store", credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
        if (!live || !body) return;
        setEvents(Array.isArray(body.events) ? body.events : []);
        setUnread(Number(body.unread) || 0);
      } catch { /* the bell is optional */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [enabled]);

  if (!enabled) return null;

  const openInbox = () => {
    setOpen(true);
    setUnread(0);
    void fetch("/api/inbox", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).catch(() => {});
  };

  return (
    <>
      <button type="button" className={styles.bell} onClick={openInbox} aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} aria-haspopup="dialog">
        <Icon name="activity" size={20} />
        {unread > 0 && <span className={styles.dot} aria-hidden="true" />}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Notifications">
        {events.length === 0 ? (
          <p className={styles.empty}>Nothing yet. Delivered payments, payments needing a look, and scheduled payments that come due appear here.</p>
        ) : (
          <ul className={styles.list}>
            {events.map((event) => (
              <li key={event.key}>
                <Link href={event.href} className={styles.row} onClick={() => setOpen(false)}>
                  <span className={styles.mark} data-kind={event.kind} aria-hidden="true">
                    <Icon name={event.kind === "delivered" ? "check" : event.kind === "schedule" ? "clock" : "alert"} size={16} />
                  </span>
                  <span className={styles.text}>
                    <span className={styles.title}>{event.title}</span>
                    <span className={styles.detail}>{event.detail}</span>
                    <span className={styles.when}>{new Date(event.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.foot}>The app checks for news while it is open. Nimiq Pay does not let a mini-app push notifications yet.</p>
      </Sheet>
    </>
  );
}
