# Payment activation on the VPS: readiness, controlled test, judging

- **Status (2026-11-06):** payments are **OFF**. Production runs on the Hermes VPS
  (`paywiththence.cv`, commit `64e6ee9`). The database emergency switch is **DISABLED**.
- Nothing in this document has been executed. Every step marked **[OWNER]** needs the
  owner's explicit approval at the time it is done.
- This document replaces the "Vercel Production env" steps in
  [`PUBLIC_PAYMENTS.md`](PUBLIC_PAYMENTS.md). Production configuration now lives in
  `/etc/thence-web-prod/production.env`, not in Vercel.

## 1. What was checked (read-only, 2026-11-06)

| Area | Finding |
|---|---|
| Client payment and claim flags | `NEXT_PUBLIC_THENCE_ENABLE_PAYMENT` and `_CLAIM` are inlined as `"1"` in the bundle the VPS serves. **No rebuild is needed to activate.** |
| Server payment mode | Runtime env (`THENCE_PAYMENTS_MODE`). Changing it needs an env edit and an app restart, not a rebuild. The env installer refuses anything but `off` unless the owner passes `--allow-payments` (owner sudo only; the deploy account cannot). |
| Emergency switch | `pilot_controls`: **DISABLED** since 2026-11-05 09:30:58Z (`scripts/pilot-switch.ts status --production`). Takes effect on the next request, with no restart. |
| Owner-only restrictions in `public` mode | None. Public mode ignores the allowlist, the per-payment and total caps and the single-route rule (`src/lib/pilot.ts`). Recipient wallets don't need verification to be paid. |
| Route and amounts | Only `usdc-polygon` is enabled. Provider limits: **356 to 20,000,000 sats** per payment. No Thence cap in public mode. |
| Satora (`api.satora.io`) from the VPS | `/health` 200 in about 0.46 s. |
| Polygon RPC (PublicNode, VPS env) | 2,000-block `eth_getLogs` OK (0.12 s); `finalized` tag OK; 20-request burst with 0 failures. It passed the full P4 scan evaluation on 2026-11-05 ([`POLYGON_RPC.md`](POLYGON_RPC.md)). Single endpoint: an outage delays verification (fail-closed), it never marks a payment Delivered. |
| Claim ("Finish delivery") | Gasless Satora coordinator claim (`satora-browser.ts`). The payer needs no MATIC; the recipient needs none either. |
| Reconciler | Runs on the VPS (`thence-reconcile.timer`, every 2 min) but **calls `https://paywiththence.vercel.app`**, the only production dependency left on Vercel. See §2. |
| VPS cron endpoint | `https://paywiththence.cv/api/cron/reconcile` answers 401 without auth. A 401, not 503, means the VPS app has `CRON_SECRET`, the same value the timer sends. |
| Stale DNS | Some resolvers still return the old Vercel A record (the old nameservers keep serving the old zone, NS TTL 24 h). Vercel runs `64e6ee9` but with payments `off`, so a judge on a stale resolver would see "Payments temporarily unavailable". This ends when caches expire (around 2026-11-07 evening). |
| Real-money evidence | One supervised mainnet delivery (2026-11-05, pilot mode, served by Vercel). **Never run on the VPS, never run in `public` mode, never run from a non-owner wallet.** |

## 2. Reconciler: remove the Vercel dependency (smallest safe change)

- **Today:** `/etc/thence/reconcile.conf` sets `THENCE_URL=https://paywiththence.vercel.app`.
- **Change:** one line, no code and no unit changes. The script already requires `https://`,
  and the public origin works through the tunnel.

**[OWNER]** on the VPS:

```
sudo cp -a /etc/thence/reconcile.conf /etc/thence/reconcile.conf.vercel   # rollback copy
sudo sed -i 's#^THENCE_URL=.*#THENCE_URL=https://paywiththence.cv#' /etc/thence/reconcile.conf
sudo grep '^THENCE_URL=' /etc/thence/reconcile.conf                     # must print the .cv origin
```

**Verify** (the deploy account can run this) within 4 minutes:

```
sudo journalctl --no-pager -n 200 -u thence-web-production.service | grep thence-reconciler | tail -2
```

- A `thence-reconciler {...}` summary in the **VPS** app log proves the runs now reach the
  VPS. `systemctl show thence-reconcile.service -p Result` should show `success`.
- An `ALERT: unauthorized` means the secrets differ: roll back.

**Rollback:**

```
sudo cp -a /etc/thence/reconcile.conf.vercel /etc/thence/reconcile.conf
```

This takes effect on the next run, two minutes later. The Vercel daily cron (`vercel.json`,
06:17) keeps running against Vercel as an independent backstop. The shared `job_leases` lease
makes overlapping runs harmless.

**Do this before activating payments.** Otherwise status advances during a payment are
computed by Vercel with Vercel's env (Tenderly RPC), not by the VPS.

## 3. Activation (two independent gates, in this order)

