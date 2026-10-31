"use client";

import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { parseLuna, shortNimiqAddress } from "./luna";
import { classifyProviderError, type HostProvider } from "./nimiq-provider";
import type { ChainOutcome } from "./balance";

/**
 * F7.3 — read-only wallet diagnostics for the release balance pipeline.
 *
 * Production pipeline (F6): `readNimBalance` asks the Nimiq Pay host first
 * (`getBalance` on the session's verified address, spaced then compact
 * spelling), then falls back to `GET /api/me/balance` — the confirmed
 * on-chain balance of the SAME session address from the configured
 * trusted node (`THENCE_NIMIQ_RPC_URL`, network `THENCE_NIMIQ_NETWORK`,
 * default mainnet). A failed lookup is an error, never a zero.
 *
 * This module only READS and COMPARES, with masked values:
 * - Phase 1 (`diagnoseSignedWallet`, no account listing): host network,
 *   host balance of the session address, server-RPC balance of the same
 *   address. Never touches `listAccounts`.
 * - Phase 2 (`listOtherWallets`, ONLY after the user explicitly taps
 *   "list my other wallets"): host account list + per-account host
 *   balances, masked, capped.
 *
 * It NEVER picks a signer, NEVER binds an unsigned address as the
 * authenticated identity, and NEVER alters the session. Full addresses,
 * tokens, keys and secrets are never logged and never leave the device
 * except as masked truncations for display. Entries are keyed
 * `session` / `host-N`, never by address bytes.
 */

export type HostNetwork = "mainnet" | "testnet" | null;

export function getActiveHostNetwork(read?: () => unknown): HostNetwork {
  try {
    const raw = read
      ? read()
      : typeof window !== "undefined"
        ? (window as unknown as { nimiqPay?: { network?: unknown } }).nimiqPay?.network
        : undefined;
    return raw === "mainnet" || raw === "testnet" ? raw : null;
  } catch {
    return null;
  }
}

/** Masked identity for display only (e.g. "NQ07 0000 … 0000"). Never the full address. */
export function maskNimiqIdentity(address: string): string {
  try {
    return shortNimiqAddress(address);
  } catch {
    return "…";
  }
}

/** Address-equality key: spaceless upper-case. Internal only, never displayed. */
function compareKey(address: string): string {
  return address.replace(/\s+/g, "").toUpperCase();
}

function isLegacyErrorResponse(value: unknown): value is { error: { type: string; message: string } } {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return typeof record["type"] === "string" && typeof record["message"] === "string";
}

function classifyBalanceError(error: unknown): "network" | "failed" {
  return classifyProviderError(error) === "network" ? "network" : "failed";
}

/** Host read of one address: verbatim session spelling, compact retry on INVALID_REQUEST. */
async function readHostBalance(
  provider: HostProvider,
  address: string,
): Promise<{ luna: bigint } | { error: "unsupported" | "unavailable" | "network" | "failed" }> {
  if (typeof provider.getBalance !== "function") return { error: "unsupported" };
  const compact = address.replace(/\s+/g, "");
  const spellings = compact === address ? [address] : [address, compact];
  for (const spelling of spellings) {
    try {
      const luna = parseLuna((await provider.getBalance(spelling)) as unknown);
      if (luna === null) {
        // Legacy hosts may resolve `{ error }` instead of rejecting.
        return { error: "failed" };
      }
      return { luna };
    } catch (error) {
      const kind = classifyProviderError(error);
      if (kind === "invalid") continue;
      if (kind === "network") return { error: "network" };
      if (kind === "unavailable") return { error: "unavailable" };
      if (kind === "unsupported") return { error: "unsupported" };
      return { error: "failed" };
    }
  }
  return { error: "failed" };
}

export interface SignedSourceRead {
  state: "loaded" | "unsupported" | "unavailable" | "not-configured" | "error";
  luna: bigint | null;
  error: "network" | "failed" | null;
  network: "mainnet" | "testnet" | null;
}

