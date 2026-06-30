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
# Expose `vp` (vite-plus) so cmd_for's `vp exec tsx` runs under the SDK's pinned
# Node 20 — NOT the system Node 24, which crashes on the Node-20-built better-sqlite3.
export PATH="$HOME/.vite-plus/bin:$PATH"
WORKER_ID="$(hostname)-$$"
LOCK="/tmp/admin-job-worker.lock"

# Single worker at a time = global write mutex (no two SQLite writers; §5.5).
exec 9>"$LOCK"
flock -n 9 || { echo "another worker holds the lock; exiting"; exit 0; }

sq() { sqlite3 "$DB" "$@"; }
esc() { printf "%s" "$1" | sed "s/'/''/g"; } # SQL-escape single quotes
# Defense-in-depth (C1): args are also whitelisted server-side at enqueue, but never
# interpolate an unvalidated value into a command. Returns 0 iff value is safe.
safe_arg() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]+$'; }

# Map kind (+ args JSON) → the command to run in sdk/. Keep in sync with
# app/lib/admin-jobs.ts JOB_KINDS.
cmd_for() {
  local kind="$1" args="$2"
  case "$kind" in
    season_update)        echo "vp exec tsx scripts/seasonUpdateWorkflow.ts --season 2026" ;;
    scrape_corps)         echo "vp exec tsx scripts/scrapeCorps.ts --apply" ;;
    scrape_event_pages)   echo "vp exec tsx scripts/scrapeEventPages.ts" ;;
    scrape_recaps)        echo "vp exec tsx scripts/scrapeWebsiteRecaps.ts" ;;
    ingest_lineups)       echo "vp exec tsx scripts/ingestLineupsFromScrapes.ts" ;;
    generate_predictions) echo "$REPO_DIR/scripts/nightly-predictions.sh" ;;
    regenerate_event)
      local slug; slug="$(printf '%s' "$args" | sed -n 's/.*"event"[: ]*"\([^"]*\)".*/\1/p')"
      safe_arg "$slug" || { echo "__ERR__ regenerate_event needs a valid args.event"; return; }
      echo "vp exec tsx scripts/predictEventRecap.ts --event $slug --season 2026 --save-db --force-refresh" ;;
    fine_tune)            echo "vp exec tsx src/training/trainModelV9Subcaption-fixed.ts --load-model latest --trial-id cron_$(date +%s)" ;;
    merge_staff_by_name)  echo "vp exec tsx scripts/mergeByNameDefault.ts --apply" ;;
    resolve_staff_identity)
      local op a b
      op="$(printf '%s' "$args" | sed -n 's/.*"op"[: ]*"\([^"]*\)".*/\1/p')"
      a="$(printf '%s' "$args" | sed -n 's/.*"a"[: ]*"\([^"]*\)".*/\1/p')"
      b="$(printf '%s' "$args" | sed -n 's/.*"b"[: ]*"\([^"]*\)".*/\1/p')"
      { [ "$op" = merge ] || [ "$op" = split ]; } && safe_arg "$a" && safe_arg "$b" \
        || { echo "__ERR__ resolve_staff_identity needs op=merge|split + valid a, b"; return; }
      echo "vp exec tsx scripts/resolveStaffIdentity.ts --$op $a $b --apply" ;;
    save_corps_colors)
      local corps primary secondary
      corps="$(printf '%s' "$args" | sed -n 's/.*"corps"[: ]*"\([^"]*\)".*/\1/p')"
      primary="$(printf '%s' "$args" | sed -n 's/.*"primary"[: ]*"\([^"]*\)".*/\1/p')"
      secondary="$(printf '%s' "$args" | sed -n 's/.*"secondary"[: ]*"\([^"]*\)".*/\1/p')"
      safe_arg "$corps" && safe_arg "$primary" && safe_arg "${secondary:-none}" \
        || { echo "__ERR__ save_corps_colors needs valid corps, primary, secondary"; return; }
      echo "vp exec tsx scripts/setCorpsColors.ts --corps $corps --primary $primary --secondary ${secondary:-none}" ;;
    suppress_profile)
      local type id
      type="$(printf '%s' "$args" | sed -n 's/.*"type"[: ]*"\([^"]*\)".*/\1/p')"
      id="$(printf '%s' "$args" | sed -n 's/.*"id"[: ]*"\([^"]*\)".*/\1/p')"
      { [ "$type" = staff ] || [ "$type" = judge ]; } && safe_arg "$id" \
        || { echo "__ERR__ suppress_profile needs type=staff|judge + valid id"; return; }
      # Suppress (durable) then republish so the entity drops from the live read-model.
      echo "vp exec tsx scripts/suppressProfile.ts --type $type --id $id --apply && bash $REPO_DIR/scripts/refresh-prod-read-model.sh" ;;
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

  local out err fin code
  out="$(mktemp)"; err="$(mktemp)"
  if [[ "$cmd" == __ERR__* ]]; then
    code=2; echo "${cmd#__ERR__ }" >"$err"
  else
    # Separate streams (L8): stdout and stderr land in their own columns.
    ( cd "$SDK_DIR" && bash -lc "$cmd" ) >"$out" 2>"$err" && code=0 || code=$?
  fi
  fin="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local status; [ "$code" -eq 0 ] && status=success || status=failed
  # Keep only the tail of each stream to bound row growth.
  local outtail errtail; outtail="$(tail -c 60000 "$out")"; errtail="$(tail -c 20000 "$err")"
  sq "UPDATE admin_jobs SET status='$status', finished_at='$fin', exit_code=$code,
         stdout='$(esc "$outtail")', stderr='$(esc "$errtail")',
         error_message=$([ "$code" -eq 0 ] && echo NULL || echo "'exit $code'")
      WHERE job_id='$job';"
  rm -f "$out" "$err"
  return 0
}

# Drain the queue this invocation (still one-at-a-time).
while process_one; do :; done
