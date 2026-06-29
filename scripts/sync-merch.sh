#!/usr/bin/env bash
# Nightly merch refresh: seed stores → ingest products (from the live corps/vendor
# storefronts) → emit the read-model with rm_merch_* → push to the prod Turso DB →
# redeploy prod so the new replication generation is picked up. End-to-end this is
# what keeps drumcorps.app's /merch current. See docs/MERCH_DEPLOY.md.
#
# Runs on the box from patrick's crontab (the box's data jobs live there, alongside
# nightly-predictions.sh and sync-dev-read-model.sh — NOT Coolify Scheduled Tasks).
# Reads creds from the gitignored repo-root .env (Turso URL/token + COOLIFY_API_TOKEN)
# via syncMerch's own loadRepoEnv — nothing secret lives in this file.
#
# Usage:  bash scripts/sync-merch.sh            # ingest → publish prod → redeploy
#         bash scripts/sync-merch.sh --no-restart   # publish only, skip redeploy
set -euo pipefail

# Prevent overlapping runs (a long merch ingest must not stack on a later cron
# tick or collide with another invocation — that's an OOM trigger on this small
# box). Mirrors auto-ingest-scores.sh / admin-job-worker.sh.
exec 9>/tmp/sync-merch.lock
flock -n 9 || { echo "[sync-merch $(date -u +%FT%TZ)] another run holds the lock; exiting"; exit 0; }

# Bound Node's heap so a single merch run can't balloon unbounded and OOM the box
# (Chromium runs as its own process; this caps the tsx/Node side). Mirrors the
# caps in nightly-predictions.sh / auto-ingest-scores.sh.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1536"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"

# cron has a minimal PATH; put the vite-plus-managed Node (the newest installed)
# on PATH so `npx`/`tsx` resolve. Mirrors the node the interactive shell uses.
NODE_DIR="$(ls -d "$HOME"/.vite-plus/js_runtime/node/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "${NODE_DIR:-}" ] && export PATH="$NODE_DIR:$PATH"

echo "[sync-merch] $(date -u +%FT%TZ) starting"
npx tsx scripts/syncMerch.ts --publish prod "$@"

# Warm the prod image cache for any new images (best-effort; fetch-on-miss covers
# anything this misses). The cache is a shared bind-mount, so this populates the
# volume the live container reads regardless of the redeploy timing above.
echo "[sync-merch] $(date -u +%FT%TZ) warming image cache"
npx tsx scripts/warmMerchImages.ts || true
echo "[sync-merch] $(date -u +%FT%TZ) done"