export interface SignedWalletDiagnosis {
  hostNetwork: HostNetwork;
  networkUnknown: boolean;
  sessionMasked: string | null;
  host: SignedSourceRead;
  chain: SignedSourceRead;
}

export type SignedGuidance =
  | "signed-out"
  | "funds-confirmed"
  | "host-chain-disagree"
  | "empty-on-read-networks"
  | "no-readable-source"
  | "read-error";

/** Pure guidance for a signed-wallet diagnosis (unit-testable). */
export function guidanceForSigned(d: Pick<SignedWalletDiagnosis, "sessionMasked" | "host" | "chain">): SignedGuidance {
  if (!d.sessionMasked) return "signed-out";
  const hostFunded = d.host.state === "loaded" && d.host.luna !== null && d.host.luna > 0n;
  const chainFunded = d.chain.state === "loaded" && d.chain.luna !== null && d.chain.luna > 0n;
  if (hostFunded || chainFunded) {
    if (hostFunded && chainFunded) return d.host.luna === d.chain.luna ? "funds-confirmed" : "host-chain-disagree";
    return "host-chain-disagree";
  }
  const hostEmpty = d.host.state === "loaded" && d.host.luna === 0n;
  const chainEmpty = d.chain.state === "loaded" && d.chain.luna === 0n;
  if (hostEmpty && chainEmpty) return "empty-on-read-networks";
  if (hostEmpty || chainEmpty) return "empty-on-read-networks";
  if (d.host.error === "network" || d.chain.error === "network") return "read-error";
  if (d.host.state === "error" || d.chain.state === "error") return "read-error";
  return "no-readable-source";
}

export interface DiagnoseSignedInput {
  getProvider: () => Promise<HostProvider>;
  readChain?: () => Promise<ChainOutcome>;
  getHostNetwork?: (() => string | undefined) | undefined;
  sessionAddress: string | null;
}

/** Phase 1: compare both balance sources for the session address. No account listing. */
export async function diagnoseSignedWallet(input: DiagnoseSignedInput): Promise<SignedWalletDiagnosis> {
  const rawNetwork = safeHostNetwork(input.getHostNetwork);
  const sessionMasked = input.sessionAddress ? maskNimiqIdentity(input.sessionAddress) : null;

  const empty: SignedWalletDiagnosis = {
    hostNetwork: rawNetwork,
    networkUnknown: rawNetwork === null,
    sessionMasked,
    host: { state: "unavailable", luna: null, error: null, network: rawNetwork },
    chain: { state: "not-configured", luna: null, error: null, network: null },
  };
  if (!input.sessionAddress) return empty;

  let host: SignedWalletDiagnosis["host"] = { state: "unavailable", luna: null, error: null, network: rawNetwork };
  try {
    const provider = await input.getProvider();
    const read = await readHostBalance(provider, input.sessionAddress);
    host =
      "luna" in read
        ? { state: "loaded", luna: read.luna, error: null, network: rawNetwork }
        : read.error === "network" || read.error === "failed"
          ? { state: "error", luna: null, error: read.error, network: rawNetwork }
          : { state: read.error, luna: null, error: null, network: rawNetwork };
  } catch (error) {
    const kind = classifyProviderError(error);
    host =
      kind === "unavailable"
        ? { state: "unavailable", luna: null, error: null, network: rawNetwork }
        : kind === "network"
          ? { state: "error", luna: null, error: "network", network: rawNetwork }
          : { state: "error", luna: null, error: "failed", network: rawNetwork };
  }

  let chain: SignedWalletDiagnosis["chain"] = { state: "not-configured", luna: null, error: null, network: null };
  if (input.readChain) {
    try {
      const outcome = await input.readChain();
      chain = outcome.ok
        ? { state: "loaded", luna: outcome.luna, error: null, network: outcome.network }
        : outcome.reason === "not-configured"
          ? { state: "not-configured", luna: null, error: null, network: null }
          : outcome.reason === "network"
            ? { state: "error", luna: null, error: "network", network: null }
            : { state: "error", luna: null, error: "failed", network: null };
    } catch {
      chain = { state: "error", luna: null, error: "failed", network: null };
    }
  }

  return { hostNetwork: rawNetwork, networkUnknown: rawNetwork === null, sessionMasked, host, chain };
}

