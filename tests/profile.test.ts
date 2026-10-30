/**
 * F2 — sign-in, session and profile persistence (live database).
 *
 * The browser client (src/ui/lib/auth-client.ts) is driven against the REAL
 * route handlers through an in-memory cookie jar. The "host" is a mocked
 * Nimiq Pay provider signing with a fixture Ed25519 wallet over the official
 * prefixed payload. This is not real Nimiq Pay evidence (HOST_INTEGRATION_PENDING).
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { sessions, users } from "@/db/schema";
import { getDb } from "@/lib/db";
import { completeOnboarding, connectWithNimiqPay, fetchMe, signOut } from "@/ui/lib/auth-client";
import { routeAfterSignIn } from "@/ui/lib/onboarding-flow";
import { sessionFromResponse } from "@/ui/lib/session";
import { LIVE, RUN, fixtureWallet, postJson } from "./helpers";
import { POST as challengePOST } from "../app/api/session/challenge/route";
import { POST as verifyPOST } from "../app/api/session/verify/route";
import { POST as logoutPOST } from "../app/api/session/logout/route";
import { GET as meGET } from "../app/api/me/route";
import { POST as onboardingPOST } from "../app/api/me/onboarding/route";

const createdUserIds = new Set<string>();
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
});

type Handler = (request: Request) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  "POST /api/session/challenge": challengePOST,
  "POST /api/session/verify": verifyPOST,
  "POST /api/session/logout": logoutPOST,
  "GET /api/me": meGET,
  "POST /api/me/onboarding": onboardingPOST,
};

/** A browser-like client: one cookie jar, per-client forwarded IP. */
function browser(label: string, extraHeaders: Record<string, string> = {}) {
  const jar = new Map<string, string>();
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = ROUTES[`${method} ${path}`];
    if (!handler) throw new TypeError(`no route ${method} ${path}`);
    const headers = new Headers(init?.headers);
    headers.set("x-forwarded-for", `f2-${label}-${RUN}`);
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await handler(
      new Request(`http://localhost${path}`, { method, headers, ...(init?.body ? { body: init.body as string } : {}) }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const [pair = ""] = setCookie.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value || /Max-Age=0/i.test(setCookie)) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  }) as typeof fetch;
  return { fetch: doFetch, jar };
}

function hostFor(wallet: ReturnType<typeof fixtureWallet>) {
  return async () => ({
    sign: async (message: string | { message: string; isHex?: boolean }) => {
      if (typeof message !== "string") throw new Error("expected the exact string challenge");
      return { publicKey: wallet.publicKeyHex, signature: wallet.signMessage(message) };
    },
  });
}

async function signIn(client: ReturnType<typeof browser>, wallet: ReturnType<typeof fixtureWallet>) {
  const outcome = await connectWithNimiqPay({ fetch: client.fetch, getProvider: hostFor(wallet) });
  if (outcome.kind !== "authenticated") throw new Error(`sign-in failed: ${outcome.kind}`);
  createdUserIds.add(outcome.me.user.id);
  return outcome.me;
}

describe.skipIf(!LIVE)("F2 sign-in through the client and real backend", () => {
  it("authenticates a first-time wallet; identity is the verified signer", async () => {
    const wallet = fixtureWallet();
    const client = browser("first");
    const me = await signIn(client, wallet);
    expect(me.user.nimiqAddress).toBe(wallet.address);
    expect(me.profile).toEqual({ displayName: null, onboardingCompletedAt: null });
    expect(client.jar.has("thence_session")).toBe(true);
  });

  it("restores the session from the HttpOnly cookie alone", async () => {
    const wallet = fixtureWallet();
    const client = browser("restore");
    await signIn(client, wallet);
    const restored = await fetchMe(client.fetch);
    expect(sessionFromResponse(restored.status, restored.me, true)).toMatchObject({ status: "valid" });
    expect(restored.me?.user.nimiqAddress).toBe(wallet.address);
  });

  it("does not authenticate when the host signs with a different key", async () => {
    const real = fixtureWallet();
    const impostor = fixtureWallet();
    const client = browser("impostor");
    const outcome = await connectWithNimiqPay({
      fetch: client.fetch,
      getProvider: async () => ({
        sign: async (message: string | { message: string }) => ({
          publicKey: real.publicKeyHex,
          signature: impostor.signMessage(typeof message === "string" ? message : message.message),
        }),
      }),
    });
    expect(outcome).toEqual({ kind: "failed", reason: "signature" });
    expect(client.jar.size).toBe(0);
  });

  it("leaves the user signed out when they decline in Nimiq Pay", async () => {
    const client = browser("decline");
    const outcome = await connectWithNimiqPay({
      fetch: client.fetch,
      getProvider: async () => ({
        sign: async () => {
          throw new NimiqProviderError("PERMISSION_DENIED", "Request canceled by the user.", 4001);
        },
      }),
    });
    expect(outcome).toEqual({ kind: "rejected" });
    expect((await fetchMe(client.fetch)).status).toBe(401);
  });
});

