#!/usr/bin/env bash
# Publish the read-model to an environment's Turso DB — the CANONICAL data-update
# path for prod and dev (both serve from their Turso embedded replica). Run on the
# VM, where the 3.4 GB sdk/dci-relational.db lives: it emits the read-model from
# that DB and pushes it to the env's Turso DB.
#
#   bash scripts/publish-read-model.sh prod
#   bash scripts/publish-read-model.sh dev [--restart]
#
# The replica auto-syncs within ~READ_MODEL_SYNC_INTERVAL_MS (default 60s), so the
# change appears shortly. BUT a long-running server stays on the old replication
# generation until it restarts — the self-healing replica only rebuilds fresh on
# process start (see app/lib/read-model-db.ts). Pass --restart to bounce the app
# container now (brief blip) instead of waiting for the next deploy. For a
# zero-downtime pickup, redeploy the app instead of using --restart.
#
# An env only *consumes* the pushed data if READ_MODEL_REPLICA_ENABLED=1 is set on
# its container (prod: yes; dev: enable it — see docs/INFRASTRUCTURE.md §4). The
# sync URL + token are read from the running prod container's env (the source of
# truth), so no secrets live in this file.
#
# This is the Linux/VM counterpart to scripts/publish-data.ps1 (the laptop helper,
# which also restic-backs-up the relational DB to R2).
set -euo pipefail

ENV="${1:-}"
case "$ENV" in
  prod | dev) ;;
  *)
    echo "usage: $0 <prod|dev> [--restart]" >&2
    exit 2
    ;;
esac
RESTART=0
[ "${2:-}" = "--restart" ] && RESTART=1

# The prod container carries both prod and dev sync URLs/tokens in its env.
PROD_C=$(docker ps --format '{{.Names}}' | grep '^if4odqr' | head -1)
[ -n "$PROD_C" ] || {
  echo "prod app container not found" >&2
  exit 1
}

if [ "$ENV" = "prod" ]; then
  SYNC=$(docker exec "$PROD_C" printenv READ_MODEL_SYNC_URL)
  TOKEN=$(docker exec "$PROD_C" printenv READ_MODEL_AUTH_TOKEN)
  APP_PREFIX=if4odqr
else
  SYNC=$(docker exec "$PROD_C" printenv READ_MODEL_SYNC_URL_DEV)
  TOKEN=$(docker exec "$PROD_C" printenv READ_MODEL_AUTH_TOKEN_DEV)
  APP_PREFIX=mjx
fi
[ -n "${SYNC:-}" ] && [ -n "${TOKEN:-}" ] || {
  echo "missing READ_MODEL_SYNC_URL / token for $ENV in the prod container env" >&2
  exit 1
}

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.vite-plus/bin:$PATH" # vite-plus managed Node 20 (SDK needs 20+)

echo "[publish-read-model] emit + push read-model → $ENV ($SYNC)"
(cd "$repo_root/sdk" && READ_MODEL_AUTH_TOKEN="$TOKEN" npx tsx scripts/emitReadModel.ts --push-turso "$SYNC")

if [ "$RESTART" = "1" ]; then
  APP=$(docker ps --format '{{.Names}}' | grep "^$APP_PREFIX" | head -1)
  [ -n "$APP" ] || {
    echo "[publish-read-model] WARN: $ENV app container not found; skipping restart." >&2
    exit 0
  }
  echo "[publish-read-model] restarting $ENV app ($APP) to rebuild its replica on the new generation (brief blip)…"
  docker restart "$APP" >/dev/null
  echo "[publish-read-model] restarted — site live on the new data once it warms (A/B serves meanwhile)."
else
  echo "[publish-read-model] done — replica auto-syncs within ~60s. To force immediate pickup, re-run with --restart, or redeploy for zero-downtime."
fi