**Gate 1, server mode [OWNER].** Payments stay closed afterwards, because the switch is still
DISABLED:

```
sudo cp -a /etc/thence-web-prod/production.env /etc/thence-web-prod/production.env.off
sudo sed -i 's/^THENCE_PAYMENTS_MODE=off$/THENCE_PAYMENTS_MODE=public/' /etc/thence-web-prod/production.env
sudo grep -c '^THENCE_PAYMENTS_MODE=public$' /etc/thence-web-prod/production.env   # must print 1
sudo systemctl restart thence-web-production.service
```

Then:
- Run `verify-https.ts https://paywiththence.cv --read-only --expect vps`; it must pass 17/17.
- A signed-in wallet's `/api/pilot/status` must still return `paused`.

**Gate 2, emergency switch [OWNER, from the operator PC].** This opens payments to everyone:

```
npx tsx scripts/pilot-switch.ts enable  --production --yes --note "<reason>"
npx tsx scripts/pilot-switch.ts disable --production --yes --note "<reason>"   # instant stop
```

**Full rollback:**
1. Disable the switch first; it is instant.
2. Copy back `production.env.off`.
3. Restart the app.

Recovery, claims, verification and refunds keep working while payments are paused.

## 4. Controlled end-to-end test (second wallet, real Polygon recipient)

Goal: prove the **exact judging configuration** (VPS, `public` mode, a non-owner wallet) with
real money, once.

**Preparation**
- **Payer:** a second Nimiq Pay account that has never signed in to Thence. Fund it with
  **about 3,000 NIM**.
  - Rate observed on 2026-11-05: about 985 NIM for 0.30 USDC, roughly 3,300 NIM per USDC.
  - The provider minimum (356 sats) is about 0.28 USDC, roughly 925 NIM.
- **Recipient:** a Polygon address the owner controls but does not use for the payer, for
  example the USDC-on-Polygon address of the owner's Nimiq Pay or OKX wallet.
- **Device:** Android if available. On iOS, **do not switch apps** between approval and
  Delivered (`RISK_IOS_WEBVIEW_STORAGE.md`).
- **Before starting:** §2 done; Gate 1 done; the switch still DISABLED.

**Steps**
1. Sign out of Thence. In Nimiq Pay, make the **second** account active, open Thence and sign
   in. Confirm the masked address on Home is the second wallet, and the balance is about
   3,000 NIM.
2. Add the recipient. Send **0.50 USDC** and open Review, which should show a live quote.
3. **[OWNER]** Enable the switch with the note `controlled test, second wallet`.
4. Swipe, then Approve in Nimiq Pay. Note the NIM debit Nimiq Pay shows.
5. Stay on the screen through "Waiting for funding", then tap **Finish delivery** when it
   appears (usually within about 1 to 2 minutes).
6. Wait for **Delivered**: about 7 minutes for 256 Polygon confirmations. Open the receipt.
7. Decide whether to **leave the switch on** for judging (§5), or **disable it**.

**Pass criteria**
- **Delivered,** with a receipt showing ≥ 0.50 USDC.
- **Wallet:** the recipient wallet shows the USDC.
- **Audit trail** of 7 transitions, including the `reconciler` actor. In the VPS app log,
  `thence-reconciler` lines show the advance.
- **Errors:** no `ALERT` in the reconciler log.

**Negative checks, during the same window (no extra money)**
- While step 6 is pending, start a second payment from the same wallet. It must be refused
  (`PAYMENT_EXPOSURE_UNCERTAIN`).
- Quote 0.10 USDC. It must be refused as below the provider minimum.
- After step 7, if the switch is disabled: Review then Approve must show "Payments temporarily
  unavailable".

**If it fails**
- Disable the switch.
- Do **not** retry the claim manually.
- Let the reconciler and the provider resolve it; a missed claim refunds the NIM.
- Collect the transfer id from Activity and the VPS logs:
  ```
  sudo journalctl --no-pager -n 200 -u thence-web-production.service
  ```

## 5. Judging configuration

- **Mode:** `public` with the switch **ENABLED** for the judging period. There is no allowlist,
  so any judge's Nimiq Pay wallet works.
- **Monitoring:**
  - the Cloudflare Tunnel Health Alert;
  - the VPS health timer;
  - the reconciler `Result`;
  - Activity on the owner device.
- **Emergency stop:** `pilot-switch.ts disable`, instant.
- **Notes for judges** (submission text or README):
  - Use the **Nimiq Pay app** and keep Thence in the foreground until **Delivered**. On iOS, do
    not switch apps mid-payment.
  - You need about **1,000 NIM or more** (the provider minimum is about 0.28 USDC). Use small
    amounts: 0.30 to 1 USDC.
  - The recipient is any Polygon wallet, for example your own Nimiq Pay USDC (Polygon) address.
  - Delivery is confirmed after 256 Polygon confirmations, about 7 minutes. **Finish delivery**
    must be tapped within about 1 hour of starting, otherwise the payment refunds automatically.
  - One payment at a time per wallet.
