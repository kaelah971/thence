# Self-hosted staging (Linux VPS, systemd)

> Production on the VPS (named tunnel, `thence-prod`, port 3200) is set up by
> `setup-root-production.sh`; the full plan, DNS migration and rollback are in
> [PRODUCTION_CUTOVER.md](PRODUCTION_CUTOVER.md). HTTPS checks:
> `npx tsx --tsconfig tsconfig.json ops/selfhost/verify-https.ts <url> [--read-only] [--expect vps|vercel]`.

An isolated **staging** copy of the Thence Next.js app. Production stays on
Vercel. Payments are off on staging and cannot be turned on by these files.

## Layout

| Item | Where | Owner |
|---|---|---|
| Service user | `thence` (system, no login shell) | root creates |
| Node (pinned v24.15.0, SHASUMS-verified) | `/opt/thence/node` | root |
| cloudflared (pinned 2026.10.1, SHA256-verified) | `/opt/thence/bin/cloudflared` | root |
| Releases, `current` symlink | `/srv/thence/staging` | `thence` |
| Env file (staging DB, `THENCE_PAYMENTS_MODE=off`) | `/etc/thence-web/staging.env`, `root:thence 0640` | root |
| App | `thence-web-staging.service`, `127.0.0.1:3100` only | systemd |
| HTTPS | `thence-tunnel-staging.service`, Cloudflare quick tunnel | systemd |

The app unit refuses to start unless `DATABASE_URL` carries the test anchor
(`scripts/assert-nonprod-db.ts`), so staging can never run on the production
database. It is memory- and CPU-capped and sandboxed (`ProtectSystem=strict`,
no capabilities, loopback bind). No inbound port is opened.

## One-time root setup

```bash
sudo bash setup-root.sh           # dry run, prints every step
sudo bash setup-root.sh --apply   # idempotent
```

Both downloads are checked against SHA256 values pinned in the script. Units
are installed but not enabled or started. It also installs
`/etc/sudoers.d/thence-deploy`, which lets the deploy account run only:
`thence-deploy` (as `thence`), `thence-env-install staging`, and
start/stop/restart/enable/disable/reset-failed/last-200-log-lines of the two
staging units, each with exact arguments.

## Deploy (deploy account, no full sudo)

```bash
# 1. env (refused unless THENCE_PAYMENTS_MODE=off, https origin, no pilot flag)
sudo /opt/thence/bin/thence-env-install staging < staging.env
# 2. release built from a git archive (no .env inside; refused otherwise)
sudo -u thence /opt/thence/bin/thence-deploy staging /tmp/thence-<sha>.tgz
# 3. start (each unit separately; the sudoers rule lists exact commands)
sudo systemctl start thence-web-staging.service
sudo systemctl start thence-tunnel-staging.service
curl -s http://127.0.0.1:3190/quicktunnel     # -> {"hostname":"<random>.trycloudflare.com"}
```

Set `THENCE_APP_ORIGIN` to that `https://` hostname (re-run step 1, restart the
app). The quick-tunnel hostname changes whenever the tunnel restarts; it is for
staging verification only. A stable hostname needs a named tunnel on a
Cloudflare-managed zone (a DNS decision, not made here).

Only after staging is verified, make it survive reboots:
`sudo systemctl enable thence-web-staging.service` (and the tunnel unit).

## Rollback

```bash
sudo systemctl stop thence-tunnel-staging.service
sudo systemctl stop thence-web-staging.service
```

Nothing else on the host depends on these units.

## Measured on the target VPS (4 vCPU, 7.8 GiB)

`npm ci` 26 s / 650 MB peak; `next build` 57 s / 1.45 GB peak; running
server ~145 MB RSS.
