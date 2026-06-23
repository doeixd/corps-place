#!/usr/bin/env bash
# Admin job worker (ADMIN_PAGE_PLAN §5). Runs ON THE VM, where sdk/ and
# dci-relational.db exist. Claims 'queued' rows from admin_jobs in contributions.db,
# runs the mapped `npx tsx` script, and streams status/stdout/stderr back into the row.
#
# The web/serving container CANNOT run this (no sdk/scripts, no tsx) — that's the
# whole point of the enqueue/worker split.
#
# Install as a cron entry on the VM (every minute; flock prevents overlap so a long
# job like fine_tune won't be double-started):
#   * * * * * /root/corps-place/scripts/admin-job-worker.sh >> /var/log/admin-jobs.log 2>&1
#
# Env:
#   ADMIN_JOBS_DB   path to contributions.db   (default /data/corps-place/contributions.db)
#   REPO_DIR        repo root                  (default /root/corps-place)
set -euo pipefail

DB="${ADMIN_JOBS_DB:-/data/corps-place/contributions.db}"
REPO_DIR="${REPO_DIR:-/root/corps-place}"
SDK_DIR="$REPO_DIR/sdk"
WORKER_ID="$(hostname)-$$"
LOCK="/tmp/admin-job-worker.lock"

# Single worker at a time = global write mutex (no two SQLite writers; §5.5).
exec 9>"$LOCK"
flock -n 9 || { echo "another worker holds the lock; exiting"; exit 0; }

sq() { sqlite3 "$DB" "$@"; }
esc() { printf "%s" "$1" | sed "s/'/''/g"; } # SQL-escape single quotes

# Map kind (+ args JSON) → the command to run in sdk/. Keep in sync with
# app/lib/admin-jobs.ts JOB_KINDS.
cmd_for() {
  local kind="$1" args="$2"
  case "$kind" in
    season_update)        echo "npx tsx scripts/seasonUpdateWorkflow.ts --season 2026" ;;
    scrape_corps)         echo "npx tsx scripts/scrapeCorps.ts --apply" ;;
    scrape_event_pages)   echo "npx tsx scripts/scrapeEventPages.ts" ;;
    scrape_recaps)        echo "npx tsx scripts/scrapeWebsiteRecaps.ts" ;;
    ingest_lineups)       echo "npx tsx scripts/ingestLineupsFromScrapes.ts" ;;
    generate_predictions) echo "$REPO_DIR/scripts/nightly-predictions.sh" ;;
    regenerate_event)
      local slug; slug="$(printf '%s' "$args" | sed -n 's/.*"event"[: ]*"\([^"]*\)".*/\1/p')"
      [ -n "$slug" ] || { echo "__ERR__ regenerate_event needs args.event"; return; }
      echo "npx tsx scripts/predictEventRecap.ts --event $slug --season 2026 --save-db --force-refresh" ;;
    fine_tune)            echo "npx tsx src/training/trainModelV9Subcaption-fixed.ts --load-model latest --trial-id cron_$(date +%s)" ;;
    *)                    echo "__ERR__ unknown kind: $kind" ;;
  esac
}

process_one() {
  # Atomically claim the oldest queued job.
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sq "BEGIN IMMEDIATE;
      UPDATE admin_jobs SET status='running', claimed_by='$(esc "$WORKER_ID")', started_at='$now'
      WHERE job_id = (SELECT job_id FROM admin_jobs WHERE status='queued' ORDER BY queued_at LIMIT 1);
      COMMIT;"
  local job; job="$(sq "SELECT job_id FROM admin_jobs WHERE status='running' AND claimed_by='$(esc "$WORKER_ID")' ORDER BY started_at LIMIT 1;")"
  [ -n "$job" ] || return 1   # nothing to do

  local kind args cmd; kind="$(sq "SELECT kind FROM admin_jobs WHERE job_id='$job';")"
  args="$(sq "SELECT COALESCE(args_json,'') FROM admin_jobs WHERE job_id='$job';")"
  cmd="$(cmd_for "$kind" "$args")"
  echo "[worker] $job $kind -> $cmd"

  local out fin code
  out="$(mktemp)"
  if [[ "$cmd" == __ERR__* ]]; then
    code=2; echo "${cmd#__ERR__ }" >"$out"
  else
    ( cd "$SDK_DIR" && bash -lc "$cmd" ) >"$out" 2>&1 && code=0 || code=$?
  fi
  fin="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local status; [ "$code" -eq 0 ] && status=success || status=failed
  # Keep only the tail to bound row growth.
  local tail; tail="$(tail -c 60000 "$out")"
  sq "UPDATE admin_jobs SET status='$status', finished_at='$fin', exit_code=$code,
         stdout='$(esc "$tail")', error_message=$([ "$code" -eq 0 ] && echo NULL || echo "'exit $code'")
      WHERE job_id='$job';"
  rm -f "$out"
  return 0
}

# Drain the queue this invocation (still one-at-a-time).
while process_one; do :; done
