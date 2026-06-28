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
        if db.execute("SELECT COUNT(*) FROM corps_scores WHERE competition_slug=?", (slug,)).fetchone()[0] == 0:
            out.append(slug)
print('\n'.join(out))
PY
)" || pending="__GATE_ERR__"
if [ "$pending" = "__GATE_ERR__" ]; then
  echo "[auto-ingest $(ts)] gate error — scraping anyway (fail-open)."
elif [ -z "$pending" ]; then
  echo "[auto-ingest $(ts)] no show in its post-show scoring window — skipping."
  exit 0
else
  echo "[auto-ingest $(ts)] scoring window open for: $(echo "$pending" | tr '\n' ' ')"
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
  # Email score-notify subscribers for each pending show that now has scores.
  if [ "$pending" != "__GATE_ERR__" ]; then
    for slug in $pending; do
      [ -z "$slug" ] && continue
      if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM corps_scores WHERE competition_slug='$slug';" 2>/dev/null || echo 0)" -gt 0 ]; then
        echo "[auto-ingest $(ts)] notifying subscribers for $slug…"
        vp exec tsx scripts/notifyScoreSubscribers.ts --event "$slug" 2>&1 | sed 's/^/    /' \
          || echo "[auto-ingest $(ts)] notify failed for $slug (non-fatal)"
      fi
    done
  fi
else
  echo "[auto-ingest $(ts)] no new scores; nothing to publish."
fi
