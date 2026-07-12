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
# Accumulates space-separated tags for any non-fatal step that failed (publish,
# notify, backfill, forecast, fantasy). A non-empty value makes write_report both
# record the detail AND fire the admin push, so partial failures aren't silent.
errors=""
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
  # every registered admin device on a failure. Best-effort: never fail the run. A
  # scrape_failed status alerts on its own; any accumulated step errors force an
  # alert too (so a stale-standings / failed-publish run still pages an admin).
  local alert_flag=""
  [ -n "$errors" ] && alert_flag="--alert"
  vp exec tsx scripts/recordIngestRun.ts \
    --status "$status" --season "$SEASON" \
    --before "${before:-}" --after "${after:-}" \
    --pending "$(printf '%s' "${pending:-}" | tr '\n' ' ')" \
    --published "$published" \
    --detail "${errors# }" \
    $alert_flag 2>&1 | sed 's/^/    /' || true
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
    # Completeness gate (fixes partial ingestion). The event used to drop out of
    # the window as soon as ANY score existed — so when Open Class posted first,
    # the later World Class scores never triggered a re-scrape and the site showed
    # a phantom field (e.g. 2026-dci-west: 5 Open + 5 World stranded). We re-scrape
    # until the COMPETITIVE field is complete. Expected = the announced performing
    # lineup minus SoundSport (DCI's non-ranked division, which reliably never
    # scores) and exhibition/non-corps.
    expected = db.execute(
        "SELECT COUNT(DISTINCT corps_key) FROM classified_event_lineup"
        " WHERE event_slug=? AND effective_is_non_performance=0 AND is_non_corps=0"
        "   AND COALESCE(is_exhibition,0)=0 AND corps_key IS NOT NULL AND corps_key!=''"
        "   AND COALESCE(division_name,'') NOT LIKE '%SoundSport%'",
        (slug,)).fetchone()[0]
    # When do scores actually post? Use the PUBLISHED SCHEDULE we've already
    # ingested, not a flat start+3.5h guess. Each lineup row carries a local clock
    # time (last corps, encore, and usually a literal "Scores Announced" row); the
    # LATEST of them ≈ when results go up. A flat estimate opened the window up to
    # an hour after a small regional's scores were already live. Fall back to a
    # field-size estimate (~13 min/corps + 40, clamped 1–4h) when no times exist.
    sched = []
    for (t,) in db.execute(
        "SELECT time FROM classified_event_lineup WHERE event_slug=? AND time IS NOT NULL AND time!=''",
        (slug,)):
        tm = re.match(r'\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])', t or '')
        if not tm:
            continue
        th, tmin, tap = int(tm.group(1)), int(tm.group(2)), tm.group(3).upper()
        if tap == 'PM' and th != 12: th += 12
        if tap == 'AM' and th == 12: th = 0
        cand = local.replace(hour=th, minute=tmin)          # event date @ this row's time
        # An AM row for an evening show is past midnight → next day. (A pre-show PM
        # row like "Gates Open 6:00 PM" stays same-day — don't bump it.)
        if tap == 'AM' and hh >= 12: cand += datetime.timedelta(days=1)
        sched.append(cand)
    if sched:
        est_end = max(sched) - datetime.timedelta(hours=off)  # last scheduled local -> UTC
        lead = datetime.timedelta(minutes=15)                 # open just before scores post
    else:
        dur_min = min(max(expected * 13 + 40, 60), 240) if expected > 0 else 210
        est_end = start_utc + datetime.timedelta(minutes=dur_min)
        lead = datetime.timedelta(minutes=45)
    if est_end - lead <= now <= est_end + datetime.timedelta(hours=12):
        scored = db.execute(
            "SELECT COUNT(DISTINCT corps_key) FROM ("
            " SELECT corps_key FROM corps_scores WHERE competition_slug=?"
            " UNION SELECT corps_key FROM corps_scores WHERE competition_slug=?"
            " UNION SELECT cs.corps_key FROM corps_scores cs JOIN event_to_competition etc"
            "  ON etc.competition_slug=cs.competition_slug WHERE etc.event_slug=?)",
            (slug, season + '-' + slug, slug)).fetchone()[0]
        incomplete = (scored < expected) if expected > 0 else (scored == 0)
        if incomplete:
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
# Scope the scrape to the pending show(s) when the gate identified them, so we
# fetch just that recap instead of re-scraping the whole season's recaps every
# poll — faster, and it avoids incidentally touching unrelated freshly-posted
# pages (a class of hang). On a fail-open (gate error) we don't know the show, so
# fall back to a full-season scrape.
slugs_arg=""
if [ -n "$pending" ] && [ "$pending" != "__GATE_ERR__" ]; then
  slugs_csv="$(printf '%s' "$pending" | tr '\n' ',' | sed 's/,,*/,/g; s/^,//; s/,$//')"
  [ -n "$slugs_csv" ] && slugs_arg="--slugs=$slugs_csv"
