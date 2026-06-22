#!/usr/bin/env bash
# BREAK-GLASS fallback: refresh the PROD read-model via the LOCAL A/B slot (no Turso).
#
# CORRECTED 2026-06-13 — the old header here was wrong. Prod now serves from the
# Turso embedded replica (READ_MODEL_REPLICA_ENABLED=1 on the prod container), so
# the CANONICAL prod-data update path is `scripts/publish-read-model.sh prod`
# (emit + push to Turso). See docs/INFRASTRUCTURE.md §4.
#
# This script writes the LOCAL A/B files in /data/corps-place instead — which the
# server reads ONLY when the replica is DISABLED. Use it only as a fallback when
# Turso is unreachable: first set READ_MODEL_REPLICA_ENABLED=0 on the prod app
# (otherwise this emit will NOT change what the site shows), run this, then
# re-enable the replica once Turso is back.
#
# It emits a fresh read-model from sdk/dci-relational.db into the *inactive* slot
# and flips the pointer; a server reading A/B polls the pointer (~5s) and hot-swaps.
#
# Run on the VM, where the 3.4 GB sdk/dci-relational.db lives:
#   bash scripts/refresh-prod-read-model.sh
# Extra emit flags pass through, e.g. --only home is for inspection only (a
# partial emit does NOT publish; use a full emit to go live).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"

# Use the vite-plus managed Node (pinned 20.x) — the SDK scripts need Node 20+.
export PATH="$HOME/.vite-plus/bin:$PATH"

echo "[refresh-prod-read-model] emitting into /data/corps-place/read-model.db (A/B hot-swap)…"
npx tsx scripts/emitReadModel.ts --out /data/corps-place/read-model.db "$@"
echo "[refresh-prod-read-model] done — server hot-swaps within ~5s."

# Always travel the product-image bytes WITH the read-model — otherwise newly
# ingested products reference media-cache keys whose bytes aren't on prod yet and
# render as broken images (prod has .skip-r2-pull; /api/media can't fetch-on-miss
# for merch-product keys). No-op when nothing new. Skip with SKIP_MEDIA_SYNC=1.
if [ "${SKIP_MEDIA_SYNC:-0}" != "1" ]; then
  bash "$repo_root/scripts/sync-prod-media-cache.sh" || echo "[refresh-prod-read-model] media-cache sync skipped/failed (non-fatal)"
fi
