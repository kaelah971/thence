# Production cutover: Vercel → VPS (named Cloudflare Tunnel)

Goal: serve `https://paywiththence.cv` from the VPS through a permanent,
named Cloudflare Tunnel in the operator's own Cloudflare account, with the
current Vercel deployment kept intact for rollback. Payments stay **off**
throughout (server `THENCE_PAYMENTS_MODE=off` on the VPS, and the shared
database emergency switch stays DISABLED).

Legend: **[CF]** Cloudflare dashboard · **[PX]** Pxxl · **[SUDO]** a VPS
command needing the operator's sudo password · **[DEPLOY]** runs as the
deploy account under the narrow sudoers rule (no password) · **[GO]** needs
explicit approval before it is done.

## Architecture after cutover

```
browser ──https──▶ Cloudflare edge (paywiththence.cv, proxied)
                     │  named tunnel "thence-production" (outbound-only from the VPS)
                     ▼
VPS: thence-tunnel-production (DynamicUser, token via systemd credential)
       └─▶ 127.0.0.1:3200 thence-web-production (user thence-prod)
                               └─▶ Neon production DB (shared with Vercel)
Reconciler timer (VPS) ─▶ https://paywiththence.vercel.app/api/cron/reconcile (unchanged)
www.paywiththence.cv ──▶ 301 → https://paywiththence.cv
```

* Staging stays separate: user `thence`, `/srv/thence`, `/etc/thence-web`,
  port 3100, quick tunnel. Production: user `thence-prod`, `/srv/thence-prod`,
  `/etc/thence-web-prod`, port 3200. Each unit makes the other's paths
  inaccessible. Production env and tunnel token can only be written with
  the operator's sudo.
* Origin/CSRF behind the tunnel: `next start` sees `localhost:3200` as its
  host; `assertSafeOrigin` now also trusts the configured canonical
  `THENCE_APP_ORIGIN` (exact, https-only in production). Forwarded-host
  headers stay untrusted; no wildcard. Covered by `tests/proxy-origin.test.ts`
  and verified on staging with no allowlist.
* Vercel and the VPS can run side by side: same commit, same database,
  DB-backed rate limits and sessions. Sessions stay valid across the switch
  (same host, same `thence_session` cookie, same DB).
* The reconciler keeps calling the Vercel URL, so reconciliation does not
  depend on the VPS. (Moving it later is optional and separate.)

## Current DNS at Pxxl (2026-11-06)

| Name | Type | Value | Note |
|---|---|---|---|
| `paywiththence.cv` | A | `216.198.79.1` | Vercel; TTL 60 |
| `www.paywiththence.cv` | A / AAAA | `188.114.96.0`, `188.114.97.0` / `2a06:98c1:3120::`, `2a06:98c1:3121::` | Pxxl forwarding; causes the www 308 loop |

No MX, TXT or CAA records. No DNSSEC (no DS record), so the nameserver
change has no DNSSEC step.

---

## Phase 0 — Cloudflare account preparation (no live effect)

1. **[CF]** Sign in to *your* Cloudflare account → **Add a domain** →
   `paywiththence.cv` → **Free** plan. When asked, choose to enter records
   manually / review imported records.
2. **[CF] DNS → Records**: make the zone contain exactly:
   | Type | Name | Content | Proxy |
   |---|---|---|---|
   | A | `@` | `216.198.79.1` | **DNS only (grey)** |
   | CNAME | `www` | `cname.vercel-dns.com` | **DNS only (grey)** |

   Delete anything else Cloudflare imported. Do **not** change nameservers
   yet. Note the two nameservers Cloudflare assigns (`xxx.ns.cloudflare.com`).
3. **[CF] SSL/TLS → Edge Certificates**: Always Use HTTPS **On**, Minimum
   TLS 1.2. (Takes effect only for proxied records.)
4. **[CF] Zero Trust → Networks → Tunnels → Create a tunnel** →
   *Cloudflared* → name `thence-production` → on the "install connector"
   page, copy only the token (the long string after `--token`). **Do not run
   the install command shown there.** Save the token to a local file
   `tunnel-token.txt` (one line). Do not add a public hostname yet.
5. **[CF] Notifications → Add**: *Tunnel Health Alert* for
   `thence-production` (email) — alerts when the connector goes down.

## Phase 1 — Production service on the VPS (no live effect)

Prerequisite: the proxy-origin fix is merged to `main` (PR) — Vercel will
redeploy `main` (behaviour there is unchanged; covered by tests).

