#!/usr/bin/env bash
# User-level log rotation for the pipeline cron logs (no root on this box, so
# /etc/logrotate.d isn't an option). Any log over the cap is copied to .1.gz
# (previous rotation replaced) and truncated in place — truncate keeps the fd
# of the appending cron job valid, like logrotate's copytruncate.
set -uo pipefail
CAP_BYTES=$((20 * 1024 * 1024)) # 20 MiB
for log in /home/patrick/*.log; do
  [ -f "$log" ] || continue
  size=$(stat -c %s "$log" 2>/dev/null || echo 0)
  [ "$size" -gt "$CAP_BYTES" ] || continue
  gzip -c "$log" > "${log}.1.gz.tmp" && mv "${log}.1.gz.tmp" "${log}.1.gz"
  : > "$log"
  echo "[rotate-cron-logs $(date -u +%FT%TZ)] rotated $log ($size bytes)"
done
