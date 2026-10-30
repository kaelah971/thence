import type { MeResponse, OnboardingResult } from "./auth-client";

export type PostSignInRoute = "/app/home" | "/app/setup/name";

/**
 * Decide where a freshly authenticated user goes.
 *
 * - Profile already complete (returning account, any device): Home. The
 *   temporary name typed on this device is discarded, never written.
 * - New account with a name typed before connecting: save it, then Home.
 * - New account without a name (e.g. came through reconnect): ask for it.
 */
export async function routeAfterSignIn(
  me: MeResponse,
  temporaryName: string | null,
  saveName: (name: string) => Promise<OnboardingResult>,
): Promise<{ route: PostSignInRoute; me: MeResponse; discardTemporaryName: boolean }> {
  if (me.profile.onboardingCompletedAt) return { route: "/app/home", me, discardTemporaryName: true };
  const name = temporaryName?.trim();
  if (!name) return { route: "/app/setup/name", me, discardTemporaryName: false };
  const result = await saveName(name);
  if (result.kind === "saved") return { route: "/app/home", me: result.me, discardTemporaryName: true };
  return { route: "/app/setup/name", me, discardTemporaryName: false };
}
