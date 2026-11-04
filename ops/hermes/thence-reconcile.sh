#!/usr/bin/env bash
# Thence — external 2-minute trigger for the authenticated server reconciler
# (GET /api/cron/reconcile). Runs on the Hermes VPS under systemd.
#
# PREPARED, NOT INSTALLED. See ops/hermes/README.md.
#
# Safety:
# - The endpoint only reads provider/chain state and advances transfers along
#   evidence-gated edges. It never pays, claims, refunds or releases a preimage.
# - Overlap: flock here (one run per host) + the server's atomic lease
#   (job_leases, 5 min TTL, 30 s spacing) across every caller.
# - The bearer secret is read from a systemd credential file and passed to curl
#   via a header file on stdin — never on the command line, never logged.
# - Bounded: 10 s connect, 75 s total (server maxDuration 60 s), one retry on
#   transient failures only, inside the same 75 s budget.
set -euo pipefail

CONF="${THENCE_RECONCILE_CONF:-/etc/thence/reconcile.conf}"
# shellcheck source=/dev/null
. "$CONF"                                   # sets THENCE_URL (https origin, no trailing slash)
: "${THENCE_URL:?THENCE_URL missing in $CONF}"
case "$THENCE_URL" in https://*) ;; *) echo "refusing: THENCE_URL must be https" >&2; exit 2 ;; esac

SECRET_FILE="${CREDENTIALS_DIRECTORY:-/nonexistent}/cron-secret"
[ -r "$SECRET_FILE" ] || { echo "refusing: cron secret credential not available" >&2; exit 2; }

exec 9>"${RUNTIME_DIRECTORY:-/run/thence-reconcile}/lock"
flock -n 9 || { echo "skip: previous run still active"; exit 0; }

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
status="$(
  { printf 'Authorization: Bearer '; tr -d '\r\n' < "$SECRET_FILE"; printf '\n'; } |
  curl --silent --show-error \
       --connect-timeout 10 --max-time 75 \
       --retry 1 --retry-delay 5 --retry-max-time 70 \
       --header @- \
       --header 'Accept: application/json' \
       --user-agent 'thence-hermes-reconciler/1' \
       --output "$body" --write-out '%{http_code}' \
       "$THENCE_URL/api/cron/reconcile"
)" || status="000"

# One-line, secret-free summary for journald (outcome/counters/error codes only).
summary="$(jq -c '(.reconciler // .) | {outcome, skipReason, candidates, due, reconciled, deferredByBudget, advanced: ((.advanced // []) | length), errors, error}' "$body" 2>/dev/null || echo '{"parse":"failed"}')"
echo "http=$status $summary"

case "$status" in
  200) exit 0 ;;
  401) echo "ALERT: unauthorized — CRON_SECRET mismatch between Hermes and Vercel" >&2; exit 1 ;;
  503) echo "ALERT: endpoint not configured (CRON_SECRET unset) or unavailable" >&2; exit 1 ;;
  *)   echo "ALERT: reconciler call failed" >&2; exit 1 ;;
esac
