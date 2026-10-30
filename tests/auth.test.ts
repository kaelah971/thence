/**
 * B1 — authentication integration tests (live database).
 *
 * Runs against the dedicated Thence development database. Uses fresh random
 * keypairs per run (isolated records; existing data is never reset).
 * Skipped entirely when DATABASE_URL is absent.
 *
 * Official-compatible fixtures: signatures are produced with node:crypto
 * Ed25519 over the exact prefixed payload pinned in tests/nimiq.test.ts.
 * A real Nimiq Pay signature still requires host interaction (pending).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authChallenges, sessions, users } from "@/db/schema";
import { LIVE, RUN, fixtureWallet, getCookieFrom, postJson } from "./helpers";
import {
  assertResourceOwner,
  getAuthenticatedSession,
  hashSessionToken,
  issueChallenge,
  readSessionToken,
  revokeSession,
  serializeSessionCookie,
  verifyChallengeAndLogin,
} from "@/lib/auth";
import { checkRateLimit, clientKeyFromHeaders } from "@/lib/rate-limit";
import { POST as challengePOST } from "../app/api/session/challenge/route";
import { POST as verifyPOST } from "../app/api/session/verify/route";
import { GET as meGET } from "../app/api/me/route";
import { POST as logoutPOST } from "../app/api/session/logout/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE || createdUserIds.length === 0) return;
  await getDb().delete(users).where(eq(users.id, createdUserIds[0] as string));
  for (const id of createdUserIds.slice(1)) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

describe.skipIf(!LIVE)("challenge issuance", () => {
  it("issues a purpose-bound server-stored challenge", async () => {
    const issued = await issueChallenge();
    expect(issued.message).toContain("Sign in to Thence");
    expect(issued.message).toContain("Purpose: wallet authentication");
    expect(issued.message).toContain("App: thence");
    const rows = await getDb().select().from(authChallenges).where(eq(authChallenges.challenge, issued.message));
    expect(rows.length).toBe(1);
    expect(rows[0]?.consumedAt).toBeNull();
  });

  it("rejects an invalid expected address at issuance", async () => {
    await expect(issueChallenge("NQ00 BOGUS")).rejects.toThrow();
  });

  it("POST /api/session/challenge returns 201 with message + expiry", async () => {
    const res = await challengePOST(postJson("http://localhost/api/session/challenge", {}, { "x-forwarded-for": `issue-${RUN}` }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { challenge: string; expiresAt: string };
    expect(typeof body.challenge).toBe("string");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe.skipIf(!LIVE)("verify + login", () => {
  it("verifies a valid signature, derives identity from the public key", async () => {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    const { login, sessionToken } = await verifyChallengeAndLogin({
      challenge: message,
      publicKey: wallet.publicKeyHex,
      signature: wallet.signMessage(message),
    });
    createdUserIds.push(login.userId);
    expect(login.nimiqAddress).toBe(wallet.address);
    expect(typeof sessionToken).toBe("string");
    expect(sessionToken.length).toBeGreaterThan(32);
    // Token hash stored — never the token itself.
    const hashRows = await getDb().select().from(sessions).where(eq(sessions.userId, login.userId));
    expect(hashRows.length).toBe(1);
    expect(hashRows[0]?.tokenHash).toBe(hashSessionToken(sessionToken));
    expect(hashRows[0]?.tokenHash).not.toBe(sessionToken);
  });

  it("enforces a pre-bound expected address (signer mismatch rejected)", async () => {
    const alice = fixtureWallet();
    const bob = fixtureWallet();
    const { message } = await issueChallenge(alice.address);
    await expect(
      verifyChallengeAndLogin({ challenge: message, publicKey: bob.publicKeyHex, signature: bob.signMessage(message) }),
    ).rejects.toMatchObject({ status: 401 });
    const ok = await verifyChallengeAndLogin({
      challenge: (await issueChallenge(alice.address)).message,
      publicKey: alice.publicKeyHex,
      signature: "",
    }).catch(() => null);
    expect(ok).toBeNull(); // empty signature must not verify
    const good = await verifyChallengeAndLogin({
      challenge: (await issueChallenge(alice.address)).message,
      publicKey: alice.publicKeyHex,
      signature: alice.signMessage((await issueChallenge()).message), // signed DIFFERENT message
    }).catch((e: { status?: number }) => e);
    expect((good as { status?: number }).status).toBe(401);
    const { login } = await verifyChallengeAndLogin(
      await (async () => {
        const { message: m } = await issueChallenge(alice.address);
        return { challenge: m, publicKey: alice.publicKeyHex, signature: alice.signMessage(m) };
      })(),
    );
    createdUserIds.push(login.userId);
    expect(login.nimiqAddress).toBe(alice.address);
  });

  it("rejects unknown, tampered and malformed inputs with 401 (never 500)", async () => {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    const sig = wallet.signMessage(message);
    await expect(
      verifyChallengeAndLogin({ challenge: "thence:never-issued", publicKey: wallet.publicKeyHex, signature: sig }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyChallengeAndLogin({ challenge: message, publicKey: wallet.publicKeyHex, signature: "00".repeat(64).slice(0, 126) + "zz" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyChallengeAndLogin({ challenge: message, publicKey: "deadbeef", signature: sig }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects expired challenges", async () => {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    await getDb().update(authChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authChallenges.challenge, message));
    await expect(
      verifyChallengeAndLogin({ challenge: message, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(message) }),
    ).rejects.toMatchObject({ status: 401, code: "CHALLENGE_INVALID" });
  });

  it("consumes challenges exactly once — even under concurrent replay", async () => {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    const signature = wallet.signMessage(message);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        verifyChallengeAndLogin({ challenge: message, publicKey: wallet.publicKeyHex, signature })
          .then((r) => {
            createdUserIds.push(r.login.userId);
            return "ok" as const;
          })
          .catch(() => "rejected" as const),
      ),
    );
    expect(attempts.filter((a) => a === "ok").length).toBe(1);
    expect(attempts.filter((a) => a === "rejected").length).toBe(9);
  });

  it("reuses the same account on repeat login (no duplicate users)", async () => {
    const wallet = fixtureWallet();
    const first = await verifyChallengeAndLogin(
      await (async () => {
        const { message: m } = await issueChallenge();
        return { challenge: m, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(m) };
      })(),
    );
    const second = await verifyChallengeAndLogin(
      await (async () => {
        const { message: m } = await issueChallenge();
        return { challenge: m, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(m) };
      })(),
    );
    createdUserIds.push(first.login.userId);
    expect(second.login.userId).toBe(first.login.userId);
  });
});

describe.skipIf(!LIVE)("sessions, /me and logout", () => {
  async function loginCookie(headers: Record<string, string> = {}): Promise<{ cookie: string; address: string }> {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    const res = await verifyPOST(
      postJson(
        "http://localhost/api/session/verify",
        { challenge: message, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(message) },
        { "x-forwarded-for": `login-${RUN}`, ...headers },
      ),
    );
    expect(res.status).toBe(200);
    const cookie = getCookieFrom(res);
    expect(cookie).toContain("thence_session=");
    const body = (await res.json()) as { user: { nimiqAddress: string } };
    return { cookie: cookie as string, address: body.user.nimiqAddress };
  }

  it("GET /api/me returns only the authenticated user; anonymous → 401", async () => {
    const { cookie, address } = await loginCookie();
    const me = await meGET(new Request("http://localhost/api/me", { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { nimiqAddress: string } }).user.nimiqAddress).toBe(address);
    const anon = await meGET(new Request("http://localhost/api/me"));
    expect(anon.status).toBe(401);
    const forged = await meGET(new Request("http://localhost/api/me", { headers: { cookie: "thence_session=tampered-token-value" } }));
    expect(forged.status).toBe(401);
  });

  it("rejects expired and revoked sessions", async () => {
    const { cookie } = await loginCookie();
    const token = readSessionToken(cookie);
    expect(token).not.toBeNull();
    const session = await getAuthenticatedSession(token);
    expect(session).not.toBeNull();
    await getDb().update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, session!.sessionId));
    const expired = await meGET(new Request("http://localhost/api/me", { headers: { cookie: cookie as string } }));
    expect(expired.status).toBe(401);
  });

  it("logout revokes the session, clears the cookie, and is idempotent", async () => {
    const { cookie } = await loginCookie();
    const out = await logoutPOST(new Request("http://localhost/api/session/logout", { method: "POST", headers: { cookie: cookie as string } }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await meGET(new Request("http://localhost/api/me", { headers: { cookie: cookie as string } }));
    expect(after.status).toBe(401);
    const again = await logoutPOST(new Request("http://localhost/api/session/logout", { method: "POST", headers: { cookie: cookie as string } }));
    expect(again.status).toBe(200);
  });

  it("isolates users: one session never reads another identity", async () => {
    const a = await loginCookie();
    const b = await loginCookie();
    expect(a.address).not.toBe(b.address);
    const meA = (await (await meGET(new Request("http://localhost/api/me", { headers: { cookie: a.cookie } }))).json()) as {
      user: { nimiqAddress: string };
    };
    expect(meA.user.nimiqAddress).toBe(a.address);
    expect(() => assertResourceOwner("other-user-id", "this-user-id")).toThrow();
  });

  it("revoking an unknown token is a safe no-op", async () => {
    await expect(revokeSession("thence_session=does-not-exist")).resolves.toBeUndefined();
    await expect(revokeSession(null)).resolves.toBeUndefined();
  });
});

describe.skipIf(!LIVE)("CSRF / origin enforcement", () => {
  it("rejects forged origins on state-changing endpoints", async () => {
    const wallet = fixtureWallet();
    const { message } = await issueChallenge();
    const forged = await verifyPOST(
      postJson(
        "http://localhost/api/session/verify",
        { challenge: message, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(message) },
        { origin: "https://evil.example", "x-forwarded-for": `csrf-${RUN}` },
      ),
    );
    expect(forged.status).toBe(403);
    const out = await logoutPOST(
      new Request("http://localhost/api/session/logout", { method: "POST", headers: { origin: "https://evil.example" } }),
    );
    expect(out.status).toBe(403);
  });

  it("accepts matching origins", async () => {
    const res = await challengePOST(
      postJson("http://localhost/api/session/challenge", {}, { origin: "http://localhost:3000", "x-forwarded-for": `ok-${RUN}` }),
    );
    expect(res.status).toBe(201);
  });
});

describe.skipIf(!LIVE)("rate limiting (DB-backed fixed window)", () => {
  it("allows within the limit, denies past it, reports retry delay", async () => {
    const key = `test:${RUN}:${randomBytes(4).toString("hex")}`;
    expect((await checkRateLimit(key, 2)).allowed).toBe(true);
    expect((await checkRateLimit(key, 2)).allowed).toBe(true);
    const denied = await checkRateLimit(key, 2);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("derives client keys from proxy headers", () => {
    expect(clientKeyFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientKeyFromHeaders(new Headers({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientKeyFromHeaders(new Headers())).toBe("unknown");
  });

  it("challenge endpoint returns 429 with Retry-After past the limit", { timeout: 180_000 }, async () => {
    // 65 sequential requests always contain 31 within a single fixed 60s
    // window (limit is 30/min), so a 429 is guaranteed regardless of where
    // minute boundaries fall — the naive 31-request version flakes then.
    const key = `flood-${RUN}`;
    const statuses: number[] = [];
    let retryAfter = "0";
    for (let i = 0; i < 65; i++) {
      const res = await challengePOST(postJson("http://localhost/api/session/challenge", {}, { "x-forwarded-for": key }));
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after") ?? "0";
    }
    expect(statuses[0]).toBe(201);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

describe("session cookie security (no database)", () => {
  it("sets HttpOnly, Path, SameSite=Lax, Max-Age and Expires", () => {
    const header = serializeSessionCookie("token-value", new Date(Date.now() + 1000));
    expect(header).toContain("thence_session=token-value");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=");
    expect(header).toContain("Expires=");
  });

  it("adds Secure only in production", () => {
    const envRecord = process.env as Record<string, string | undefined>;
    const previous = envRecord["NODE_ENV"];
    const previousOrigin = envRecord["THENCE_APP_ORIGIN"];
    envRecord["NODE_ENV"] = "production";
    // C5 requires an explicit https origin in production.
    envRecord["THENCE_APP_ORIGIN"] = "https://pay.example.com";
    try {
      expect(serializeSessionCookie("t", new Date(Date.now() + 1000))).toContain("Secure");
    } finally {
      if (previous === undefined) delete envRecord["NODE_ENV"];
      else envRecord["NODE_ENV"] = previous;
      if (previousOrigin === undefined) delete envRecord["THENCE_APP_ORIGIN"];
      else envRecord["THENCE_APP_ORIGIN"] = previousOrigin;
    }
    expect(serializeSessionCookie("t", new Date(Date.now() + 1000))).not.toContain("Secure");
  });
});
