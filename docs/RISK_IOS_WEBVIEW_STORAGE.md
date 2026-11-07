# Risk: Nimiq Pay iOS webview storage across app switching (UNRESOLVED)

Status: **open, narrowed.** Recorded from the 2026-11-05 supervised payment
(2c2432af) and the same day's no-money device diagnostic (see "Device
results"). Cookie loss on relaunch is confirmed; survival of the real claim
vault (`lendaswap-v3`, `thence-recovery`) is **not yet observed**. The
re-authentication recovery path is traced and tested with simulated
payments.

## What was observed (evidence)

- About 1 minute before the quote, the owner signed in inside Nimiq Pay on iOS; the server session
  (`sessions` row) was created with a 30-day expiry and was **never revoked**.
- The session cookie is persistent: `thence_session`, `HttpOnly`,
  `SameSite=Lax`, `Secure`, `Max-Age` = session TTL, `Expires` set
  (`serializeSessionCookie`, `src/lib/auth.ts`).
- After the claim, the owner switched to the OKX app to check the balance and
  came back. About 2.5 minutes after the claim the page reloaded and the request log shows
  `GET /api/me` → `/app/reconnect` → `POST /api/session/challenge` →
  `POST /api/session/verify` → a **second** server session seconds later.

Conclusion: the webview **reloaded the page and did not send the persistent
session cookie** after the app switch. The server did not end the session.

## What this does NOT prove

Cookie loss does **not** prove that IndexedDB or localStorage were lost.
WKWebView keeps cookies (HTTPCookieStore) and website data (IndexedDB,
localStorage) in different stores with different lifecycles; a host app can
also use a non-persistent data store, clear cookies only, or lose a cookie
that was set while the webview process was being torn down. None of these is
distinguishable from the evidence above. No claim was attempted after the
reload (the claim had already been submitted about 2.5 minutes earlier), so there is **no
evidence either way** about client claim storage surviving the switch.

## Why it matters: what lives on the device until Finish delivery

| Data | Store | If it is gone before Finish delivery |
|---|---|---|
| Claim secret (preimage, keys) | IndexedDB `lendaswap-v3` (Satora SDK) | Claim impossible. The gate refuses before anything is revealed; the provider refunds its Polygon lock after the deadline; Nimiq Pay returns the NIM on its own HTLC timer. Not delivered, no loss to a third party — the 2026-11-02 (077770a1) outcome. |
| Recovery binding (transfer ↔ swap ↔ owner) | IndexedDB `thence-recovery` | Same: Finish delivery refused ("recovery information doesn't match"). |
| Submitted-claim record, handoff record | localStorage | Safe for money: the server claim lease, `claimReady` and the one-shot HTLC still prevent a second claim; the screen may briefly re-check. |
| Session | Cookie | Sign in again (what happened on 2026-11-05). |

Thence never requests persistent storage (`navigator.storage.persist()` is not
called); on iOS that request is largely advisory anyway.

## Current mitigation in the UI

- At the action: "Only this device can do it." The Finish delivery state is
  shown immediately on return (tracker resumes on visibility/focus/pageshow).
- After submission the screen says the owner can leave: verification and
  DELIVERED are server-side (Hermes / reconciler) and need no client storage.

## How to verify (no money, owner device)

The diagnostic page now exists (`/app/diagnostics/storage`, owner only); the
procedure and verdicts are in `docs/IOS_STORAGE_DIAGNOSTIC.md`. **The device
test has not been run; this risk remains open.**

1. Build a diagnostics-only page (no swap, no invoice) that writes a random
   marker to IndexedDB (a dedicated database), localStorage and a test cookie,
   and shows them.
2. Open it inside Nimiq Pay on the iPhone; note the markers.
3. Switch to another app for 10 s, 2 min and 10 min; return each time and read
   the markers. Repeat after locking the phone, after swiping Nimiq Pay away,
   and after a device memory-pressure event (open several heavy apps).
4. Record which stores survive each case.

