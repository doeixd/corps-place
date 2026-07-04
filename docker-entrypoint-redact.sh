#!/bin/sh
# Production entrypoint: refresh the read-model from R2, then serve.
#
# Best-effort by design — the pull script always exits 0, and we also guard with
# `|| true`, so a pull failure (no creds, R2 down, checksum mismatch) NEVER blocks
# startup. The app then serves whatever read-model is already in /data (the A/B
# slot fallback). This replaces the old Turso embedded-replica sync-on-boot.
#
# Hot-deploy skip: when /data/.skip-r2-pull exists, the R2 pulls are skipped
# entirely — the server boots from the on-disk DBs. Used for box-side deploys
# where the data is already current.
set -e

SKIP_MARKER=/data/.skip-r2-pull

if [ -f "$SKIP_MARKER" ]; then
  echo "[entrypoint] skip marker present — booting from on-disk data (no R2 pull)"
else
  echo "[entrypoint] refreshing read-model from R2 (best-effort)…"
  # Bound the pull so a slow/hung R2 can never delay boot past the health check.
  timeout 120 node /app/scripts/pullReadModel.mjs || echo "[entrypoint] read-model pull skipped/timed out — serving on-disk data"

  echo "[entrypoint] refreshing media-cache from R2 (best-effort)…"
  timeout 120 node /app/scripts/pullMediaCache.mjs || echo "[entrypoint] media-cache pull skipped/timed out — serving on-disk data"
fi

# Apply contributions.db column migrations deterministically, before serving — the
# lazy first-request path proved unreliable. Best-effort: never blocks boot (the
# app's own ensureColumns remains a fallback).
echo "[entrypoint] applying contributions.db migrations…"
node /app/scripts/migrate-contributions.mjs || echo "[entrypoint] migration step failed — continuing"

# Cap the SSR server's V8 heap so a leak/runaway can't OOM the ~3.8 GB box
# (earlyoom is the backstop, not the first line). Steady-state is ~272 MB, so 1 GB
# is generous headroom. Tune without a code change via APP_MAX_OLD_SPACE_MB; any
# pre-set NODE_OPTIONS is preserved.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${APP_MAX_OLD_SPACE_MB:-1024}"
echo "[entrypoint] NODE_OPTIONS=$NODE_OPTIONS"

exec node scripts/serve-dist.mjs
