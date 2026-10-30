"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { absoluteShareUrl } from "@/ui/lib/requests-api";
import { Button } from "./Button";
import styles from "./share.module.css";

const noSubscribe = () => () => {};

/** Copy / share a request link. Uses the server's trusted URL, or the current origin for relative links. */
export function ShareLink({ url, title }: { url: string; title: string }): React.JSX.Element {
  // Browser-only facts, read without an effect; the server render uses the raw URL.
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
  const canShare = useSyncExternalStore(noSubscribe, () => typeof navigator.share === "function", () => false);
  const full = origin ? absoluteShareUrl(url, origin) : url;
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title, url: full });
    } catch {
      /* Dismissed share sheets are not errors. */
    }
  };

  return (
    <div className={styles.share}>
      <p className={styles.label}>Payment link</p>
      <p className={styles.url}>{full}</p>
      <div className={styles.actions} data-single={!canShare}>
        <Button variant="ink" size="md" icon={copied === "copied" ? "check" : "link"} onClick={() => void copy()}>
          {copied === "copied" ? "Copied" : "Copy link"}
        </Button>
        {canShare && (
          <Button variant="soft" size="md" icon="arrow-up-right" onClick={() => void share()}>
            Share
          </Button>
        )}
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {copied === "failed" ? "Couldn't copy. Select the link above and copy it instead." : ""}
      </p>
    </div>
  );
}
