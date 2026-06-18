#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/vm-sync.sh [dev|prod] [--from-runtime|--to-runtime] [--allow-dirty] [--dry-run|--apply]

What it does on the VM:
  1. Checks out and fast-forwards the branch for the chosen environment.
     dev  -> branch dev,    data /data/corps-place-dev
     prod -> branch master, data /data/corps-place
  2. Syncs SQLite runtime files.

Modes:
  --from-runtime  Copy app-mounted DBs from /data/... into sdk/ for local VM work.
                  This is the default.
  --to-runtime    Publish DBs from sdk/ back into /data/... . This is a write to
                  the mounted app data dir; dry-run unless --apply is passed.
  --dry-run       Print copy operations without writing. Default for --to-runtime.
  --apply         Actually write in --to-runtime mode.

Files synced:
  read-model.db
  read-model.a.db
  read-model.b.db
  read-model.active
  media-cache.db

Examples:
  scripts/vm-sync.sh dev
  scripts/vm-sync.sh prod --from-runtime
  scripts/vm-sync.sh dev --to-runtime
  scripts/vm-sync.sh dev --to-runtime --apply

Notes:
  - This script never runs git reset and never force-overwrites code changes.
  - It does not sync sdk/dci-relational.db; that source-of-truth DB lives on the
    laptop and is backed up separately.
EOF
}

env_name=""
direction="from-runtime"
allow_dirty=0
dry_run=0
apply=0

for arg in "$@"; do
  case "$arg" in
    dev|prod)
      env_name="$arg"
      ;;
    --from-runtime)
      direction="from-runtime"
      ;;
    --to-runtime)
      direction="to-runtime"
      ;;
    --allow-dirty)
      allow_dirty=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    --apply)
      apply=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$direction" == "to-runtime" && "$apply" -ne 1 ]]; then
  dry_run=1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

current_branch="$(git rev-parse --abbrev-ref HEAD)"

if [[ -z "$env_name" ]]; then
  case "$current_branch" in
    dev) env_name="dev" ;;
    master|main) env_name="prod" ;;
    *)
      echo "Current branch is '$current_branch'. Pass 'dev' or 'prod' explicitly." >&2
      exit 2
      ;;
  esac
fi

case "$env_name" in
  dev)
    branch="dev"
    data_dir="/data/corps-place-dev"
    ;;
  prod)
    branch="master"
    data_dir="/data/corps-place"
    ;;
  *)
    echo "Invalid environment: $env_name" >&2
    exit 2
    ;;
esac

if [[ "$allow_dirty" -ne 1 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit/stash first, or pass --allow-dirty." >&2
  git status --short
  exit 1
fi

echo "==> Environment: $env_name"
echo "==> Branch:      $branch"
echo "==> Data dir:    $data_dir"
echo "==> Direction:   $direction"
if [[ "$dry_run" -eq 1 ]]; then
  echo "==> Dry run:     yes"
fi

if [[ "$current_branch" != "$branch" ]]; then
  echo "==> Checking out $branch"
  git checkout "$branch"
fi

echo "==> Fetching origin"
git fetch origin "$branch"

echo "==> Fast-forwarding $branch"
git pull --ff-only origin "$branch"

if [[ ! -d "$data_dir" ]]; then
  echo "Data dir does not exist: $data_dir" >&2
  exit 1
fi

mkdir -p "$repo_root/sdk"

files=(
  "read-model.db"
  "read-model.a.db"
  "read-model.b.db"
  "read-model.active"
  "media-cache.db"
)

have_docker=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  have_docker=1
fi

direct_sync() {
  local src_dir="$1"
  local dst_dir="$2"

  for file in "${files[@]}"; do
    if [[ -e "$src_dir/$file" ]]; then
      if [[ "$dry_run" -eq 1 ]]; then
        echo "DRY RUN cp -p '$src_dir/$file' '$dst_dir/$file'"
      else
        cp -p "$src_dir/$file" "$dst_dir/$file"
        echo "copied $file"
      fi
    else
      echo "skip missing $src_dir/$file"
    fi
  done
}

docker_sync() {
  local src_dir="$1"
  local dst_dir="$2"
  local src_mount="$3"
  local dst_mount="$4"

  docker run --rm \
    -v /data:/data \
    -v "$repo_root/sdk:/work/sdk" \
    alpine:3.20 sh -eu -c '
      dry_run="$1"
      src_dir="$2"
      dst_dir="$3"
      shift 3
      for file in "$@"; do
        if [ -e "$src_dir/$file" ]; then
          if [ "$dry_run" = "1" ]; then
            echo "DRY RUN cp -p $src_dir/$file $dst_dir/$file"
          else
            cp -p "$src_dir/$file" "$dst_dir/$file"
            echo "copied $file"
          fi
        else
          echo "skip missing $src_dir/$file"
        fi
      done
    ' sh "$dry_run" "$src_mount" "$dst_mount" "${files[@]}"
}

case "$direction" in
  from-runtime)
    echo "==> Syncing runtime DBs into sdk/"
    if [[ -r "$data_dir" ]]; then
      direct_sync "$data_dir" "$repo_root/sdk"
    elif [[ "$have_docker" -eq 1 ]]; then
      docker_sync "$data_dir" "$repo_root/sdk" "$data_dir" "/work/sdk"
    else
      echo "Cannot read $data_dir directly, and docker is unavailable." >&2
      exit 1
    fi
    ;;
  to-runtime)
    echo "==> Syncing sdk/ DBs into runtime data dir"
    if [[ "$dry_run" -eq 0 ]]; then
      echo "This will overwrite files in $data_dir."
    fi

    if [[ -w "$data_dir" ]]; then
      direct_sync "$repo_root/sdk" "$data_dir"
    elif [[ "$have_docker" -eq 1 ]]; then
      docker_sync "$repo_root/sdk" "$data_dir" "/work/sdk" "$data_dir"
    else
      echo "Cannot write $data_dir directly, and docker is unavailable." >&2
      exit 1
    fi
    ;;
  *)
    echo "Invalid sync direction: $direction" >&2
    exit 2
    ;;
esac

echo "==> Runtime DB summary"
if command -v sqlite3 >/dev/null 2>&1; then
  active_file="$data_dir/read-model.active"
  active_slot=""
  if [[ -r "$active_file" ]]; then
    active_slot="$(tr -d '\r\n' < "$active_file")"
  fi
  model="$data_dir/read-model.db"
  if [[ "$active_slot" == "a" || "$active_slot" == "b" ]]; then
    model="$data_dir/read-model.$active_slot.db"
  fi
  if [[ -r "$model" ]]; then
    sqlite3 "$model" "SELECT 'schema_version', value FROM rm_meta WHERE key='schema_version';"
    sqlite3 "$model" "SELECT 'rm_events', count(*) FROM rm_events UNION ALL SELECT 'rm_show_titles', count(*) FROM rm_show_titles;"
  else
    echo "read-model not readable for summary: $model"
  fi
else
  echo "sqlite3 not installed; skipped row-count summary."
fi

echo "==> Done"