Until that is done, the safe operating rule for a funded payment is: **stay in
Nimiq Pay between approval and tapping Finish delivery.** After tapping it,
leaving is safe.

## Device results — 2026-11-05 diagnostic (no money)

Owner's iPhone, inside Nimiq Pay, build `378ba43` (`/app/diagnostics/storage`).
Device model, iOS and Nimiq Pay versions were not recorded.

| Time (UTC) | Event | Source |
|---|---|---|
| 16:24:25 | Server session A created (sign-in) | `sessions` (read-only query) |
| 16:27:39 | Session B created — a **second sign-in 3 min later**; A was never revoked | `sessions` |
| 16:28:29 | Diagnostic test started (markers + `thence_diag` written; session B) | owner report |
| 16:29:52 – 16:33:24 | Diagnostic checks: all PASS (every request carried the cookies) | owner report, Vercel logs |
| 16:33:42 | Page went back to `/app/home` | Vercel logs |
| 16:33:42 – 16:35:20 | App switching / reopening (no scenario labels recorded) | owner report |
| 16:35:20, 16:35:25 | Thence **loaded fresh from its start URL** `/` → `/app` (served `304` from the HTTP cache) | Vercel logs |
| 16:35:26 | `GET /api/me` → **401** (no session cookie sent) → `/app/reconnect` | Vercel logs |
| 16:35:29 – 16:35:31 | Challenge + verify → session C created; B never revoked | Vercel logs, `sessions` |
| 16:35:40 | Diagnostic: IndexedDB **PASS**, localStorage **PASS**, diagnostic cookie **FAIL**, original session **FAIL** (re-signed in), sessionStorage FAIL (informational) | owner report |

What this shows:

- **Every cookie** for the origin was gone (the login cookie and `thence_diag`,
  which have identical attributes), while IndexedDB, localStorage and the HTTP
  cache survived. The server never ended a session (A, B and C are all
  unrevoked and unexpired); the device stopped sending them.
- The loss coincides with Nimiq Pay **relaunching the mini app** (a fresh load
  of `/`), not with a page reload inside a running mini app, and it happened
  **twice within 11 minutes** (16:24→16:27 and 16:33→16:35).

What this does NOT show:

- **Which action caused it.** No scenario was selected in the diagnostic, so
  the history cannot attribute the loss to the camera, memory pressure, a
  force-quit or closing Thence. Do not attribute it to any one of them.
- **That the real claim vault survives.** The diagnostic wrote to its own
  database `thence-diag-v1`. Same origin and storage policy as `lendaswap-v3`
  (Satora SDK secrets) and `thence-recovery` (binding), so the same outcome
  is likely, but it has not been observed for those databases.
- Whether the host clears cookies deliberately (for example on mini-app
  close) or loses them (for example, persistent cookies not yet flushed when
  the webview process ends). Both fit the evidence.

## Re-authentication recovery — traced and tested (simulated, no money)

Code trace (`main` @ `378ba43`):

1. Cookie gone → `/api/me` 401 → session `expired` → `/app/reconnect`. Expiry
   clears nothing on the device; only an explicit **Sign out** clears the
   localStorage pending pointer (`signOutEverywhere`), and never the vault.
2. Signing in with the **same wallet** resolves to the **same user id**
   (`users.nimiq_address` is unique; `verifyChallengeAndLogin`). No payment
   state references a session id; transfers, attempts, the vault binding
   (`ownerUserId`) and the claim record are all keyed by user and transfer.
3. Finish delivery (`useSettlement.attemptClaimOnce`) requires, in order:
   a valid session; the vault binding for this transfer, owner and bound swap;
   Satora SDK readback with recovery material whose payment hash and refund
   locktime equal the server's; a server deadline outside the 5-minute unsafe
   window; no earlier unresolved claim; then the server's claim intent (fresh
   provider read, on-chain lock and deadline, per-transfer lease) whose answer
   must match the local material again — only then `claim(swapId)`.
