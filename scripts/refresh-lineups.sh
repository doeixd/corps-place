#!/usr/bin/env bash
# Refresh event-page LINEUPS/SCHEDULES for the upcoming window, then publish.
#
# Lineups (event_lineup_entries / event_participants / schedules) are DERIVED from
# the event_page_scrapes archive. DCI announces & edits participation throughout
# the season, and the 5-min score cron does NOT touch lineups — so this daily job
# keeps them current for upcoming shows. It scrapes only a rolling window (recent +
# next N days) to stay cheap on the small box.
#
# Pipeline: scrape event pages (Browserbase-rendered, bypasses Cloudflare) →
# archive → re-derive lineups from the archive → backfills → FAST seeded read-model
# publish (--only events). Corps appearances catch up in the nightly full emit.
#
# Cron (daily, off-peak, before the day's shows):
#   45 4 * * * /root/corps-place/scripts/refresh-lineups.sh >> /home/patrick/refresh-lineups.log 2>&1
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"
export PATH="$HOME/.vite-plus/bin:$PATH"

# Load .env for child scripts (Browserbase/VAPID/etc.). Line-by-line, NOT `source`
# — values may contain spaces/metacharacters (mirrors auto-ingest-scores.sh).
if [ -f "$repo_root/.env" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in [A-Za-z_]*) export "$_k=$_v" ;; esac
  done < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$repo_root/.env")
fi
SEASON="${SEASON:-2026}"
UPCOMING_DAYS="${UPCOMING_DAYS:-21}"   # window: recent (7d) + next N days
DB='file:dci-relational.db?mode=ro'

LOCK="/tmp/refresh-lineups.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "[lineups $(date -u +%FT%TZ)] another run holds the lock; exiting"; exit 0; }

ts() { date -u +%FT%TZ; }
# Count lineup entries for the season — the change signal + the run-report metric.
count_lineups() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM event_lineup_entries ele
    JOIN events e ON e.slug = ele.event_slug
    WHERE e.season='$SEASON' OR strftime('%Y', e.start_date)='$SEASON';" 2>/dev/null || echo 0
}

errors=""
published=false
scrape_ok=true
before="$(count_lineups)"
echo "[lineups $(ts)] starting — season=$SEASON window=+${UPCOMING_DAYS}d (lineup entries before=$before)"

# (1) Scrape event pages in the upcoming window (Browserbase render bypasses the
# Cloudflare block). Heap-capped. On failure we record/alert at the end and skip
# the publish (no new data to ship) but still let the idempotent re-derive run.
if ! NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/scrapeEventPages.ts \
      --season="$SEASON" --upcoming-days="$UPCOMING_DAYS" 2>&1 | sed 's/^/    /'; then
  echo "[lineups $(ts)] event-page scrape FAILED (non-fatal; publish will be skipped)"
  errors="scrape-failed"
  scrape_ok=false
fi

# (2) Re-derive lineups from the freshly archived scrapes (idempotent, no re-fetch).
echo "[lineups $(ts)] ingesting lineups from scrapes…"
NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/ingestLineupsFromScrapes.ts --season "$SEASON" 2>&1 | sed 's/^/    /' \
  || { echo "[lineups $(ts)] lineup ingest failed (non-fatal)"; errors="$errors ingest-failed"; }

# (3) Backfills that enrich the derived rows (all idempotent, best-effort).
for step in \
  "backfillEventLineupIsNonPerformance.ts" \
  "backfillPerformanceOrder.ts" \
  "backfillEventVenues.ts" \
  "backfillEventGroupTypes.ts" \
  "backfillLineupClassification.ts --apply"; do
  echo "[lineups $(ts)] backfill: $step"
  # shellcheck disable=SC2086
  NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/$step 2>&1 | sed 's/^/    /' \
    || { echo "[lineups $(ts)] backfill $step failed (non-fatal)"; errors="$errors backfill-failed:${step%% *}"; }
done

after="$(count_lineups)"
echo "[lineups $(ts)] lineup entries after=$after (delta=$((after - before)))"

# (4) FAST publish so lineup/schedule changes go live (~25s seeded emit of the
# events section). Always publish after a successful scrape — content can change
# without the row COUNT changing — but skip if the scrape failed (nothing new).
if [ "$scrape_ok" = true ]; then
  echo "[lineups $(ts)] publishing lineups (events section, seeded)…"
  if SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2048" \
       bash "$repo_root/scripts/refresh-prod-read-model.sh" --only events --seed-active 2>&1 | sed 's/^/    /'; then
    published=true
    echo "[lineups $(ts)] published — lineups live in ~5s."
  else
    echo "[lineups $(ts)] lineup publish FAILED"
    errors="$errors publish-failed"
  fi
else
  echo "[lineups $(ts)] skipping publish (scrape failed)."
fi

# (5) Record the run (visible in /admin/jobs) + push admins on any failure.
status=$([ -n "$errors" ] && echo lineups_error || echo lineups_ok)
alert_flag=""; [ -n "$errors" ] && alert_flag="--alert"
vp exec tsx scripts/recordIngestRun.ts \
  --kind lineup-refresh --status "$status" --season "$SEASON" \
  --before "$before" --after "$after" --published "${published:-false}" \
  --detail "${errors# }" $alert_flag 2>&1 | sed 's/^/    /' || true

echo "[lineups $(ts)] done."