fi
echo "[auto-ingest $(ts)] recent show(s) present; scraping $SEASON recaps${slugs_arg:+ (only: $slugs_csv)} (scores before=$before)…"
# Hard timeout on the scrape: a Browserbase fetch of a freshly-posted (uncached)
# recap can HANG indefinitely (browser session never responds, no internal
# timeout) — that stalls the whole ingest and holds the flock lock, so every
# subsequent poll just exits and scores never land. Cap it at 5 min (normal runs
# are seconds; a couple of new-page Browserbase fetches take 1-3 min) and SIGKILL
# 30s after SIGTERM. On timeout we treat it as a scrape failure and exit; the next
# cron run retries with a fresh session.
if ! out="$(timeout -k 30 300 vp exec tsx scripts/scrapeWebsiteRecaps.ts --season="$SEASON" --concurrency=2 ${slugs_arg} 2>&1)"; then
  rc=$?
  printf '%s\n' "$out" | tail -20
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "[auto-ingest $(ts)] scrape TIMED OUT after 5m (hung fetch) — killed; next run retries"
  else
    echo "[auto-ingest $(ts)] scrape FAILED (rc=$rc)"
  fi
  after="$(count_scores)"
  write_report scrape_failed
  exit 1
fi
printf '%s\n' "$out" | tail -6

after="$(count_scores)"
echo "[auto-ingest $(ts)] scores after=$after (delta=$((after - before)))"

