#!/usr/bin/env bash
# Auto-ingest newly-released DCI scores and publish them to drumcorps.app — no
# manual step. Scores post right after a show ends, and we know show start times,
# so this only scrapes in the window AFTER a recent show's estimated end (start +
# 3.5h), polling every few minutes until the recap appears, then idling.
#
# Trigger model: (1) the end-time gate below proceeds only when NOW is in a recent
# show's post-show scoring window AND that show isn't ingested yet; (2) republish
# only when the scrape actually ADDED score rows (count delta) — re-running over
# already-cached recaps is a cheap no-op.
#
# Runs Node 20 via `vp exec tsx` (system Node 24 crashes on the Node-20 better-sqlite3).
#
# Cron (every 5 min; the end-time gate keeps it idle except just after shows end):
#   */5 * * * * /root/corps-place/scripts/auto-ingest-scores.sh >> /home/patrick/auto-ingest-scores.log 2>&1
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"
export PATH="$HOME/.vite-plus/bin:$PATH"

# Load .env for child `vp exec` scripts (cron's env is bare; vp does NOT auto-load
# it). Parse line-by-line WITHOUT `source` so unquoted values containing spaces or
# shell metacharacters (e.g. MAGIC_LINK_FROM="DrumCorps.app <noreply@...>") can't
# break parsing or be evaluated. Without this, notifyScoreSubscribers had no
# RESEND_API_KEY / VAPID_* and silently sent nothing.
if [ -f "$repo_root/.env" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in [A-Za-z_]*) export "$_k=$_v" ;; esac
  done < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$repo_root/.env")
fi
SEASON="${SEASON:-2026}"
DB='file:dci-relational.db?mode=ro'

LOCK="/tmp/auto-ingest-scores.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "[auto-ingest $(date -u +%FT%TZ)] another run holds the lock; exiting"; exit 0; }

ts() { date -u +%FT%TZ; }
count_scores() { sqlite3 "$DB" "SELECT COUNT(*) FROM corps_scores;" 2>/dev/null || echo 0; }
# Does this event have ingested scores? Resolve the competition slug the way the
# read-model does — bare slug, season-prefixed slug, OR the event_to_competition
# bridge — so season-prefixed/renamed competitions still register (review #10).
event_has_scores() {
  local slug="$1"
  sqlite3 "$DB" "SELECT EXISTS(
    SELECT 1 FROM corps_scores WHERE competition_slug='$slug'
    UNION ALL SELECT 1 FROM corps_scores WHERE competition_slug='${SEASON}-$slug'
    UNION ALL SELECT 1 FROM corps_scores cs JOIN event_to_competition etc
      ON etc.competition_slug=cs.competition_slug WHERE etc.event_slug='$slug'
  );" 2>/dev/null || echo 0
}

# Structured per-run report so a score-release run is auditable/alertable instead
# of log-spelunking — distinguishes idle / scrape-failed / published / no-change,
# and records counts + what was regenerated/notified (review Low #12). Written to
# the gitignored sdk/results/ tree; best-effort (never fails the run).
REPORT_DIR="$repo_root/sdk/results/score-ingest-runs"
published=false
regenerated=false
notified=""
write_report() {
  local status="$1"
  mkdir -p "$REPORT_DIR" 2>/dev/null || return 0
  python3 - "$REPORT_DIR/$(date -u +%Y%m%dT%H%M%SZ).json" "$status" "$SEASON" \
    "${before:-}" "${after:-}" "${pending:-}" "$published" "$regenerated" "$notified" <<'PY' || true
import sys, json, datetime
path, status, season, before, after, pending, published, regenerated, notified = sys.argv[1:10]
def num(x):
    try: return int(x)
    except Exception: return None
gate_error = pending == '__GATE_ERR__'
pend = [] if gate_error else [s for s in pending.replace('\n', ' ').split() if s]
b, a = num(before), num(after)
json.dump({
    "ts": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
    "season": season,
    "status": status,            # idle | scrape_failed | published | no_new_scores
    "gate_error": gate_error,
    "pending_events": pend,
    "scores_before": b,
    "scores_after": a,
    "scores_delta": (a - b) if (a is not None and b is not None) else None,
    "published": published == "true",
    "forecasts_regenerated": regenerated == "true",
    "notified_events": [s for s in notified.split() if s],
}, open(path, 'w'), indent=2)
print(f"[auto-ingest] run report -> {path}")
PY
  # Also record the run into contributions.db so /admin shows cron health, and push
  # every registered admin device on a failure. Best-effort: never fail the run.
  vp exec tsx scripts/recordIngestRun.ts \
    --status "$status" --season "$SEASON" \
    --before "${before:-}" --after "${after:-}" \
    --pending "$(printf '%s' "${pending:-}" | tr '\n' ' ')" \
    --published "$published" 2>&1 | sed 's/^/    /' || true
}

