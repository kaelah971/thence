/**
 * B5.1 — rate-limit keying regression tests.
 *
 * Authenticated endpoints must key rate limits by the server-derived
 * session user id. Forging `x-forwarded-for` must not reset the counter.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authRateLimits } from "@/db/schema";
import { rateLimitKeyFor, clientKeyFromHeaders } from "@/lib/rate-limit";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as challengePost } from "../app/api/session/challenge/route";
import { POST as verifyPost } from "../app/api/session/verify/route";
import { POST as tokenSubmit } from "../app/api/verify/[token]/route";

describe("rate-limit key derivation (pure, no I/O)", () => {
  it("keys authenticated callers by session user id, ignoring forged headers", () => {
    const headers = new Headers({ "x-forwarded-for": "forged-1, forged-2", "x-real-ip": "forged-3" });
    expect(rateLimitKeyFor("user-abc", headers)).toBe("user:user-abc");
    expect(rateLimitKeyFor(null, headers)).toBe("forged-1");
    expect(rateLimitKeyFor("", headers)).toBe("forged-1");
    expect(rateLimitKeyFor(undefined, headers)).toBe("forged-1");
    // Header fallback behavior is unchanged for anonymous endpoints.
    expect(clientKeyFromHeaders(headers)).toBe("forged-1");
    expect(clientKeyFromHeaders(new Headers())).toBe("unknown");
  });
});

describe.skipIf(!LIVE)("anonymous endpoints resist header forgery", () => {
  it("challenge issuance counts rotated IPs against one global key", async () => {
    for (let i = 0; i < 6; i++) {
      await challengePost(postJson("http://localhost/api/session/challenge", {}, { "x-forwarded-for": `b52-chal-${RUN}-${i}` }));
    }
    const rows = await getDb().select({ count: authRateLimits.count }).from(authRateLimits).where(eq(authRateLimits.key, "challenge:global"));
    // All six counted under the shared key despite six distinct forged IPs
    // (other suites may add more in the same window — never fewer).
    expect(rows.reduce((n, r) => n + (r.count ?? 0), 0)).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it("one challenge cannot be retried beyond its cap via fresh IPs", async () => {
    const previous = process.env["THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE"];
    process.env["THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE"] = "2";
    try {
      const issued = (await (await challengePost(postJson("http://localhost/api/session/challenge", {}, { "x-forwarded-for": `b52-vfy-${RUN}` }))).json()) as { challenge: string };
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await verifyPost(
          postJson("http://localhost/api/session/verify", { challenge: issued.challenge, publicKey: "00".repeat(32), signature: "00".repeat(64) }, { "x-forwarded-for": `b52-vfy-${RUN}-${i}` }),
        );
        statuses.push(res.status);
      }
      expect(statuses[0]).not.toBe(429);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
      const key = `verify-challenge:${createHash("sha256").update(issued.challenge, "utf8").digest("hex")}`;
      const rows = await getDb().select({ count: authRateLimits.count }).from(authRateLimits).where(eq(authRateLimits.key, key));
      expect(rows.reduce((n, r) => n + (r.count ?? 0), 0)).toBe(6);
    } finally {
      if (previous === undefined) delete process.env["THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE"];
      else process.env["THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE"] = previous;
    }
  }, 60_000);

  it("one verification token cannot be submitted beyond its cap via fresh IPs", async () => {
    const previous = process.env["THENCE_VERIFY_ATTEMPTS_PER_TOKEN"];
    process.env["THENCE_VERIFY_ATTEMPTS_PER_TOKEN"] = "2";
    const token = `b52-token-${RUN}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await tokenSubmit(
          postJson(`http://localhost/api/verify/${token}`, { signature: "0x" + "00".repeat(65) }, { "x-forwarded-for": `b52-tok-${RUN}-${i}` }),
          { params: Promise.resolve({ token }) },
        );
        statuses.push(res.status);
      }
      expect(statuses[0]).not.toBe(429);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
      const key = `verification-token:${createHash("sha256").update(token, "utf8").digest("hex")}`;
      const rows = await getDb().select({ count: authRateLimits.count }).from(authRateLimits).where(eq(authRateLimits.key, key));
      expect(rows.reduce((n, r) => n + (r.count ?? 0), 0)).toBe(6);
    } finally {
      if (previous === undefined) delete process.env["THENCE_VERIFY_ATTEMPTS_PER_TOKEN"];
      else process.env["THENCE_VERIFY_ATTEMPTS_PER_TOKEN"] = previous;
    }
  }, 60_000);
});

describe.skipIf(!LIVE)("authenticated rate limits resist header forgery", () => {
  it("rotating x-forwarded-for does not reset an authenticated caller's counter", async () => {
    const previous = process.env["THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE"];
    process.env["THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE"] = "2";
    try {
      const { cookie, userId } = await loginAs({ "x-forwarded-for": `b51-${RUN}-ratelimit` });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await createTransfer(
          postJson("http://localhost/api/transfers", {}, { cookie, "x-forwarded-for": `198.51.100.${i + 1}` }),
        );
        statuses.push(res.status);
      }
      // First two always pass the guard (empty body fails later with 400);
      // enforcement is window-independent: at least two are blocked.
      expect(statuses[0]).toBe(400);
      expect(statuses[1]).toBe(400);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
      // All six counted against the single server-derived user key despite
      // six distinct forged IPs — rotation bought the attacker nothing.
      const rows = await getDb()
        .select({ count: authRateLimits.count })
        .from(authRateLimits)
        .where(eq(authRateLimits.key, `transfers-write:user:${userId}`));
      const total = rows.reduce((n, r) => n + (r.count ?? 0), 0);
      expect(total).toBe(6);
    } finally {
      if (previous === undefined) delete process.env["THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE"];
      else process.env["THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE"] = previous;
    }
  }, 60_000);
});
