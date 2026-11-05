/**
 * iOS WebView storage diagnostic — client engine (no money, owner only).
 *
 * Writes a random, non-sensitive run marker to Thence's OWN diagnostic
 * namespace and later checks what survived app switches, locking, reloads
 * and process kills inside Nimiq Pay:
 *
 *   IndexedDB  database "thence-diag-v1" (store "kv") — same origin, same
 *              storage policy as the claim vault, but a separate database.
 *   localStorage / sessionStorage keys prefixed "thence-diag:v1:".
 *   Cookie     `thence_diag`, set by the server with the session cookie's
 *              attributes (HttpOnly — the page never reads it directly).
 *   Session    the real login, checked server-side (authenticated + tag).
 *
 * v2 adds: cookie persistence variants (persistent / session-lifetime /
 * SameSite=None / script-written), a persistent launch counter that marks
 * relaunches (new browsing session) apart from reloads, and a NAMES-ONLY
 * check that the real recovery databases still exist.
 *
 * SAFETY: this module never opens, reads, writes or deletes the payment
 * recovery stores. For the real databases it only calls
 * `indexedDB.databases()` and compares the returned NAMES with
 * REAL_RECOVERY_DBS; no other name is kept. Existence is not proof that
 * the claim secrets inside survived. It holds no NIM, swap, preimage or token data, and
 * `reset` removes only its own namespace. tests/ui-storage-diagnostic
 * pins this.
 */

export const DIAG_KEY_PREFIX = "thence-diag:v1:";
export const DIAG_IDB_NAME = "thence-diag-v1";
export const DIAG_IDB_STORE = "kv";
export const DIAG_API = "/api/diagnostics/storage";
/** Must equal DIAG_COOKIES.script in src/lib/diagnostics.ts (pinned by a test). */
export const DIAG_SCRIPT_COOKIE = "thence_diag_js";
/**
 * The real recovery databases, compared BY NAME ONLY. Must equal the names in
 * src/ui/lib/recovery-vault.ts and the Satora SDK (pinned by a test).
 */
export const REAL_RECOVERY_DBS = { sdk: "lendaswap-v3", binding: "thence-recovery" } as const;
export type RealDbKey = keyof typeof REAL_RECOVERY_DBS;
export type CookieVariant = "persistent" | "session" | "sameSiteNone" | "script";
export const COOKIE_VARIANTS: readonly CookieVariant[] = ["persistent", "session", "sameSiteNone", "script"];

/** Names-only presence of the real databases (null when enumeration is unavailable). */
export interface RealDbPresence {
  available: boolean;
  sdk: boolean | null;
  binding: boolean | null;
}

export interface LaunchCounter {
  runId: string;
  count: number;
  relaunches: number;
  lastAt: string;
}

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type StoreName = "indexedDB" | "localStorage" | "sessionStorage";

export interface DiagRun {
  runId: string;
  startedAt: string;
  /** Server session tag at start (null when the server was unreachable). */
  sessionTag: string | null;
  /** v2: names-only presence of the real recovery databases at start. */
  realDbsAtStart?: RealDbPresence | null;
}

export interface DiagEvent {
  at: string;
  type: string;
  detail?: string;
  page: string;
}

export interface CheckRecord {
  at: string;
  trigger: string;
  scenario: string | null;
  page: string;
  navigation: string;
  runId: string | null;
  results: Partial<Record<CheckName, Verdict>>;
  overall: Verdict;
  /** v2: launch number and whether this load began a new browsing session. */
  launch?: { n: number; relaunch: boolean } | null;
  /** v2: names-only verdict for the real recovery databases. */
  realDbs?: Verdict;
}

/** Minimal async key/value store (diagnostic namespace only). */
export interface KvStore {
  readonly name: StoreName;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** Remove only this module's own keys/records. */
  clear(): Promise<void>;
}

export type StoreRead = { state: "ok"; run: DiagRun | null } | { state: "error"; message: string };

export type CookieEcho = Partial<Record<CookieVariant, string | null>>;

export type ServerRead =
  | { state: "ok"; tag: string; createdAt: string | null; diagRunId: string | null; cookies?: CookieEcho }
  | { state: "unauthenticated"; diagRunId: string | null; cookies?: CookieEcho }
  | { state: "not-owner" }
  | { state: "error"; message: string };