# Gate: scrape only when a show's scores should be posting — i.e. NOW is in the
# window after a recent show's estimated end time AND that show isn't ingested yet.
# We know each show's start (events.web_start_time, e.g. "6:00 PM ET") + date;
# estimate end = start + 3.5h and poll from 30 min before that to 6h after. So a
# tight cron only does work right after shows finish. Fail-open on parse errors.
pending="$(python3 - "$SEASON" <<'PY'
import sqlite3, re, sys, datetime
season = sys.argv[1]
OFF = {'ET':-4,'EDT':-4,'EST':-5,'CT':-5,'CDT':-5,'CST':-6,'MT':-6,'MDT':-6,'MST':-7,
       'PT':-7,'PDT':-7,'PST':-8,'AT':-3,'ADT':-3}
db = sqlite3.connect('file:dci-relational.db?mode=ro', uri=True)
now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
out = []
for slug, sd, wst in db.execute(
    "SELECT slug, start_date, web_start_time FROM events "
    "WHERE season=? AND web_start_time IS NOT NULL AND web_start_time!=''", (season,)):
    if not sd:
        continue
    m = re.match(r'\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*([A-Za-z]{2,3})', wst or '')
    if not m:
        continue
    hh, mm, ap, tz = int(m.group(1)), int(m.group(2)), m.group(3).upper(), m.group(4).upper()
    if ap == 'PM' and hh != 12: hh += 12
    if ap == 'AM' and hh == 12: hh = 0
    off = OFF.get(tz)
    if off is None:
        continue
    try:
        local = datetime.datetime.strptime(sd[:10], '%Y-%m-%d').replace(hour=hh, minute=mm)
    except Exception:
        continue
    start_utc = local - datetime.timedelta(hours=off)        # local time -> UTC
    est_end = start_utc + datetime.timedelta(hours=3.5)
    if est_end - datetime.timedelta(minutes=30) <= now <= est_end + datetime.timedelta(hours=6):
        # "Already ingested?" must resolve the competition slug the way the rest of
        # the system does: 2026 score rows land under a season-prefixed or
        # event_to_competition-bridged competition slug, not the bare event slug.
        # Checking only `competition_slug = events.slug` left scored shows looking
        # pending all post-show window (review Medium #10).
        scored = db.execute(
            "SELECT EXISTS("
            " SELECT 1 FROM corps_scores WHERE competition_slug=?"
            " UNION ALL SELECT 1 FROM corps_scores WHERE competition_slug=?"
            " UNION ALL SELECT 1 FROM corps_scores cs JOIN event_to_competition etc"
            "  ON etc.competition_slug=cs.competition_slug WHERE etc.event_slug=?)",
            (slug, season + '-' + slug, slug)).fetchone()[0]
        if not scored:
            out.append(slug)
print('\n'.join(out))
PY
)" || pending="__GATE_ERR__"
if [ "$pending" = "__GATE_ERR__" ]; then
  echo "[auto-ingest $(ts)] gate error — scraping anyway (fail-open)."
elif [ -z "$pending" ]; then
  echo "[auto-ingest $(ts)] no show in its post-show scoring window — skipping."
  write_report idle
  exit 0
else
  echo "[auto-ingest $(ts)] scoring window open for: $(echo "$pending" | tr '\n' ' ')"
fi

before="$(count_scores)"
echo "[auto-ingest $(ts)] recent show(s) present; scraping $SEASON recaps (scores before=$before)…"
if ! out="$(vp exec tsx scripts/scrapeWebsiteRecaps.ts --season="$SEASON" --concurrency=2 2>&1)"; then
  printf '%s\n' "$out" | tail -20
  echo "[auto-ingest $(ts)] scrape FAILED"
  after="$(count_scores)"
  write_report scrape_failed
  exit 1
fi
printf '%s\n' "$out" | tail -6

after="$(count_scores)"
echo "[auto-ingest $(ts)] scores after=$after (delta=$((after - before)))"

