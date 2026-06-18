#!/usr/bin/env bash
# Reseed dev's read-model from prod, with zero downtime.
#
# DEPRECATED once dev's Turso replica is enabled. This script is a workaround for
# dev having `READ_MODEL_SYNC_URL` set but NOT `READ_MODEL_REPLICA_ENABLED=1` — so
# the replica path is silently off and dev never consumes its own Turso DB. The
# real fix is to set `READ_MODEL_REPLICA_ENABLED=1` on the dev app (Coolify env)
# and publish with `scripts/publish-read-model.sh dev`; then dev refreshes itself
# and this prod→dev copy is unnecessary. See docs/INFRASTRUCTURE.md §4.
#
# WHY (until then): dev (`dev.drumcorps.app`, data `/data/corps-place-dev`) serves
# from its own LOCAL read-model A/B files with the replica OFF, so its data never
# refreshes and drifts stale (symptom: home "Shows this/next weekend" section and
# other date-relative widgets silently vanish once dev's data predates them).
# Prod (`/data/corps-place`) IS kept fresh (Turso replica), so the freshest
# available source for dev is simply prod's served read-model.
#
# WHAT: take a consistent snapshot of what prod currently serves and hot-swap it
# into dev using the blessed A/B mechanism — write the *inactive* slot, then flip
# the `.active` pointer. The dev app polls the pointer every ~5s and reconnects
# with no restart (see app/lib/read-model-db.ts). Prod is only ever read.
#
# All filesystem work runs inside a throwaway `alpine` container because /data is
# root-owned; membership in the `docker` group is enough (no sudo). See
# docs/DEPLOYMENT_REALITY.md §5 and docs/INFRASTRUCTURE.md §3.
#
# Usage:  bash scripts/sync-dev-read-model.sh
set -euo pipefail

PROD_DIR=/data/corps-place
DEV_DIR=/data/corps-place-dev
STEM=read-model

docker run --rm -i -v /data:/data alpine sh -s "$PROD_DIR" "$DEV_DIR" "$STEM" <<'INNER'
set -eu
PROD_DIR=$1; DEV_DIR=$2; STEM=$3
apk add --no-cache sqlite >/dev/null

# Source = what prod actually serves: its active A/B slot (Turso/embedded-replica
# retired 2026-06-15 — prod's read-model is pulled from R2 into the A/B slot on boot).
ACTIVE=$(cat "$PROD_DIR/$STEM.active" 2>/dev/null || echo a)
SRC="$PROD_DIR/$STEM.$ACTIVE.db"
[ -f "$SRC" ] || { echo "no prod source read-model at $SRC" >&2; exit 1; }

# Target = dev's INACTIVE slot (the one the pointer is NOT on). VACUUM INTO gives
# a clean, WAL-consistent copy even though the source may be live.
CUR=$(cat "$DEV_DIR/$STEM.active" 2>/dev/null || echo a)
[ "$CUR" = a ] && NEXT=b || NEXT=a
TMP="$DEV_DIR/$STEM.$NEXT.db.tmp"

echo "source: $SRC -> dev slot $NEXT (current active: $CUR)"
rm -f "$TMP"
sqlite3 "$SRC" "VACUUM INTO '$TMP'"
[ "$(sqlite3 "$TMP" 'PRAGMA integrity_check;')" = ok ] || { echo "integrity check failed" >&2; rm -f "$TMP"; exit 1; }

mv -f "$TMP" "$DEV_DIR/$STEM.$NEXT.db"
printf '%s' "$NEXT" > "$DEV_DIR/$STEM.active"   # atomic-enough single-byte flip; app polls it every ~5s
echo "done: dev pointer flipped $CUR -> $NEXT"
INNER

echo "dev read-model reseeded from prod. The dev app hot-swaps within ~5s; no restart needed."
