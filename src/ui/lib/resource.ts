"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { friendlyMessage, type ApiResult } from "./api";

/**
 * Minimal data hook (no state-management framework).
 *
 * - `key` identifies the data, including the signed-in user id, so another
 *   account's data can never be shown: a new key means a fresh load.
 * - Responses for an old key or an older request are dropped.
 * - `invalidateData()` (after any successful change) refetches mounted
 *   resources while keeping the current data on screen.
 */
export type Resource<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; data: T; refreshing: boolean; refresh: () => void };

let generation = 0;
const listeners = new Set<() => void>();

export function invalidateData(): void {
  generation += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface Settled<T> {
  key: string;
  result: ApiResult<T>;
}

export function useApiResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<ApiResult<T>>): Resource<T> {
  const version = useSyncExternalStore(subscribe, () => generation, () => 0);
  const [local, setLocal] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [lastGood, setLastGood] = useState<{ key: string; data: T } | null>(null);
  const requestKey = key ? `${key}#${version}.${local}` : null;

  useEffect(() => {
    if (!key || !requestKey) return;
    const controller = new AbortController();
    void load(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setSettled({ key: requestKey, result });
      if (result.ok) setLastGood({ key, data: result.data });
    });
    return () => controller.abort();
    // `load` is intentionally excluded: callers pass inline closures; `key` captures its inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const refresh = () => setLocal((n) => n + 1);
  if (!key) return { status: "idle" };
  const current = settled && settled.key === requestKey ? settled.result : null;
  if (current?.ok) return { status: "ready", data: current.data, refreshing: false, refresh };
  if (current && !current.ok && current.kind !== "aborted") {
    if (lastGood && lastGood.key === key && current.kind !== "unauthorized") {
      return { status: "ready", data: lastGood.data, refreshing: false, refresh };
    }
    return { status: "error", message: friendlyMessage(current, "load"), retry: refresh };
  }
  if (lastGood && lastGood.key === key) return { status: "ready", data: lastGood.data, refreshing: true, refresh };
  return { status: "loading" };
}
