"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/ui/components/Icon";
import shell from "@/ui/components/shell.module.css";
import styles from "./receipts.module.css";

interface Receipt {
  id: string;
  createdAt: string;
  status: string;
  asset: string;
  network: string;
  recipient: string;
  amount: string;
  nimiqTxHash: string | null;
  payoutTxHash: string | null;
}

const RANGES = [
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
  { id: "365", label: "1 year" },
] as const;

const short = (value: string) => (value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value);

/**
 * Receipts for freelancers and small merchants: every payment with both
 * transaction hashes, and a CSV that a spreadsheet can open.
 */
export function Receipts(): React.JSX.Element {
  const [days, setDays] = useState<string>("90");
  const [rows, setRows] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/receipts?days=${days}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }) => {
        if (!live) return;
        if (!ok) { setError(body?.message ?? "Could not load receipts."); setRows([]); return; }
        setRows(Array.isArray(body?.receipts) ? body.receipts : []);
        setError(null);
      })
      .catch(() => { if (live) { setRows([]); setError("Could not load receipts."); } });
    return () => { live = false; };
  }, [days]);

  return (
    <main className={shell.screen}>
      <section className={shell.darkTop}>
        <span className={shell.glow} aria-hidden="true" />
        <h1 className={shell.title}>Receipts</h1>
        <p className={styles.lede}>Every payment, with the two transactions that prove it.</p>
        <div className={styles.filters} role="group" aria-label="Date range">
          {RANGES.map((range) => (
            <button key={range.id} type="button" className={styles.chip} data-active={days === range.id}
              aria-pressed={days === range.id} onClick={() => setDays(range.id)}>
              {range.label}
            </button>
          ))}
        </div>
      </section>

      <section className={`${shell.paper} th-light`}>
        <span className={shell.paperHandle} aria-hidden="true" />
        <div className={styles.head}>
          <p className={styles.count}>{rows ? `${rows.length} payment${rows.length === 1 ? "" : "s"}` : "Loading…"}</p>
          <a className={styles.download} href={`/api/receipts?format=csv&days=${days}`} download>
            Download CSV
          </a>
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}
        {rows && rows.length === 0 && !error && <p className={styles.empty}>No payments in this range yet.</p>}

        <ul className={styles.list}>
          {(rows ?? []).map((row) => (
            <li key={row.id} className={styles.row}>
              <div className={styles.line}>
                <span className={styles.amount}>{row.amount} {row.asset}</span>
                <span className={styles.status} data-status={row.status}>{row.status.replaceAll("_", " ").toLowerCase()}</span>
              </div>
              <p className={styles.meta}>
                {new Date(row.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · {row.network} · to {short(row.recipient)}
              </p>
              <p className={styles.hashes}>
                {row.nimiqTxHash ? <span>NIM <code>{short(row.nimiqTxHash)}</code></span> : <span>NIM <code>—</code></span>}
                {row.payoutTxHash ? <span>USDC <code>{short(row.payoutTxHash)}</code></span> : <span>USDC <code>—</code></span>}
              </p>
            </li>
          ))}
        </ul>

        <p className={styles.foot}>
          The CSV carries full hashes and dates. <Link href="/app/activity" className={styles.link}>Activity</Link> has the same payments with their status.
        </p>
      </section>

      <div className={styles.back}>
        <Link href="/app/home" className={styles.link}><Icon name="chevron-left" size={14} /> Home</Link>
      </div>
    </main>
  );
}
