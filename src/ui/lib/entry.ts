/**
 * Entry-state routing for /app.
 *
 * Durable rule (F2): an authenticated profile with onboarding completion
 * decides whether someone skips the tour. The local intro hint only
 * improves the pre-auth experience on this device; it is never treated
 * as an account or a session.
 */

export type SessionState = "valid" | "expired" | "none";

export interface EntryInput {
  session: SessionState;
  /** From the authenticated profile (F2). Null when unknown or unauthenticated. */
  profileOnboarded: boolean | null;
  /** Device-local hint that the intro was completed here. */
  introSeenHint: boolean;
}

export type EntryRoute = "/app/home" | "/app/setup/name" | "/app/reconnect" | "/app/welcome";

export function resolveEntry({ session, profileOnboarded, introSeenHint }: EntryInput): EntryRoute {
  if (session === "valid") return profileOnboarded ? "/app/home" : "/app/setup/name";
  if (session === "expired") return "/app/reconnect";
  return introSeenHint ? "/app/reconnect" : "/app/welcome";
}
