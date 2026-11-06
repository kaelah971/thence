/**
 * Origin/CSRF check behind a reverse proxy or tunnel.
 *
 * Self-hosted `next start` behind cloudflared reports its listen address
 * (e.g. http://localhost:3200) in request.url, not the public host. The
 * configured canonical THENCE_APP_ORIGIN must therefore be accepted, while
 * every other origin — including spoofed forwarded-host headers — stays
 * rejected. Pure unit test: no database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeOrigin, AuthError } from "@/lib/auth";

const KEYS = ["THENCE_APP_ORIGIN", "THENCE_ALLOWED_ORIGINS", "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

function post(url: string, headers: Record<string, string>): Request {
  return new Request(url, { method: "POST", headers });
}

function code(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof AuthError) return `${err.status} ${err.code}`;
    throw err;
  }
}

describe("assertSafeOrigin behind a proxy", () => {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env["THENCE_APP_ORIGIN"] = "https://paywiththence.cv";
    process.env["THENCE_ALLOWED_ORIGINS"] = "";
    // env validation needs a URL; this test never connects to a database
    if (!process.env["DATABASE_URL"]) process.env["DATABASE_URL"] = "postgresql://postgres:postgres@localhost:5432/thence";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const PROXIED = "http://localhost:3200/api/recipients";

  it("accepts the canonical origin when request.url carries the listen address", () => {
    expect(code(() => assertSafeOrigin(post(PROXIED, { origin: "https://paywiththence.cv" })))).toBeNull();
  });

  it("accepts a Referer on the canonical origin when Origin is absent", () => {
    expect(code(() => assertSafeOrigin(post(PROXIED, { referer: "https://paywiththence.cv/app/send" })))).toBeNull();
  });

  it("rejects foreign origins", () => {
    for (const o of ["https://evil.example", "https://paywiththence.cv.evil.example", "https://evilpaywiththence.cv", "https://www.paywiththence.cv"]) {
      expect(code(() => assertSafeOrigin(post(PROXIED, { origin: o })))).toBe("403 ORIGIN_MISMATCH");
    }
  });

  it("does not trust forwarded-host headers", () => {
    expect(
      code(() =>
        assertSafeOrigin(post(PROXIED, { origin: "https://evil.example", "x-forwarded-host": "evil.example", host: "evil.example" })),
      ),
    ).toBe("403 ORIGIN_MISMATCH");
  });

  it("keeps the existing same-host rule (Vercel aliases)", () => {
    expect(code(() => assertSafeOrigin(post("https://paywiththence.vercel.app/api/x", { origin: "https://paywiththence.vercel.app" })))).toBeNull();
  });

  it("keeps the exact THENCE_ALLOWED_ORIGINS allowlist", () => {
    process.env["THENCE_ALLOWED_ORIGINS"] = "https://vps.paywiththence.cv";
    expect(code(() => assertSafeOrigin(post(PROXIED, { origin: "https://vps.paywiththence.cv" })))).toBeNull();
    expect(code(() => assertSafeOrigin(post(PROXIED, { origin: "https://other.paywiththence.cv" })))).toBe("403 ORIGIN_MISMATCH");
  });

  it("without a canonical origin, a proxied request from the public host is still rejected", () => {
    process.env["THENCE_APP_ORIGIN"] = "";
    expect(code(() => assertSafeOrigin(post(PROXIED, { origin: "https://paywiththence.cv" })))).toBe("403 ORIGIN_MISMATCH");
  });

  it("rejects unparsable origins; absent origin stays allowed (documented)", () => {
    expect(code(() => assertSafeOrigin(post(PROXIED, { origin: "not a url" })))).toBe("403 BAD_ORIGIN");
    expect(code(() => assertSafeOrigin(post(PROXIED, {})))).toBeNull();
  });
});