export type CheckName =
  | "indexedDB"
  | "localStorage"
  | "diagCookie"
  | "session"
  | "sessionStorage"
  | "cookieSession"
  | "cookieSameSiteNone"
  | "cookieScript"
  | "launchCounter"
  | "realSdkDb"
  | "realBindingDb";

export interface CheckLine {
  name: CheckName;
  label: string;
  verdict: Verdict;
  detail: string;
  /** Counted in the overall verdict (sessionStorage is informational). */
  counted: boolean;
}

export interface Evaluation {
  expected: DiagRun | null;
  /** Diagnostic markers, cookies, session and launch counter. */
  lines: CheckLine[];
  overall: Verdict;
  /** v2: real recovery databases, names only — reported separately. */
  realDbLines: CheckLine[];
  realDbsOverall: Verdict;
}

export interface EvaluateExtras {
  /** Names-only presence now (null = probe not run / unavailable). */
  realNow?: RealDbPresence | null;
  /** The script cookie as the page itself reads it (null when absent). */
  scriptLocal?: string | null;
  /** Launch counter as of this page load (null when not recorded). */
  launch?: { counter: LaunchCounter | null; lost: boolean } | null;
}

const LABELS: Record<CheckName, string> = {
  indexedDB: "IndexedDB marker (same storage as the claim vault)",
  localStorage: "localStorage marker",
  diagCookie: "Diagnostic cookie (same settings as the login cookie)",
  session: "Server login session",
  sessionStorage: "sessionStorage marker (informational)",
  cookieSession: "Cookie without expiry (browser-session lifetime)",
  cookieSameSiteNone: "Cookie with SameSite=None",
  cookieScript: "Cookie written by page script",
  launchCounter: "Launch counter (relaunch vs reload)",
  realSdkDb: "Real swap SDK claim database exists (lendaswap-v3, name only)",
  realBindingDb: "Real Thence recovery database exists (thence-recovery, name only)",
};

export function isDiagRun(value: unknown): value is DiagRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["runId"] === "string" &&
    typeof v["startedAt"] === "string" &&
    (v["sessionTag"] === null || typeof v["sessionTag"] === "string")
  );
}

export function isLaunchCounter(value: unknown): value is LaunchCounter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["runId"] === "string" && Number.isInteger(v["count"]) && Number.isInteger(v["relaunches"]) && typeof v["lastAt"] === "string";
}

/** Keep ONLY the two real names' presence; every other database name is discarded. */
export function realDbPresence(names: readonly string[] | null): RealDbPresence {
  if (names === null) return { available: false, sdk: null, binding: null };
  return { available: true, sdk: names.includes(REAL_RECOVERY_DBS.sdk), binding: names.includes(REAL_RECOVERY_DBS.binding) };
}

/** Newest run among memory and the surviving stores. */
export function expectedRun(memory: DiagRun | null, reads: Partial<Record<StoreName, StoreRead>>): DiagRun | null {
  const found: DiagRun[] = memory ? [memory] : [];
  for (const r of Object.values(reads)) if (r && r.state === "ok" && r.run) found.push(r.run);
  if (found.length === 0) return null;
  return found.reduce((a, b) => (Date.parse(b.startedAt) > Date.parse(a.startedAt) ? b : a));
}

function storeLine(name: StoreName, read: StoreRead | undefined, expected: DiagRun | null): CheckLine {
  const counted = name !== "sessionStorage";
  const base = { name, label: LABELS[name], counted } as const;
  if (!read) return { ...base, verdict: "UNKNOWN", detail: "Not available in this browser." };
  if (read.state === "error") return { ...base, verdict: "UNKNOWN", detail: `Could not read: ${read.message}` };
  if (!expected) return { ...base, verdict: "UNKNOWN", detail: "No test started on this device yet (or every marker is gone)." };
  if (read.run?.runId === expected.runId) return { ...base, verdict: "PASS", detail: "Marker survived." };
  const detail = read.run ? "A different, older marker was found." : "Marker missing — this storage was cleared.";
  return {
    ...base,
    verdict: "FAIL",
    detail: name === "sessionStorage" ? `${detail} Normal after the app or page was closed.` : detail,
  };
}

