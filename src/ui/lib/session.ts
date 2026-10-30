"use client";

import { useEffect, useSyncExternalStore } from "react";
import { setUnauthorizedHandler } from "./api";
import { fetchMe, signOut, type MeResponse } from "./auth-client";
import { clearPending } from "./prepare-flow";
import { invalidateData } from "./resource";
import { readSignedInHint, setSignedInHint } from "./stores";

/**
 * Client view of the backend session. The session itself is an HttpOnly
 * cookie the browser holds; this store only mirrors what GET /api/me says.
 */
export type SessionState =
  | { status: "unknown" }
  | { status: "valid"; me: MeResponse }
  | { status: "expired" }
  | { status: "none" }
  | { status: "error" };

/** Pure mapping from a /api/me response to a session state. */
export function sessionFromResponse(httpStatus: number, me: MeResponse | null, signedInHint: boolean): SessionState {
  if (httpStatus === 200 && me) return { status: "valid", me };
  if (httpStatus === 401) return signedInHint ? { status: "expired" } : { status: "none" };
  return { status: "error" };
}

export function isOnboarded(state: SessionState): boolean {
  return state.status === "valid" && state.me.profile.onboardingCompletedAt !== null;
}

const UNKNOWN: SessionState = { status: "unknown" };
let current: SessionState = UNKNOWN;
let inflight: Promise<SessionState> | null = null;
const listeners = new Set<() => void>();
const browserFetch: typeof fetch = (...args) => fetch(...args);

function publish(next: SessionState): void {
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSessionSnapshot(): SessionState {
  return current;
}

export function refreshSession(): Promise<SessionState> {
  if (inflight) return inflight;
  inflight = fetchMe(browserFetch)
    .then(({ status, me }) => sessionFromResponse(status, me, readSignedInHint()))
    .catch((): SessionState => ({ status: "error" }))
    .then((next) => {
      if (next.status === "valid") setSignedInHint(true);
      publish(next);
      inflight = null;
      return next;
    });
  return inflight;
}

export function setAuthenticated(me: MeResponse): void {
  setSignedInHint(true);
  publish({ status: "valid", me });
}

/** Explicit sign-out: revoke the server session, then forget the local hint. */
export async function signOutEverywhere(): Promise<void> {
  const signingOutUserId = current.status === "valid" ? current.me.user.id : null;
  await signOut(browserFetch);
  // Drop this device's interrupted-payment pointer so the next sign-in
  // (same or different account) never offers someone else's resume.
  // Reads are already owner-scoped; this keeps the banner honest too.
  if (signingOutUserId) clearPending(signingOutUserId);
  setSignedInHint(false);
  publish({ status: "none" });
  invalidateData();
}

// Any 401 from the data layer means the session ended: re-check it so the
// app moves to the reconnect screen (data keys drop with the user id).
setUnauthorizedHandler(() => {
  if (current.status === "valid") void refreshSession();
});

/** Subscribe to the session; checks /api/me once on first use. */
export function useSession(): SessionState {
  const state = useSyncExternalStore(subscribe, getSessionSnapshot, () => UNKNOWN);
  useEffect(() => {
    if (getSessionSnapshot().status === "unknown") void refreshSession();
  }, []);
  return state;
}
