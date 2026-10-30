/**
 * Wallet sign-in against the existing B1 backend.
 *
 *   1. init the Nimiq Pay provider (fail fast outside Nimiq Pay)
 *   2. POST /api/session/challenge       → exact server message
 *   3. provider.sign(message)            → { publicKey, signature }
 *   4. POST /api/session/verify          → server verifies, sets HttpOnly cookie
 *   5. GET  /api/me                      → identity + profile from the session
 *
 * The client never asserts an address: identity is whatever the backend
 * derives from the verified public key. No token is ever readable here.
 */
import { classifyProviderError, type HostProvider } from "./nimiq-provider";

export interface MeResponse {
  user: { id: string; nimiqAddress: string; createdAt: string };
  profile: { displayName: string | null; onboardingCompletedAt: string | null };
}

export type ConnectStep = "initializing" | "signing" | "verifying";

export type ConnectOutcome =
  | { kind: "authenticated"; me: MeResponse }
  | { kind: "unavailable" }
  | { kind: "rejected" }
  | { kind: "network" }
  | { kind: "expired" }
  | { kind: "rate-limited" }
  | { kind: "failed"; reason: "signature" | "server" | "unsupported" };

export interface AuthDeps {
  getProvider: () => Promise<HostProvider>;
  fetch: typeof fetch;
}

const JSON_POST: RequestInit = {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
};

async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export async function fetchMe(doFetch: typeof fetch): Promise<{ status: number; me: MeResponse | null }> {
  const res = await doFetch("/api/me", { credentials: "same-origin", cache: "no-store" });
  if (res.status !== 200) return { status: res.status, me: null };
  return { status: 200, me: (await res.json()) as MeResponse };
}

export async function connectWithNimiqPay(deps: AuthDeps, onStep?: (step: ConnectStep) => void): Promise<ConnectOutcome> {
  onStep?.("initializing");
  let provider: HostProvider;
  try {
    provider = await deps.getProvider();
  } catch (error) {
    return classifyProviderError(error) === "unavailable" ? { kind: "unavailable" } : { kind: "failed", reason: "server" };
  }

  let challenge: string;
  try {
    const res = await deps.fetch("/api/session/challenge", { ...JSON_POST, body: "{}" });
    if (res.status === 429) return { kind: "rate-limited" };
    if (res.status !== 201) return { kind: "failed", reason: "server" };
    const body = (await res.json()) as { challenge?: unknown };
    if (typeof body.challenge !== "string") return { kind: "failed", reason: "server" };
    challenge = body.challenge;
  } catch {
    return { kind: "network" };
  }

  onStep?.("signing");
  let signed: { publicKey: string; signature: string };
  try {
    signed = await provider.sign(challenge);
  } catch (error) {
    switch (classifyProviderError(error)) {
      case "rejected":
        return { kind: "rejected" };
      case "network":
        return { kind: "network" };
      case "unavailable":
        return { kind: "unavailable" };
      case "unsupported":
        return { kind: "failed", reason: "unsupported" };
      default:
        return { kind: "failed", reason: "signature" };
    }
  }
  if (!signed || typeof signed.publicKey !== "string" || typeof signed.signature !== "string") {
    return { kind: "failed", reason: "signature" };
  }

  onStep?.("verifying");
  try {
    const res = await deps.fetch("/api/session/verify", {
      ...JSON_POST,
      body: JSON.stringify({ challenge, publicKey: signed.publicKey, signature: signed.signature }),
    });
    if (res.status === 429) return { kind: "rate-limited" };
    if (res.status !== 200) {
      const code = await readError(res);
      if (code === "CHALLENGE_INVALID") return { kind: "expired" };
      if (res.status === 401 || res.status === 400) return { kind: "failed", reason: "signature" };
      return { kind: "failed", reason: "server" };
    }
    const { status, me } = await fetchMe(deps.fetch);
    if (status !== 200 || !me) return { kind: "failed", reason: "server" };
    return { kind: "authenticated", me };
  } catch {
    return { kind: "network" };
  }
}

export type OnboardingResult =
  | { kind: "saved"; me: MeResponse; applied: boolean }
  | { kind: "unauthenticated" }
  | { kind: "invalid"; message: string }
  | { kind: "failed" };

/** Persist the name and complete onboarding. Never overwrites a completed profile. */
export async function completeOnboarding(doFetch: typeof fetch, displayName: string): Promise<OnboardingResult> {
  try {
    const res = await doFetch("/api/me/onboarding", { ...JSON_POST, body: JSON.stringify({ displayName }) });
    if (res.status === 401) return { kind: "unauthenticated" };
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      return { kind: "invalid", message: typeof body.message === "string" ? body.message : "That name can't be used." };
    }
    if (res.status !== 200) return { kind: "failed" };
    const { applied } = (await res.json()) as { applied: boolean };
    const { me } = await fetchMe(doFetch);
    return me ? { kind: "saved", me, applied } : { kind: "unauthenticated" };
  } catch {
    return { kind: "failed" };
  }
}

/** Explicit sign-out: revokes the server session and clears the cookie. */
export async function signOut(doFetch: typeof fetch): Promise<boolean> {
  try {
    const res = await doFetch("/api/session/logout", { ...JSON_POST, body: "{}" });
    return res.ok;
  } catch {
    return false;
  }
}
