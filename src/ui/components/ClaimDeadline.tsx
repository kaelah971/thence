"use client";

/**
 * P2 — claim deadline awareness for funded payments that need the owner to
 * finish delivery (Send settlement screen and Activity recovery).
 *
 * Time-aware by construction: it re-evaluates on a short clock tick AND the
 * moment the app returns to the foreground, so a payment left in the
 * background never shows a stale "time left" or a claim action that is no
 * longer safe. The action (children) renders ONLY while the window is open
 * or closing; never when unknown, unsafe or passed.
 *
 * The deadline shown is the Polygon claim deadline (Satora
 * evm_refund_locktime, fixed at swap creation). It is deliberately labelled
 * as separate from Nimiq Pay's own NIM refund timer.
 */
import { useEffect, useState } from "react";
import { Notice } from "@/ui/components/primitives";
import { claimActionAllowed, claimWindowAt, type ClaimWindow } from "@/domain/claim-deadline";

/** Current time, refreshed every `intervalMs` and immediately on foreground. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (typeof document === "undefined" || !document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [intervalMs]);
  return now;
}

/** "1 h 5 min", "42 min", "under 1 min". */
export function formatTimeLeft(ms: number): string {
  if (ms < 60_000) return "under 1 min";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export const NIM_TIMER_SEPARATE_NOTE =
  "This is the delivery deadline on the recipient's network. It's separate from Nimiq Pay's own timer for returning NIM.";

/** Live claim window for a deadline (re-evaluated on a clock tick and on foreground). */
export function useClaimWindow(deadlineMs: number | null, intervalMs = 5_000): { window: ClaimWindow; now: number } {
  const now = useNow(intervalMs);
  return { window: claimWindowAt(deadlineMs, now), now };
}

/**
 * Compact deadline line for the primary "Finish delivery" state: the real
 * Polygon deadline and a live countdown. Outside the open/closing window it
 * renders the same explicit warnings as ClaimDeadlineNotice, and the caller
 * must not offer the action (see useClaimWindow + claimActionAllowed).
 */
export function ClaimDeadlineLine({ deadlineMs, className }: { deadlineMs: number | null; className?: string | undefined }): React.JSX.Element {
  const { window, now } = useClaimWindow(deadlineMs);
  if (window === "unknown" || window === "passed" || window === "unsafe" || deadlineMs === null) {
    return <ClaimDeadlineNotice deadlineMs={deadlineMs} actionAvailable={false} />;
  }
  return (
    <div data-claim-window={window} className={className}>
      <p data-deadline-line data-tone={window === "closing" ? "warn" : undefined}>
        Finish delivery before {formatClockTime(deadlineMs)} — <span className="tabular">{formatTimeLeft(deadlineMs - now)}</span> left
      </p>
      <p data-deadline-note>
        After that it can&apos;t be delivered and the funds go back to the provider. It&apos;s separate from Nimiq Pay&apos;s own timer for returning NIM.
      </p>
    </div>
  );
}

export function ClaimDeadlineNotice({
  deadlineMs,
  actionAvailable,
  children,
}: {
  deadlineMs: number | null;
  /** Server-side claim readiness (funded, clean identity, server window). Both clocks must agree. */
  actionAvailable: boolean;
  /** The finish-delivery control; rendered only while a claim is still safe. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const now = useNow();
  const window: ClaimWindow = claimWindowAt(deadlineMs, now);
  if (window === "unknown" || deadlineMs === null) {
    return (
      <div data-claim-window="unknown">
        <Notice tone="warn" icon="alert" title="Action needed — we can't confirm the delivery deadline yet" live>
          Finishing delivery stays unavailable until the deadline is confirmed. Check again shortly — don&apos;t resend.
        </Notice>
      </div>
    );
  }
  const at = formatClockTime(deadlineMs);
  if (window === "passed") {
    return (
      <div data-claim-window="passed">
        <Notice tone="warn" icon="alert" title="The delivery deadline has passed" live>
          The deadline was {at}. Thence is checking whether the provider took the funds back on-chain. Don&apos;t resend.
        </Notice>
      </div>
    );
  }
  if (window === "unsafe") {
    return (
      <div data-claim-window="unsafe">
        <Notice tone="warn" icon="alert" title="Too close to the delivery deadline" live>
          There isn&apos;t enough time left to finish delivery safely before {at} ({formatTimeLeft(deadlineMs - now)} left). Don&apos;t try now —
          Thence keeps checking what happens next. Don&apos;t resend.
        </Notice>
      </div>
    );
  }
  return (
    <div data-claim-window={window}>
      <Notice tone="warn" icon="clock" title="Action needed — Finish delivery" live>
        Finish delivery before {at} — {formatTimeLeft(deadlineMs - now)} left. After that the provider takes the funds back and this payment
        can&apos;t be delivered. {NIM_TIMER_SEPARATE_NOTE}
      </Notice>
      {claimActionAllowed(window) && actionAvailable ? children : null}
    </div>
  );
}
