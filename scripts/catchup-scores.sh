#!/usr/bin/env bash
# Daily catch-up for LATE-POSTED scores. The every-3-min auto-ingest only polls
# while a show is inside its post-show scoring window (bounded at ~12h); a recap
# DCI posts later than that would otherwise never ingest (observed 2026-07-12:
# DCI Little Rock still unposted 13h after the show — if it appears tomorrow,
# only this job will catch it). One full-season recap scrape per day; when new
# scores land, fast-publish + notify subscribers for exactly the events that
# gained scores. Predictions/backfill catch up on the next nightly run.
#
# Cron (root + patrick):  0 16 * * *  (11am CT — after any morning postings,
# well before the evening shows open their windows).
set -uo pipefail

exec 9>/tmp/catchup-scores.lock
flock -n 9 || { echo "[catchup $(date -u +%FT%TZ)] another run holds the lock; exiting"; exit 0; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"
# Load .env for child vp exec scripts (cron env is bare) — mirrors auto-ingest.
if [ -f "$repo_root/.env" ]; then
  while IFS= read -r line; do export "$line" 2>/dev/null || true; done \
    < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$repo_root/.env")
fi
export PATH="$HOME/.vite-plus/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=1536"

ts() { date -u +%FT%TZ; }
season="$(date +%Y)"
DB=./dci-relational.db

scored_slugs() {
  sqlite3 "$DB" "SELECT DISTINCT competition_slug FROM corps_scores WHERE competition_slug LIKE '${season}-%' ORDER BY 1" 2>/dev/null
}

before_file=$(mktemp) after_file=$(mktemp)
trap 'rm -f "$before_file" "$after_file"' EXIT
scored_slugs > "$before_file"

echo "[catchup $(ts)] full-season recap scrape (season=$season)…"
scrape_out=$(mktemp)
timeout -k 30 900 vp exec tsx scripts/scrapeWebsiteRecaps.ts --season="$season" >"$scrape_out" 2>&1
scrape_rc=$?
tail -5 "$scrape_out"
# The scraper can complete its work ("Done!") but keep the event loop alive on
# lingering browser handles until the timeout kills it (rc 124) — that's a
# SUCCESS. Only treat it as failed when the completion marker never printed.
if [ $scrape_rc -ne 0 ] && ! grep -q "^Done!$" "$scrape_out"; then
  echo "[catchup $(ts)] scrape failed (rc=$scrape_rc, non-fatal — next daily run retries)"
  vp exec tsx scripts/recordIngestRun.ts --status scrape_failed --kind score-catchup \
    --season "$season" --detail "daily catch-up scrape failed (rc=$scrape_rc)" || true
  rm -f "$scrape_out"
  exit 0
fi
rm -f "$scrape_out"

scored_slugs > "$after_file"
new_slugs=$(comm -13 "$before_file" "$after_file")

if [ -z "$new_slugs" ]; then
  echo "[catchup $(ts)] no late-posted scores found."
  vp exec tsx scripts/recordIngestRun.ts --status no_new_scores --kind score-catchup \
    --season "$season" --detail "daily catch-up: nothing new" || true
  exit 0
fi

echo "[catchup $(ts)] late scores landed for:" $new_slugs
SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2048" \
  bash "$repo_root/scripts/refresh-prod-read-model.sh" --only events,recaps,home,rankings --seed-active \
  || echo "[catchup $(ts)] publish failed (next nightly full emit will publish)"

for slug in $new_slugs; do
  vp exec tsx scripts/notifyScoreSubscribers.ts --event "$slug" 2>&1 | sed 's/^/    /' \
    || echo "[catchup $(ts)] notify failed for $slug (non-fatal)"
done

vp exec tsx scripts/recordIngestRun.ts --status published --kind score-catchup \
  --season "$season" --published true --detail "late scores: $(echo $new_slugs | tr '\n' ' ')" || true
echo "[catchup $(ts)] done."
