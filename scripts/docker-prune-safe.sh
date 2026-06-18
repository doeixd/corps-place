#!/usr/bin/env bash
set -euo pipefail

UNTIL="${DOCKER_PRUNE_UNTIL:-168h}"

if ! command -v docker >/dev/null 2>&1; then
  echo '[docker-prune-safe] docker is not installed; skipping'
  exit 0
fi

echo "[docker-prune-safe] pruning Docker objects older than ${UNTIL}"
docker builder prune -af --filter "until=${UNTIL}"
docker container prune -f --filter "until=${UNTIL}"
docker image prune -af --filter "until=${UNTIL}"
docker network prune -f --filter "until=${UNTIL}"

if [ "${PRUNE_DOCKER_VOLUMES:-false}" = "true" ]; then
  echo '[docker-prune-safe] PRUNE_DOCKER_VOLUMES=true; pruning unused volumes'
  docker volume prune -f --filter "label!=keep"
fi

if command -v npm >/dev/null 2>&1; then
  npm cache clean --force >/dev/null 2>&1 || true
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm store prune >/dev/null 2>&1 || true
fi

df -h /
