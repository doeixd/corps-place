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

# Run under the vite-plus managed Node (pinned 20.x via sdk/.node-version). NOTE:
# putting ~/.vite-plus/bin on PATH only exposes `vp`, NOT node/npx — so `npx tsx`
# would run the system Node (v24) and crash on the Node-20-built better-sqlite3
# (ABI mismatch). `vp exec tsx` runs tsx under the correct Node 20. Requires a
# one-time `vp install` in sdk (installs tsx + native deps).
export PATH="$HOME/.vite-plus/bin:$PATH"

# Normalize all-age division labels before emitting: the score-list scrape labels
# DCA corps with a generic "All Age Class", while recap pages give the specific
# "All-Age - World/Open/A Class". A corps split across both labels shows up TWICE
# in division-grouped rankings (e.g. Connecticut Hurricanes). Collapse a corps's
# generic rows onto the specific all-age class it uses elsewhere. Idempotent; only
# touches corps that have BOTH labels (corps with only the generic label are left
# alone). Unambiguous: no corps has >1 distinct specific all-age label.
sqlite3 dci-relational.db "
UPDATE corps_scores
SET division_name = (SELECT s.division_name FROM corps_scores s
                     WHERE s.corps_key = corps_scores.corps_key AND s.division_name LIKE 'All-Age - %Class' LIMIT 1)
WHERE division_name = 'All Age Class'
  AND EXISTS (SELECT 1 FROM corps_scores s2 WHERE s2.corps_key = corps_scores.corps_key AND s2.division_name LIKE 'All-Age - %Class');
" 2>/dev/null && echo "[refresh-prod-read-model] normalized all-age division labels."

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