function cookieLine(server: ServerRead, expected: DiagRun | null): CheckLine {
  const base = { name: "diagCookie", label: LABELS.diagCookie, counted: true } as const;
  if (server.state === "error") return { ...base, verdict: "UNKNOWN", detail: `Server unreachable: ${server.message}` };
  if (server.state === "not-owner") return { ...base, verdict: "UNKNOWN", detail: "Signed in with a wallet that cannot run diagnostics." };
  if (!expected) return { ...base, verdict: "UNKNOWN", detail: "No test started on this device yet." };
  if (server.diagRunId === expected.runId) return { ...base, verdict: "PASS", detail: "Cookie was sent to the server." };
  return {
    ...base,
    verdict: "FAIL",
    detail: server.diagRunId ? "A different, older cookie was sent." : "Cookie missing — the webview dropped it.",
  };
}

function sessionLine(server: ServerRead, expected: DiagRun | null): CheckLine {
  const base = { name: "session", label: LABELS.session, counted: true } as const;
  if (server.state === "error") return { ...base, verdict: "UNKNOWN", detail: `Server unreachable: ${server.message}` };
  if (server.state === "not-owner") return { ...base, verdict: "UNKNOWN", detail: "Signed in with a wallet that cannot run diagnostics." };
  if (server.state === "unauthenticated") {
    return { ...base, verdict: "FAIL", detail: "Signed out — the login cookie was not sent (or the session expired)." };
  }
  if (expected?.sessionTag && expected.sessionTag !== server.tag) {
    return { ...base, verdict: "FAIL", detail: "Signed in again — the session from the start of the test was lost." };
  }
  return {
    ...base,
    verdict: "PASS",
    detail: expected?.sessionTag ? "Same login session as at the start." : "Signed in (no start-of-test session to compare).",
  };
}

