#!/usr/bin/env bash
# Propagate freshly-ingested merch product image bytes into the PROD media-cache.
#
# Why this exists: product images are served as `merch-product:<hash>/<i>` cache
# keys from the prod container's /data/corps-place/media-cache.db. Ingest writes
# the bytes to sdk/media-cache.db (CACHE_DB_PATH), NOT to the prod file — and prod
# has `.skip-r2-pull`, so it never pulls media-cache from R2. `/api/media` also
# CANNOT fetch-on-miss for a merch-product key (no source URL → 404), so
# warmMerchImages can't repair it either. Net: after a targeted re-ingest, new
# products show BROKEN images until their cached bytes are copied here.
#
# This copies exactly the rows prod is missing (referenced by a current product,
# present in sdk/media-cache.db, absent from prod) into the root-owned prod DB via
# the running container (we're in the `docker` group; no passwordless sudo). It's
# idempotent — a second run with nothing new is a no-op.
#
# Run on the VM after `ingestMerch` (+ usually `refresh-prod-read-model.sh`):
#   bash scripts/sync-prod-media-cache.sh
#
# See the "prod read-model A/B slot publish" memory for the full deploy model.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
SDK_CACHE="$repo_root/sdk/media-cache.db"
REL_DB="${DCI_RELATIONAL_DB_URL_FILE:-$repo_root/sdk/dci-relational.db}"
PROD_DATA_DIR="${PROD_DATA_DIR:-/data/corps-place}"
PROD_CACHE="$PROD_DATA_DIR/media-cache.db"
RECOVER="/tmp/recover-mediacache.$$.db"

[ -f "$SDK_CACHE" ] || { echo "[sync-media] no sdk/media-cache.db — nothing to copy"; exit 0; }
[ -f "$PROD_CACHE" ] || { echo "[sync-media] prod media-cache not found at $PROD_CACHE" >&2; exit 1; }

CID="$(docker ps --format '{{.ID}} {{.Names}}' | grep -E 'if4odqr' | awk '{print $1}' | head -1 || true)"
[ -n "$CID" ] || { echo "[sync-media] prod app container (if4odqr…) not running" >&2; exit 1; }

echo "[sync-media] computing missing product images (prod=$PROD_CACHE container=$CID)…"

# Build a small portable DB holding ONLY the rows prod is missing. All three DBs
# are readable as the box user; only the WRITE to prod needs the container (root).
rm -f "$RECOVER"
python3 - "$REL_DB" "$SDK_CACHE" "$PROD_CACHE" "$RECOVER" <<'PY'
import sqlite3, sys, os
rel_db, sdk_cache, prod_cache, recover = sys.argv[1:5]
rel  = sqlite3.connect(f"file:{rel_db}?mode=ro", uri=True)
sdk  = sqlite3.connect(f"file:{sdk_cache}?mode=ro", uri=True)
prod = sqlite3.connect(f"file:{prod_cache}?mode=ro", uri=True)
keys = [r[0] for r in rel.execute(
    "SELECT DISTINCT image_url FROM merch_products "
    "WHERE image_url LIKE 'merch-product:%'")]
def has(db, k):
    return db.execute("SELECT 1 FROM media_cache WHERE url=? AND byte_length>0 LIMIT 1",
                      (k,)).fetchone() is not None
missing      = [k for k in keys if not has(prod, k)]
recoverable  = [k for k in missing if has(sdk, k)]
unrecoverable = len(missing) - len(recoverable)
out = sqlite3.connect(recover)
out.execute("CREATE TABLE media_cache (url TEXT PRIMARY KEY, content_type TEXT, "
            "bytes BLOB, byte_length INTEGER, fetched_at TEXT)")
n = 0
for k in recoverable:
    row = sdk.execute("SELECT url,content_type,bytes,byte_length,fetched_at "
                      "FROM media_cache WHERE url=?", (k,)).fetchone()
    if row:
        out.execute("INSERT OR IGNORE INTO media_cache VALUES (?,?,?,?,?)", row)
        n += 1
out.commit()
print(f"[sync-media] product keys={len(keys)} missing_from_prod={len(missing)} "
      f"recoverable={n} unrecoverable={unrecoverable}")
if unrecoverable:
    print(f"[sync-media] WARNING: {unrecoverable} image(s) missing from BOTH prod and "
          f"sdk/media-cache.db — re-run ingestMerch for the affected store(s).")
# Signal "nothing to do" by removing the file when empty.
if n == 0:
    out.close(); os.remove(recover)
PY

if [ ! -f "$RECOVER" ]; then
  echo "[sync-media] prod media-cache already complete — nothing to copy."
  exit 0
fi

echo "[sync-media] merging $(du -h "$RECOVER" | cut -f1) of image bytes into prod…"
docker cp "$RECOVER" "$CID:/tmp/recover-mediacache.db"
rm -f "$RECOVER"

docker exec "$CID" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/data/media-cache.db');
db.exec('PRAGMA busy_timeout=20000');
db.exec(\"ATTACH '/tmp/recover-mediacache.db' AS rec\");
const before = db.prepare('SELECT COUNT(*) c FROM media_cache').get().c;
db.exec('BEGIN');
db.exec('INSERT OR IGNORE INTO media_cache (url,content_type,bytes,byte_length,fetched_at,thumbhash) ' +
        'SELECT url,content_type,bytes,byte_length,fetched_at,NULL FROM rec.media_cache');
db.exec('COMMIT');
const after = db.prepare('SELECT COUNT(*) c FROM media_cache').get().c;
console.log('[sync-media] rows ' + before + ' -> ' + after + ' (added ' + (after - before) + ')');
db.close();
" 2>&1 | grep -vE 'ExperimentalWarning|trace-warnings'

docker exec "$CID" rm -f /tmp/recover-mediacache.db
echo "[sync-media] done."
