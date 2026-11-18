"use client";

import { useEffect, useRef, useState } from "react";
import { getHostNetwork } from "@nimiq/mini-app-sdk";
import type { PublicDeskOrder } from "@/lib/desk/store";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Notice } from "@/ui/components/primitives";
import { getHostProvider } from "@/ui/lib/nimiq-provider";
import { handoffDeskPayment } from "@/ui/lib/desk-handoff";
import { formatLuna } from "@/ui/lib/luna";
import styles from "./desk.module.css";

interface DeskView { enabled: boolean; orders: PublicDeskOrder[] }
async function api<T>(body?: unknown): Promise<T> {
  const response = await fetch("/api/desk", body ? { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store", credentials: "same-origin" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "Payment status is unavailable. Do not pay again.");
  return data as T;
}
function usdc(atomic: string) {
  const n = BigInt(atomic);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}
const descriptions: Record<PublicDeskOrder["state"], string> = {
  QUOTED: "Review the exact amounts below before continuing.",
  AWAITING_NIM: "Checking for your NIM payment. If you approved it, do not pay again. You can leave and reopen this page.",
  VERIFIED: "NIM received and verified. Your USDC delivery is queued.",
  PAYOUT_PREPARED: "Your USDC payment is prepared. Delivery is not confirmed yet.",
  PAYOUT_SUBMITTED: "Your USDC payment is being checked on Polygon. Delivery is not confirmed yet.",
  DELIVERED: "Your USDC delivery is confirmed on Polygon.",
  REFUND_DUE: "A full NIM refund is due. Thence must send it from the collection wallet. No refund is confirmed yet.",
  REFUNDED: "The full NIM return is verified on-chain.",
  EXPIRED: "This quote expired before authorization. Get a new quote when ready.",
};
export function Desk() {
  const [view, setView] = useState<DeskView | null>(null), [selected, setSelected] = useState<PublicDeskOrder | null>(null);
  const [recipient, setRecipient] = useState(""), [amount, setAmount] = useState("0.30"), [hash, setHash] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const running = useRef(false);
  const refresh = async () => {
    const next = await api<DeskView>();
    setView(next);
    setSelected(current => next.orders.find(o => o.id === current?.id) ?? next.orders[0] ?? null);
  };
  useEffect(() => {
    let active = true;
    // Read-only hydration. Progress runs on explicit checks or the dedicated server worker.
    void api<DeskView>().then(next => { if (active) { setView(next); setSelected(next.orders[0] ?? null); } }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);
  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setMessage("");
    try { await work(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not check the payment. Do not pay again."); }
    finally { running.current = false; setBusy(false); }
  };
  const quote = () => run(async () => {
    const result = await api<{ order: PublicDeskOrder }>({ action: "quote", recipient, amount, requestKey: crypto.randomUUID() });
    setSelected(result.order); setConsent(false); await refresh();
  });
  const pay = () => run(async () => {
    if (!selected || selected.state !== "QUOTED" || !consent) return;
    const provider = await getHostProvider();
    if (getHostNetwork() !== "mainnet") throw new Error("Open your mainnet Nimiq Pay wallet to continue.");
    if (!provider.sendBasicTransactionWithData) throw new Error("This Nimiq Pay version cannot send this payment.");
    try {
      await handoffDeskPayment({
        authorize: async () => {
          const result = await api<{ order: PublicDeskOrder; promptAllowed: boolean }>({ action: "authorize", id: selected.id });
          setSelected(result.order); return result;
        },
        send: tx => provider.sendBasicTransactionWithData!(tx),
        saveHash: (id, h) => { setHash(h); try { localStorage.setItem(`thence:desk:${id}`, h); } catch { /* Server discovery recovers without browser storage. */ } },
        report: (id, h) => api({ action: "report", id, hash: h }),
      });
    } finally { await refresh(); }
  });
  const check = () => run(async () => {
    if (!selected) { await refresh(); return; }
    let stored = "";
    try { stored = localStorage.getItem(`thence:desk:${selected.id}`) ?? ""; } catch { /* Optional cache. */ }
    const candidate = hash || selected.reportedHash || stored;
    if (selected.state === "AWAITING_NIM" && candidate) await api({ action: "report", id: selected.id, hash: candidate });
    await api({ action: "check", id: selected.id });
    await refresh();
  });
  const canQuote = view?.enabled && (!selected || ["QUOTED", "DELIVERED", "REFUNDED", "EXPIRED"].includes(selected.state));
  return <main className={styles.screen}>
    <ButtonLink href="/app/home" variant="ghost" size="sm">Back to home</ButtonLink>
    <header><p className={styles.eyebrow}>Private pilot · Polygon</p><h1>Pay NIM. Deliver USDC.</h1><p>Thence receives your NIM and pays the recipient from its own USDC wallet.</p></header>
    {message && <Notice live title="Payment update">{message}</Notice>}
    {!view && !message && <p role="status">Loading your payments…</p>}
    {view && !view.enabled && <Notice>New payments are paused. Existing payments can still be checked.</Notice>}
    {canQuote && <form className={styles.card} onSubmit={event => { event.preventDefault(); void quote(); }}>
      <label htmlFor="desk-recipient">Recipient’s Polygon address</label><input id="desk-recipient" value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} required />
      <label htmlFor="desk-amount">USDC they receive</label><input id="desk-amount" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" disabled={busy} required />
      <Button type="submit" disabled={busy} block>Get a quote</Button>
    </form>}
    {selected && <section className={styles.card} aria-label="Payment details">
      <h2>{selected.state === "QUOTED" ? "Review payment" : "Payment status"}</h2><p role="status">{descriptions[selected.state]}</p>
      {selected.code === "MULTIPLE_DEPOSITS" && <Notice>More than one deposit matches this payment. Thence must review it. Do not pay again.</Notice>}
      <dl><dt>Recipient receives</dt><dd>{usdc(selected.amountAtomic)} USDC on Polygon</dd><dt>You send</dt><dd>{formatLuna(BigInt(selected.nimLuna)).text} NIM, plus any wallet network fee</dd><dt>Thence fee (included)</dt><dd>{formatLuna(BigInt(selected.feeLuna)).text} NIM ({selected.feeBps / 100}%)</dd><dt>Recipient</dt><dd>{selected.recipient}</dd><dt>NIM collection wallet</dt><dd>{selected.nimAddress}</dd><dt>Payment reference</dt><dd>{selected.id}</dd></dl>
      {selected.state === "QUOTED" && <>
        <p>Quote expires {new Date(selected.expiresAt).toLocaleTimeString()}. After continuing, approve within five minutes. Late deposits require a refund.</p>
        <label className={styles.consent}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /><span>I understand Thence will hold my NIM while delivering USDC. Refunds require Thence to send NIM back.</span></label>
        <Button block disabled={busy || !consent || !view?.enabled} onClick={() => void pay()}>Continue in Nimiq Pay</Button>
      </>}
      {selected.state === "AWAITING_NIM" && <><label htmlFor="desk-hash">NIM transaction hash (if available)</label><input id="desk-hash" value={hash} onChange={e => setHash(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy} /></>}
      {selected.state === "VERIFIED" && <Button variant="soft" disabled={busy} onClick={() => void run(async () => { await api({ action: "request-refund", id: selected.id }); await refresh(); })}>Request NIM return instead</Button>}
      {selected.payoutHash && <a href={`https://polygonscan.com/tx/${selected.payoutHash}`} target="_blank" rel="noopener noreferrer">View USDC transaction</a>}
      {selected.refundHash && <p className={styles.hash}>Verified NIM return: {selected.refundHash}</p>}
      <Button variant="soft" block onClick={() => void check()} disabled={busy}>{busy ? "Checking…" : "Check this payment"}</Button>
    </section>}
    {view && view.orders.length > 1 && <section className={styles.card}><h2>Your pilot payments</h2>{view.orders.map(o => <Button key={o.id} variant="soft" size="sm" onClick={() => { setSelected(o); setHash(""); setConsent(false); }} disabled={busy}>{usdc(o.amountAtomic)} USDC · {o.state.replaceAll("_", " ")} · {o.id.slice(0, 8)}</Button>)}</section>}
  </main>;
}