export function overallOf(lines: CheckLine[]): Verdict {
  const counted = lines.filter((l) => l.counted);
  if (counted.some((l) => l.verdict === "FAIL")) return "FAIL";
  if (counted.some((l) => l.verdict === "UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

const VARIANT_LINE: Record<Exclude<CookieVariant, "persistent">, CheckName> = {
  session: "cookieSession",
  sameSiteNone: "cookieSameSiteNone",
  script: "cookieScript",
};

/** v2 cookie variants: informational comparison against the primary cookie. */
function variantLine(variant: Exclude<CookieVariant, "persistent">, server: ServerRead, expected: DiagRun | null, scriptLocal: string | null): CheckLine {
  const name = VARIANT_LINE[variant];
  const base = { name, label: LABELS[name], counted: false } as const;
  const sent = server.state === "ok" || server.state === "unauthenticated" ? (server.cookies?.[variant] ?? null) : null;
  if (!expected) return { ...base, verdict: "UNKNOWN", detail: "No test started on this device yet." };
  if (server.state === "error" || server.state === "not-owner") {
    if (variant === "script" && scriptLocal !== null) {
      return scriptLocal === expected.runId
        ? { ...base, verdict: "PASS", detail: "Present on the page (server unreachable)." }
        : { ...base, verdict: "FAIL", detail: "A different, older cookie is on the page." };
    }
    return { ...base, verdict: "UNKNOWN", detail: "Server unreachable." };
  }
  if (server.cookies === undefined) return { ...base, verdict: "UNKNOWN", detail: "Server did not report cookie variants." };
  if (variant === "script" && scriptLocal === expected.runId && sent !== expected.runId) {
    return { ...base, verdict: "FAIL", detail: "Readable on the page but not sent to the server." };
  }
  if (sent === expected.runId) return { ...base, verdict: "PASS", detail: "Kept and sent." };
  return { ...base, verdict: "FAIL", detail: sent ? "A different, older cookie was sent." : "Missing — the webview dropped it." };
}

function launchLine(expected: DiagRun | null, launch: EvaluateExtras["launch"]): CheckLine {
  const base = { name: "launchCounter", label: LABELS.launchCounter, counted: false } as const;
  if (!expected) return { ...base, verdict: "UNKNOWN", detail: "No test started on this device yet." };
  if (!launch || !launch.counter) return { ...base, verdict: "UNKNOWN", detail: "Not recorded on this page load." };
  const c = launch.counter;
  const summary = `Load #${c.count} since the test started; ${c.relaunches} relaunch${c.relaunches === 1 ? "" : "es"} (new browsing session).`;
  if (launch.lost) return { ...base, verdict: "FAIL", detail: `The counter was lost and restarted. ${summary}` };
  return { ...base, verdict: "PASS", detail: summary };
}

function realDbLine(key: RealDbKey, atStart: RealDbPresence | null | undefined, now: RealDbPresence | null | undefined): CheckLine {
  const name: CheckName = key === "sdk" ? "realSdkDb" : "realBindingDb";
  const base = { name, label: LABELS[name], counted: true } as const;
  const caveat = "Name only: it was not opened, so this does not show that its claim data survived.";
  if (!now || !now.available) return { ...base, verdict: "UNKNOWN", detail: "This browser cannot list database names." };
  const present = now[key];
  const before = atStart && atStart.available ? atStart[key] : null;
  if (present) return { ...base, verdict: "PASS", detail: `Present. ${caveat}` };
  if (before === true) return { ...base, verdict: "FAIL", detail: "Present when the test started, gone now." };
  return { ...base, verdict: "UNKNOWN", detail: "Not on this device (never created here, or cleared before the test started)." };
}

export function evaluate(
  memory: DiagRun | null,
  reads: Partial<Record<StoreName, StoreRead>>,
  server: ServerRead,
  extras: EvaluateExtras = {},
): Evaluation {
  const expected = expectedRun(memory, reads);
  const scriptLocal = extras.scriptLocal ?? null;
  const lines: CheckLine[] = [
    storeLine("indexedDB", reads.indexedDB, expected),
    storeLine("localStorage", reads.localStorage, expected),
    cookieLine(server, expected),
    sessionLine(server, expected),
    storeLine("sessionStorage", reads.sessionStorage, expected),
    variantLine("session", server, expected, scriptLocal),
    variantLine("sameSiteNone", server, expected, scriptLocal),
    variantLine("script", server, expected, scriptLocal),
    launchLine(expected, extras.launch ?? null),
  ];
  const realDbLines = [realDbLine("sdk", expected?.realDbsAtStart, extras.realNow), realDbLine("binding", expected?.realDbsAtStart, extras.realNow)];
  return { expected, lines, overall: overallOf(lines), realDbLines, realDbsOverall: overallOf(realDbLines) };
}

/* ------------------------------------------------------------------ */
/* scenarios (iPhone guide)                                             */
/* ------------------------------------------------------------------ */

export interface Scenario {
  id: string;
  title: string;
  steps: string;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: "baseline", title: "1. Baseline", steps: "Tap Start test. Every line should read PASS." },
  { id: "reload", title: "2. Reload", steps: "Tap Reload page. Results appear again after the reload." },
  { id: "visibility", title: "3. Quick app switch", steps: "Switch to another app for about 30 seconds, then come back." },
  { id: "lock", title: "4. Lock the phone", steps: "Lock the iPhone for 2 minutes, unlock, return to Nimiq Pay." },
  { id: "background-long", title: "5. Long background", steps: "Leave Nimiq Pay in the background for 15–30 minutes (about half a claim window)." },
  { id: "close-miniapp", title: "6. Close and reopen Thence", steps: "Close Thence inside Nimiq Pay, open it again, go to Wallet → Storage diagnostic." },
  { id: "swipe-away", title: "7. Force-quit Nimiq Pay", steps: "Swipe Nimiq Pay away in the app switcher, reopen it, open Thence, go back to this page." },
  { id: "memory", title: "8. Memory pressure", steps: "Open the camera and several heavy apps or games for 5 minutes, then return." },
];

/* ------------------------------------------------------------------ */
/* engine                                                               */
/* ------------------------------------------------------------------ */

export interface ServerApi {
  read(): Promise<ServerRead>;
  setCookie(runId: string): Promise<ServerRead>;
  clearCookie(): Promise<void>;
}

export interface EngineDeps {
  stores: KvStore[];
  server: ServerApi;
  now?: () => Date;
  randomId?: () => string;
  /** Random per page load; a change between checks means the page reloaded. */
  pageInstance: string;
  navigationType: string;
  /** v2: script-written cookie (not HttpOnly; carries only the run id). */
  scriptCookie?: ScriptCookie | undefined;
  /** v2: database NAMES (null when enumeration is unavailable). Never opens anything. */
  listDatabaseNames?: (() => Promise<string[] | null>) | undefined;
}

export interface ScriptCookie {
  read(): string | null;
  write(runId: string): void;
  clear(): void;
}

export interface EngineState {
  run: DiagRun | null;
  scenario: string | null;
  evaluation: Evaluation | null;
  history: CheckRecord[];
  events: DiagEvent[];
  busy: boolean;
  notOwner: boolean;
  lastCheckedAt: string | null;
  /** Why Start could not begin (signed out, server unreachable). */
  startError: string | null;
  /** v2: launch counter as of this page load. */
  launch: { counter: LaunchCounter | null; lost: boolean; relaunch: boolean } | null;
}

const MAX_EVENTS = 80;
const MAX_HISTORY = 40;

export function newRunId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `r-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export class StorageDiagnosticEngine {
  private state: EngineState = {
    run: null,
    scenario: null,
    evaluation: null,
    history: [],
    events: [],
    busy: false,
    notOwner: false,
    lastCheckedAt: null,
    startError: null,
    launch: null,
  };
  private launchRecorded = false;
  private listeners = new Set<() => void>();
  private checking: Promise<void> | null = null;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  /** Persist logs only for a confirmed owner or an existing run on this device. */
  private ownerSeen = false;
  private get mayPersist(): boolean {
    return this.ownerSeen || this.state.run !== null;
  }

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.randomId = deps.randomId ?? newRunId;
  }

  getState = (): EngineState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private async readAll(key: string): Promise<Map<StoreName, { ok: true; value: unknown } | { ok: false; message: string }>> {
    const out = new Map<StoreName, { ok: true; value: unknown } | { ok: false; message: string }>();
    await Promise.all(
      this.deps.stores.map(async (s) => {
        try {
          out.set(s.name, { ok: true, value: await s.get(key) });
        } catch (err) {
          out.set(s.name, { ok: false, message: err instanceof Error ? err.name || "error" : "error" });
        }
      }),
    );
    return out;
  }

  private async writeAll(key: string, value: unknown): Promise<void> {
    await Promise.all(
      this.deps.stores.map(async (s) => {
        try {
          await s.set(key, value);
        } catch {
          /* a failing store shows up as UNKNOWN/FAIL on the next check */
        }
      }),
    );
  }

  /** First list found among stores (IndexedDB preferred), for logs/history. */
  private async readList<T>(key: string): Promise<T[]> {
    const all = await this.readAll(key);
    for (const name of ["indexedDB", "localStorage", "sessionStorage"] as const) {
      const r = all.get(name);
      if (r?.ok && Array.isArray(r.value)) return r.value as T[];
    }
    return [];
  }

  private async probeRealDbs(): Promise<RealDbPresence | null> {
    if (!this.deps.listDatabaseNames) return null;
    try {
      return realDbPresence(await this.deps.listDatabaseNames());
    } catch {
      return realDbPresence(null);
    }
  }

  private readScriptCookie(): string | null {
    try {
      return this.deps.scriptCookie?.read() ?? null;
    } catch {
      return null;
    }
  }

  private sessionStore(): KvStore | undefined {
    return this.deps.stores.find((s) => s.name === "sessionStorage");
  }

  /**
   * Count this page load once. A load without the sessionStorage "alive"
   * marker began a new browsing session (relaunch); with it, a reload.
   * Runs only when an owner run already exists on this device.
   */
  private async recordLaunch(expected: DiagRun | null): Promise<void> {
    if (this.launchRecorded || !expected) return;
    this.launchRecorded = true;
    const stored = await this.readAll("launches");
    let prior: LaunchCounter | null = null;
    for (const name of ["indexedDB", "localStorage"] as const) {
      const r = stored.get(name);
      if (r?.ok && isLaunchCounter(r.value) && r.value.runId === expected.runId) {
        if (!prior || r.value.count > prior.count) prior = r.value;
      }
    }
    let alive = false;
    try {
      alive = (await this.sessionStore()?.get("alive")) === true;
    } catch {
      alive = false;
    }
    const at = this.now().toISOString();
    const relaunch = !alive;
    const counter: LaunchCounter = prior
      ? { runId: expected.runId, count: prior.count + 1, relaunches: prior.relaunches + (relaunch ? 1 : 0), lastAt: at }
      : { runId: expected.runId, count: 1, relaunches: 0, lastAt: at };
    this.set({ launch: { counter, lost: prior === null, relaunch } });
    // Only reached when an owner run already exists on this device (expected),
    // including while signed out — the case being measured.
    await this.writeAll("launches", counter);
    try {
      await this.sessionStore()?.set("alive", true);
    } catch {
      /* reported through the sessionStorage line */
    }
    await this.logEvent(relaunch ? "relaunch" : "reload", `#${counter.count}`);
  }

  /** Restore the scenario, log and history from whatever survived. */
  async load(): Promise<void> {
    const [events, history, scen] = await Promise.all([
      this.readList<DiagEvent>("events"),
      this.readList<CheckRecord>("history"),
      this.readAll("scenario"),
    ]);
    let scenario: string | null = null;
    for (const name of ["indexedDB", "localStorage", "sessionStorage"] as const) {
      const r = scen.get(name);
      if (r?.ok && typeof r.value === "string") {
        scenario = r.value;
        break;
      }
    }
    this.set({ events, history, scenario });
  }

  async logEvent(type: string, detail?: string): Promise<void> {
    const ev: DiagEvent = { at: this.now().toISOString(), type, page: this.deps.pageInstance, ...(detail ? { detail } : {}) };
    const events = [...this.state.events, ev].slice(-MAX_EVENTS);
    this.set({ events });
    if (this.mayPersist) await this.writeAll("events", events);
  }

  async setScenario(id: string | null): Promise<void> {
    this.set({ scenario: id });
    if (this.mayPersist) await this.writeAll("scenario", id);
    await this.logEvent("scenario", id ?? "none");
  }

  async start(): Promise<void> {
    this.set({ busy: true, startError: null });
    try {
      const runId = this.randomId();
      // Script cookie first so the POST below already carries it.
      try {
        this.deps.scriptCookie?.write(runId);
      } catch {
        /* reported as FAIL/UNKNOWN on the next check */
      }
      const realDbsAtStart = await this.probeRealDbs();
      const server = await this.deps.server.setCookie(runId);
      if (server.state === "not-owner") {
        this.set({ notOwner: true });
        return;
      }
      if (server.state !== "ok") {
        this.set({
          startError:
            server.state === "unauthenticated"
              ? "You are signed out. Open Thence, sign in, then come back here."
              : "The server could not be reached. Try again.",
        });
        return;
      }
      this.ownerSeen = true;
      const run: DiagRun = {
        runId,
        startedAt: this.now().toISOString(),
        sessionTag: server.state === "ok" ? server.tag : null,
        realDbsAtStart,
      };
      const counter: LaunchCounter = { runId, count: 1, relaunches: 0, lastAt: run.startedAt };
      this.launchRecorded = true;
      this.set({ run, history: [], startError: null, launch: { counter, lost: false, relaunch: false } });
      await this.writeAll("run", run);
      await this.writeAll("history", []);
      await this.writeAll("launches", counter);
      try {
        await this.sessionStore()?.set("alive", true);
      } catch {
        /* reported through the sessionStorage line */
      }
      await this.logEvent("start", runId);
    } finally {
      this.set({ busy: false });
    }
    await this.check("start");
  }

  /** Re-read every store and the server; serialised (one check at a time). */
  check(trigger: string): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.runCheck(trigger).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(trigger: string): Promise<void> {
    const runs = await this.readAll("run");
    const reads: Partial<Record<StoreName, StoreRead>> = {};
    for (const s of this.deps.stores) {
      const r = runs.get(s.name);
      if (!r) continue;
      reads[s.name] = r.ok ? { state: "ok", run: isDiagRun(r.value) ? r.value : null } : { state: "error", message: r.message };
    }
    const server = await this.deps.server.read();
    if (server.state === "not-owner") {
      this.set({ notOwner: true });
      return;
    }
    if (server.state === "ok") this.ownerSeen = true;
    await this.recordLaunch(expectedRun(this.state.run, reads));
    const realNow = await this.probeRealDbs();
    const evaluation = evaluate(this.state.run, reads, server, {
      realNow,
      scriptLocal: this.readScriptCookie(),
      launch: this.state.launch,
    });
    const at = this.now().toISOString();
    const results = Object.fromEntries(evaluation.lines.map((l) => [l.name, l.verdict])) as Record<CheckName, Verdict>;
    const record: CheckRecord = {
      at,
      trigger,
      scenario: this.state.scenario,
      page: this.deps.pageInstance,
      navigation: this.deps.navigationType,
      runId: evaluation.expected?.runId ?? null,
      results,
      overall: evaluation.overall,
      launch: this.state.launch?.counter ? { n: this.state.launch.counter.count, relaunch: this.state.launch.relaunch } : null,
      realDbs: evaluation.realDbsOverall,
    };
    const history = [...this.state.history, record].slice(-MAX_HISTORY);
    // Adopt the surviving run in memory so later checks compare against it.
    this.set({ evaluation, history, run: evaluation.expected, lastCheckedAt: at });
    if (this.mayPersist) await this.writeAll("history", history);
  }

  /** Remove ONLY the diagnostic namespace and cookie. */
  async reset(): Promise<void> {
    this.set({ busy: true });
    try {
      await Promise.all(this.deps.stores.map((s) => s.clear().catch(() => undefined)));
      await this.deps.server.clearCookie().catch(() => undefined);
      try {
        this.deps.scriptCookie?.clear();
      } catch {
        /* best effort */
      }
      this.set({ run: null, scenario: null, evaluation: null, history: [], events: [], lastCheckedAt: null, launch: null });
    } finally {
      this.set({ busy: false });
    }
  }
}

