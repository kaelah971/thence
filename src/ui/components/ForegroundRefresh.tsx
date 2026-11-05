"use client";

import { useEffect } from "react";
import { invalidateData } from "@/ui/lib/resource";

/** Minimum spacing between foreground refreshes (bursts of focus/visibility/pageshow coalesce). */
export const FOREGROUND_REFRESH_SPACING_MS = 10_000;

/**
 * Re-read mounted data (Activity, Home, balances) when the app returns to the
 * foreground — after Nimiq Pay, another app (e.g. checking the wallet that
 * received the funds), a locked screen or the iOS back-forward cache.
 *
 * Read-only: it only refetches GET resources that are already on screen.
 * Payment progress itself is kept fresh by the shared payment tracker.
 */
export function ForegroundRefresh(): null {
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const now = Date.now();
      if (now - last < FOREGROUND_REFRESH_SPACING_MS) return;
      last = now;
      invalidateData();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      // bfcache restore: the page's data is from before it was frozen.
      if (event.persisted) last = 0;
      refresh();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
  return null;
}
