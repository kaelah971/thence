"use client";

import { useEffect, useState } from "react";
import { quoteKey, requestQuote, resolveQuoteState, type QuoteInput, type QuoteState, type SettledQuote } from "@/ui/lib/quotes-api";

/**
 * One live price check for the current selection.
 *
 * - `input === null` means "don't ask" (route unavailable, amount invalid,
 *   preview mode…): no request is sent.
 * - A new key (person, wallet, amount, currency, request) aborts the old
 *   request; late answers for an old key are ignored by resolveQuoteState.
 * - Freshness ticks every second; past `validUntil` the state is "expired"
 *   and the old price is no longer presented as current.
 * - Refresh is explicit. A successful quote never starts a payment.
 */
export function useLiveQuote(input: QuoteInput | null, payTo: string): QuoteState & { refresh: () => void } {
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<SettledQuote | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const base = input ? quoteKey(input, payTo) : null;
  const key = base ? `${base}#${nonce}` : null;

  useEffect(() => {
    if (!input || !key) return;
    const controller = new AbortController();
    void requestQuote(input, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setNow(Date.now());
      setSettled({ key, result });
    });
    return () => controller.abort();
    // `input` is captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const state = resolveQuoteState(key, settled, now, input ?? undefined);
  const ticking = state.status === "ready";

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
