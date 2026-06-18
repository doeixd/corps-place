#!/bin/sh
# Production entrypoint: refresh the read-model from R2, then serve.
#
# Best-effort by design — the pull script always exits 0, and we also guard with
# `|| true`, so a pull failure (no creds, R2 down, checksum mismatch) NEVER blocks
# startup. The app then serves whatever read-model is already in /data (the A/B
# slot fallback). This replaces the old Turso embedded-replica sync-on-boot.
set -e

echo "[entrypoint] refreshing read-model from R2 (best-effort)…"
# Bound the pull so a slow/hung R2 can never delay boot past the health check.
timeout 120 node /app/scripts/pullReadModel.mjs || echo "[entrypoint] read-model pull skipped/timed out — serving on-disk data"

echo "[entrypoint] refreshing media-cache from R2 (best-effort)…"
timeout 120 node /app/scripts/pullMediaCache.mjs || echo "[entrypoint] media-cache pull skipped/timed out — serving on-disk data"

exec node .output/server/index.mjs
