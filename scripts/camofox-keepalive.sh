#!/usr/bin/env bash
# Keep the camofox-browser stealth-Firefox REST service (localhost:9377) alive.
# It's the last rung of the score-scraper's Cloudflare-bypass chain (see
# sdk/src/browserbaseService.ts). Cron runs this every 5 min + @reboot; it
# starts the server only when the port isn't answering. Setup notes:
#  - install dir: tools/camofox (npm i @askjo/camofox-browser)
#  - browser binary: ~/.cache/camoufox — the upstream v152 release zip is
#    BROKEN (fonts only); v135.0.1-beta.24 was extracted manually.
#  - plugins/headless (local, ships via this repo? NO — lives inside
#    node_modules; re-create after any npm update): forces headless because
#    Xvfb on this box never reports a display and the async failure bypasses
#    the server's own fallback (DISPLAY="[object Promise]" → SIGBUS).
set -uo pipefail

PORT=9377
if curl -sf -m 3 -o /dev/null "http://localhost:$PORT/openapi.json"; then
  exit 0
fi

LOCK="/tmp/camofox-keepalive.lock"
exec 9>"$LOCK"
flock -n 9 || exit 0

repo="/root/corps-place"
plug="$repo/tools/camofox/node_modules/@askjo/camofox-browser/plugins/headless"
# Re-assert the headless plugin (an npm update wipes it).
if [ ! -f "$plug/index.js" ]; then
  mkdir -p "$plug"
  cp "$repo/tools/camofox/headless-plugin.js" "$plug/index.js" 2>/dev/null || true
  python3 - <<'PY' || true
import json
p='/root/corps-place/tools/camofox/node_modules/@askjo/camofox-browser/camofox.config.json'
d=json.load(open(p)); d.setdefault('plugins',{})['headless']={'enabled':True}
json.dump(d,open(p,'w'),indent=2)
PY
fi

echo "[camofox-keepalive $(date -u +%FT%TZ)] starting camofox-browser…"
cd "$repo/tools/camofox"
CAMOFOX_CRASH_REPORT_ENABLED=false setsid /home/patrick/.local/bin/node \
  node_modules/@askjo/camofox-browser/bin/camofox-browser.js \
  >> /home/patrick/camofox-server.log 2>&1 < /dev/null &
disown
sleep 8
curl -sf -m 3 -o /dev/null "http://localhost:$PORT/openapi.json" \
  && echo "[camofox-keepalive $(date -u +%FT%TZ)] up on :$PORT" \
  || echo "[camofox-keepalive $(date -u +%FT%TZ)] FAILED to come up (see camofox-server.log)"
