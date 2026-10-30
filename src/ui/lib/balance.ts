"use client";

import { useEffect, useState } from "react";
import { parseLuna } from "./luna";
import { classifyProviderError, getHostProvider, type HostProvider } from "./nimiq-provider";

export type BalanceState =
  | { status: "disconnected" }
  | { status: "loading" }
  | { status: "loaded"; luna: bigint }
  | { status: "unavailable"; reason: "not-in-host" | "host-outdated" }
  | { status: "error"; reason: "network" | "failed" };

/**
 * Read the NIM balance (Luna) of the session's verified address through
 * Nimiq Pay. A rejected lookup is an error, never a zero.
 */
export async function readNimBalance(getProvider: () => Promise<HostProvider>, address: string): Promise<BalanceState> {
  let provider: HostProvider;
  try {
    provider = await getProvider();
  } catch (error) {
    return classifyProviderError(error) === "unavailable"
      ? { status: "unavailable", reason: "not-in-host" }
      : { status: "error", reason: "failed" };
  }
  if (typeof provider.getBalance !== "function") return { status: "unavailable", reason: "host-outdated" };
  try {
    const luna = parseLuna(await provider.getBalance(address));
    return luna === null ? { status: "error", reason: "failed" } : { status: "loaded", luna };
  } catch (error) {
    const kind = classifyProviderError(error);
    if (kind === "network") return { status: "error", reason: "network" };
    if (kind === "unavailable") return { status: "unavailable", reason: "not-in-host" };
    if (kind === "unsupported") return { status: "unavailable", reason: "host-outdated" };
    return { status: "error", reason: "failed" };
  }
}

export function useNimBalance(address: string | null): { state: BalanceState; retry: () => void } {
  const [result, setResult] = useState<{ key: string; state: BalanceState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = address ? `${address}#${attempt}` : null;

  useEffect(() => {
    if (!address || !key) return;
    let cancelled = false;
    void readNimBalance(getHostProvider, address).then((state) => {
      if (!cancelled) setResult({ key, state });
    });
    return () => {
      cancelled = true;
    };
  }, [address, key]);

  const state: BalanceState = !address
    ? { status: "disconnected" }
    : result && result.key === key
      ? result.state
      : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}