1. **[SUDO]** Install the reviewed production setup (hash-verified command
   supplied with this plan): dry run, then `--apply`. Creates `thence-prod`,
   directories, units (not enabled, not started) and the updated sudoers rule.
2. **[SUDO]** Production env. Create `production.env` on your PC from the
   values you hold for Vercel Production (Vercel shows them as Sensitive and
   cannot reveal them). **Do not include `CRON_SECRET`** — it is appended on
   the VPS from `/etc/thence/cron-secret` so it never leaves the server:
   ```
   DATABASE_URL=<production Neon URL, as in ~/.thence/production.env>
   THENCE_APP_ORIGIN=https://paywiththence.cv
   THENCE_ALLOWED_ORIGINS=https://vps.paywiththence.cv
   THENCE_PAYMENTS_MODE=off
   THENCE_ENABLED_ROUTES=<as Vercel>
   THENCE_ROUTE_TOKENS_JSON=<as Vercel>
   THENCE_EVM_RPCS_JSON=<as Vercel>
   THENCE_NIMIQ_RPC_URL=<as Vercel>
   THENCE_NIMIQ_NETWORK=<as Vercel>
   NEXT_PUBLIC_THENCE_ENABLE_PAYMENT=1
   NEXT_PUBLIC_THENCE_ENABLE_CLAIM=1
   ```
   (`THENCE_PILOT_*` are not needed while payments are off. The
   `NEXT_PUBLIC_*` flags are build-time UI flags matching Vercel; the claim
   flag keeps fund recovery working. Server mode `off` still blocks new
   payments.) `THENCE_ALLOWED_ORIGINS` is temporary for the Phase 3 test
   host and is removed in Phase 5. The installer refuses the file unless
   payments are off, the origin is exactly `https://paywiththence.cv` and
   `CRON_SECRET` is present.
3. **[SUDO]** Install the tunnel token (`tunnel-token.txt` from Phase 0).
   Stored root-only (`0600`); systemd hands it to the tunnel process.
4. **[DEPLOY]** Build the merged `main` commit as `thence-prod`:
   `sudo -u thence-prod /opt/thence/bin/thence-deploy production /tmp/thence-<sha>.tgz`
5. **[DEPLOY]** Start (not enable): `sudo systemctl start thence-web-production.service`,
   then `sudo systemctl start thence-tunnel-production.service`.
   Check: `curl -s http://127.0.0.1:3200/api/health` → `"status":"ok"`;
   **[CF]** tunnel `thence-production` shows **HEALTHY**.

## Phase 2 — Move DNS hosting to Cloudflare **[GO]** (no behaviour change)

Records still point to Vercel (grey cloud), so the site keeps being served
by Vercel; only the DNS provider changes. This also fixes `www`.

1. **[DEPLOY, with approval]** Add `www.paywiththence.cv` to the Vercel
   project as a **308 redirect to `paywiththence.cv`**
   (`vercel domains add` / project Domains → *Redirect to*).
2. **[PX]** Domain → Nameservers → replace `ns1.hola.cv` / `ns2.hola.cv`
   with the two Cloudflare nameservers from Phase 0.
3. **[CF]** Wait for the zone to show **Active** (minutes to a few hours).
4. Verify (the deploy account runs these):
   * `ops/selfhost/verify-https.ts https://paywiththence.cv --read-only --expect vercel` → all PASS
   * `curl -sI https://www.paywiththence.cv/` → `308` to `https://paywiththence.cv/`
   * Vercel project → Domains: both show *Valid Configuration*.

Rollback for this phase: **[PX]** set nameservers back to
`ns1.hola.cv` / `ns2.hola.cv` (Pxxl still holds the old records).

## Phase 3 — Pre-flight on a test hostname (no effect on paywiththence.cv)

1. **[CF]** Tunnel `thence-production` → **Public Hostname → Add**:
   subdomain `vps`, domain `paywiththence.cv`, service `HTTP` →
   `127.0.0.1:3200`. (Cloudflare creates the proxied `vps` CNAME.)
2. Verify (deploy account):
   `verify-https.ts https://vps.paywiththence.cv --read-only --expect vps`
   → all PASS. Read-only mode signs in nowhere and writes nothing beyond an
   anonymous sign-in challenge, so the production DB gets no test data.
3. **[SUDO]** Restart test: `sudo systemctl kill -s KILL thence-web-production.service`
   → it is back within seconds (`Restart=always`); the tunnel reconnects by
   itself after `sudo systemctl restart thence-tunnel-production.service`.
