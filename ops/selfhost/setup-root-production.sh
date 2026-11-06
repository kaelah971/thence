#!/usr/bin/env bash
# Thence self-host — one-time ROOT setup for the PRODUCTION app on this VPS.
# Requires the staging setup (setup-root.sh) to have been applied already:
# it reuses the pinned Node and cloudflared under /opt/thence.
#
#   sudo bash setup-root-production.sh            # dry run: prints what it would do
#   sudo bash setup-root-production.sh --apply    # performs it (idempotent)
#
# What it does (and nothing else):
#   - creates system user/group `thence-prod` (separate from staging's `thence`)
#   - creates /srv/thence-prod/production and /etc/thence-web-prod (root:thence-prod 0750)
#   - installs the updated thence-deploy / thence-env-install helpers
#   - installs production units: web (127.0.0.1:3200), named tunnel (metrics 127.0.0.1:3290),
#     health check + timer, recovery unit — NOT enabled, NOT started
#   - replaces /etc/sudoers.d/thence-deploy with the reviewed staging+production rule
#
# It does NOT: write the production env file or tunnel token (the operator
# installs those), start anything, open ports, touch DNS, Vercel, OpenBot,
# the thence-reconcile timer / thence-cron user / /etc/thence, or the running
# staging units. No payment setting is changed.
set -euo pipefail
umask 022

APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
DEPLOYER="${THENCE_DEPLOYER:-claude-babe}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
run() { echo "+ $*"; if [ "$APPLY" = 1 ]; then "$@"; fi; }

UNITS="thence-web-production.service thence-tunnel-production.service thence-health-production.service thence-health-production.timer thence-web-production-recover.service"

[ "$(id -u)" = 0 ] || { echo "must run as root (sudo)"; exit 1; }
id "$DEPLOYER" >/dev/null 2>&1 || { echo "deploy account $DEPLOYER not found"; exit 1; }
id thence >/dev/null 2>&1 && [ -x /opt/thence/node/bin/node ] && [ -x /opt/thence/bin/cloudflared ] \
  || { echo "staging setup (setup-root.sh --apply) must be applied first"; exit 1; }
for f in thence-deploy thence-env-install sudoers-thence $UNITS; do
  [ -f "$HERE/$f" ] || { echo "missing $HERE/$f"; exit 1; }
done
for p in 3200 3290; do
  if ss -Hltn "sport = :$p" | grep -q . && ! systemctl is-active --quiet thence-web-production.service thence-tunnel-production.service; then
    echo "port $p already in use by something else; refusing"; exit 1
  fi
done
[ "$APPLY" = 1 ] || echo "DRY RUN — re-run with --apply to perform these steps"

# 1. production service user
if ! id thence-prod >/dev/null 2>&1; then
  run useradd --system --user-group --home-dir /srv/thence-prod --create-home --shell /usr/sbin/nologin thence-prod
fi

# 2. directories (production env dir is separate from staging's /etc/thence-web)
run install -d -o thence-prod -g thence-prod -m 0750 /srv/thence-prod /srv/thence-prod/production /srv/thence-prod/production/releases
run install -d -o root -g thence-prod -m 0750 /etc/thence-web-prod

# 3. helpers (staging keeps working: same commands, production target added)
run install -o root -g root -m 0755 "$HERE/thence-deploy"      /opt/thence/bin/thence-deploy
run install -o root -g root -m 0755 "$HERE/thence-env-install" /opt/thence/bin/thence-env-install

# 4. production units
for u in $UNITS; do
  run install -o root -g root -m 0644 "$HERE/$u" "/etc/systemd/system/$u"
done

# 5. sudoers (validated alone, then the whole sudo config re-validated; previous rule restored on failure)
sed "s/@DEPLOYER@/$DEPLOYER/g" "$HERE/sudoers-thence" > "$WORK/sudoers"
visudo -cf "$WORK/sudoers" >/dev/null || { echo "sudoers rule failed validation; refusing" >&2; exit 1; }
echo "+ replace /etc/sudoers.d/thence-deploy for $DEPLOYER (visudo-validated)"
if [ "$APPLY" = 1 ]; then
  [ -f /etc/sudoers.d/thence-deploy ] && cp -p /etc/sudoers.d/thence-deploy "$WORK/sudoers.prev"
  install -o root -g root -m 0440 "$WORK/sudoers" /etc/sudoers.d/thence-deploy
  if ! visudo -c >/dev/null; then
    if [ -f "$WORK/sudoers.prev" ]; then cp -p "$WORK/sudoers.prev" /etc/sudoers.d/thence-deploy; else rm -f /etc/sudoers.d/thence-deploy; fi
    echo "sudo config invalid; previous rule restored" >&2; exit 1
  fi
fi

# 6. load unit files only (nothing is enabled or started)
run systemctl daemon-reload

cat <<EOF

$([ "$APPLY" = 1 ] && echo "Applied." || echo "Dry run only; nothing changed.") Production units are installed but NOT enabled and NOT started.
Next (operator, own sudo — see PRODUCTION_CUTOVER.md):
  sudo /opt/thence/bin/thence-env-install production < production.env
  sudo /opt/thence/bin/thence-env-install tunnel-token-production < tunnel-token.txt
EOF
