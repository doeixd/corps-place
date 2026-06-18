#!/usr/bin/env bash
set -euo pipefail

LOG=/home/patrick/docker-cleanup.log

echo "=== $(date) ===" >> "$LOG"
echo "Before:" >> "$LOG"
df -h / | tail -1 >> "$LOG"

# Remove unused images + build cache, keeping anything <48h old
docker system prune -af --filter "until=48h" >> "$LOG" 2>&1

echo "After:" >> "$LOG"
df -h / | tail -1 >> "$LOG"
echo "" >> "$LOG"