4. Optional, with your approval: one wallet sign-in in Nimiq Pay at
   `https://vps.paywiththence.cv` (creates a real session; no payment).

## Phase 4 — Cutover **[GO]**

Payments remain off. Do it at a quiet time; it takes effect within about a
minute and is reversible the same way.

1. **[CF] DNS → Records**: delete the `A @ 216.198.79.1` record. (Cloudflare
   will not add the tunnel route while it exists; do steps 1 and 2 back to
   back — the apex is unresolvable only for those seconds.)
2. **[CF]** Tunnel `thence-production` → Public Hostname → **Add**:
   subdomain *(empty)*, domain `paywiththence.cv`, service `HTTP` →
   `127.0.0.1:3200`. (Creates the proxied apex CNAME → tunnel.)
3. **[CF] DNS → Records**: edit `www` → CNAME `paywiththence.cv`, **Proxied
   (orange)**. **[CF] Rules → Redirect Rules → Create** (*Redirect from WWW
   to root* template): `https://www.paywiththence.cv/*` → `https://paywiththence.cv/${1}`,
   301, preserve query string.
4. Verify (deploy account):
   * `verify-https.ts https://paywiththence.cv --read-only --expect vps` → all PASS
   * `curl -sI https://www.paywiththence.cv/app` → `301` → `https://paywiththence.cv/app`
   * Reconciler timer still `Result=success` (it calls the Vercel URL).
   * Payment status still `paused`; emergency switch still DISABLED.
5. Nimiq Pay Mini App: no change if its URL is already `https://paywiththence.cv`.

## Phase 5 — Make it permanent

1. **[SUDO]** Start on reboot + monitoring:
   ```
   sudo systemctl enable thence-web-production.service thence-tunnel-production.service thence-health-production.timer
   sudo systemctl start thence-health-production.timer
   ```
   The health timer checks `127.0.0.1:3200/api/health` every minute and
   restarts the app only if it is running but unresponsive (a deliberately
   stopped app is left alone; crashes are restarted by `Restart=always`).
   Cloudflare's Tunnel Health Alert covers connector outages.
2. **[SUDO]** Re-install `production.env` without `THENCE_ALLOWED_ORIGINS`;
   **[DEPLOY]** `sudo systemctl restart thence-web-production.service`.
   **[CF]** delete the `vps` public hostname.
3. Keep the Vercel project, its `paywiththence.cv` domain entry and its
   current production deployment untouched for rollback. (Vercel will show
   the domain as misconfigured while DNS points to the tunnel; that is
   expected.)
4. Reboot test (optional, coordinate with the VPS owner because OpenBot
   shares the host): after `sudo reboot`, all three units come back and the
   read-only verifier passes.

## Rollback

| Situation | Action | Who | Time |
|---|---|---|---|
| Bad app release on VPS | `sudo -u thence-prod /opt/thence/bin/thence-deploy production rollback` then `sudo systemctl restart thence-web-production.service` | DEPLOY | ~10 s |
| VPS or tunnel problem after cutover | **[CF]** delete the apex tunnel route/CNAME, re-add `A @ 216.198.79.1` **DNS only**; set `www` back to CNAME `cname.vercel-dns.com` DNS only and disable the redirect rule | CF | ~1–5 min (TTL) |
| Abandon migration entirely | Rollback above, then **[PX]** nameservers back to `ns1/ns2.hola.cv` | PX | hours (NS TTL) |
| Stop VPS production | `sudo systemctl disable --now thence-health-production.timer thence-tunnel-production.service thence-web-production.service` | SUDO | immediate |

Vercel keeps serving from the same database, so a DNS rollback needs no
data migration; signed-in users stay signed in. If the Vercel certificate
for `paywiththence.cv` expired while DNS pointed elsewhere (>~60 days),
Vercel re-issues it within minutes of the A record returning.

## Who does what

| Step | You (Cloudflare / Pxxl) | You (VPS sudo) | Deploy account |
|---|---|---|---|
| 0 | Add zone, records, tunnel, alert | – | – |
| 1 | – | setup apply, production env, tunnel token | build + start, health checks |
| 2 | Nameservers at Pxxl | – | Vercel www redirect (approved), verification |
| 3 | `vps` public hostname | kill/restart test | verification |
| 4 | Apex route, www record + redirect rule | – | verification |
| 5 | Delete `vps` hostname | enable units, env without allowlist | restart, verification |
