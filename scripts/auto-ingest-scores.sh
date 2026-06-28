#!/usr/bin/env bash
# Auto-ingest newly-released DCI scores and publish them to drumcorps.app — no
# manual step. Reacts to shows finishing: when a show has happened in the last day
# and new recaps appear on dci.org, scrape them into sdk/dci-relational.db and
# republish the prod read-model (local A/B hot-swap, ~5s, no restart).
#
# Trigger model: there is no exact "show end time" feed, so we (a) only do work
# when an event is dated within the last day (avoids pointless scrapes on off
# days), and (b) only republish when the scrape actually ADDED score rows
# (count delta) — re-running over already-cached recaps is a cheap no-op.
#
# Runs Node 20 via `vp exec tsx` (system Node 24 crashes on the Node-20 better-sqlite3).
#
# Cron (every 20 min; the gate + cached no-op keep it light):
#   */20 * * * * /root/corps-place/scripts/auto-ingest-scores.sh >> /home/patrick/auto-ingest-scores.log 2>&1
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"
export PATH="$HOME/.vite-plus/bin:$PATH"
SEASON="${SEASON:-2026}"
DB='file:dci-relational.db?mode=ro'

LOCK="/tmp/auto-ingest-scores.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "[auto-ingest $(date -u +%FT%TZ)] another run holds the lock; exiting"; exit 0; }

ts() { date -u +%FT%TZ; }
count_scores() { sqlite3 "$DB" "SELECT COUNT(*) FROM corps_scores;" 2>/dev/null || echo 0; }

# Gate: only proceed if a show is dated within ±1 day (shows post scores within a
# few hours of finishing). Skips quietly on off-days.
recent="$(sqlite3 "$DB" "SELECT COUNT(*) FROM events WHERE season='$SEASON' AND start_date IS NOT NULL AND start_date >= date('now','-1 day') AND start_date <= date('now','+1 day');" 2>/dev/null || echo 0)"
if [ "${recent:-0}" -eq 0 ]; then
  echo "[auto-ingest $(ts)] no show dated within a day — skipping."
  exit 0
fi

before="$(count_scores)"
echo "[auto-ingest $(ts)] recent show(s) present; scraping $SEASON recaps (scores before=$before)…"
if ! out="$(vp exec tsx scripts/scrapeWebsiteRecaps.ts --season="$SEASON" --concurrency=2 2>&1)"; then
  printf '%s\n' "$out" | tail -20
  echo "[auto-ingest $(ts)] scrape FAILED"
  exit 1
fi
printf '%s\n' "$out" | tail -6

after="$(count_scores)"
echo "[auto-ingest $(ts)] scores after=$after (delta=$((after - before)))"

if [ "$after" -gt "$before" ]; then
  echo "[auto-ingest $(ts)] new scores landed — republishing prod read-model…"
  SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2560" bash "$repo_root/scripts/refresh-prod-read-model.sh"
  echo "[auto-ingest $(ts)] published — drumcorps.app updates in ~5s."
else
  echo "[auto-ingest $(ts)] no new scores; nothing to publish."
fi
