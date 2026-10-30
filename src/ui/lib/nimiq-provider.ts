/**
 * Browser-only access to the Nimiq Pay provider (@nimiq/mini-app-sdk).
 *
 * - Never touched during server rendering: `getHostProvider()` rejects
 *   immediately when `window` is undefined.
 * - Uses the SDK's `init()`, which waits for Nimiq Pay to inject the
 *   provider and throws a plain Error on timeout (not inside Nimiq Pay).
 * - Nimiq Pay chooses the signing account. This module never calls
 *   `listAccounts()` to pick a signer; identity is the address the
 *   backend derives from the verified signature.
 */
import { init, NimiqProviderError, type NimiqProvider } from "@nimiq/mini-app-sdk";

/** The subset of the provider Thence uses in F2. `getBalance` is absent on older hosts. */
export interface HostProvider {
  sign: NimiqProvider["sign"];
  getBalance?: NimiqProvider["getBalance"];
}

export type ProviderFailure = "unavailable" | "rejected" | "network" | "unsupported" | "invalid" | "failed";

export class HostUnavailableError extends Error {
  constructor(message = "Nimiq Pay is not available here.") {
    super(message);
    this.name = "HostUnavailableError";
  }
}

export const PROVIDER_TIMEOUT_MS = 6_000;

/** Map any provider/SDK error onto the handful of outcomes the UI distinguishes. */
export function classifyProviderError(error: unknown): ProviderFailure {
  if (error instanceof HostUnavailableError) return "unavailable";
  if (NimiqProviderError.is(error)) {
    switch (error.type) {
      case "PERMISSION_DENIED":
        return "rejected";
      case "NETWORK_ERROR":
        return "network";
      case "UNKNOWN_REQUEST":
        return "unsupported";
      case "INVALID_REQUEST":
        return "invalid";
      default:
        return "failed";
    }
  }
  if (error instanceof Error && /not injected|nimiq app/i.test(error.message)) return "unavailable";
  return "failed";
}

type Loader = () => Promise<HostProvider>;

let loader: Loader = () => init({ timeout: PROVIDER_TIMEOUT_MS });
let pending: Promise<HostProvider> | null = null;

/**
 * Resolve the injected provider once per page. A failed attempt is not
 * cached, so "Try again" re-initializes.
 */
export function getHostProvider(): Promise<HostProvider> {
  if (typeof window === "undefined") return Promise.reject(new HostUnavailableError("Not in a browser."));
  if (!pending) {
    pending = loader().catch((error: unknown) => {
      pending = null;
      throw classifyProviderError(error) === "unavailable" ? new HostUnavailableError() : error;
    });
  }
  return pending;
}

/** Test seam: replace the SDK loader (mock hosts in unit tests). */
export function setHostProviderLoaderForTests(next: Loader | null): void {
  loader = next ?? (() => init({ timeout: PROVIDER_TIMEOUT_MS }));
  pending = null;
}
