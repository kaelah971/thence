"use client";

import { useEffect, useState } from "react";
import { getHostNetwork } from "@nimiq/mini-app-sdk";
import { apiRequest } from "./api";
import { parseLuna } from "./luna";
import { classifyProviderError, getHostProvider, type HostProvider } from "./nimiq-provider";

/** Where a loaded balance came from: the Nimiq Pay host, or Thence's trusted Nimiq node. */
export type BalanceSource = "host" | "chain";

export type BalanceState =
  | { status: "disconnected" }
  | { status: "loading" }
  | {
      status: "loaded";
      /** Wallet total the user expects: basic plus active managed vaults. */
      luna: bigint;
      /** Basic-account-only portion (pre-F8.6 figure). */
      basicLuna: bigint;
      /** Active Nimiq Pay vault portion, or null when no vault holds funds. */
      vaultLuna: bigint | null;
      /** True when vault discovery was incomplete: the total may understate. */
      vaultUnknown: boolean;
      source: BalanceSource;
      network: string | null;
    }
  | { status: "unavailable"; reason: "not-in-host" | "host-outdated" | "network-mismatch" }
  | { status: "error"; reason: "network" | "failed" };

type HostOutcome =
  | { ok: true; luna: bigint }
  | { ok: false; reason: "not-in-host" | "host-outdated" | "network" | "failed" };

export interface ChainVaults {
  totalLuna: bigint;
  contracts: number;
}

export type ChainOutcome =
  | {
      ok: true;
      /** Wallet total (basic + active vaults) as read by the server. */
      luna: bigint;
      basicLuna: bigint;
      vaults: ChainVaults | null;
      /** Absent means unknown (fail-closed): the total may understate. */
      vaultsUnknown?: boolean;
      network: "mainnet" | "testnet";
    }
  | { ok: false; reason: "not-configured" | "network" | "failed" };

export interface BalanceDeps {
  getProvider: () => Promise<HostProvider>;
  /** Server read of the session address' confirmed balance. Omit to disable the fallback. */
  readChain?: () => Promise<ChainOutcome>;
  /** Network Nimiq Pay reports, when the host exposes it. */
  hostNetwork?: () => string | undefined;
}

/**
 * Ask the host. The verbatim session spelling goes first so identity never
 * shifts; a compact (spaceless) retry only follows an INVALID_REQUEST.
 */
async function readFromHost(getProvider: () => Promise<HostProvider>, address: string): Promise<HostOutcome> {
  let provider: HostProvider;
  try {
    provider = await getProvider();
  } catch (error) {
    return { ok: false, reason: classifyProviderError(error) === "unavailable" ? "not-in-host" : "failed" };
  }
  if (typeof provider.getBalance !== "function") return { ok: false, reason: "host-outdated" };
  const compact = address.replace(/\s+/g, "");
  const spellings = compact === address ? [address] : [address, compact];
  for (const spelling of spellings) {
    try {
      const luna = parseLuna(await provider.getBalance(spelling));
      return luna === null ? { ok: false, reason: "failed" } : { ok: true, luna };
    } catch (error) {
      const kind = classifyProviderError(error);
      if (kind === "invalid") continue;
      if (kind === "network") return { ok: false, reason: "network" };
      if (kind === "unavailable") return { ok: false, reason: "not-in-host" };
      if (kind === "unsupported") return { ok: false, reason: "host-outdated" };
      return { ok: false, reason: "failed" };
    }
  }
  return { ok: false, reason: "failed" };
}

/**
 * Read the NIM balance (Luna) of the session's verified address.
 * Nimiq Pay is asked first; only when it can't answer is Thence's Nimiq
 * node consulted. A failed lookup is an error or "unavailable", never a zero.
 *
 * F8.4 LAZY FALLBACK (proven failure it fixes): the public Nimiq RPC is
 * tightly IP-rate-limited (HTTP 429 under modest concurrency) and Vercel
 * functions share egress IPs, so every server-side read consumes a shared
 * throttle budget. The previous code fired the chain read on EVERY page
 * load in parallel — even when the host was about to answer — wasting that
 * budget and turning other users' genuine fallbacks into 429s. Starting the
 * chain read only after a host failure preserves the exact outcome matrix
 * (provider-first, same sources, same errors) while removing the wasted
 * reads. Host failure paths are near-synchronous (missing method, rejected
 * init), so fallback users lose no meaningful latency.
 *
 * F8.8 HOST-ZERO CONFIRMATION (proven failure it fixes): the lazy rule
 * above treated a host zero as final, skipping the vault-aware chain read
 * — but a host zero may be a basic-only view of vault-held funds. A
 * nonzero host balance still stands on its own (fast path); a host zero
 * always falls through to the vault-aware chain read, and only a
 * chain-confirmed zero renders as "no NIM yet".
 */
