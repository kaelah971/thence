"use client";

import { useSession } from "./session";

/**
 * Wallet connection model (F2).
 *
 * "connected" means the backend holds a valid session for an address it
 * derived from a verified Nimiq Pay signature. The address shown is that
 * verified identity — never a value the client asserted. Balances are read
 * separately through the provider (see balance.ts).
 */
export type WalletConnection =
  | { status: "checking" }
  | { status: "disconnected" }
  | { status: "expired" }
  | { status: "connected"; address: string };

export type ConnectAttempt =
  | "idle"
  | "initializing"
  | "signing"
  | "verifying"
  | "rejected"
  | "unavailable"
  | "network"
  | "expired"
  | "rate-limited"
  | "failed";

export function useWallet(): WalletConnection {
  const session = useSession();
  switch (session.status) {
    case "unknown":
      return { status: "checking" };
    case "valid":
      return { status: "connected", address: session.me.user.nimiqAddress };
    case "expired":
      return { status: "expired" };
    default:
      return { status: "disconnected" };
  }
}