/* ------------------------------------------------------------------ */
/* report                                                               */
/* ------------------------------------------------------------------ */

export function buildReport(state: EngineState, meta: { build: string; userAgent: string; page: string; navigation: string }): string {
  const lines: string[] = [
    "Thence iOS storage diagnostic",
    `build ${meta.build} · page ${meta.page} (${meta.navigation})`,
    `agent ${meta.userAgent}`,
    `run ${state.run?.runId ?? "none"} started ${state.run?.startedAt ?? "-"}`,
    "",
  ];
  if (state.evaluation) {
    lines.push(`NOW: ${state.evaluation.overall}`);
    for (const l of state.evaluation.lines) lines.push(`  ${l.verdict.padEnd(7)} ${l.name} — ${l.detail}`);
    lines.push(`REAL RECOVERY DATABASES (names only, contents not checked): ${state.evaluation.realDbsOverall}`);
    for (const l of state.evaluation.realDbLines) lines.push(`  ${l.verdict.padEnd(7)} ${l.name} — ${l.detail}`);
    lines.push("");
  }
  lines.push("HISTORY (at · trigger · scenario · page · launch · IDB/LS/cookie/session/SS · cookies s/none/js · realDBs · overall)");
  const v = (x: Verdict | undefined) => x ?? "-";
  for (const h of state.history) {
    const r = h.results;
    const launch = h.launch ? `#${h.launch.n}${h.launch.relaunch ? " relaunch" : ""}` : "-";
    lines.push(
      `  ${h.at} · ${h.trigger} · ${h.scenario ?? "-"} · ${h.page}/${h.navigation} · ${launch} · ${v(r.indexedDB)}/${v(r.localStorage)}/${v(r.diagCookie)}/${v(r.session)}/${v(r.sessionStorage)} · ${v(r.cookieSession)}/${v(r.cookieSameSiteNone)}/${v(r.cookieScript)} · ${v(h.realDbs)} · ${h.overall}`,
    );
  }
  lines.push("", "EVENTS");
  for (const e of state.events) lines.push(`  ${e.at} ${e.page} ${e.type}${e.detail ? ` ${e.detail}` : ""}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* browser adapters                                                     */
/* ------------------------------------------------------------------ */

export function webStorageStore(name: "localStorage" | "sessionStorage", storage: () => Storage): KvStore {
  return {
    name,
    async get(key) {
      const raw = storage().getItem(DIAG_KEY_PREFIX + key);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    },
    async set(key, value) {
      storage().setItem(DIAG_KEY_PREFIX + key, JSON.stringify(value));
    },
    async clear() {
      const s = storage();
      const own: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null && k.startsWith(DIAG_KEY_PREFIX)) own.push(k);
      }
      for (const k of own) s.removeItem(k);
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function indexedDbStore(factory: () => IDBFactory): KvStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory().open(DIAG_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DIAG_IDB_STORE)) req.result.createObjectStore(DIAG_IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
  const withStore = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      const tx = db.transaction(DIAG_IDB_STORE, mode);
      const result = await request(fn(tx.objectStore(DIAG_IDB_STORE)));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      });
      return result;
    } finally {
      db.close();
    }
  };
  return {
    name: "indexedDB",
    async get(key) {
      return (await withStore("readonly", (s) => s.get(key))) ?? null;
    },
    async set(key, value) {
      await withStore("readwrite", (s) => s.put(value, key));
    },
    async clear() {
      await withStore("readwrite", (s) => s.clear());
    },
  };
}

async function readServer(res: Response): Promise<ServerRead> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty or non-JSON body */
  }
  const cookie = body["diagCookie"] as { runId?: unknown } | undefined;
  const diagRunId = typeof cookie?.runId === "string" ? cookie.runId : null;
  const raw = body["diagCookies"] as Record<string, unknown> | undefined;
  const cookies: CookieEcho | undefined =
    raw && typeof raw === "object"
      ? Object.fromEntries(COOKIE_VARIANTS.map((k) => [k, typeof raw[k] === "string" ? (raw[k] as string) : null]))
      : undefined;
  if (res.status === 401) {
    // Signed out: an absent echo means the request carried no diagnostic cookie at all.
    return { state: "unauthenticated", diagRunId, cookies: cookies ?? { persistent: null, session: null, sameSiteNone: null, script: null } };
  }
  if (res.status === 404) return { state: "not-owner" };
  if (!res.ok) return { state: "error", message: `HTTP ${res.status}` };
  const session = body["session"] as { tag?: unknown; createdAt?: unknown } | undefined;
  if (typeof session?.tag !== "string") return { state: "error", message: "unexpected response" };
  return {
    state: "ok",
    tag: session.tag,
    createdAt: typeof session.createdAt === "string" ? session.createdAt : null,
    diagRunId,
    ...(cookies ? { cookies } : {}),
  };
}

/* ---------------- v2 adapters ---------------- */

const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;

/** Script-written cookie on `document` (Path=/, SameSite=Lax, Secure on https). */
export function documentScriptCookie(doc: () => Document, maxAgeSeconds = 30 * 24 * 3600): ScriptCookie {
  const secure = () => (doc().location?.protocol === "https:" ? "; Secure" : "");
  return {
    read() {
      for (const part of doc().cookie.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0 || part.slice(0, idx).trim() !== DIAG_SCRIPT_COOKIE) continue;
        const value = part.slice(idx + 1).trim();
        return RUN_ID_RE.test(value) ? value : null;
      }
      return null;
    },
    write(runId) {
      if (!RUN_ID_RE.test(runId)) return;
      doc().cookie = `${DIAG_SCRIPT_COOKIE}=${runId}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure()}`;
    },
    clear() {
      doc().cookie = `${DIAG_SCRIPT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure()}`;
    },
  };
}

/**
 * NAMES ONLY: `indexedDB.databases()`. Never calls open() or deleteDatabase().
 * Returns null when the browser cannot enumerate (reported as UNKNOWN).
 */
export function databaseNameLister(factory: () => IDBFactory | undefined): () => Promise<string[] | null> {
  return async () => {
    const f = factory();
    if (!f || typeof f.databases !== "function") return null;
    try {
      const list = await f.databases();
      return list.map((d) => d.name).filter((n): n is string => typeof n === "string");
    } catch {
      return null;
    }
  };
}

export function fetchServerApi(doFetch: typeof fetch = (...a) => fetch(...a)): ServerApi {
  const call = async (method: "GET" | "POST" | "DELETE", body?: unknown): Promise<ServerRead> => {
    try {
      const res = await doFetch(DIAG_API, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      return await readServer(res);
    } catch (err) {
      return { state: "error", message: err instanceof Error ? err.name || "network error" : "network error" };
    }
  };
  return {
    read: () => call("GET"),
    setCookie: (runId) => call("POST", { runId }),
    clearCookie: async () => {
      await call("DELETE");
    },
  };
}
