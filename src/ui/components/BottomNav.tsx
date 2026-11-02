"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";
import { NEW_PAYMENT_HREF } from "@/ui/lib/send-navigation";
import styles from "./shell.module.css";

const TABS: ReadonlyArray<{ href: string; linkHref?: string; label: string; icon: IconName }> = [
  { href: "/app/home", label: "Home", icon: "home" },
  { href: "/app/send", linkHref: NEW_PAYMENT_HREF, label: "Send", icon: "send" },
  { href: "/app/recipients", label: "Recipients", icon: "users" },
  { href: "/app/activity", label: "Activity", icon: "activity" },
];

export function BottomNav(): React.JSX.Element {
  const pathname = usePathname();
  // Requests live under the Send tab (Send · Request).
  const path = pathname.startsWith("/app/requests") ? "/app/send" : pathname;
  const active = Math.max(0, TABS.findIndex((tab) => path.startsWith(tab.href)));
  return (
    <nav className={styles.navWrap} aria-label="Main">
      <div className={styles.nav}>
        <span className={styles.navPill} style={{ transform: `translateX(${active * 100}%)` }} aria-hidden="true" />
        {TABS.map((tab, index) => {
          const current = index === active;
          return (
            <Link key={tab.href} href={tab.linkHref ?? tab.href} className={styles.navItem} aria-current={current ? "page" : undefined} data-active={current}>
              <Icon name={tab.icon} size={22} strokeWidth={current ? 2.2 : 1.9} />
              <span className={styles.navLabel}>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
