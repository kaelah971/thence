# iOS storage diagnostic — iPhone testing guide (no money)

Purpose: close the open question in `docs/RISK_IOS_WEBVIEW_STORAGE.md`: does
Nimiq Pay iOS keep Thence's on-device data (IndexedDB, localStorage, cookies)
and the login session when the app is switched away, locked, reloaded or
force-quit? The claim secret lives in IndexedDB until **Finish delivery**, so
the IndexedDB line is the one that matters most.

**Status: the diagnostic exists; the device test has not been run.** The risk
stays UNRESOLVED until the results below are recorded.

## What it does and does not do

| Tested | How | Notes |
|---|---|---|
| IndexedDB | random marker in database `thence-diag-v1` | Same origin and storage policy as the claim vault (`lendaswap-v3`, `thence-recovery`); a separate database, so the real one is never opened |
| localStorage | key `thence-diag:v1:run` | Same origin as the claim-submitted record |
| Diagnostic cookie | `thence_diag`, set by the server | Same attributes as the login cookie (HttpOnly, SameSite=Lax, Secure, Path=/, same 30-day Max-Age). Carries only the random run id |
| Login session | `GET /api/diagnostics/storage` | Server says signed in / signed out, plus a one-way 12-character tag of the session so "same session" is distinguishable from "signed in again". Tokens and cookies are never shown |
| sessionStorage | key `thence-diag:v1:run` | Informational: it is expected to clear when the page or app closes |

- No NIM, no Satora swap, no invoice, no payment secret, no transfer. The page
  never opens, reads, changes or deletes the real recovery data; **Clear
  diagnostic data** removes only the `thence-diag` items and `thence_diag`.
- Owner only: signed-in non-owners get a 404 for the page and the API, and
  the link in the Wallet sheet is shown only after the server confirms an
  owner. Owners are `THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES` (falls back
  to `THENCE_PILOT_OWNER_NIMIQ_ADDRESSES` when unset; empty means nobody).
  In production the pilot allowlist already holds the owner wallet, so no
  configuration change is needed.
- Signed out, the page still shows results **if this phone already holds
  markers from an owner run**. A lost login is one of the outcomes being
  measured. It cannot start a test without an owner session.
- The page records lifecycle events (`visible` / `hidden`, `pageshow` /
  `pagehide` incl. back-forward cache, `freeze` / `resume`, `online` /
  `offline`) and re-checks automatically on return (visibility, focus,
  pageshow, resume) and on every load. A new page id in History means the
  webview reloaded the page.

## Verdicts

- **PASS**: the marker from the current test was found (session: the same
  login as at the start).
- **FAIL**: the marker is missing or older (session: signed out, or signed
  in again, so the original session was lost).
- **UNKNOWN**: could not tell: no test started, the storage threw an error,
  or the server was unreachable. UNKNOWN never counts as PASS.
- The headline is FAIL if any of IndexedDB / localStorage / cookie / session
  failed, else UNKNOWN if any is unknown, else PASS. sessionStorage is not
  counted.

## On the iPhone (about 45 minutes, mostly waiting)

Payments stay disabled. Nothing here can move money.

1. Open Nimiq Pay → Thence → **Home**, tap the greeting at the top ("Hello …")
   to open the **Your wallet** sheet, then tap **Storage diagnostic (owner,
   no money)** at the bottom. If you are asked to sign in,
   sign in first.
2. Tap **Start test**. Every line should say PASS. If not, stop and send the
   report.
3. For each step below: tap the step in **What are you about to do?**, do it,
   come back to this page, wait for the result (it re-checks by itself; tap
   **Check now** if unsure), and note the headline.
   1. Baseline (no action).
   2. Reload: tap **Reload page**.
   3. Quick app switch: another app for ~30 s.
   4. Lock the phone for 2 minutes.
   5. Long background: 15–30 minutes in another app.
   6. Close Thence inside Nimiq Pay, reopen it, go back to the page.
   7. Force-quit Nimiq Pay (swipe it away), reopen, go back to the page.
   8. Memory pressure: camera plus several heavy apps or games for 5 minutes.
4. After a FAIL you may continue. Later lines are still compared against the
   same run while any marker survives. If everything is gone, tap **Start
   test** again before the next step.
5. Tap **Copy report** (or select the text in the Report box) and send it.
   The report holds verdicts, times, the build id and the browser's user
   agent; no keys, tokens or payment data.
6. Optional: tap **Clear diagnostic data** at the end.

## Reading the result

| Outcome | Meaning for real payments |
|---|---|
| IndexedDB PASS everywhere | The claim secret is expected to survive leaving the app; the "stay in Nimiq Pay" rule can be relaxed for those cases |
| IndexedDB FAIL after force-quit / memory pressure only | Keep the rule for long absences; app switches are safe |
| IndexedDB FAIL after a quick switch or lock | Keep the rule strictly; consider a design change (see the risk document, "Decisions needed") |
| Session FAIL, storage PASS | Cookie-only loss (as on 2026-11-05): sign in again, payments recoverable |

Whatever the outcome, a lost claim secret fails safe: Finish delivery is
refused before anything is revealed, the provider refunds after the deadline,
and Nimiq Pay returns the NIM, as in the 2026-11-02 (077770a1) refund path.
The refusal step is covered by the E2E spec "missing IndexedDB recovery
material" (`e2e/payment.e2e.ts`, simulated provider and chain).

## Recording results

Copy the device, iOS and Nimiq Pay versions plus the per-step headline into a
"Device results" section of `docs/RISK_IOS_WEBVIEW_STORAGE.md`, attach the
report, and only then change that document's status.