export async function readNimBalance(deps: BalanceDeps | (() => Promise<HostProvider>), address: string): Promise<BalanceState> {
  const { getProvider, readChain, hostNetwork } = typeof deps === "function" ? { getProvider: deps } as BalanceDeps : deps;
  const host = await readFromHost(getProvider, address);
  // Fast path: a nonzero host balance stands on its own (F8.4 saving).
  if (host.ok && host.luna > 0n)
    return { status: "loaded", luna: host.luna, basicLuna: host.luna, vaultLuna: null, vaultUnknown: false, source: "host", network: hostNetwork?.() ?? null };
  // F8.8: host failure OR host zero falls through to the vault-aware chain
  // read. A host zero is never final on its own: the host may only see the
  // basic account while funds sit in Nimiq Pay-managed vaults, so a zero
  // must be confirmed on-chain instead of stranding verified holdings.
  if (!readChain) {
    if (!host.ok) {
      if (host.reason === "network") return { status: "error", reason: "network" };
      if (host.reason === "failed") return { status: "error", reason: "failed" };
      return { status: "unavailable", reason: host.reason };
    }
    // Host answered zero with no chain to confirm against: loaded, but the
    // total is explicitly unverified (never "no NIM yet" on this path).
    return {
      status: "loaded",
      luna: 0n,
      basicLuna: 0n,
      vaultLuna: null,
      vaultUnknown: true,
      source: "host",
      network: hostNetwork?.() ?? null,
    };
  }
  let chain: ChainOutcome;
  try {
    chain = await readChain();
  } catch {
    chain = { ok: false, reason: "failed" };
  }
  if (chain.ok) {
    const reported = hostNetwork?.();
    if (reported && reported !== chain.network) return { status: "unavailable", reason: "network-mismatch" };
    // Absent vault fields mean unknown (fail-closed): never present a
    // possibly partial total as complete.
    const vaultsUnknown = chain.vaultsUnknown ?? chain.vaults === undefined;
    const vaults = chain.vaults ?? null;
    return {
      status: "loaded",
      luna: chain.luna,
      basicLuna: chain.basicLuna ?? chain.luna,
      vaultLuna: vaults ? vaults.totalLuna : null,
      vaultUnknown: vaultsUnknown,
      source: "chain",
      network: chain.network,
    };
  }
  if (!host.ok) {
    // Legacy host-failure matrix, unchanged: the host failure decides with
    // chain confirmation where available.
    if (host.reason === "network" || chain.reason === "network") return { status: "error", reason: "network" };
    if (host.reason === "failed" || chain.reason === "failed") return { status: "error", reason: "failed" };
    return { status: "unavailable", reason: host.reason };
  }
  // Host answered zero: confirm on-chain before rendering anything.
  if (chain.reason === "not-configured") {
    // No chain exists to confirm vaults against: show the zero but mark
    // coverage unknown (never "no NIM yet" on this path).
    return {
      status: "loaded",
      luna: 0n,
      basicLuna: 0n,
      vaultLuna: null,
      vaultUnknown: true,
      source: "host",
      network: hostNetwork?.() ?? null,
    };
  }
  // Chain read failed (network or failed error): retryable error with Try
  // again. A host zero behind it is never presented as a confirmed zero.
  return { status: "error", reason: chain.reason === "network" ? "network" : "failed" };
}

/** Browser read of GET /api/me/balance. */
export async function readChainBalanceFromApi(): Promise<ChainOutcome> {
  const result = await apiRequest<{
    balance: {
      luna: string;
      basicLuna?: string;
      vaults?: { totalLuna: string; contracts: number } | null;
      vaultsUnknown?: boolean;
      network: "mainnet" | "testnet";
    };
  }>("/api/me/balance");
  if (!result.ok) {
    if (result.code === "BALANCE_NOT_CONFIGURED") return { ok: false, reason: "not-configured" };
    return { ok: false, reason: result.kind === "network" || result.code === "BALANCE_READ_FAILED" ? "network" : "failed" };
  }
  const raw = result.data?.balance;
  if (!raw || typeof raw.luna !== "string" || !/^\d{1,24}$/.test(raw.luna)) return { ok: false, reason: "failed" };
  if (raw.network !== "mainnet" && raw.network !== "testnet") return { ok: false, reason: "failed" };
  const basicLuna = typeof raw.basicLuna === "string" && /^\d{1,24}$/.test(raw.basicLuna) ? BigInt(raw.basicLuna) : BigInt(raw.luna);
  // Absent unknown-flag means unknown (fail-closed against shape drift).
  const vaultsUnknown = typeof raw.vaultsUnknown === "boolean" ? raw.vaultsUnknown : true;
  let vaults: ChainVaults | null = null;
  if (raw.vaults !== null && raw.vaults !== undefined) {
    if (
      typeof raw.vaults !== "object" ||
      typeof raw.vaults.totalLuna !== "string" ||
      !/^\d{1,24}$/.test(raw.vaults.totalLuna) ||
      typeof raw.vaults.contracts !== "number" ||
      !Number.isSafeInteger(raw.vaults.contracts) ||
      raw.vaults.contracts < 0
    ) {
      return { ok: false, reason: "failed" };
    }
    vaults = { totalLuna: BigInt(raw.vaults.totalLuna), contracts: raw.vaults.contracts };
  }
  return { ok: true, luna: BigInt(raw.luna), basicLuna, vaults, vaultsUnknown, network: raw.network };
}

const liveDeps: BalanceDeps = { getProvider: getHostProvider, readChain: readChainBalanceFromApi, hostNetwork: getHostNetwork };

export function useNimBalance(address: string | null): { state: BalanceState; retry: () => void } {
  const [result, setResult] = useState<{ key: string; state: BalanceState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = address ? `${address}#${attempt}` : null;

  useEffect(() => {
    if (!address || !key) return;
    let cancelled = false;
    void readNimBalance(liveDeps, address).then((state) => {
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
