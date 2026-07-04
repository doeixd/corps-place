#!/usr/bin/env bash
# Box-side backup of the relational DB (the source of truth, mutated nightly by the
# merch ingest) AND contributions.db (users/fantasy/score-notify) to the
# restic → Cloudflare R2 repo. Linux/VM counterpart to the
# laptop's scripts/backup-relational.ps1 — SAME restic repo (content-deduped), but a
# distinct host tag (`corps-place-vm`) so box vs laptop snapshots are separable.
# See docs/MERCH_DEPLOY.md §7 and docs/INFRASTRUCTURE.md §5.
#
# Consistency: never restic a live SQLite file (WAL ⇒ torn read). We take a
# transactionally-consistent copy with `sqlite3 .backup` (safe under concurrent
# writers) into a fixed temp path, restic THAT, then delete it.
#
# Creds (RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
# come from the gitignored repo-root .env — nothing secret lives here.
#
# Usage:  bash scripts/backup-relational.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
restic="$HOME/.local/bin/restic"
snap_dir="$repo_root/sdk/.backup-snapshot"

# tag → source path. contributions.db holds users/sessions plus ALL fantasy
# tables (the standalone /data/corps-place/fantasy.db is a 0-byte stray, not
# the live store) and score-notify subscriptions.
declare -A dbs=(
  [dci-relational]="$repo_root/sdk/dci-relational.db"
  [contributions]="/data/corps-place/contributions.db"
)

# Load .env (RESTIC_* / AWS_*) without clobbering anything already in the environment.
if [ -f "$repo_root/.env" ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [ -z "${!key:-}" ] && export "$key=$val"
  done < "$repo_root/.env"
fi

[ -x "$restic" ] || { echo "[backup] restic not found at $restic (install it: see scripts/backup-relational.sh header)" >&2; exit 1; }
[ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${RESTIC_PASSWORD:-}" ] || { echo "[backup] RESTIC_REPOSITORY/PASSWORD missing from .env" >&2; exit 1; }

mkdir -p "$snap_dir"
cleanup() { rm -f "$snap_dir"/*.db "$snap_dir"/*.db-wal "$snap_dir"/*.db-shm; }
trap cleanup EXIT

failures=0
for tag in "${!dbs[@]}"; do
  db="${dbs[$tag]}"
  snap="$snap_dir/$tag.db"
  if [ ! -f "$db" ]; then
    echo "[backup] DB not found, skipping: $db" >&2
    failures=$((failures + 1))
    continue
  fi

  echo "[backup] $(date -u +%FT%TZ) $tag: consistent snapshot via sqlite .backup"
  rm -f "$snap" "$snap"-wal "$snap"-shm
  sqlite3 "$db" ".backup '$snap'"

  echo "[backup] $tag: restic backup → ${RESTIC_REPOSITORY%%/*}//…"
  "$restic" backup "$snap" --tag "$tag" --host corps-place-vm

  echo "[backup] $tag: prune (keep 7 daily / 4 weekly / 6 monthly)"
  "$restic" forget --tag "$tag" --host corps-place-vm \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
done

echo "[backup] $(date -u +%FT%TZ) done ($failures skipped)"
exit "$failures"
