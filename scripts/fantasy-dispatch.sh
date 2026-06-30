#!/usr/bin/env bash
# Periodic Fantasy DCI dispatcher. Hits the live app's guarded dispatch endpoint,
# which (idempotently) starts due scheduled drafts, sends due draft reminders, and
# flushes queued standings/season-complete notifications (email + push). This is
# the time-based companion to auto-ingest-scores.sh: score ingest is the PRIMARY
# standings-recompute trigger, but draft reminders fire on the clock, so they need
# a steady cron regardless of whether new scores landed.
#
# Cron (every 5 min):
#   */5 * * * * /usr/bin/bash /root/corps-place/scripts/fantasy-dispatch.sh >> /home/patrick/fantasy-dispatch.log 2>&1
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
ts() { date -u +%FT%TZ; }

# Load .env (cron's env is bare). Parse line-by-line WITHOUT `source` so unquoted
# values with spaces/metacharacters can't break parsing — same approach as
# auto-ingest-scores.sh.
if [ -f "$repo_root/.env" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in [A-Za-z_]*) export "$_k=$_v" ;; esac
  done < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$repo_root/.env")
fi

if [ -z "${FANTASY_CRON_SECRET:-}" ]; then
  echo "[fantasy-dispatch $(ts)] FANTASY_CRON_SECRET unset — nothing to do."
  exit 0
fi

SITE="${FANTASY_SITE:-https://drumcorps.app}"

# Single-flight: never overlap with a previous slow run.
LOCK="/tmp/fantasy-dispatch.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "[fantasy-dispatch $(ts)] another run holds the lock; exiting"; exit 0; }

echo "[fantasy-dispatch $(ts)] dispatching…"
curl -fsS -m 120 -X POST "$SITE/api/fantasy/jobs/dispatch" \
  -H "x-fantasy-cron: $FANTASY_CRON_SECRET" 2>&1 | sed 's/^/    /' \
  || { echo "[fantasy-dispatch $(ts)] dispatch failed"; exit 1; }
echo "[fantasy-dispatch $(ts)] done."
