"use client";

/**
 * Owner-only iOS WebView storage diagnostic screen (no money).
 * See docs/IOS_STORAGE_DIAGNOSTIC.md for the iPhone procedure.
 */
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/ui/components/Button";
import { Notice } from "@/ui/components/primitives";
import shell from "@/ui/components/shell.module.css";
import { buildId } from "@/ui/lib/build";
import {
  SCENARIOS,
  StorageDiagnosticEngine,
  buildReport,
  fetchServerApi,
  indexedDbStore,
  newRunId,
  webStorageStore,
  type KvStore,
  type ServerApi,
  type Verdict,
} from "@/ui/lib/storage-diagnostic";
import styles from "./diagnostics.module.css";

const CHECK_THROTTLE_MS = 1500;

function navigationType(): string {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

function browserStores(): KvStore[] {
  const stores: KvStore[] = [];
  if (typeof indexedDB !== "undefined") stores.push(indexedDbStore(() => indexedDB));
  stores.push(webStorageStore("localStorage", () => window.localStorage));
  stores.push(webStorageStore("sessionStorage", () => window.sessionStorage));
  return stores;
}

export interface StorageDiagnosticProps {
  /** Server-rendered: the current request carried an owner session. */
  ownerAtRender: boolean;
  /** Test seams. */
  stores?: KvStore[];
  server?: ServerApi;
  pageInstance?: string;
  navigation?: string;
}

function VerdictBadge({ verdict }: { verdict: Verdict }): React.JSX.Element {
  return (
    <span className={styles.badge} data-verdict={verdict}>
      {verdict}
    </span>
  );
}

export function StorageDiagnostic(props: StorageDiagnosticProps): React.JSX.Element {
  const [page] = useState(() => props.pageInstance ?? newRunId().slice(2, 8));
  const [nav] = useState(() => props.navigation ?? navigationType());
  const [engine] = useState(
    () =>
      new StorageDiagnosticEngine({
        stores: props.stores ?? browserStores(),
        server: props.server ?? fetchServerApi(),
        pageInstance: page,
        navigationType: nav,
      }),
  );
  const state = useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let lastCheck = 0;
    const checkSoon = (trigger: string) => {
      const now = Date.now();
      if (now - lastCheck < CHECK_THROTTLE_MS) return;
      lastCheck = now;
      void engine.check(trigger);
    };
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      void engine.logEvent(visible ? "visible" : "hidden");
      if (visible) checkSoon("visible");
    };
    const onPageShow = (e: PageTransitionEvent) => {
      void engine.logEvent("pageshow", e.persisted ? "bfcache" : "fresh");
      if (e.persisted) checkSoon("pageshow");
    };
    const onPageHide = (e: PageTransitionEvent) => void engine.logEvent("pagehide", e.persisted ? "persisted" : "unload");
    const onFocus = () => checkSoon("focus");
    const onFreeze = () => void engine.logEvent("freeze");
    const onResume = () => {
      void engine.logEvent("resume");
      checkSoon("resume");
    };
    const onOnline = () => void engine.logEvent("online");
    const onOffline = () => void engine.logEvent("offline");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("focus", onFocus);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    void (async () => {
      await engine.load();
      await engine.logEvent("load", nav);
      lastCheck = Date.now();
      await engine.check("load");
      setLoaded(true);
    })();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [engine, nav]);

  const report = useMemo(
    () =>
      buildReport(state, {
        build: buildId(),
        userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
        page,
        navigation: nav,
      }),
    [state, page, nav],
  );

  const hasRun = state.evaluation?.expected != null || state.run != null;
  const available = !state.notOwner && (props.ownerAtRender || hasRun);

  if (!loaded && !props.ownerAtRender) {
    return (
      <main className={shell.screen}>
        <div className={styles.wrap}>
          <p className={styles.muted} role="status">
            Loading…
          </p>
        </div>
      </main>
    );
  }

  if (!available) {
    return (
      <main className={shell.screen}>
        <div className={styles.wrap}>
          <h1 className={styles.title}>Not available</h1>
          <p className={styles.muted}>This page isn&apos;t available for this account.</p>
          <Link className={styles.link} href="/app">
            Back to Thence
          </Link>
        </div>
      </main>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  const evaluation = state.evaluation;

  return (
    <main className={shell.screen}>
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>Owner diagnostic · no money</p>
        <h1 className={styles.title}>Storage check</h1>
        <p className={styles.muted}>
          Tests whether this phone keeps Thence&apos;s saved data when Nimiq Pay is switched away, locked, reloaded or closed.
          It uses its own test markers only — it never reads or changes payment recovery data, and it moves no money.
        </p>

        {state.startError && (
          <Notice tone="warn" title="Couldn't start">
            {state.startError}
          </Notice>
        )}

        <section className={styles.card} aria-labelledby="diag-now">
          <div className={styles.cardHead}>
            <h2 id="diag-now" className={styles.h2}>
              Result now
            </h2>
            {evaluation && <VerdictBadge verdict={evaluation.overall} />}
          </div>
          {!evaluation && <p className={styles.muted}>Checking…</p>}
          {evaluation && (
            <ul className={styles.lines}>
              {evaluation.lines.map((l) => (
                <li key={l.name} className={styles.line} data-counted={l.counted}>
                  <VerdictBadge verdict={l.verdict} />
                  <div>
                    <p className={styles.lineLabel}>{l.label}</p>
                    <p className={styles.lineDetail}>{l.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.meta}>
            Run {state.run?.runId ?? "not started"} · page {page} ({nav}) · checked {state.lastCheckedAt ?? "—"}
          </p>
          <div className={styles.actions}>
            <Button variant="ink" block onClick={() => void engine.start()} disabled={state.busy} aria-busy={state.busy}>
              {state.run ? "Start a new test" : "Start test"}
            </Button>
            <Button variant="soft" block onClick={() => void engine.check("manual")} disabled={state.busy}>
              Check now
            </Button>
            <Button variant="soft" block onClick={() => window.location.reload()} disabled={state.busy}>
              Reload page
            </Button>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="diag-step">
          <h2 id="diag-step" className={styles.h2}>
            What are you about to do?
          </h2>
          <p className={styles.muted}>Pick the step before you leave the app, so the next result is labelled.</p>
          <ul className={styles.scenarios}>
            {SCENARIOS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={styles.scenario}
                  aria-pressed={state.scenario === s.id}
                  onClick={() => void engine.setScenario(s.id)}
                >
                  <span className={styles.scenarioTitle}>{s.title}</span>
                  <span className={styles.scenarioSteps}>{s.steps}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.card} aria-labelledby="diag-history">
          <h2 id="diag-history" className={styles.h2}>
            History
          </h2>
          {state.history.length === 0 ? (
            <p className={styles.muted}>No checks yet.</p>
          ) : (
            <ol className={styles.history}>
              {[...state.history].reverse().map((h) => (
                <li key={`${h.at}-${h.trigger}`} className={styles.historyRow}>
                  <VerdictBadge verdict={h.overall} />
                  <span>
                    {new Date(h.at).toLocaleTimeString()} · {h.trigger}
                    {h.scenario ? ` · ${h.scenario}` : ""}
                    {h.page !== page ? " · earlier page load" : ""}
                    <br />
                    <span className={styles.lineDetail}>
                      IndexedDB {h.results.indexedDB} · localStorage {h.results.localStorage} · cookie {h.results.diagCookie} · session{" "}
                      {h.results.session}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className={styles.card} aria-labelledby="diag-report">
          <h2 id="diag-report" className={styles.h2}>
            Report
          </h2>
          <p className={styles.muted}>Copy this and send it back. It contains no keys, tokens or payment data.</p>
          <div className={styles.actions}>
            <Button variant="soft" block onClick={() => void copy()}>
              {copied === "copied" ? "Copied" : "Copy report"}
            </Button>
          </div>
          {copied === "failed" && <p className={styles.muted}>Copy isn&apos;t allowed here — select the text below instead.</p>}
          <pre className={styles.report}>{report}</pre>
          <Button variant="ghost" block onClick={() => void engine.reset()} disabled={state.busy}>
            Clear diagnostic data
          </Button>
        </section>

        <Link className={styles.link} href="/app/home">
          Back to Thence
        </Link>
      </div>
    </main>
  );
}
