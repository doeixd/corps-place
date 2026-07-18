#!/usr/bin/env bash
# Alert admins when a cron job fails. Reuses the proven ingest-run notification
# path (recordIngestRun --alert → admin web-push + throttled email), so silent
# jobs (backups, merch, predictions, v10-shadow) no longer fail unnoticed the way
# the lineup scraper hung for days. Wire in crontab as: `<job> ... || \
#   /usr/bin/bash /root/corps-place/scripts/notify-cron-failure.sh <kind> "<detail>"`.
# Best-effort and non-fatal: never let the notifier itself error a cron line.
set -uo pipefail

KIND="${1:-cron}"
DETAIL="${2:-${KIND} cron job failed}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk" || exit 0

# Load .env so vp/child scripts get DB + push/email creds (cron env is bare) —
# mirrors auto-ingest-scores.sh / catchup-scores.sh.
if [ -f "$repo_root/.env" ]; then
  while IFS= read -r line; do export "$line" 2>/dev/null || true; done \
    < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$repo_root/.env")
fi
export PATH="$HOME/.vite-plus/bin:$PATH"

vp exec tsx scripts/recordIngestRun.ts \
  --status scrape_failed --kind "$KIND" --detail "$DETAIL" --alert 2>&1 || true
