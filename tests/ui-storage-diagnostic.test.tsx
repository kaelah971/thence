// @vitest-environment jsdom
/**
 * iOS WebView storage diagnostic — client engine, verdicts and screen.
 *
 * No money, no Satora, no payment secrets: stores are in-memory fakes or
 * jsdom web storage; the server is a fake ServerApi. The safety block pins
 * that the diagnostic never touches payment recovery data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAG_IDB_NAME,
  DIAG_KEY_PREFIX,
  DIAG_SCRIPT_COOKIE,
  REAL_RECOVERY_DBS,
  databaseNameLister,
  documentScriptCookie,
  realDbPresence,
  SCENARIOS,
  StorageDiagnosticEngine,
  buildReport,
  evaluate,
  indexedDbStore,
  webStorageStore,
  type CookieVariant,
  type DiagRun,
  type KvStore,
  type ScriptCookie,
  type ServerApi,
  type ServerRead,
  type StoreName,
} from "@/ui/lib/storage-diagnostic";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, string>)}>
      {children}
    </a>
  ),
}));

/* ---------------- fakes ---------------- */

class MemStore implements KvStore {
  data = new Map<string, unknown>();
  failReads = false;
  constructor(readonly name: StoreName) {}
  async get(key: string) {
    if (this.failReads) throw Object.assign(new Error("boom"), { name: "SecurityError" });
    return this.data.has(key) ? structuredClone(this.data.get(key)) : null;
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async clear() {
    this.data.clear();
  }
  wipe() {
    this.data.clear();
  }
}

class FakeScriptCookie implements ScriptCookie {
  value: string | null = null;
  read() {
    return this.value;
  }
  write(runId: string) {
    this.value = runId;
  }
  clear() {
    this.value = null;
  }
}

class FakeServer implements ServerApi {
  /** Server-written variants the "browser" still holds. */
  jar: Record<Exclude<CookieVariant, "script">, string | null> = { persistent: null, session: null, sameSiteNone: null };
  signedIn = true;
  owner = true;
  down = false;
  tag = "aaaaaaaaaaaa";
  calls: string[] = [];
  constructor(private readonly script: FakeScriptCookie) {}
  get cookie(): string | null {
    return this.jar.persistent;
  }
  set cookie(v: string | null) {
    this.jar.persistent = v;
  }
  /** Simulate the webview dropping every cookie (login + diagnostic). */
  dropAllCookies() {
    this.jar = { persistent: null, session: null, sameSiteNone: null };
    this.script.value = null;
    this.signedIn = false;
  }
  private result(): ServerRead {
    if (this.down) return { state: "error", message: "TypeError" };
    const cookies = { ...this.jar, script: this.script.value };
    if (!this.signedIn) return { state: "unauthenticated", diagRunId: this.cookie, cookies };
    if (!this.owner) return { state: "not-owner" };
    return { state: "ok", tag: this.tag, createdAt: "2026-11-05T10:00:00.000Z", diagRunId: this.cookie, cookies };
  }
  async read() {
    this.calls.push("GET");
    return this.result();
  }
  async setCookie(runId: string) {
    this.calls.push("POST");
    if (this.signedIn && this.owner && !this.down) this.jar = { persistent: runId, session: runId, sameSiteNone: runId };
    return this.result();
  }
  async clearCookie() {
    this.calls.push("DELETE");
    this.jar = { persistent: null, session: null, sameSiteNone: null };
  }
}

function setup(opts: { page?: string } = {}) {
  const stores = { indexedDB: new MemStore("indexedDB"), localStorage: new MemStore("localStorage"), sessionStorage: new MemStore("sessionStorage") };
  const script = new FakeScriptCookie();
  const server = new FakeServer(script);
  /** Database names the browser would list (the real ones by default, plus an unrelated one). */
  const dbs = { names: [REAL_RECOVERY_DBS.sdk, REAL_RECOVERY_DBS.binding, "unrelated-app-db"] as string[] | null };
  const lister = async () => (dbs.names === null ? null : [...dbs.names]);
  let n = 0;
  const make = (page: string) =>
    new StorageDiagnosticEngine({
      stores: Object.values(stores),
      server,
      pageInstance: page,
      navigationType: "navigate",
      randomId: () => `r-test-run-${++n}`,
      now: () => new Date(Date.UTC(2026, 10, 5, 12, 0, n)),
      scriptCookie: script,
      listDatabaseNames: lister,
    });
  return { stores, server, script, dbs, lister, engine: make(opts.page ?? "p1"), make };
}

const RUN: DiagRun = { runId: "r-run-1", startedAt: "2026-11-05T12:00:00.000Z", sessionTag: "aaaaaaaaaaaa" };
const ok = (run: DiagRun | null) => ({ state: "ok" as const, run });
const ALL_COOKIES = { persistent: "r-run-1", session: "r-run-1", sameSiteNone: "r-run-1", script: "r-run-1" };
const SERVER_OK: ServerRead = { state: "ok", tag: "aaaaaaaaaaaa", createdAt: null, diagRunId: "r-run-1", cookies: ALL_COOKIES };
const LAUNCH = { counter: { runId: "r-run-1", count: 1, relaunches: 0, lastAt: "2026-11-05T12:00:00.000Z" }, lost: false };

/* ---------------- verdicts ---------------- */

describe("evaluate — PASS / FAIL / UNKNOWN", () => {
  const all = { indexedDB: ok(RUN), localStorage: ok(RUN), sessionStorage: ok(RUN) };
  const v = (e: ReturnType<typeof evaluate>, name: string) => e.lines.find((l) => l.name === name)?.verdict;

  it("everything survived → PASS", () => {
    const e = evaluate(RUN, all, SERVER_OK, { launch: LAUNCH, scriptLocal: "r-run-1" });
    expect(e.overall).toBe("PASS");
    expect(e.lines.every((l) => l.verdict === "PASS")).toBe(true);
  });

  it("IndexedDB marker gone → FAIL (the claim-vault storage)", () => {
    const e = evaluate(null, { ...all, indexedDB: ok(null) }, SERVER_OK);
    expect(v(e, "indexedDB")).toBe("FAIL");
    expect(e.overall).toBe("FAIL");
  });

  it("localStorage gone but IndexedDB kept → FAIL only on localStorage", () => {
    const e = evaluate(null, { ...all, localStorage: ok(null) }, SERVER_OK);
    expect(v(e, "indexedDB")).toBe("PASS");
    expect(v(e, "localStorage")).toBe("FAIL");
  });

  it("diagnostic cookie dropped → FAIL; session still checked separately", () => {
    const e = evaluate(RUN, all, { ...SERVER_OK, diagRunId: null });
    expect(v(e, "diagCookie")).toBe("FAIL");
    expect(v(e, "session")).toBe("PASS");
  });

  it("signed out (401) → session FAIL, cookie judged from the echoed diag cookie", () => {
    const e = evaluate(RUN, all, { state: "unauthenticated", diagRunId: "r-run-1" });
    expect(v(e, "session")).toBe("FAIL");
    expect(v(e, "diagCookie")).toBe("PASS");
  });

  it("re-signed in (different session tag) → session FAIL", () => {
    const e = evaluate(RUN, all, { ...SERVER_OK, tag: "bbbbbbbbbbbb" });
    expect(v(e, "session")).toBe("FAIL");
    expect(e.lines.find((l) => l.name === "session")?.detail).toMatch(/Signed in again/);
  });

  it("server unreachable → cookie and session UNKNOWN, never PASS", () => {
    const e = evaluate(RUN, all, { state: "error", message: "TypeError" });
    expect(v(e, "diagCookie")).toBe("UNKNOWN");
    expect(v(e, "session")).toBe("UNKNOWN");
    expect(e.overall).toBe("UNKNOWN");
  });

  it("store read throws → UNKNOWN, not FAIL", () => {
    const e = evaluate(RUN, { ...all, indexedDB: { state: "error", message: "SecurityError" } }, SERVER_OK);
    expect(v(e, "indexedDB")).toBe("UNKNOWN");
  });

  it("no test started and nothing stored → UNKNOWN (not a false PASS)", () => {
    const e = evaluate(null, { indexedDB: ok(null), localStorage: ok(null), sessionStorage: ok(null) }, { ...SERVER_OK, diagRunId: null });
    expect(v(e, "indexedDB")).toBe("UNKNOWN");
    expect(v(e, "diagCookie")).toBe("UNKNOWN");
    expect(e.overall).toBe("UNKNOWN");
  });

  it("sessionStorage loss is informational and does not fail the overall", () => {
    const e = evaluate(RUN, { ...all, sessionStorage: ok(null) }, SERVER_OK);
    expect(v(e, "sessionStorage")).toBe("FAIL");
    expect(e.overall).toBe("PASS");
  });

  it("an older marker left in one store is FAIL against the newest run", () => {
    const older = { ...RUN, runId: "r-old", startedAt: "2026-11-05T11:00:00.000Z" };
    const e = evaluate(null, { ...all, localStorage: ok(older) }, SERVER_OK);
    expect(e.expected?.runId).toBe("r-run-1");
    expect(v(e, "localStorage")).toBe("FAIL");
  });
});

/* ---------------- engine lifecycle ---------------- */

describe("engine — start, survive, reload, reset", () => {
  it("start writes the same run marker to every store and the cookie, then PASSes", async () => {
    const { stores, server, engine } = setup();
    await engine.start();
    const run = engine.getState().run!;
    for (const s of Object.values(stores)) expect((s.data.get("run") as DiagRun).runId).toBe(run.runId);
    expect(server.cookie).toBe(run.runId);
    expect(run.sessionTag).toBe("aaaaaaaaaaaa");
    expect(engine.getState().evaluation?.overall).toBe("PASS");
  });

  it("a fresh page load (webview reloaded) recovers the run from surviving storage", async () => {
    const { stores, engine, make } = setup();
    await engine.start();
    const runId = engine.getState().run!.runId;
    stores.sessionStorage.wipe(); // closed page
    const reloaded = make("p2");
    await reloaded.load();
    await reloaded.check("load");
    const s = reloaded.getState();
    expect(s.run?.runId).toBe(runId);
    expect(s.evaluation?.overall).toBe("PASS");
    expect(s.history.at(-1)?.page).toBe("p2");
    expect(s.history.some((h) => h.page === "p1")).toBe(true); // history survived the reload
  });

  it("IndexedDB wiped while away → FAIL on the next check, recorded with the scenario", async () => {
    const { stores, engine } = setup();
    await engine.start();
    await engine.setScenario("swipe-away");
    stores.indexedDB.wipe();
    await engine.check("visible");
    const last = engine.getState().history.at(-1)!;
    expect(last.results.indexedDB).toBe("FAIL");
    expect(last.scenario).toBe("swipe-away");
    expect(last.overall).toBe("FAIL");
  });

  it("everything wiped and signed out → session FAIL, storage UNKNOWN (no baseline left)", async () => {
    const { stores, server, engine, make } = setup();
    await engine.start();
    Object.values(stores).forEach((s) => s.wipe());
    server.signedIn = false;
    server.cookie = null;
    const fresh = make("p3");
    await fresh.load();
    await fresh.check("load");
    const e = fresh.getState().evaluation!;
    expect(e.lines.find((l) => l.name === "session")?.verdict).toBe("FAIL");
    expect(e.lines.find((l) => l.name === "indexedDB")?.verdict).toBe("UNKNOWN");
  });

  it("concurrent triggers run one check at a time", async () => {
    const { server, engine } = setup();
    await engine.start();
    server.calls = [];
    await Promise.all([engine.check("visible"), engine.check("focus"), engine.check("pageshow")]);
    expect(server.calls.filter((c) => c === "GET")).toHaveLength(1);
  });

  it("start while signed out does not write markers and explains why", async () => {
    const { stores, server, engine } = setup();
    server.signedIn = false;
    await engine.start();
    expect(engine.getState().startError).toMatch(/signed out/);
    expect(stores.localStorage.data.size).toBe(0);
  });

  it("a non-owner never gets markers written", async () => {
    const { stores, server, engine } = setup();
    server.owner = false;
    await engine.start();
    await engine.check("load");
    await engine.logEvent("visible");
    expect(engine.getState().notOwner).toBe(true);
    for (const s of Object.values(stores)) expect(s.data.size).toBe(0);
  });

  it("a signed-out visitor with no markers gets nothing persisted", async () => {
    const { stores, server, engine } = setup();
    server.signedIn = false;
    await engine.load();
    await engine.logEvent("load");
    await engine.check("load");
    for (const s of Object.values(stores)) expect(s.data.size).toBe(0);
  });

  it("reset clears the diagnostic namespace and cookie only", async () => {
    const { stores, server, engine } = setup();
    await engine.start();
    await engine.reset();
    expect(server.cookie).toBeNull();
    for (const s of Object.values(stores)) expect(s.data.size).toBe(0);
    expect(engine.getState().run).toBeNull();
  });

  it("report contains verdicts and history but no tokens or cookie names", async () => {
    const { engine } = setup();
    await engine.start();
    const text = buildReport(engine.getState(), { build: "abc123", userAgent: "UA", page: "p1", navigation: "navigate" });
    expect(text).toContain("NOW: PASS");
    expect(text).toMatch(/IDB\/LS\/cookie\/session/);
    expect(text).not.toMatch(/thence_session|token|preimage|secret/i);
  });

  it("guide covers visibility, lock, background, reopen, force-quit, memory and reload", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(
      expect.arrayContaining(["baseline", "reload", "visibility", "lock", "background-long", "close-miniapp", "swipe-away", "memory"]),
    );
  });
});

