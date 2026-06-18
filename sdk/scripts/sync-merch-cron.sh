#!/usr/bin/env bash
# Cron wrapper for periodic merch re-sync (Approach 3).
# Refreshes product data + images from all storefronts so stale URLs or
# out-of-stock changes are caught without manual intervention.
#
# Install in crontab (runs Mon/Wed/Fri at 04:00):
#   0 4 * * 1,3,5 /root/corps-place/sdk/scripts/sync-merch-cron.sh >> /var/log/merch-sync.log 2>&1
#
# Or via /etc/cron.d/:
#   echo "0 4 * * 1,3,5 root /root/corps-place/sdk/scripts/sync-merch-cron.sh" > /etc/cron.d/merch-sync

set -euo pipefail
cd "$(dirname "$0")/.."

# Load env (BROWSERBASE_API_KEY, COOLIFY_API_TOKEN, etc.)
if [ -f ../.env ]; then
  set -a; source ../.env; set +a
fi

LOG_TS=$(date '+%Y-%m-%d %H:%M:%S')
echo "[${LOG_TS}] merch sync starting"

# Run the full pipeline: seed → ingest → emit read-model → push to R2.
# --publish is omitted here so it only emits the local read-model; run with
# --publish prod if you want automatic deploy (requires COOLIFY_API_TOKEN).
npx tsx scripts/syncMerch.ts 2>&1

echo "[${LOG_TS}] merch sync complete (exit=$?)"
