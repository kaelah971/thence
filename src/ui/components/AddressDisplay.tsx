"use client";

import { useState } from "react";
import { maskAddress } from "@/ui/lib/assets";
import { Button } from "./Button";
import styles from "./address.module.css";

/**
 * Consistent wallet-address display (Slice 1 C2).
 *
 * Shows a middle-truncated value (`0x4f2a…3b21`) that never wraps or breaks
 * the layout, with a copy action that always writes the EXACT original
 * address and a user-initiated toggle for the full value.
 * Editable inputs (DestinationForm, request details) intentionally do NOT
 * use this — they stay full-text editable with checksum validation.
 */
export async function copyExactAddress(address: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(address);
    return true;
  } catch {
    return false;
  }
}

export function AddressDisplay({
  address,
  align = "start",
}: {
  /** Exact on-chain address. Copied verbatim; displayed truncated until expanded. */
  address: string;
  /** Right-align inside right-aligned detail rows (facts tables). */
  align?: "start" | "end";
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copy = async () => {
    const ok = await copyExactAddress(address);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <span className={styles.wrap} data-align={align}>
      <span className={styles.row}>
        <span className={styles.truncated} title={address}>
          {maskAddress(address)}
        </span>
        <Button variant="soft" size="sm" icon={copied ? "check" : "link"} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </span>
      {expanded ? (
        <span className={styles.fullRow}>
          <span className={styles.full}>{address}</span>
          <button type="button" className={styles.toggle} onClick={() => setExpanded(false)} aria-expanded="true">
            Show less
          </button>
        </span>
      ) : (
        <button type="button" className={styles.toggle} onClick={() => setExpanded(true)} aria-expanded="false">
          Show full address
        </button>
      )}
    </span>
  );
}
