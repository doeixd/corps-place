#!/usr/bin/env bash
# Nightly: generate any missing 2026 event predictions, then republish the prod
# read-model so drumcorps.app serves them (SSR'd instantly by the route loader).
#
# WHY: prediction pages serve frozen summaries from rm_event_prediction — the
# serving container has no ML model, so an event whose lineup appeared after the
# last builder run has no prediction until one is generated here and re-emitted.
# This closes that gap automatically (a missing prediction shows a "coming soon"
# card on the site in the meantime, never an error).
#
# WHAT: query sdk/dci-relational.db for 2026 events that have lineup entries but
# no saved prediction run, generate each via predictEventRecap.ts --save-db
# (pure-JS tfjs; a handful of events takes seconds), then run
# refresh-prod-read-model.sh which emits into the inactive A/B slot and flips
# the pointer (the server hot-swaps within ~5s; zero downtime).
#
# Usage:  bash scripts/nightly-predictions.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/sdk"
export PATH="$HOME/.vite-plus/bin:$PATH"

missing=$(python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('file:dci-relational.db?mode=ro', uri=True)
rows = db.execute("""
  SELECT DISTINCT e.slug
  FROM events e
  JOIN event_lineup_entries l ON l.event_slug = e.slug
  LEFT JOIN model_event_prediction_runs p ON p.event_slug = e.slug
  WHERE e.season = '2026' AND l.is_non_performance = 0 AND p.event_slug IS NULL
  ORDER BY e.slug
""").fetchall()
print('\n'.join(r[0] for r in rows))
EOF
)

if [ -z "$missing" ]; then
  echo "[nightly-predictions] no events missing predictions — nothing to do."
  exit 0
fi

echo "[nightly-predictions] generating predictions for:"
echo "$missing" | sed 's/^/  - /'

failures=0
while IFS= read -r slug; do
  [ -z "$slug" ] && continue
  echo "[nightly-predictions] === $slug"
  if ! vp exec tsx scripts/predictEventRecap.ts --event "$slug" --save-db; then
    echo "[nightly-predictions] FAILED: $slug (continuing)"
    failures=$((failures + 1))
  fi
done <<<"$missing"

echo "[nightly-predictions] republishing prod read-model…"
bash "$repo_root/scripts/refresh-prod-read-model.sh"

if [ "$failures" -gt 0 ]; then
  echo "[nightly-predictions] done with $failures failure(s)."
  exit 1
fi
echo "[nightly-predictions] done."