4. Bindings are deleted only on an explicit retry after a failed pre-approval
   save, or when the server proves the invoice expired before funding.

Tests added (`tests/p3-claim-intent.test.ts` "re-authentication after
login-cookie loss", live TEST database; `tests/ui-reauth-recovery.test.tsx`):

| Case | Result |
|---|---|
| Same wallet, new session | Same user id; payment listed and readable; Nimiq Pay approval refused (409 `NOT_AUTHORIZABLE`); a second payment refused (409 `PAYMENT_EXPOSURE_UNCERTAIN`); no new transfer, swap or handoff attempt; claim intent authorized once for the bound swap, deadline and destination; the old session cannot start a second claim (409) |
| No session / forged token / signed-out session | 401, status unchanged, no claim authorized; signing in again restores access |
| Different wallet | Payment not visible (404), claim refused, nothing changed; on the device the binding is `foreign` and nothing is revealed |
| Page recreated, same wallet, vault intact | Finish delivery resumes from the same binding: one claim intent, one SDK claim, nothing re-created; after another reload no second attempt |
| Binding missing (`thence-recovery`) / SDK material missing (`lendaswap-v3`) | Blocked before any server authorization or SDK claim |
| Deadline passed / inside the unsafe window after re-sign-in | No Finish delivery, no claim |

Mutation checks: ignoring the session state, or removing both owner checks,
makes these tests fail. Earlier suites already cover reload, background,
duplicate taps, unknown outcomes and deadline handling
(`tests/ui-p3-claim-completion.test.tsx`, `tests/ui-payment-lifecycle.test.tsx`,
`e2e/payment.e2e.ts`).

**Conclusion:** with the recovery material present, login-cookie loss costs
one Nimiq Pay sign-in (a signature, not a payment approval) and the original
payment resumes safely; without it, every path fails closed into the
refund path. No code change is required for safety.

## Cookie loss — investigation without weakening protections

Not acceptable as fixes: moving the session token to localStorage or an
`Authorization` header (readable by script; loses HttpOnly), dropping
`Secure` or `SameSite=Lax`, relaxing the Origin check, or replacing wallet
signature sign-in. None is proposed.

Next no-money diagnostic. Items 1–3 are implemented as diagnostic v2
(`docs/IOS_STORAGE_DIAGNOSTIC.md`, "Version 2 additions"); device run pending:

1. Cookie variants written together, compared after each relaunch: the
   current HttpOnly server cookie; a session cookie (no `Max-Age`/`Expires`);
   a script-written cookie; `SameSite=None; Secure`. If every variant
   disappears at every relaunch, the host clears cookies per launch.
2. A launch counter (localStorage) and a `pageshow`/start-URL marker so each
   relaunch is visible in the history even without a scenario label.
3. **Real vault presence, metadata only:** list IndexedDB database names
   (`indexedDB.databases()`) and record whether `lendaswap-v3` and
   `thence-recovery` exist, without opening, reading, writing or deleting
   them. The 2c2432af payment created both on this device; their
   presence after today's relaunches would be direct evidence that the real
   databases survive. If approved, a record **count** (no values) is the next
   step.
4. Ask the Nimiq Pay team how mini-app webviews persist cookies across
   relaunch (`WKWebsiteDataStore`, cookie clearing on close).

## Remaining before public beta (this risk)

- Run the diagnostic v2 above with scenario labels for each step; record
  model, iOS and Nimiq Pay versions.
- Until real-vault presence is shown across relaunches: keep the rule — stay
  in Nimiq Pay between approval and Finish delivery.
- UX (small, optional): after re-sign-in, land on the payment that needs
  Finish delivery instead of Home, and say on the reconnect screen that an
  unfinished payment is safe and continues after signing in.

## Decisions needed (owner)

- Run the device check above before further real payments.
- If IndexedDB does not survive app switching, a server-held or
  pre-signed claim is a custody change and needs its own design and approval
  (see docs/CLAIM_COMPLETION.md, "Unattended claiming").