/* ---------------- safety: never touch payment recovery data ---------------- */

describe("safety — diagnostic namespace only", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("web storage adapter writes prefixed keys and clear() leaves every other key alone", async () => {
    window.localStorage.setItem("lendaswap-v3:swap", "keep");
    window.localStorage.setItem("thence-recovery", "keep");
    window.localStorage.setItem("thence-diagX", "keep"); // prefix look-alike
    const store = webStorageStore("localStorage", () => window.localStorage);
    await store.set("run", RUN);
    expect(window.localStorage.getItem(`${DIAG_KEY_PREFIX}run`)).not.toBeNull();
    expect(await store.get("run")).toEqual(RUN);
    await store.clear();
    expect(window.localStorage.getItem(`${DIAG_KEY_PREFIX}run`)).toBeNull();
    expect(window.localStorage.getItem("lendaswap-v3:swap")).toBe("keep");
    expect(window.localStorage.getItem("thence-recovery")).toBe("keep");
    expect(window.localStorage.getItem("thence-diagX")).toBe("keep");
  });

  it("IndexedDB adapter opens only its own database", async () => {
    const opened: string[] = [];
    const factory = {
      open: (name: string) => {
        opened.push(name);
        const req: Record<string, unknown> = { error: new Error("stub") };
        queueMicrotask(() => (req["onerror"] as () => void)?.());
        return req;
      },
    } as unknown as IDBFactory;
    const store = indexedDbStore(() => factory);
    await expect(store.get("run")).rejects.toThrow();
    await expect(store.clear()).rejects.toThrow();
    expect(opened).toEqual([DIAG_IDB_NAME, DIAG_IDB_NAME]);
    expect(DIAG_IDB_NAME).not.toMatch(/lendaswap|recovery/);
  });

  it("diagnostic source: real recovery names only in the names-only constant; never opened, deleted or cleared", () => {
    const root = join(__dirname, "..");
    const strip = (rel: string) =>
      readFileSync(join(root, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const rel of [
      "src/ui/lib/storage-diagnostic.ts",
      "src/ui/screens/diagnostics/StorageDiagnostic.tsx",
      "src/ui/components/DiagnosticsLink.tsx",
      "src/lib/diagnostics.ts",
      "app/api/diagnostics/storage/route.ts",
    ]) {
      const code = strip(rel);
      expect(code, rel).not.toMatch(/recovery-vault|satora-browser|deleteDatabase|localStorage\.clear|sessionStorage\.clear/);
      expect(code, rel).not.toMatch(/preimage|satora|nimiq-pay|sendBasicTransaction|transfers/i);
      // The only IndexedDB open() anywhere is of the diagnostic's own database.
      for (const m of code.matchAll(/\.open\(([^,)]*)/g)) expect(m[1]!.trim(), rel).toBe("DIAG_IDB_NAME");
      if (rel !== "src/ui/lib/storage-diagnostic.ts") expect(code, rel).not.toMatch(/lendaswap|thence-recovery|\.databases\(/);
    }
    const lib = strip("src/ui/lib/storage-diagnostic.ts");
    expect(lib.match(/"lendaswap-v3"/g)).toHaveLength(1);
    expect(lib.match(/"thence-recovery"/g)).toHaveLength(1);
    expect(lib.match(/\.databases\(/g)).toHaveLength(1);
  });

  it("the names compared are exactly the real stores' names (SDK and vault sources)", () => {
    const root = join(__dirname, "..");
    const sdk = readFileSync(join(root, "node_modules/@lendasat/lendaswap-sdk-pure/dist/index.js"), "utf8");
    expect(sdk).toContain(`DB_NAME = "${REAL_RECOVERY_DBS.sdk}"`);
    expect(readFileSync(join(root, "src/ui/lib/recovery-vault.ts"), "utf8")).toContain(`const DB_NAME = "${REAL_RECOVERY_DBS.binding}"`);
    expect(readFileSync(join(root, "src/lib/diagnostics.ts"), "utf8")).toContain(`script: "${DIAG_SCRIPT_COOKIE}"`);
  });

  it("names-only lister: calls databases() and never open() or deleteDatabase() through a full test cycle", async () => {
    const open = vi.fn(() => {
      throw new Error("must not open");
    });
    const deleteDatabase = vi.fn(() => {
      throw new Error("must not delete");
    });
    const databases = vi.fn(async () => [{ name: REAL_RECOVERY_DBS.sdk, version: 1 }, { name: "unrelated-app-db", version: 3 }]);
    const factory = { open, deleteDatabase, databases } as unknown as IDBFactory;
    const lister = databaseNameLister(() => factory);
    const stores = [new MemStore("indexedDB"), new MemStore("localStorage"), new MemStore("sessionStorage")];
    const script = new FakeScriptCookie();
    const engine = new StorageDiagnosticEngine({ stores, server: new FakeServer(script), pageInstance: "p1", navigationType: "navigate", scriptCookie: script, listDatabaseNames: lister });
    await engine.start();
    await engine.check("visible");
    await engine.reset();
    expect(databases).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(await databaseNameLister(() => undefined)()).toBeNull();
    expect(await databaseNameLister(() => ({}) as IDBFactory)()).toBeNull();
    expect(await databaseNameLister(() => ({ databases: async () => Promise.reject(new Error("x")) }) as unknown as IDBFactory)()).toBeNull();
  });

  it("only the two real names' presence is kept — other database names never reach state or the report", async () => {
    expect(realDbPresence(["unrelated-app-db"])).toEqual({ available: true, sdk: false, binding: false });
    expect(realDbPresence(null)).toEqual({ available: false, sdk: null, binding: null });
    const { engine } = setup();
    await engine.start();
    const text = JSON.stringify(engine.getState()) + buildReport(engine.getState(), { build: "b", userAgent: "UA", page: "p1", navigation: "navigate" });
    expect(text).not.toContain("unrelated-app-db");
  });

  it("script cookie adapter writes only its own name and a run id", () => {
    const fake = { cookie: "", location: { protocol: "https:" } } as unknown as Document;
    const writes: string[] = [];
    Object.defineProperty(fake, "cookie", { get: () => "other=1; thence_diag_js=r-abcdef12", set: (v: string) => writes.push(v) });
    const c = documentScriptCookie(() => fake);
    expect(c.read()).toBe("r-abcdef12");
    c.write("r-abcdef12");
    c.write("bad value; Domain=evil");
    c.clear();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe("thence_diag_js=r-abcdef12; Path=/; Max-Age=2592000; SameSite=Lax; Secure");
    expect(writes[1]).toMatch(/^thence_diag_js=; Path=\/; Max-Age=0/);
  });
});

/* ---------------- v2: cookies, launch counter, real databases ---------------- */

describe("v2 — cookie variants", () => {
  it("all four variants PASS after start; they are informational and do not change the headline", async () => {
    const { engine, server } = setup();
    await engine.start();
    const lines = engine.getState().evaluation!.lines;
    for (const name of ["cookieSession", "cookieSameSiteNone", "cookieScript"]) expect(lines.find((l) => l.name === name)?.verdict, name).toBe("PASS");
    server.jar.session = null; // only the expiry-less cookie lost
    await engine.check("visible");
    const e = engine.getState().evaluation!;
    expect(e.lines.find((l) => l.name === "cookieSession")?.verdict).toBe("FAIL");
    expect(e.lines.find((l) => l.name === "diagCookie")?.verdict).toBe("PASS");
    expect(e.overall).toBe("PASS");
  });

  it("every cookie dropped (the 2026-11-05 pattern) while storage survives: all cookie lines FAIL, markers PASS", async () => {
    const { engine, server } = setup();
    await engine.start();
    server.dropAllCookies();
    await engine.check("visible");
    const e = engine.getState().evaluation!;
    const v = (n: string) => e.lines.find((l) => l.name === n)?.verdict;
    expect([v("diagCookie"), v("cookieSession"), v("cookieSameSiteNone"), v("cookieScript"), v("session")]).toEqual(["FAIL", "FAIL", "FAIL", "FAIL", "FAIL"]);
    expect([v("indexedDB"), v("localStorage")]).toEqual(["PASS", "PASS"]);
  });

  it("script cookie readable on the page but not sent to the server → FAIL with that reason", async () => {
    const { engine, server } = setup();
    await engine.start();
    const runId = engine.getState().run!.runId;
    const read = server.read.bind(server);
    server.read = async () => {
      const r = await read();
      return r.state === "ok" ? { ...r, cookies: { ...r.cookies, script: null } } : r;
    };
    await engine.check("visible");
    const line = engine.getState().evaluation!.lines.find((l) => l.name === "cookieScript")!;
    expect(line.verdict).toBe("FAIL");
    expect(line.detail).toMatch(/not sent/);
    expect(runId).toMatch(/^r-/);
  });

  it("server unreachable → variant lines UNKNOWN (script judged from the page)", async () => {
    const { engine, server } = setup();
    await engine.start();
    server.down = true;
    await engine.check("visible");
    const e = engine.getState().evaluation!;
    expect(e.lines.find((l) => l.name === "cookieSession")?.verdict).toBe("UNKNOWN");
    expect(e.lines.find((l) => l.name === "cookieScript")?.verdict).toBe("PASS");
  });
});

describe("v2 — launch counter", () => {
  it("reload keeps the browsing session (no relaunch); a new browsing session counts as a relaunch", async () => {
    const { engine, stores, make } = setup();
    await engine.start();
    const reload = make("p2");
    await reload.check("load");
    expect(reload.getState().launch).toMatchObject({ lost: false, relaunch: false, counter: { count: 2, relaunches: 0 } });
    stores.sessionStorage.wipe(); // mini app relaunched: new browsing session
    const relaunch = make("p3");
    await relaunch.check("load");
    expect(relaunch.getState().launch).toMatchObject({ lost: false, relaunch: true, counter: { count: 3, relaunches: 1 } });
    expect(relaunch.getState().history.at(-1)!.launch).toEqual({ n: 3, relaunch: true });
    expect(relaunch.getState().evaluation!.lines.find((l) => l.name === "launchCounter")?.verdict).toBe("PASS");
  });

  it("counted once per page load, not per visibility check", async () => {
    const { engine, make } = setup();
    await engine.start();
    const page = make("p2");
    await page.check("load");
    await page.check("visible");
    await page.check("focus");
    expect(page.getState().launch!.counter!.count).toBe(2);
  });

  it("relaunch while signed out (cookies gone) is still counted and persisted", async () => {
    const { engine, stores, server, make } = setup();
    await engine.start();
    server.dropAllCookies();
    stores.sessionStorage.wipe();
    const page = make("p2");
    await page.check("load");
    expect(page.getState().launch).toMatchObject({ relaunch: true, counter: { count: 2, relaunches: 1 } });
    const next = make("p3");
    stores.sessionStorage.wipe();
    await next.check("load");
    expect(next.getState().launch!.counter!.count).toBe(3);
  });

  it("counter lost while the run marker survived → FAIL (not silently restarted)", async () => {
    const { engine, stores, make } = setup();
    await engine.start();
    stores.indexedDB.data.delete("launches");
    stores.localStorage.data.delete("launches");
    const page = make("p2");
    await page.check("load");
    expect(page.getState().evaluation!.lines.find((l) => l.name === "launchCounter")?.verdict).toBe("FAIL");
  });

  it("no run on the device → nothing counted, nothing written", async () => {
    const { engine, stores } = setup();
    await engine.check("load");
    expect(engine.getState().launch).toBeNull();
    expect(stores.localStorage.data.has("launches")).toBe(false);
  });
});

describe("v2 — real recovery databases (names only)", () => {
  const real = (e: ReturnType<typeof evaluate>) => e.realDbLines.map((l) => l.verdict);

  it("present at start and now → PASS, with the 'name only, contents not checked' caveat", async () => {
    const { engine } = setup();
    await engine.start();
    const e = engine.getState().evaluation!;
    expect(real(e)).toEqual(["PASS", "PASS"]);
    expect(e.realDbsOverall).toBe("PASS");
    expect(e.realDbLines[0]!.detail).toMatch(/Name only: it was not opened, so this does not show that its claim data survived/);
  });

  it("present at start, gone later → FAIL", async () => {
    const { engine, dbs } = setup();
    await engine.start();
    dbs.names = [REAL_RECOVERY_DBS.binding];
    await engine.check("visible");
    expect(real(engine.getState().evaluation!)).toEqual(["FAIL", "PASS"]);
  });

  it("never on this device → UNKNOWN (absence before the test proves nothing)", async () => {
    const { engine, dbs } = setup();
    dbs.names = ["unrelated-app-db"];
    await engine.start();
    expect(real(engine.getState().evaluation!)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });

  it("enumeration unavailable → UNKNOWN, never PASS", async () => {
    const { engine, dbs } = setup();
    dbs.names = null;
    await engine.start();
    const e = engine.getState().evaluation!;
    expect(real(e)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(e.realDbLines[0]!.detail).toMatch(/cannot list/);
  });

  it("real-database verdict is separate from the storage headline", async () => {
    const { engine, dbs } = setup();
    await engine.start();
    dbs.names = [];
    await engine.check("visible");
    const e = engine.getState().evaluation!;
    expect(e.realDbsOverall).toBe("FAIL");
    expect(e.overall).toBe("PASS");
    expect(engine.getState().history.at(-1)!.realDbs).toBe("FAIL");
  });
});

/* ---------------- screen ---------------- */

import { StorageDiagnostic } from "@/ui/screens/diagnostics/StorageDiagnostic";
import { DiagnosticsLink } from "@/ui/components/DiagnosticsLink";

afterEach(() => cleanup());

async function renderScreen(props: { ownerAtRender: boolean }, s = setup()) {
  render(
    <StorageDiagnostic
      ownerAtRender={props.ownerAtRender}
      stores={Object.values(s.stores)}
      server={s.server}
      scriptCookie={s.script}
      listDatabaseNames={s.lister}
      pageInstance="p1"
      navigation="navigate"
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return s;
}

describe("StorageDiagnostic screen", () => {
  it("owner: Start test shows a PASS result for every line", async () => {
    await renderScreen({ ownerAtRender: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start test" }));
    });
    const now = within(await screen.findByRole("region", { name: "Result now" }));
    expect(await now.findByText("Same login session as at the start.")).toBeTruthy();
    expect(now.getAllByText("PASS")).toHaveLength(10); // overall + 9 lines (markers, 4 cookies, session, launch)
    expect(screen.getByText("Owner diagnostic · no money")).toBeTruthy();
  });

  it("returning to the app (visibilitychange → visible) re-checks and records the scenario", async () => {
    const s = await renderScreen({ ownerAtRender: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start test" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Quick app switch/ }));
    });
    s.stores.indexedDB.wipe();
    s.server.calls = [];
    await new Promise((r) => setTimeout(r, 1600)); // past the check throttle
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(s.server.calls).toContain("GET");
    const now = within(screen.getByRole("region", { name: "Result now" }));
    expect(await now.findByText("Marker missing — this storage was cleared.")).toBeTruthy();
    const history = within(screen.getByRole("region", { name: "History" }));
    expect(history.getByText(/visible · load #1 · visibility/)).toBeTruthy();
  });

  it("signed out with no markers on this device → Not available, nothing started", async () => {
    const s = setup();
    s.server.signedIn = false;
    await renderScreen({ ownerAtRender: false }, s);
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start test" })).toBeNull();
  });

  it("signed out but an owner run is on this device → results show the lost session", async () => {
    const s = setup();
    await s.engine.start();
    s.server.signedIn = false;
    await renderScreen({ ownerAtRender: false }, s);
    const now = within(await screen.findByRole("region", { name: "Result now" }));
    expect(await now.findByText(/Signed out — the login cookie was not sent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a new test" })).toBeTruthy();
  });

  it("signed in as a non-owner → Not available", async () => {
    const s = setup();
    s.server.owner = false;
    await renderScreen({ ownerAtRender: true }, s);
    expect(await screen.findByText("Not available")).toBeTruthy();
  });
});

describe("DiagnosticsLink", () => {
  it("shows only when the server confirms an owner (200)", async () => {
    const owner = vi.fn(async () => new Response("{}", { status: 200 }));
    render(<DiagnosticsLink doFetch={owner as unknown as typeof fetch} />);
    expect(await screen.findByRole("link", { name: /Storage diagnostic/ })).toBeTruthy();
  });

  it("renders nothing for a non-owner (404) or signed-out user (401)", async () => {
    for (const status of [404, 401]) {
      const f = vi.fn(async () => new Response("{}", { status }));
      const { container } = render(<DiagnosticsLink doFetch={f as unknown as typeof fetch} />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(f).toHaveBeenCalled();
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });
});
