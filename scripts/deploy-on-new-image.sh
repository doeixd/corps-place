#!/usr/bin/env bash
# Off-box build deploy trigger (SEASON_2026_OPS_PLAN §1).
# GitHub Actions builds ghcr.io/doeixd/corps-place:latest; this cron compares
# the registry digest against the running prod container's image and asks
# Coolify (local API) to redeploy when a new image appears. Push-triggered
# auto-deploy is DISABLED for the app — this is the only deploy path, so a
# deploy always pulls a fully-built image (no stale-:latest race).
set -euo pipefail
IMAGE="ghcr.io/doeixd/corps-place:latest"
APP_UUID="if4odqr9tkybb0uezey95mid"
TOKEN="$(cat /root/corps-place/.coolify-deploy-token)"
LOCK=/tmp/deploy-on-new-image.lock
exec 9>"$LOCK"; flock -n 9 || exit 0

remote=$(docker manifest inspect "$IMAGE" 2>/dev/null | sha256sum | cut -d' ' -f1)
[ -n "$remote" ] || exit 0
state=/tmp/deploy-image-digest
last=$(cat "$state" 2>/dev/null || echo "")
if [ "$remote" != "$last" ]; then
  # First run just records the baseline; afterwards a change = new build.
  if [ -n "$last" ]; then
    echo "[deploy-watch $(date -u +%FT%TZ)] new image digest — triggering deploy"
    curl -fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
      "http://127.0.0.1:8000/api/v1/deploy?uuid=$APP_UUID" || echo "[deploy-watch] trigger FAILED"
    # Purge the Cloudflare edge after the container swap: edge-cached HTML (5-min
    # rule) still references the OLD build's hashed chunks, which die with the old
    # container → 404s on / for cookieless visitors until the TTL expires
    # (observed 2026-07-12). Wait for the rollout (Coolify health-gates the swap),
    # then purge; a failed purge degrades to the 5-min TTL. Runs in the background
    # so the watcher tick isn't held open.
    (
      sleep 150
      CF_TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' /root/corps-place/.env 2>/dev/null | head -1 | cut -d= -f2-)"
      if [ -n "$CF_TOKEN" ]; then
        curl -s -m 15 -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
          --data '{"purge_everything":true}' \
          "https://api.cloudflare.com/client/v4/zones/c710acd5ee534fd065c5c0b5b3e4316d/purge_cache" >/dev/null \
          && echo "[deploy-watch $(date -u +%FT%TZ)] post-deploy Cloudflare purge done" \
          || echo "[deploy-watch $(date -u +%FT%TZ)] post-deploy purge FAILED (5-min TTL applies)"
      fi
    ) &
  else
    echo "[deploy-watch $(date -u +%FT%TZ)] baseline digest recorded"
  fi
  echo "$remote" > "$state"
fi
