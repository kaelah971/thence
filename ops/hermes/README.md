# Hermes — 2-minute reconciliation trigger (PREPARED, NOT INSTALLED)

Vercel Hobby cron runs at most daily (`vercel.json`: `17 6 * * *`, kept as a
backstop). Hermes calls the same authenticated endpoint every 2 minutes so a
funded payment's state, claim readiness and delivery proof stay current with
no browser open. The endpoint never pays, claims, refunds or releases a
preimage (docs/SERVER_RECONCILER.md, docs/CLAIM_COMPLETION.md).

## Prerequisites (owner-approved, in order)

1. `CRON_SECRET` set in Vercel **Production** (≥ 32 random chars) and
   deployed; migration 0017 (`job_leases`) applied. Until then the endpoint
   answers 503 and this unit logs `ALERT: endpoint not configured`.
2. The production origin (https) for `THENCE_URL`.

## Install (do not run until approved)

```bash
sudo apt-get install -y curl jq util-linux              # flock is in util-linux
sudo useradd --system --no-create-home --shell /usr/sbin/nologin thence-cron
sudo install -d -m 0750 -o root -g root /etc/thence
sudo install -m 0644 thence-reconcile.service thence-reconcile.timer /etc/systemd/system/
sudo install -m 0755 thence-reconcile.sh /usr/local/bin/thence-reconcile.sh
printf 'THENCE_URL=https://<production-origin>\n' | sudo tee /etc/thence/reconcile.conf >/dev/null
sudo chmod 0644 /etc/thence/reconcile.conf
# Secret: paste with an editor, never echo/argv/history. Root-only; systemd
# hands a private copy to the service via LoadCredential.
sudo install -m 0600 -o root -g root /dev/null /etc/thence/cron-secret
sudoedit /etc/thence/cron-secret
sudo systemctl daemon-reload
```

## Verify before enabling the timer

```bash
sudo systemctl start thence-reconcile.service      # one manual run
journalctl -u thence-reconcile.service -n 5 --no-pager
```

Expected: `http=200 {"outcome":"completed",...}` (or `"skipped"` with
`"skipReason":"too-soon"` if another caller ran within 30 s). `http=401`
means the secret differs from Vercel; `http=503` means `CRON_SECRET` is not
deployed. Then:

```bash
sudo systemctl enable --now thence-reconcile.timer
systemctl list-timers thence-reconcile.timer
```

## Operations

- **Health:** `journalctl -u thence-reconcile.service --since "-10 min"` shows
  ~5 runs, each `http=200`. Server side: `job_leases.last_finished_at` for
  `server-reconciler` advances every ~2 min; `last_summary` holds counters.
- **Overlap:** `flock` (per host) + server lease (global). A slow run makes the
  next tick log `skip: previous run still active`; a concurrent Vercel cron
  run makes one of them `skipped/lease-held`.
- **Retries:** one curl retry on transient failure inside a 75 s cap; no other
  retry — the next tick is 2 min away.
- **Stop:** `sudo systemctl disable --now thence-reconcile.timer`. Stopping it
  never affects money; only how fast server state follows the provider.
- **Secret rotation:** update Vercel `CRON_SECRET` → redeploy → `sudoedit
  /etc/thence/cron-secret`; expect a few `http=401` lines in between.
