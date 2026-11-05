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
  SCENARIOS,
  StorageDiagnosticEngine,
  buildReport,
  evaluate,
  indexedDbStore,
  webStorageStore,
  type DiagRun,
  type KvStore,
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

class FakeServer implements ServerApi {
  cookie: string | null = null;
  signedIn = true;
  owner = true;
  down = false;
  tag = "aaaaaaaaaaaa";
  calls: string[] = [];
  private result(): ServerRead {
    if (this.down) return { state: "error", message: "TypeError" };
    if (!this.signedIn) return { state: "unauthenticated", diagRunId: this.cookie };
    if (!this.owner) return { state: "not-owner" };
    return { state: "ok", tag: this.tag, createdAt: "2026-11-05T10:00:00.000Z", diagRunId: this.cookie };
  }
  async read() {
    this.calls.push("GET");
    return this.result();
  }
  async setCookie(runId: string) {
    this.calls.push("POST");
    if (this.signedIn && this.owner && !this.down) this.cookie = runId;
    return this.result();
  }
  async clearCookie() {
    this.calls.push("DELETE");
    this.cookie = null;
  }
}

function setup(opts: { page?: string } = {}) {
  const stores = { indexedDB: new MemStore("indexedDB"), localStorage: new MemStore("localStorage"), sessionStorage: new MemStore("sessionStorage") };
  const server = new FakeServer();
  let n = 0;
  const make = (page: string) =>
    new StorageDiagnosticEngine({
      stores: Object.values(stores),
      server,
      pageInstance: page,
      navigationType: "navigate",
      randomId: () => `r-test-run-${++n}`,
      now: () => new Date(Date.UTC(2026, 10, 5, 12, 0, n)),
    });
  return { stores, server, engine: make(opts.page ?? "p1"), make };
}

const RUN: DiagRun = { runId: "r-run-1", startedAt: "2026-11-05T12:00:00.000Z", sessionTag: "aaaaaaaaaaaa" };
const ok = (run: DiagRun | null) => ({ state: "ok" as const, run });
const SERVER_OK: ServerRead = { state: "ok", tag: "aaaaaaaaaaaa", createdAt: null, diagRunId: "r-run-1" };

/* ---------------- verdicts ---------------- */

describe("evaluate — PASS / FAIL / UNKNOWN", () => {
  const all = { indexedDB: ok(RUN), localStorage: ok(RUN), sessionStorage: ok(RUN) };
  const v = (e: ReturnType<typeof evaluate>, name: string) => e.lines.find((l) => l.name === name)?.verdict;

  it("everything survived → PASS", () => {
    const e = evaluate(RUN, all, SERVER_OK);
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

  it("diagnostic source never references recovery stores, deletes databases or enumerates them", () => {
    const root = join(__dirname, "..");
    for (const rel of [
      "src/ui/lib/storage-diagnostic.ts",
      "src/ui/screens/diagnostics/StorageDiagnostic.tsx",
      "src/ui/components/DiagnosticsLink.tsx",
      "src/lib/diagnostics.ts",
      "app/api/diagnostics/storage/route.ts",
    ]) {
      const code = readFileSync(join(root, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, rel).not.toMatch(/lendaswap|thence-recovery|recovery-vault|deleteDatabase|indexedDB\.databases|localStorage\.clear|sessionStorage\.clear/);
      expect(code, rel).not.toMatch(/preimage|satora|nimiq-pay|sendBasicTransaction|transfers/i);
    }
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
    expect(now.getAllByText("PASS")).toHaveLength(6); // overall + 5 lines
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
    expect(history.getByText(/visible · visibility/)).toBeTruthy();
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
