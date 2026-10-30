/**
 * F2 — sign-in client against MOCKED hosts and a mocked backend.
 * These prove client logic only; they are not real Nimiq Pay evidence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { connectWithNimiqPay, type ConnectStep, type MeResponse } from "@/ui/lib/auth-client";
import {
  classifyProviderError,
  getHostProvider,
  HostUnavailableError,
  setHostProviderLoaderForTests,
  type HostProvider,
} from "@/ui/lib/nimiq-provider";
import { routeAfterSignIn } from "@/ui/lib/onboarding-flow";
import { isOnboarded, sessionFromResponse } from "@/ui/lib/session";

const ME: MeResponse = {
  user: { id: "u1", nimiqAddress: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000", createdAt: "2026-10-29T00:00:00.000Z" },
  profile: { displayName: null, onboardingCompletedAt: null },
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function backend(responses: Record<string, () => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const make = responses[url];
    if (!make) throw new TypeError("network down");
    return make();
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HAPPY = {
  "/api/session/challenge": json(201, { challenge: "Sign in to Thence\nNonce: abc", expiresAt: "x" }),
  "/api/session/verify": json(200, { user: { id: "u1", nimiqAddress: ME.user.nimiqAddress } }),
  "/api/me": json(200, ME),
};

const signingProvider = (sign: HostProvider["sign"]): (() => Promise<HostProvider>) => async () => ({ sign });

afterEach(() => setHostProviderLoaderForTests(null));

describe("provider availability", () => {
  it("rejects outside the browser without touching the SDK (SSR-safe)", async () => {
    await expect(getHostProvider()).rejects.toBeInstanceOf(HostUnavailableError);
  });

  it("classifies SDK and host errors", () => {
    expect(classifyProviderError(new Error("Nimiq provider was not injected. Are you running inside a Nimiq app?"))).toBe("unavailable");
    expect(classifyProviderError(new NimiqProviderError("PERMISSION_DENIED", "User cancelled", 4001))).toBe("rejected");
    expect(classifyProviderError(new NimiqProviderError("NETWORK_ERROR", "offline", -32000))).toBe("network");
    expect(classifyProviderError(new NimiqProviderError("UNKNOWN_REQUEST", "nope", 4200))).toBe("unsupported");
    expect(classifyProviderError(new NimiqProviderError("SOMETHING_NEW", "?"))).toBe("failed");
    expect(classifyProviderError("weird")).toBe("failed");
  });
});

describe("connectWithNimiqPay (mocked host)", () => {
  it("signs the exact server challenge and authenticates via the backend", async () => {
    const steps: ConnectStep[] = [];
    let signedMessage: unknown;
    const api = backend(HAPPY);
    const outcome = await connectWithNimiqPay(
      {
        fetch: api.fetch,
        getProvider: signingProvider(async (message) => {
          signedMessage = message;
          return { publicKey: "aa".repeat(32), signature: "bb".repeat(64) };
        }),
      },
      (s) => steps.push(s),
    );
    expect(outcome).toEqual({ kind: "authenticated", me: ME });
    expect(signedMessage).toBe("Sign in to Thence\nNonce: abc");
    expect(steps).toEqual(["initializing", "signing", "verifying"]);
    const verify = api.calls.find((c) => c.url === "/api/session/verify");
    expect(JSON.parse(String(verify?.init?.body))).toEqual({
      challenge: "Sign in to Thence\nNonce: abc",
      publicKey: "aa".repeat(32),
      signature: "bb".repeat(64),
    });
    // Never asserts an address; challenge requested without one.
    expect(api.calls.find((c) => c.url === "/api/session/challenge")?.init?.body).toBe("{}");
    for (const call of api.calls) expect(call.init?.credentials).toBe("same-origin");
  });

  it("reports an unavailable provider without contacting the backend", async () => {
    const api = backend(HAPPY);
    const outcome = await connectWithNimiqPay({
      fetch: api.fetch,
      getProvider: async () => {
        throw new HostUnavailableError();
      },
    });
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(api.calls).toHaveLength(0);
  });

  it("treats a declined signature as a normal, unauthenticated outcome", async () => {
    const api = backend(HAPPY);
    const outcome = await connectWithNimiqPay({
      fetch: api.fetch,
      getProvider: signingProvider(async () => {
        throw new NimiqProviderError("PERMISSION_DENIED", "Request canceled by the user.", 4001);
      }),
    });
    expect(outcome).toEqual({ kind: "rejected" });
    expect(api.calls.map((c) => c.url)).toEqual(["/api/session/challenge"]);
  });

  it("does not authenticate when the server rejects the signature", async () => {
    const api = backend({ ...HAPPY, "/api/session/verify": json(401, { error: "SIGNATURE_INVALID" }) });
    const outcome = await connectWithNimiqPay({
      fetch: api.fetch,
      getProvider: signingProvider(async () => ({ publicKey: "aa".repeat(32), signature: "cc".repeat(64) })),
    });
    expect(outcome).toEqual({ kind: "failed", reason: "signature" });
    expect(api.calls.some((c) => c.url === "/api/me")).toBe(false);
  });

  it("distinguishes expired challenges, rate limits and network failure", async () => {
    const provider = signingProvider(async () => ({ publicKey: "aa".repeat(32), signature: "bb".repeat(64) }));
    const expired = backend({ ...HAPPY, "/api/session/verify": json(401, { error: "CHALLENGE_INVALID" }) });
    expect(await connectWithNimiqPay({ fetch: expired.fetch, getProvider: provider })).toEqual({ kind: "expired" });
    const limited = backend({ ...HAPPY, "/api/session/challenge": json(429, { error: "RATE_LIMITED" }) });
    expect(await connectWithNimiqPay({ fetch: limited.fetch, getProvider: provider })).toEqual({ kind: "rate-limited" });
    const offline = backend({});
    expect(await connectWithNimiqPay({ fetch: offline.fetch, getProvider: provider })).toEqual({ kind: "network" });
  });

  it("never reports a connected state unless /api/me confirms the session", async () => {
    const api = backend({ ...HAPPY, "/api/me": json(401, { error: "UNAUTHORIZED" }) });
    const outcome = await connectWithNimiqPay({
      fetch: api.fetch,
      getProvider: signingProvider(async () => ({ publicKey: "aa".repeat(32), signature: "bb".repeat(64) })),
    });
    expect(outcome.kind).not.toBe("authenticated");
  });

  it("rejects malformed host signatures", async () => {
    const api = backend(HAPPY);
    const outcome = await connectWithNimiqPay({
      fetch: api.fetch,
      getProvider: signingProvider(async () => ({}) as unknown as { publicKey: string; signature: string }),
    });
    expect(outcome).toEqual({ kind: "failed", reason: "signature" });
  });

  it("re-initializes after a failed provider init (not cached)", async () => {
    Object.assign(globalThis, { window: globalThis });
    try {
      let attempts = 0;
      setHostProviderLoaderForTests(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Nimiq provider was not injected. Are you running inside a Nimiq app?");
        return { sign: async () => ({ publicKey: "", signature: "" }) };
      });
      await expect(getHostProvider()).rejects.toBeInstanceOf(HostUnavailableError);
      await expect(getHostProvider()).resolves.toBeDefined();
      expect(attempts).toBe(2);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("session restoration and returning users", () => {
  it("maps /api/me responses to session states", () => {
    expect(sessionFromResponse(200, ME, false)).toEqual({ status: "valid", me: ME });
    expect(sessionFromResponse(401, null, true)).toEqual({ status: "expired" });
    expect(sessionFromResponse(401, null, false)).toEqual({ status: "none" });
    expect(sessionFromResponse(500, null, true)).toEqual({ status: "error" });
  });

  it("knows onboarding completion only from the server profile", () => {
    expect(isOnboarded({ status: "valid", me: ME })).toBe(false);
    expect(isOnboarded({ status: "valid", me: { ...ME, profile: { displayName: "Ada", onboardingCompletedAt: "2026-10-29T00:00:00Z" } } })).toBe(true);
    expect(isOnboarded({ status: "expired" })).toBe(false);
  });

  it("first-time account: saves the name typed before connecting, then Home", async () => {
    const saved = { ...ME, profile: { displayName: "Ada", onboardingCompletedAt: "2026-10-29T00:00:00Z" } };
    let savedName = "";
    const next = await routeAfterSignIn(ME, "  Ada ", async (name) => ((savedName = name), { kind: "saved", me: saved, applied: true }));
    expect(savedName).toBe("Ada");
    expect(next).toEqual({ route: "/app/home", me: saved, discardTemporaryName: true });
  });

  it("returning account: never sends the temporary name, goes Home", async () => {
    const returning = { ...ME, profile: { displayName: "Ada", onboardingCompletedAt: "2026-01-01T00:00:00Z" } };
    let called = false;
    const next = await routeAfterSignIn(returning, "Someone else", async () => ((called = true), { kind: "failed" }));
    expect(called).toBe(false);
    expect(next.route).toBe("/app/home");
    expect(next.discardTemporaryName).toBe(true);
  });

  it("new account without a name: asks for it", async () => {
    expect((await routeAfterSignIn(ME, null, async () => ({ kind: "failed" }))).route).toBe("/app/setup/name");
    expect((await routeAfterSignIn(ME, "Ada", async () => ({ kind: "failed" }))).route).toBe("/app/setup/name");
  });
});
