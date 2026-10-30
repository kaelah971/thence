"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { NimMark } from "@/ui/components/PaymentCard";
import { Notice, Segmented } from "@/ui/components/primitives";
import { completeOnboarding, connectWithNimiqPay, type ConnectOutcome } from "@/ui/lib/auth-client";
import { getHostProvider } from "@/ui/lib/nimiq-provider";
import { routeAfterSignIn } from "@/ui/lib/onboarding-flow";
import { setAuthenticated } from "@/ui/lib/session";
import { clearSetupName, PREVIEW_ALLOWED, readSetupName } from "@/ui/lib/stores";
import type { ConnectAttempt } from "@/ui/lib/wallet";
import styles from "../screens.module.css";

/**
 * "Continue with Nimiq Pay": real provider init → server challenge →
 * Nimiq Pay signature → backend verification → session. Every failure
 * leaves the user disconnected with an honest explanation.
 */
const browserFetch: typeof fetch = (...args) => fetch(...args);

const BUSY: ReadonlySet<ConnectAttempt> = new Set(["initializing", "signing", "verifying"]);

const OUTCOME_STATE: Record<Exclude<ConnectOutcome["kind"], "authenticated">, ConnectAttempt> = {
  unavailable: "unavailable",
  rejected: "rejected",
  network: "network",
  expired: "expired",
  "rate-limited": "rate-limited",
  failed: "failed",
};

/** Development-only: preview each notice. It never creates a session. */
const STATE_OPTIONS: ReadonlyArray<{ value: ConnectAttempt; label: string }> = [
  { value: "idle", label: "Idle" },
  { value: "signing", label: "Waiting" },
  { value: "rejected", label: "Declined" },
  { value: "unavailable", label: "Unavailable" },
];

const BUTTON_LABEL: Partial<Record<ConnectAttempt, string>> = {
  initializing: "Opening Nimiq Pay…",
  signing: "Waiting for approval…",
  verifying: "Checking your signature…",
};

export function ConnectWallet({ tone = "light", returnTo }: { tone?: "light" | "dark"; returnTo?: string }): React.JSX.Element {
  const router = useRouter();
  const [attempt, setAttempt] = useState<ConnectAttempt>("idle");
  const [failure, setFailure] = useState<"signature" | "server" | "unsupported">("server");
  const running = useRef(false);
  const dark = tone === "dark";
  const busy = BUSY.has(attempt);

  const connect = async () => {
    if (running.current) return;
    running.current = true;
    try {
      const outcome = await connectWithNimiqPay({ getProvider: getHostProvider, fetch: browserFetch }, setAttempt);
      if (outcome.kind !== "authenticated") {
        if (outcome.kind === "failed") setFailure(outcome.reason);
        setAttempt(OUTCOME_STATE[outcome.kind]);
        return;
      }
      // Decide the destination first, then publish the session once, so the
      // screens' "already signed in" redirects can't race this navigation.
      const next = await routeAfterSignIn(outcome.me, readSetupName(), (name) => completeOnboarding(browserFetch, name));
      setAuthenticated(next.me);
      if (next.discardTemporaryName) clearSetupName();
      // An onboarded person returns to what they were doing (e.g. paying a request link).
      router.replace(returnTo?.startsWith("/app/") && next.route === "/app/home" ? returnTo : next.route);
    } finally {
      running.current = false;
    }
  };

  const retryLabel = attempt === "idle" || busy ? null : "Try Nimiq Pay again";

  return (
    <div className={styles.connect}>
      <div aria-live="polite" className={styles.connectStatus}>
        {(attempt === "initializing" || attempt === "signing" || attempt === "verifying") && (
          <Notice tone={dark ? "dark" : "info"} icon="clock" title={attempt === "verifying" ? "Checking your signature…" : "Waiting for Nimiq Pay…"}>
            {attempt === "verifying"
              ? "Thence is confirming the signature with its server."
              : "Approve the sign-in request in Nimiq Pay. Signing in doesn't move any money."}
          </Notice>
        )}
        {attempt === "rejected" && (
          <Notice tone={dark ? "dark" : "warn"} icon="info" title="Sign-in declined">
            Nothing was shared and you&apos;re not connected. Try again whenever you&apos;re ready.
          </Notice>
        )}
        {attempt === "unavailable" && (
          <Notice tone={dark ? "dark" : "warn"} icon="info" title="Open Thence inside Nimiq Pay to connect">
            Nimiq Pay wasn&apos;t found in this browser. Open Thence from the Mini Apps list in Nimiq Pay, then try again.
          </Notice>
        )}
        {attempt === "network" && (
          <Notice tone={dark ? "dark" : "warn"} icon="alert" title="Connection problem">
            Thence couldn&apos;t reach the network. Check your connection and try again.
          </Notice>
        )}
        {attempt === "expired" && (
          <Notice tone={dark ? "dark" : "warn"} icon="clock" title="That sign-in request expired">
            Sign-in requests are only valid for a few minutes. Try again to get a fresh one.
          </Notice>
        )}
        {attempt === "rate-limited" && (
          <Notice tone={dark ? "dark" : "warn"} icon="clock" title="Too many attempts">
            Wait a minute, then try again.
          </Notice>
        )}
        {attempt === "failed" && (
          <Notice tone={dark ? "dark" : "error"} icon="alert" title="Couldn't sign you in">
            {failure === "signature"
              ? "The signature couldn't be verified, so you weren't signed in."
              : failure === "unsupported"
                ? "This version of Nimiq Pay can't sign in to Thence. Update Nimiq Pay and try again."
                : "Something went wrong on our side. You weren't signed in — try again."}
          </Notice>
        )}
      </div>

      <Button
        variant={dark ? "light" : "ink"}
        block
        onClick={() => void connect()}
        disabled={busy}
        aria-busy={busy}
        className={styles.nimiqButton}
      >
        <span className={styles.nimiqButtonInner}>
          <NimMark size={22} />
          {BUTTON_LABEL[attempt] ?? retryLabel ?? "Continue with Nimiq Pay"}
        </span>
      </Button>

      <p className={dark ? styles.trustDark : styles.trust}>
        <Icon name="shield" size={18} />
        <span>
          You approve every payment.
          <br />
          Thence doesn&apos;t hold your funds.
        </span>
      </p>

      {PREVIEW_ALLOWED && (
        <div className={dark ? styles.devToolsDark : styles.devTools}>
          <p className={styles.devLabel}>Development only · previews messages, never signs in</p>
          <Segmented label="Preview connection state" options={STATE_OPTIONS} value={attempt} onChange={setAttempt} tone={dark ? "dark" : "light"} className={styles.devSegmented} />
          <Link href="/app/preview" className={styles.devLink}>
            Open the development preview
            <Icon name="arrow-right" size={16} />
          </Link>
        </div>
      )}
    </div>
  );
}
