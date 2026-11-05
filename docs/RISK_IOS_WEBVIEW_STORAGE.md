# Risk: Nimiq Pay iOS webview storage across app switching (UNRESOLVED)

Status: **open, unverified.** Recorded from the 2026-11-05 supervised payment
(2c2432af). Nothing here was tested on a real device; no setting, storage or
payment behaviour was changed to produce it.

## What was observed (evidence)

- 09:29:35Z the owner signed in inside Nimiq Pay on iOS; the server session
  (`sessions` row) was created with a 30-day expiry and was **never revoked**.
- The session cookie is persistent: `thence_session`, `HttpOnly`,
  `SameSite=Lax`, `Secure`, `Max-Age` = session TTL, `Expires` set
  (`serializeSessionCookie`, `src/lib/auth.ts`).
- After the claim, the owner switched to the OKX app to check the balance and
  came back. At 10:34:02 (Lagos) the page reloaded and the request log shows
  `GET /api/me` → `/app/reconnect` → `POST /api/session/challenge` →
  `POST /api/session/verify` → a **second** server session at 09:34:07Z.

Conclusion: the webview **reloaded the page and did not send the persistent
session cookie** after the app switch. The server did not end the session.

## What this does NOT prove

Cookie loss does **not** prove that IndexedDB or localStorage were lost.
WKWebView keeps cookies (HTTPCookieStore) and website data (IndexedDB,
localStorage) in different stores with different lifecycles; a host app can
also use a non-persistent data store, clear cookies only, or lose a cookie
that was set while the webview process was being torn down. None of these is
distinguishable from the evidence above. No claim was attempted after the
reload (the claim had already been submitted at 09:31:43Z), so there is **no
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

## Decisions needed (owner)

- Run the device check above before further real payments.
- If IndexedDB does not survive app switching, a server-held or
  pre-signed claim is a custody change and needs its own design and approval
  (see docs/CLAIM_COMPLETION.md, "Unattended claiming").
