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
  const [network, setNetwork] = useState<"polygon" | "arbitrum" | "base">("polygon");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const running = useRef(false);
  // Send hands off the exact recipient and amount after its own amount step.
  const preset = useRef(false);
  const newestActive = (orders: PublicDeskOrder[]) =>
    orders.find(o => !["DELIVERED", "REFUNDED", "EXPIRED"].includes(o.state)) ?? null;
  const refresh = async () => {
    const next = await api<DeskView>();
    setView(next);
    setSelected(current => {
      const same = next.orders.find(o => o.id === current?.id);
      // An expired quote must not sit above the form as a second card.
      if (same && same.state === "EXPIRED") return newestActive(next.orders);
      return same ?? newestActive(next.orders);
    });
  };
  useEffect(() => {
    let active = true;
    // Read-only hydration. Progress runs on explicit checks or the dedicated server worker.
    void api<DeskView>().then(next => {
      if (!active) return;
      setView(next);
      setSelected(newestActive(next.orders));
      // Send hands off recipient + amount after its own amount step.
      const params = new URLSearchParams(window.location.search);
      const to = params.get("recipient") ?? "", value = params.get("amount") ?? "";
      const raw = params.get("network");
      const chain = raw === "arbitrum" ? "arbitrum" : raw === "base" ? "base" : "polygon";
      if (preset.current || !/^0x[0-9a-fA-F]{40}$/.test(to) || !/^\d+(\.\d{1,6})?$/.test(value)) return;
      preset.current = true;
      setNetwork(chain);
      setRecipient(to); setAmount(value);
      void api<{ order: PublicDeskOrder }>({ action: "quote", recipient: to, amount: value, requestKey: crypto.randomUUID(), network: chain })
        .then(result => { if (active) { setSelected(result.order); setConsent(false); void refresh(); } })
        .catch(error => {
          if (!active) return;
          // Never leave an unrelated quote on screen when this one failed.
          setSelected(null);
          setMessage(error instanceof Error ? error.message : "Could not quote this payment.");
        });
    }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);
  /**
   * Live progress: while an order is in flight, re-read the desk every few
   * seconds so the step advances on its own (what the worker just learned),
   * without the user tapping. Stopped when the sheet is hidden or the order
   * reaches a terminal state.
   */
  const activeId = selected && ["AWAITING_NIM", "VERIFIED", "PAYOUT_PREPARED", "PAYOUT_SUBMITTED", "REFUND_DUE"].includes(selected.state) ? selected.id : null;
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "hidden" || running.current) return;
      try {
        const next = await api<DeskView>();
        if (cancelled) return;
        setView(next);
        setSelected(current => next.orders.find(o => o.id === current?.id) ?? newestActive(next.orders));
      } catch {
        // A failed poll is silent: the manual check is what reports problems.
      }
    };
    const timer = window.setInterval(() => void tick(), 5_000);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Only the active order should restart polling; newestActive is stable here.
  }, [activeId]);

  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setMessage("");
    try { await work(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not check the payment. Do not pay again."); }
    finally { running.current = false; setBusy(false); }
  };
  const quoteFor = (to: string, value: string, chain = network) => run(async () => {
    const result = await api<{ order: PublicDeskOrder }>({ action: "quote", recipient: to, amount: value, requestKey: crypto.randomUUID(), network: chain });
    setSelected(result.order); setConsent(false); await refresh();
  });
  const quote = () => quoteFor(recipient, amount);
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
    // Something must visibly happen even when the state is unchanged.
    setCheckedAt(Date.now());
  });
  const canQuote = view?.enabled && (!selected || ["QUOTED", "DELIVERED", "REFUNDED", "EXPIRED"].includes(selected.state));
  // One action at a time: while an order needs attention the form is hidden,
  // so the screen never shows "Get a quote" and "Continue in Nimiq Pay" together.
  const active = selected !== null && !["DELIVERED", "REFUNDED", "EXPIRED"].includes(selected.state);
  const canCheck = selected !== null && ["AWAITING_NIM", "VERIFIED", "PAYOUT_PREPARED", "PAYOUT_SUBMITTED", "REFUND_DUE"].includes(selected.state);
  return <main className={styles.screen}>
    <ButtonLink href="/app/home" variant="ghost" size="sm">Back to home</ButtonLink>
    <header><p className={styles.eyebrow}>Open pilot · Polygon</p><h1>Pay NIM. Deliver USDC.</h1><p>Thence receives your NIM and pays the recipient from its own USDC wallet.</p></header>
    {message && <Notice live title="Payment update">{message}</Notice>}
    {!view && !message && <p role="status">Loading your payments…</p>}
    {view && !view.enabled && <Notice>New payments are paused. Existing payments can still be checked.</Notice>}
    {canQuote && !active && <form className={styles.card} onSubmit={event => { event.preventDefault(); void quote(); }}>
      <div className={styles.networks} role="group" aria-label="Network">
        <button type="button" aria-pressed={network === "polygon"} disabled={busy} onClick={() => { setNetwork("polygon"); setSelected(null); }}>Polygon</button>
        <button type="button" aria-pressed={network === "arbitrum"} disabled={busy} onClick={() => { setNetwork("arbitrum"); setSelected(null); }}>Arbitrum</button>
        <button type="button" aria-pressed={network === "base"} disabled={busy} onClick={() => { setNetwork("base"); setSelected(null); }}>Base</button>
      </div>
      <label htmlFor="desk-recipient">Recipient’s {network === "arbitrum" ? "Arbitrum" : network === "base" ? "Base" : "Polygon"} address</label><input id="desk-recipient" value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} required />
      <label htmlFor="desk-amount">USDC they receive</label><input id="desk-amount" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" disabled={busy} required />
      <Button type="submit" disabled={busy} block>Get exact amount</Button>
      <p className={styles.hint}>We’ll show the exact NIM to send before anything leaves your wallet.</p>
    </form>}
    {selected && <section className={styles.card} aria-label="Payment details">
      <h2>{selected.state === "QUOTED" ? "Review payment" : "Payment status"}</h2><p role="status">{descriptions[selected.state]}</p>
      {selected.code === "MULTIPLE_DEPOSITS" && <Notice>More than one deposit matches this payment. Thence must review it. Do not pay again.</Notice>}
      <dl><dt>Recipient receives</dt><dd>{usdc(selected.amountAtomic)} USDC on {selected.network === "arbitrum" ? "Arbitrum" : selected.network === "base" ? "Base" : "Polygon"}</dd><dt>You send</dt><dd>{formatLuna(BigInt(selected.nimLuna)).text} NIM, plus any wallet network fee</dd><dt>Thence fee (included)</dt><dd>{formatLuna(BigInt(selected.feeLuna)).text} NIM ({selected.feeBps / 100}%)</dd><dt>Recipient</dt><dd>{selected.recipient}</dd><dt>NIM collection wallet</dt><dd>{selected.nimAddress}</dd><dt>Payment reference</dt><dd>{selected.id}</dd></dl>
      {selected.state === "QUOTED" && <>
        <p>Quote expires {new Date(selected.expiresAt).toLocaleTimeString()}. After continuing, approve within five minutes. Late deposits require a refund.</p>
        <label className={styles.consent}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /><span>I understand Thence will hold my NIM while delivering USDC. Refunds require Thence to send NIM back.</span></label>
        <Button block disabled={busy || !consent || !view?.enabled} onClick={() => void pay()}>Continue in Nimiq Pay</Button>
      </>}
      {selected.state === "AWAITING_NIM" && <><label htmlFor="desk-hash">NIM transaction hash (if available)</label><input id="desk-hash" value={hash} onChange={e => setHash(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy} /></>}
      {selected.state === "VERIFIED" && <Button variant="soft" disabled={busy} onClick={() => void run(async () => { await api({ action: "request-refund", id: selected.id }); await refresh(); })}>Request NIM return instead</Button>}
      {selected.payoutHash && <a href={`https://${selected.network === "arbitrum" ? "arbiscan.io" : selected.network === "base" ? "basescan.org" : "polygonscan.com"}/tx/${selected.payoutHash}`} target="_blank" rel="noopener noreferrer">View USDC transaction</a>}
      {selected.refundHash && <p className={styles.hash}>Verified NIM return: {selected.refundHash}</p>}
      {canCheck && <Button variant="soft" block onClick={() => void check()} disabled={busy}>{busy ? "Checking…" : "Check this payment"}</Button>}
      {checkedAt !== null && <p className={styles.hint} role="status">Checked {new Date(checkedAt).toLocaleTimeString()} — nothing has moved yet if the step above is unchanged.</p>}
    </section>}

  </main>;
}
