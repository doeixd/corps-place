#!/usr/bin/env bash
# Gentle daily scrape of the external benchmark "Field Read" -> external_benchmark_predictions.
# One page load per endpoint (/record, /predictions) per run; the site is a BETA hobby project.
# Pure Node (system Node 24 + puppeteer-core + system chromium); no vp/tsx needed.
#
# Cron (once daily, 04:10 UTC):
#   10 4 * * * /usr/bin/timeout 600 /usr/bin/bash /root/corps-place/scripts/scrape-field-read.sh \
#     >> /home/patrick/scrape-field-read.log 2>&1 \
#     || /usr/bin/bash /root/corps-place/scripts/notify-cron-failure.sh scrape-field-read "scrape-field-read cron failed"
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Prefer the repo's Node 24 (matches puppeteer-core); fall back to system node.
export PATH="$HOME/.local/bin:$PATH"
node_bin="$(command -v node || echo /usr/bin/node)"

echo "[scrape-field-read.sh] $(date -u +%FT%TZ) starting ($node_bin $($node_bin --version))"
"$node_bin" scripts/scrape-field-read.mjs
echo "[scrape-field-read.sh] $(date -u +%FT%TZ) done"