function safeHostNetwork(get?: () => string | undefined): HostNetwork {
  if (!get) return getActiveHostNetwork();
  try {
    const value = get();
    return value === "mainnet" || value === "testnet" ? value : getActiveHostNetwork();
  } catch {
    return getActiveHostNetwork();
  }
}

export interface OtherWalletEntry {
  /** Display-safe key (`host-N`). Never an address. */
  key: string;
  masked: string;
  luna: bigint | null;
  error: "network" | "failed" | null;
}

export interface OtherWalletsResult {
  state: "ready" | "unsupported" | "unavailable" | "failed";
  sessionInHost: boolean | null;
  others: OtherWalletEntry[];
}

export interface ListOthersInput {
  getProvider: () => Promise<HostProvider>;
  sessionAddress: string;
}

/**
 * Phase 2 — ONLY call after the user explicitly asks to list other wallets.
 * Returns masked identities + host balances, capped at 10. Never binds any
 * listed address to the session.
 */
export async function listOtherWallets(input: ListOthersInput): Promise<OtherWalletsResult> {
  let provider: HostProvider;
  try {
    provider = await input.getProvider();
  } catch (error) {
    return classifyProviderError(error) === "unavailable"
      ? { state: "unavailable", sessionInHost: null, others: [] }
      : { state: "failed", sessionInHost: null, others: [] };
  }
  if (typeof provider.listAccounts !== "function") return { state: "unsupported", sessionInHost: null, others: [] };

  let accounts: string[];
  try {
    const raw = (await provider.listAccounts()) as unknown;
    if (isLegacyErrorResponse(raw)) {
      const converted = NimiqProviderError.fromLegacyResponse(raw) ?? new Error(raw.error.message);
      const kind = classifyProviderError(converted);
      return {
        state: kind === "unavailable" ? "unavailable" : kind === "unsupported" ? "unsupported" : "failed",
        sessionInHost: null,
        others: [],
      };
    }
    if (!Array.isArray(raw) || !raw.every((a) => typeof a === "string")) return { state: "failed", sessionInHost: null, others: [] };
    accounts = (raw as string[]).slice(0, 20);
  } catch (error) {
    const kind = classifyProviderError(error);
    return {
      state: kind === "unavailable" ? "unavailable" : kind === "unsupported" ? "unsupported" : "failed",
      sessionInHost: null,
      others: [],
    };
  }

  const sessionKey = compareKey(input.sessionAddress);
  const sessionInHost = accounts.some((a) => compareKey(a) === sessionKey);
  const seen = new Set<string>([sessionKey]);
  const others: OtherWalletEntry[] = [];
  let index = 0;
  for (const address of accounts) {
    const key = compareKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    if (others.length >= 10) break;
    index += 1;
    let luna: bigint | null = null;
    let error: OtherWalletEntry["error"] = null;
    try {
      if (typeof provider.getBalance !== "function") {
        error = "failed";
      } else {
        const raw = (await provider.getBalance(address)) as unknown;
        if (isLegacyErrorResponse(raw)) {
          error = classifyBalanceError(NimiqProviderError.fromLegacyResponse(raw) ?? new Error(raw.error.message));
        } else {
          const parsed = parseLuna(raw);
          if (parsed === null) error = "failed";
          else luna = parsed;
        }
      }
    } catch (thrown) {
      error = classifyBalanceError(thrown);
    }
    others.push({ key: `host-${index}`, masked: maskNimiqIdentity(address), luna, error });
  }
  return { state: "ready", sessionInHost, others };
}
