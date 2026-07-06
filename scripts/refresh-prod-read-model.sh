#!/usr/bin/env bash
# CANONICAL prod read-model update: emit into the LOCAL A/B slot + flip the pointer.
#
# CORRECTED 2026-06-28 — Turso was RETIRED 2026-06-15. Prod serves from the LOCAL
# A/B files in /data/corps-place (READ_MODEL_REPLICA_ENABLED=0, .skip-r2-pull), so
# THIS script is the live-update path (publish-read-model.sh / Turso are dead). A
# 2026-06-28 score ingest confirmed: emit here + pointer flip = live on the site
# in ~5s, no restart. (The earlier 2026-06-13 "Turso is canonical" note is void.)
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

# Serialize emits. The nightly-predictions cron and the every-5-min score-ingest
# cron both call this script; a full emit's corps section takes ~3 min, so an
# ingest emit landing mid-nightly used to race the shared build temp + the A/B
# slot copy → SQLITE_READONLY_DBMOVED and a failed/partial publish. flock makes a
# second emit WAIT for the first (up to 15 min) instead of racing, by re-exec'ing
# this script under the lock. Degrades to no-lock if flock is unavailable.
_LOCK="/tmp/read-model-emit.lock"
if [ "${_RM_EMIT_LOCKED:-}" != "1" ] && command -v flock >/dev/null 2>&1; then
  exec env _RM_EMIT_LOCKED=1 flock --timeout 900 "$_LOCK" "$0" "$@"
fi

# Run under the vite-plus managed Node (pinned 20.x via sdk/.node-version). NOTE:
# putting ~/.vite-plus/bin on PATH only exposes `vp`, NOT node/npx — so `npx tsx`
# would run the system Node (v24) and crash on the Node-20-built better-sqlite3
# (ABI mismatch). `vp exec tsx` runs tsx under the correct Node 20. Requires a
# one-time `vp install` in sdk (installs tsx + native deps).
export PATH="$HOME/.vite-plus/bin:$PATH"

# Belt-and-suspenders: the recap scrape already normalizes all-age division labels
# at the source (src/normalizeDivisions.ts — DCA corps like Connecticut Hurricanes
# otherwise double in division-grouped rankings). Re-run the canonical normalizer
# here so ANY emit path leaves a clean read-model. Idempotent; non-fatal on error.
vp exec tsx scripts/normalizeDivisions.ts || echo "[refresh-prod-read-model] division normalize skipped (non-fatal)"

echo "[refresh-prod-read-model] emitting into /data/corps-place/read-model.db (A/B hot-swap)…"
vp exec tsx scripts/emitReadModel.ts --out /data/corps-place/read-model.db "$@"
echo "[refresh-prod-read-model] done — server hot-swaps within ~5s."

# Always travel the product-image bytes WITH the read-model — otherwise newly
# ingested products reference media-cache keys whose bytes aren't on prod yet and
# render as broken images (prod has .skip-r2-pull; /api/media can't fetch-on-miss
# for merch-product keys). No-op when nothing new. Skip with SKIP_MEDIA_SYNC=1.
if [ "${SKIP_MEDIA_SYNC:-0}" != "1" ]; then
  bash "$repo_root/scripts/sync-prod-media-cache.sh" || echo "[refresh-prod-read-model] media-cache sync skipped/failed (non-fatal)"
fi
