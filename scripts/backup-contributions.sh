#!/usr/bin/env bash
# Box-side backup of the user-writable contributions DB (show wiki edits, citations,
# uploads metadata, auth-adjacent app data) to the restic → Cloudflare R2 repo.
#
# Consistency: never restic a live SQLite/WAL file directly. We take a
# transactionally-consistent copy with `sqlite3 .backup`, then back up the copy.
#
# DB discovery:
#   1. CONTRIBUTIONS_DB_URL=file:/path/to/contributions.db from .env/env
#   2. /data/corps-place/contributions.db (prod host volume)
#   3. /data/corps-place-dev/contributions.db (dev host volume)
#   4. sdk/contributions.db (local fallback)
#
# Usage: bash scripts/backup-contributions.sh [optional-db-path]
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
restic="$HOME/.local/bin/restic"
snap_dir="$repo_root/sdk/.backup-snapshot"
snap="$snap_dir/contributions.db"

# Load .env (RESTIC_* / AWS_* / CONTRIBUTIONS_DB_URL) without clobbering existing env.
if [ -f "$repo_root/.env" ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [ -z "${!key:-}" ] && export "$key=$val"
  done < "$repo_root/.env"
fi

db_from_url() {
  local url="${1:-}"
  case "$url" in
    file:*) printf '%s\n' "${url#file:}" ;;
    *) return 1 ;;
  esac
}

choose_db() {
  if [ -n "${1:-}" ]; then
    printf '%s\n' "$1"
    return
  fi
  if db_from_url "${CONTRIBUTIONS_DB_URL:-}" >/tmp/contrib-db-path.$$ 2>/dev/null; then
    local from_env
    from_env="$(cat /tmp/contrib-db-path.$$)"
    rm -f /tmp/contrib-db-path.$$
    if [ -n "$from_env" ]; then
      printf '%s\n' "$from_env"
      return
    fi
  fi
  rm -f /tmp/contrib-db-path.$$
  for candidate in \
    /data/corps-place/contributions.db \
    /data/corps-place-dev/contributions.db \
    "$repo_root/sdk/contributions.db"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  printf '%s\n' "$repo_root/sdk/contributions.db"
}

db="$(choose_db "${1:-}")"

[ -f "$db" ] || { echo "[backup] contributions DB not found: $db" >&2; exit 1; }
[ -x "$restic" ] || { echo "[backup] restic not found at $restic" >&2; exit 1; }
[ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${RESTIC_PASSWORD:-}" ] || {
  echo "[backup] RESTIC_REPOSITORY/PASSWORD missing from .env" >&2
  exit 1
}

mkdir -p "$snap_dir"
cleanup() { rm -f "$snap" "$snap"-wal "$snap"-shm; }
trap cleanup EXIT

echo "[backup] $(date -u +%FT%TZ) consistent contributions snapshot via sqlite .backup"
cleanup
sqlite3 "$db" ".backup '$snap'"

echo "[backup] restic backup → ${RESTIC_REPOSITORY%%/*}//…"
"$restic" backup "$snap" --tag contributions --host corps-place-vm

echo "[backup] prune contributions snapshots (keep 14 daily / 8 weekly / 12 monthly)"
"$restic" forget --tag contributions --host corps-place-vm \
  --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune

echo "[backup] $(date -u +%FT%TZ) done"