if [ "$after" -gt "$before" ]; then
  echo "[auto-ingest $(ts)] new scores landed (delta=$((after - before))) — fast-publishing, then backfill/forecast + full publish…"

  # (1) FAST PUBLISH — get the raw scores live ASAP. A seeded incremental emit
  # rebuilds only the light sections (events/recaps/home/rankings, ~30s) from the
  # current live slot instead of the full ~208s emit (dominated by the ~179s corps
  # rebuild). Event pages, home "latest results", /rankings and the scored badge
  # go live in ~5s. Corps pages and predictions catch up in the full emit (5).
  # Non-fatal: if the fast path fails, the full emit still publishes everything.
  echo "[auto-ingest $(ts)] fast-publishing scores (events,recaps,home,rankings)…"
  if SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2048" \
       bash "$repo_root/scripts/refresh-prod-read-model.sh" --only events,recaps,home,rankings --seed-active 2>&1 | sed 's/^/    /'; then
    echo "[auto-ingest $(ts)] scores live in ~5s — corps/predictions to follow."
  else
    echo "[auto-ingest $(ts)] fast publish FAILED (non-fatal; full emit still runs)"
    errors="$errors fast-publish-failed"
  fi

  # (2) Notify score-notify subscribers now that the scores are live.
  if [ "$pending" != "__GATE_ERR__" ]; then
    for slug in $pending; do
      [ -z "$slug" ] && continue
      if [ "$(event_has_scores "$slug")" -gt 0 ]; then
        echo "[auto-ingest $(ts)] notifying subscribers for $slug…"
        if vp exec tsx scripts/notifyScoreSubscribers.ts --event "$slug" 2>&1 | sed 's/^/    /'; then
          notified="$notified $slug"
        else
          echo "[auto-ingest $(ts)] notify failed for $slug (non-fatal)"
          errors="$errors notify-failed:$slug"
        fi
      fi
    done
  fi

  # (3) Backfill actuals/errors into saved prediction runs for each newly-scored
  # show. Reads the just-ingested DB scores (no extra scrape). Best-effort per show.
  if [ "$pending" != "__GATE_ERR__" ]; then
    for slug in $pending; do
      [ -z "$slug" ] && continue
      if [ "$(event_has_scores "$slug")" -gt 0 ]; then
        echo "[auto-ingest $(ts)] backfilling actuals for $slug…"
        NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/updateEventPredictionStatus.ts \
          --event "$slug" --season "$SEASON" 2>&1 | sed 's/^/    /' \
          || { echo "[auto-ingest $(ts)] backfill failed for $slug (non-fatal)"; errors="$errors backfill-failed:$slug"; }
      fi
    done
  fi

  # (4) Regenerate FUTURE-only forecasts WITHOUT their own publish — the full emit
  # (5) ships the released scores + refreshed forecasts together. Best-effort.
  echo "[auto-ingest $(ts)] regenerating future forecasts (no publish)…"
  if SKIP_PUBLISH=1 bash "$repo_root/scripts/nightly-predictions.sh" 2>&1 | sed 's/^/    /'; then
    regenerated=true
  else
    echo "[auto-ingest $(ts)] future-forecast regen had failures (non-fatal)"
    errors="$errors forecast-regen-failed"
  fi

  # (5) FULL PUBLISH — corps/rankings/predictions + everything, live. Guarded so an
  # emit failure is recorded + alerted (was an unguarded `set -e` abort that skipped
  # the run report entirely). If this fails, the fast-published scores are still up.
  echo "[auto-ingest $(ts)] publishing full read-model…"
  if SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2560" \
       bash "$repo_root/scripts/refresh-prod-read-model.sh" 2>&1 | sed 's/^/    /'; then
    published=true
    echo "[auto-ingest $(ts)] full read-model published — drumcorps.app fully updated in ~5s."
  else
    echo "[auto-ingest $(ts)] FULL PUBLISH FAILED — scores may be live from the fast publish, corps/predictions stale."
    errors="$errors full-publish-failed"
  fi

  # (6) Fantasy standings are a function of the fresh scores, so recompute them
  # after the swap, then dispatch queued notifications (standings emails/push + due
  # draft reminders). Guarded by FANTASY_CRON_SECRET; best-effort. Short settle so
  # the server has picked up the flipped A/B pointer (~5s poll) before recompute.
  if [ -n "${FANTASY_CRON_SECRET:-}" ]; then
    fantasy_site="${FANTASY_SITE:-https://drumcorps.app}"
    sleep 10
    echo "[auto-ingest $(ts)] recomputing fantasy standings ($SEASON)…"
    curl -fsS -m 120 -X POST "$fantasy_site/api/fantasy/jobs/recompute?season=$SEASON" \
      -H "x-fantasy-cron: $FANTASY_CRON_SECRET" 2>&1 | sed 's/^/    /' \
      || { echo "[auto-ingest $(ts)] fantasy recompute failed (non-fatal)"; errors="$errors fantasy-recompute-failed"; }
    echo "[auto-ingest $(ts)] dispatching fantasy notifications…"
    curl -fsS -m 120 -X POST "$fantasy_site/api/fantasy/jobs/dispatch" \
      -H "x-fantasy-cron: $FANTASY_CRON_SECRET" 2>&1 | sed 's/^/    /' \
      || { echo "[auto-ingest $(ts)] fantasy dispatch failed (non-fatal)"; errors="$errors fantasy-dispatch-failed"; }
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
