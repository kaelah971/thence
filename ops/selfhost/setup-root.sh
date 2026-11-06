#!/usr/bin/env bash
# Thence self-host — one-time ROOT setup for the isolated STAGING app.
#
# Run once, by whoever holds sudo on the VPS, after reading it:
#   sudo bash setup-root.sh            # dry run: prints what it would do
#   sudo bash setup-root.sh --apply    # performs it (idempotent)
#
# What it does (and nothing else):
#   - creates system user/group `thence` (no login shell, home /srv/thence)
#   - installs pinned, SHA256-pinned Node and cloudflared under /opt/thence
#   - creates /srv/thence/staging (app) and /etc/thence-web (env files, root:thence 0750)
#   - installs thence-web-staging.service and thence-tunnel-staging.service
#     (NOT enabled, NOT started)
#   - installs a narrow sudoers rule so the deploy account can deploy and
#     start/stop/enable ONLY these two units
#
# It does NOT: open ports, touch DNS, nginx/caddy, other users' services
# (OpenBot, existing tunnels), the existing thence-reconcile timer, the
# thence-cron user or /etc/thence, apt sources, or any secret. No payment
# setting is changed. Ports used (loopback only): 3100 app, 3190 tunnel metrics.
set -euo pipefail
umask 022

APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
DEPLOYER="${THENCE_DEPLOYER:-claude-babe}"
HERE="$(cd "$(dirname "$0")" && pwd)"

NODE_V=v24.15.0
NODE_SHA256=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
CF_V=2026.10.1
CF_SHA256=3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
run() { echo "+ $*"; if [ "$APPLY" = 1 ]; then "$@"; fi; }
fetch() { # fetch <url> <dest> <sha256>  — download, then refuse unless the hash matches
  echo "+ download $1 (expect sha256 $3)"
  [ "$APPLY" = 1 ] || return 0
  curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  echo "$3  $2" | sha256sum -c --strict - || { echo "CHECKSUM MISMATCH: $1" >&2; exit 1; }
}

[ "$(id -u)" = 0 ] || { echo "must run as root (sudo)"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "expected x86_64"; exit 1; }
id "$DEPLOYER" >/dev/null 2>&1 || { echo "deploy account $DEPLOYER not found"; exit 1; }
for f in thence-deploy thence-env-install thence-web-staging.service thence-tunnel-staging.service sudoers-thence; do
  [ -f "$HERE/$f" ] || { echo "missing $HERE/$f"; exit 1; }
done
for p in 3100 3190; do
  if ss -Hltn "sport = :$p" | grep -q .; then
    if ! systemctl is-active --quiet thence-web-staging.service thence-tunnel-staging.service; then
      echo "port $p already in use by something else; refusing"; exit 1
    fi
  fi
done
[ "$APPLY" = 1 ] || echo "DRY RUN — re-run with --apply to perform these steps"

# 1. service user (separate from the existing thence-cron reconciler user)
if ! id thence >/dev/null 2>&1; then
  run useradd --system --user-group --home-dir /srv/thence --create-home --shell /usr/sbin/nologin thence
fi

# 2. directories
run install -d -o root   -g root   -m 0755 /opt/thence /opt/thence/bin
run install -d -o thence -g thence -m 0750 /srv/thence /srv/thence/staging /srv/thence/staging/releases
run install -d -o root   -g thence -m 0750 /etc/thence-web
if [ ! -e /etc/thence-web/staging.env ]; then
  run install -o root -g thence -m 0640 /dev/null /etc/thence-web/staging.env
fi

# 3. pinned Node (official tarball, SHA256 pinned in this file)
if [ ! -x /opt/thence/node/bin/node ] || [ "$(/opt/thence/node/bin/node -v)" != "$NODE_V" ]; then
  T="node-$NODE_V-linux-x64.tar.xz"
  fetch "https://nodejs.org/dist/$NODE_V/$T" "$WORK/$T" "$NODE_SHA256"
  run rm -rf /opt/thence/node
  run install -d -o root -g root -m 0755 /opt/thence/node
  run tar xJf "$WORK/$T" -C /opt/thence/node --strip-components=1 --no-same-owner --no-same-permissions
fi

# 4. pinned cloudflared (separate from any other account's cloudflared)
if [ ! -x /opt/thence/bin/cloudflared ] || ! /opt/thence/bin/cloudflared --version 2>/dev/null | grep -q "$CF_V"; then
  fetch "https://github.com/cloudflare/cloudflared/releases/download/$CF_V/cloudflared-linux-amd64" "$WORK/cloudflared" "$CF_SHA256"
  run install -o root -g root -m 0755 "$WORK/cloudflared" /opt/thence/bin/cloudflared
fi

# 5. helpers and units (root-owned; the deploy account cannot modify them)
run install -o root -g root -m 0755 "$HERE/thence-deploy"      /opt/thence/bin/thence-deploy
run install -o root -g root -m 0755 "$HERE/thence-env-install" /opt/thence/bin/thence-env-install
run install -o root -g root -m 0644 "$HERE/thence-web-staging.service"    /etc/systemd/system/thence-web-staging.service
run install -o root -g root -m 0644 "$HERE/thence-tunnel-staging.service" /etc/systemd/system/thence-tunnel-staging.service

# 6. sudoers (validated alone, then the whole sudo config re-validated)
sed "s/@DEPLOYER@/$DEPLOYER/g" "$HERE/sudoers-thence" > "$WORK/sudoers"
visudo -cf "$WORK/sudoers" >/dev/null || { echo "sudoers rule failed validation; refusing" >&2; exit 1; }
echo "+ install /etc/sudoers.d/thence-deploy for $DEPLOYER (visudo-validated)"
if [ "$APPLY" = 1 ]; then
  install -o root -g root -m 0440 "$WORK/sudoers" /etc/sudoers.d/thence-deploy
  visudo -c >/dev/null || { rm -f /etc/sudoers.d/thence-deploy; echo "sudo config invalid; rule removed" >&2; exit 1; }
fi

# 7. load unit files only (nothing is enabled or started)
run systemctl daemon-reload

cat <<EOF

$([ "$APPLY" = 1 ] && echo "Applied." || echo "Dry run only; nothing changed.") Units are installed but NOT enabled and NOT started.
Next, as $DEPLOYER (see README.md):
  sudo /opt/thence/bin/thence-env-install staging < staging.env
  sudo -u thence /opt/thence/bin/thence-deploy staging /tmp/thence-<sha>.tgz
  sudo systemctl start thence-web-staging.service
  sudo systemctl start thence-tunnel-staging.service
EOF
