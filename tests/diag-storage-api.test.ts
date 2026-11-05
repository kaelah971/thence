/**
 * iOS WebView storage diagnostic — owner gate, diagnostic cookie and
 * session check (live TEST database; no money, no Satora, no transfers).
 *
 * Pins: signed-out → 401 (echoing only the caller's own diagnostic run id);
 * signed-in non-owner → 404 everywhere including the page; owner → session
 * tag and diagnostic cookie with the session cookie's attributes; no token,
 * token hash or session id ever appears in a response; empty owner list ⇒
 * nobody; the API writes nothing to the database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/db/schema";
import { hashSessionToken } from "@/lib/auth";
import {
  DIAG_COOKIE_NAME,
  diagnosticsOwners,
  isDiagnosticsOwner,
  readDiagCookie,
  sessionTag,
} from "@/lib/diagnostics";
import { LIVE, RUN, deleteJson, loginAs, postJson, type TestLogin } from "./helpers";
import { DELETE, GET, POST } from "../app/api/diagnostics/storage/route";

const cookieJar = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "thence_session" && cookieJar.value ? { name, value: cookieJar.value } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const URL = "http://localhost/api/diagnostics/storage";
const OWNER_ADDR = "NQ52 1111 2222 3333 4444 5555 6666 7777 8888"; // placeholder, not a real wallet

describe("diagnostics owner list (pure)", () => {
  it("uses the dedicated list, falls back to pilot owners, and is empty ⇒ nobody", () => {
    expect(diagnosticsOwners({ THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES: OWNER_ADDR })).toHaveLength(1);
    expect(isDiagnosticsOwner(OWNER_ADDR.toLowerCase(), { THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER_ADDR })).toBe(true);
    expect(isDiagnosticsOwner(OWNER_ADDR, {})).toBe(false);
    expect(isDiagnosticsOwner(null, { THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES: OWNER_ADDR })).toBe(false);
    // The dedicated list wins over the pilot list.
    expect(
      isDiagnosticsOwner(OWNER_ADDR, {
        THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
        THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER_ADDR,
      }),
    ).toBe(false);
  });

  it("parses only well-formed diagnostic cookies", () => {
    expect(readDiagCookie(`a=1; ${DIAG_COOKIE_NAME}=r-abcdef12; b=2`)).toBe("r-abcdef12");
    expect(readDiagCookie(`${DIAG_COOKIE_NAME}=<script>`)).toBeNull();
    expect(readDiagCookie(null)).toBeNull();
    expect(sessionTag("x")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe.skipIf(!LIVE)("/api/diagnostics/storage (live TEST database)", () => {
  const created: string[] = [];
  let owner: TestLogin;
  let other: TestLogin;
  const get = (cookie?: string) => GET(new Request(URL, { headers: cookie ? { cookie } : {} }));

  beforeAll(async () => {
    owner = await loginAs({ "x-forwarded-for": `diag-owner-${RUN}` }, (id) => created.push(id));
    other = await loginAs({ "x-forwarded-for": `diag-other-${RUN}` }, (id) => created.push(id));
  }, 60_000); // two live logins; the 10 s hook default flakes on Neon latency
  afterEach(() => {
    vi.unstubAllEnvs();
    cookieJar.value = null;
  });
  afterAll(async () => {
    for (const id of created) await getDb().delete(users).where(eq(users.id, id));
  }, 60_000);
  const asOwner = () => vi.stubEnv("THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES", owner.address);

  it("signed out → 401 with no account data", async () => {
    asOwner();
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHORIZED", message: "Authentication required." });
  });

  it("signed out but carrying the diagnostic cookie → 401 echoing only that run id", async () => {
    asOwner();
    const res = await get(`${DIAG_COOKIE_NAME}=r-device-run-1`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["diagCookie"]).toEqual({ present: true, runId: "r-device-run-1" });
    expect(Object.keys(body).sort()).toEqual(["diagCookie", "error", "message"]);
  });

  it("signed-in non-owner → 404 for GET, POST and DELETE", async () => {
    asOwner();
    expect((await get(other.cookie)).status).toBe(404);
    expect((await POST(postJson(URL, { runId: "r-abcdef123" }, { cookie: other.cookie }))).status).toBe(404);
    expect((await DELETE(deleteJson(URL, { cookie: other.cookie }))).status).toBe(404);
  });

  it("empty owner configuration ⇒ even the owner wallet gets 404", async () => {
    vi.stubEnv("THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES", "");
    vi.stubEnv("THENCE_PILOT_OWNER_NIMIQ_ADDRESSES", "");
    expect((await get(owner.cookie)).status).toBe(404);
  });

  it("owner GET → session tag, never the token, hash or session id", async () => {
    asOwner();
    const res = await get(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const text = await res.text();
    const body = JSON.parse(text) as { owner: boolean; session: { authenticated: boolean; tag: string; createdAt: string }; diagCookie: unknown };
    expect(body.owner).toBe(true);
    expect(body.session.authenticated).toBe(true);
    expect(body.session.tag).toMatch(/^[0-9a-f]{12}$/);
    expect(Date.parse(body.session.createdAt)).toBeGreaterThan(0);
    expect(body.diagCookie).toEqual({ present: false, runId: null });
    const token = decodeURIComponent(owner.cookie.split("=")[1] ?? "");
    expect(token.length).toBeGreaterThan(20);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashSessionToken(token));
    expect(text).not.toContain(owner.userId);
    expect(text).not.toMatch(/thence_session|tokenHash|sessionId/);
  });

  it("the tag is stable for one session and differs after a new sign-in", async () => {
    asOwner();
    const a = ((await (await get(owner.cookie)).json()) as { session: { tag: string } }).session.tag;
    const b = ((await (await get(owner.cookie)).json()) as { session: { tag: string } }).session.tag;
    expect(a).toBe(b);
    const again = await loginAs({ "x-forwarded-for": `diag-again-${RUN}` });
    created.push(again.userId);
    vi.stubEnv("THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES", `${owner.address},${again.address}`);
    const c = ((await (await get(again.cookie)).json()) as { session: { tag: string } }).session.tag;
    expect(c).not.toBe(a);
  });

  it("owner POST sets thence_diag with the session cookie's attributes; GET then sees it", async () => {
    asOwner();
    const res = await POST(postJson(URL, { runId: "r-abcdef123456" }, { cookie: owner.cookie }));
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^thence_diag=r-abcdef123456;/);
    for (const attr of ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age="]) expect(set).toContain(attr);
    expect(set).not.toContain("thence_session");
    const seen = (await (await get(`${owner.cookie}; ${DIAG_COOKIE_NAME}=r-abcdef123456`)).json()) as { diagCookie: unknown };
    expect(seen.diagCookie).toEqual({ present: true, runId: "r-abcdef123456" });
  });

  it("POST rejects malformed run ids and foreign origins", async () => {
    asOwner();
    expect((await POST(postJson(URL, { runId: "x" }, { cookie: owner.cookie }))).status).toBe(400);
    expect((await POST(postJson(URL, { runId: "a;b=c" }, { cookie: owner.cookie }))).status).toBe(400);
    expect((await POST(postJson(URL, {}, { cookie: owner.cookie }))).status).toBe(400);
    const foreign = await POST(postJson(URL, { runId: "r-abcdef123456" }, { cookie: owner.cookie, origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("set-cookie")).toBeNull();
  });

  it("owner DELETE clears only thence_diag", async () => {
    asOwner();
    const res = await DELETE(deleteJson(URL, { cookie: `${owner.cookie}; ${DIAG_COOKIE_NAME}=r-abcdef123456` }));
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^thence_diag=;/);
    expect(set).toContain("Max-Age=0");
    expect(set).not.toContain("thence_session");
  });

  it("the API writes nothing to the database (rows for these accounts + the payment switch)", async () => {
    asOwner();
    const ids = sql.join([owner.userId, other.userId].map((id) => sql`${id}::uuid`), sql`, `);
    const snapshot = async () => {
      const r = await getDb().execute(sql`
        SELECT
          (SELECT count(*)::int FROM sessions WHERE user_id IN (${ids})) AS sessions,
          (SELECT max(coalesce(revoked_at, created_at))::text FROM sessions WHERE user_id IN (${ids})) AS session_change,
          (SELECT count(*)::int FROM transfers WHERE owner_user_id IN (${ids})) AS transfers,
          (SELECT count(*)::int FROM users WHERE id IN (${ids})) AS users,
          (SELECT row_to_json(p)::text FROM pilot_controls p WHERE id = 'pilot') AS pilot`);
      return r.rows[0];
    };
    const before = await snapshot();
    await get(owner.cookie);
    await POST(postJson(URL, { runId: "r-abcdef123456" }, { cookie: owner.cookie }));
    await DELETE(deleteJson(URL, { cookie: owner.cookie }));
    await get(other.cookie);
    await get();
    expect(await snapshot()).toEqual(before);
  });

  describe("page gate", () => {
    const tokenOf = (l: TestLogin) => decodeURIComponent(l.cookie.split("=")[1] ?? "");

    it("non-owner session → 404", async () => {
      asOwner();
      const { default: Page } = await import("../app/app/diagnostics/storage/page");
      cookieJar.value = tokenOf(other);
      await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    });

    it("owner session → diagnostic rendered as owner; signed out → shell without owner", async () => {
      asOwner();
      const { default: Page } = await import("../app/app/diagnostics/storage/page");
      cookieJar.value = tokenOf(owner);
      const el = (await Page()) as { props: { ownerAtRender: boolean } };
      expect(el.props.ownerAtRender).toBe(true);
      cookieJar.value = null;
      const anon = (await Page()) as { props: { ownerAtRender: boolean } };
      expect(anon.props.ownerAtRender).toBe(false);
    });
  });
});