describe.skipIf(!LIVE)("F2 durable profile and onboarding", () => {
  it("persists the name typed before connecting and completes onboarding", async () => {
    const wallet = fixtureWallet();
    const client = browser("onboard");
    const me = await signIn(client, wallet);
    const next = await routeAfterSignIn(me, "Ada", (name) => completeOnboarding(client.fetch, name));
    expect(next.route).toBe("/app/home");
    expect(next.me.profile.displayName).toBe("Ada");
    expect(next.me.profile.onboardingCompletedAt).not.toBeNull();
    const row = await getDb().select().from(users).where(eq(users.id, me.user.id));
    expect(row[0]?.displayName).toBe("Ada");
  });

  it("a returning account on a new device keeps its saved name and skips setup", async () => {
    const wallet = fixtureWallet();
    const first = browser("deviceA");
    const me = await signIn(first, wallet);
    await completeOnboarding(first.fetch, "Ada");

    const second = browser("deviceB");
    const again = await signIn(second, wallet);
    expect(again.user.id).toBe(me.user.id);
    expect(again.profile.displayName).toBe("Ada");
    const next = await routeAfterSignIn(again, "Temporary Name", (name) => completeOnboarding(second.fetch, name));
    expect(next.route).toBe("/app/home");
    expect(next.me.profile.displayName).toBe("Ada");

    // Even a direct write attempt cannot overwrite a completed profile.
    const direct = await completeOnboarding(second.fetch, "Overwrite");
    expect(direct).toMatchObject({ kind: "saved", applied: false });
    if (direct.kind === "saved") expect(direct.me.profile.displayName).toBe("Ada");
  });

  it("validates names and normalizes whitespace", async () => {
    const client = browser("validate");
    await signIn(client, fixtureWallet());
    expect(await completeOnboarding(client.fetch, "   ")).toMatchObject({ kind: "invalid" });
    expect(await completeOnboarding(client.fetch, "x".repeat(33))).toMatchObject({ kind: "invalid" });
    expect(await completeOnboarding(client.fetch, "Ada\u202Eevil")).toMatchObject({ kind: "invalid" });
    expect(await completeOnboarding(client.fetch, "Ada\u0000")).toMatchObject({ kind: "invalid" });
    const ok = await completeOnboarding(client.fetch, "  Ada   Lovelace ");
    expect(ok).toMatchObject({ kind: "saved", applied: true });
    if (ok.kind === "saved") expect(ok.me.profile.displayName).toBe("Ada Lovelace");
  });

  it("derives the owner from the session and rejects identity fields", async () => {
    const victimClient = browser("victim");
    const victim = await signIn(victimClient, fixtureWallet());
    const attackerClient = browser("attacker");
    await signIn(attackerClient, fixtureWallet());

    for (const field of ["userId", "user_id", "nimiqAddress", "address", "ownerUserId"]) {
      const res = await attackerClient.fetch("/api/me/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Pwned", [field]: victim.user.id }),
      });
      expect(res.status).toBe(400);
    }
    const victimRow = await getDb().select().from(users).where(eq(users.id, victim.user.id));
    expect(victimRow[0]?.displayName).toBeNull();
    expect(victimRow[0]?.onboardingCompletedAt).toBeNull();
  });

  it("requires a session and the same origin", async () => {
    const anonymous = browser("anon");
    expect(await completeOnboarding(anonymous.fetch, "Ada")).toEqual({ kind: "unauthenticated" });

    const signedIn = browser("origin");
    await signIn(signedIn, fixtureWallet());
    const cookie = [...signedIn.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const crossSite = await onboardingPOST(
      postJson("http://localhost/api/me/onboarding", { displayName: "Ada" }, { cookie, origin: "https://evil.example" }),
    );
    expect(crossSite.status).toBe(403);
  });
});

describe.skipIf(!LIVE)("F2 logout, expiry and reconnection", () => {
  it("logout revokes the session; reconnecting signs in again without the tour", async () => {
    const wallet = fixtureWallet();
    const client = browser("logout");
    const me = await signIn(client, wallet);
    await completeOnboarding(client.fetch, "Ada");
    const staleCookie = [...client.jar].map(([k, v]) => `${k}=${v}`).join("; ");

    expect(await signOut(client.fetch)).toBe(true);
    const after = await fetchMe(client.fetch);
    expect(after.status).toBe(401);
    // With the device hint set, a 401 means "returning user" → reconnect screen.
    expect(sessionFromResponse(after.status, after.me, true)).toEqual({ status: "expired" });

    // A copied pre-logout cookie no longer works (server-side revocation).
    const replay = await meGET(new Request("http://localhost/api/me", { headers: { cookie: staleCookie } }));
    expect(replay.status).toBe(401);

    const again = await signIn(client, wallet);
    expect(again.user.id).toBe(me.user.id);
    expect(again.profile.onboardingCompletedAt).not.toBeNull();
    expect((await routeAfterSignIn(again, null, async () => ({ kind: "failed" }))).route).toBe("/app/home");
  });

  it("an expired session reads as expired, not as a new user", async () => {
    const client = browser("expiry");
    const me = await signIn(client, fixtureWallet());
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, me.user.id));
    const res = await fetchMe(client.fetch);
    expect(res.status).toBe(401);
    expect(sessionFromResponse(res.status, res.me, true)).toEqual({ status: "expired" });
    expect(sessionFromResponse(res.status, res.me, false)).toEqual({ status: "none" });
  });
});