if [ "$after" -gt "$before" ]; then
  echo "[auto-ingest $(ts)] new scores landed — backfilling actuals, regenerating future forecasts, then publishing once…"
  # (1) Backfill actuals/errors into saved prediction runs for each newly-scored
  # show (review High #1). Reads the just-ingested DB scores (no extra scrape);
  # #9 makes this fill ALL snapshots for the event. Best-effort per show.
  if [ "$pending" != "__GATE_ERR__" ]; then
    for slug in $pending; do
      [ -z "$slug" ] && continue
      if [ "$(event_has_scores "$slug")" -gt 0 ]; then
        echo "[auto-ingest $(ts)] backfilling actuals for $slug…"
        NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/updateEventPredictionStatus.ts \
          --event "$slug" --season "$SEASON" 2>&1 | sed 's/^/    /' \
          || echo "[auto-ingest $(ts)] backfill failed for $slug (non-fatal)"
      fi
    done
  fi
  # (2) Regenerate FUTURE-only forecasts (score-state aware after #2) WITHOUT its
  # own publish, so the released scores and the updated forecasts ship together in
  # (3) one read-model emit below — closing the "scores live but forecasts stale"
  # gap the review flagged. Best-effort: a regen hiccup must not block publishing.
  echo "[auto-ingest $(ts)] regenerating future forecasts (no publish)…"
  SKIP_PUBLISH=1 bash "$repo_root/scripts/nightly-predictions.sh" 2>&1 | sed 's/^/    /' \
    || echo "[auto-ingest $(ts)] future-forecast regen had failures (non-fatal)"
  regenerated=true
  # (3) Single publish: scores + refreshed forecasts together.
  echo "[auto-ingest $(ts)] publishing prod read-model…"
  SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2560" bash "$repo_root/scripts/refresh-prod-read-model.sh"
  published=true
  echo "[auto-ingest $(ts)] published — drumcorps.app updates in ~5s."
  # Email score-notify subscribers for each pending show that now has scores.
  if [ "$pending" != "__GATE_ERR__" ]; then
    for slug in $pending; do
      [ -z "$slug" ] && continue
      if [ "$(event_has_scores "$slug")" -gt 0 ]; then
        echo "[auto-ingest $(ts)] notifying subscribers for $slug…"
        if vp exec tsx scripts/notifyScoreSubscribers.ts --event "$slug" 2>&1 | sed 's/^/    /'; then
          notified="$notified $slug"
        else
          echo "[auto-ingest $(ts)] notify failed for $slug (non-fatal)"
        fi
      fi
    done
  fi

  # Fantasy standings are a function of the fresh scores, so recompute them right
  # after the read-model swap, then dispatch queued notifications (standings
  # emails/push + any due draft reminders). Without this, standings + their
  # emails lag behind posted scores until a separate cron runs. The endpoints are
  # guarded by FANTASY_CRON_SECRET and hit the live app; best-effort, never fail
  # the ingest over a fantasy hiccup. Short settle so the server has picked up the
  # flipped A/B pointer (~5s poll) before recompute reads the read-model.
  if [ -n "${FANTASY_CRON_SECRET:-}" ]; then
    fantasy_site="${FANTASY_SITE:-https://drumcorps.app}"
    sleep 10
    echo "[auto-ingest $(ts)] recomputing fantasy standings ($SEASON)…"
    curl -fsS -m 120 -X POST "$fantasy_site/api/fantasy/jobs/recompute?season=$SEASON" \
      -H "x-fantasy-cron: $FANTASY_CRON_SECRET" 2>&1 | sed 's/^/    /' \
      || echo "[auto-ingest $(ts)] fantasy recompute failed (non-fatal)"
    echo "[auto-ingest $(ts)] dispatching fantasy notifications…"
    curl -fsS -m 120 -X POST "$fantasy_site/api/fantasy/jobs/dispatch" \
      -H "x-fantasy-cron: $FANTASY_CRON_SECRET" 2>&1 | sed 's/^/    /' \
      || echo "[auto-ingest $(ts)] fantasy dispatch failed (non-fatal)"
  else
    echo "[auto-ingest $(ts)] FANTASY_CRON_SECRET unset — skipping fantasy recompute/dispatch."
  fi
else
  echo "[auto-ingest $(ts)] no new scores; nothing to publish."
fi

# Structured per-run report (review Low #12).
if [ "${after:-0}" -gt "${before:-0}" ]; then
  write_report published
else
  write_report no_new_scores
fi
