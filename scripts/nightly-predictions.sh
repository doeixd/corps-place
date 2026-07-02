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
  -- (Re)generate predictions for events with a lineup that are either MISSING a
  -- prediction entirely, OR still genuinely upcoming. "Upcoming" is defined by
  -- SCORE STATE, not calendar date: a show that started today but already has
  -- released scores is COMPLETE and must keep its run untouched (regenerating it
  -- after actuals are known would overwrite the latest visible run and break the
  -- as-of history). So a same-season event counts as still-future only when it
  -- has no ingested corps_scores yet — checked via the event_to_competition
  -- bridge AND the raw/season-prefixed slug fallback.
  WHERE e.season = '2026' AND l.is_non_performance = 0
    AND (
      p.event_slug IS NULL
      OR (
        e.start_date >= date('now')
        AND NOT EXISTS (
          SELECT 1 FROM corps_scores cs
          JOIN event_to_competition etc ON etc.competition_slug = cs.competition_slug
          WHERE etc.event_slug = e.slug
        )
        AND NOT EXISTS (
          SELECT 1 FROM corps_scores cs2 WHERE cs2.competition_slug = e.slug
        )
      )
    )
  ORDER BY e.slug
""").fetchall()
print('\n'.join(r[0] for r in rows))
EOF
)

# ── Same-season ML sequence refresh ─────────────────────────────────────────
# predictEventRecap picks its mode from ml_sequence_rows_v9_subcaption: with no
# same-season rows it stays in preseason_forecast FOREVER, where the model's
# weight on point totals is 0 (pure prior-season baselines) — even after real
# scores land. Rebuild the current season's rows whenever the DB has scored
# competitions the sequence table hasn't seen, so in-season predictions actually
# engage the model. Upsert-only + single season → training seasons untouched.
# NOTE: never regenerate the index maps (corps/judge/show) here — they're
# positional and frozen into the trained model's embeddings.
seq_stale=$(python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('file:dci-relational.db?mode=ro', uri=True)
scored = db.execute("""
  SELECT COUNT(DISTINCT cs.competition_slug) FROM corps_scores cs
  JOIN competitions c ON c.slug = cs.competition_slug WHERE c.season='2026'
""").fetchone()[0]
seq = db.execute(
  "SELECT COUNT(DISTINCT competition_slug) FROM ml_sequence_rows_v9_subcaption WHERE season='2026'"
).fetchone()[0]
print('stale' if scored > seq else 'fresh')
EOF
)
if [ "$seq_stale" = "stale" ]; then
  echo "[nightly-predictions] 2026 sequence rows behind ingested scores — rebuilding…"
  if ! NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/computeEloRatingsV7.ts 2>&1 | tail -2; then
    echo "[nightly-predictions] elo recompute failed (non-fatal — sequences fall back to averages)"
  fi
  if NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx src/buildMlSequencesV9Subcaption.ts --seasons 2026 2>&1 | tail -3; then
    echo "[nightly-predictions] 2026 ML sequences rebuilt."
  else
    echo "[nightly-predictions] 2026 sequence rebuild FAILED (non-fatal; predictions stay on baselines)"
  fi
fi

if [ -z "$missing" ]; then
  echo "[nightly-predictions] no events to (re)generate — nothing to do."
  exit 0
fi

echo "[nightly-predictions] (re)generating predictions for (missing + upcoming):"
echo "$missing" | sed 's/^/  - /'

failures=0
while IFS= read -r slug; do
  [ -z "$slug" ] && continue
  echo "[nightly-predictions] === $slug"
  # Cap each prediction's heap so a single tfjs run can't balloon the 4GB box;
  # processes run one at a time and exit, so memory doesn't accumulate.
  if ! NODE_OPTIONS="--max-old-space-size=1536" vp exec tsx scripts/predictEventRecap.ts --event "$slug" --save-db; then
    echo "[nightly-predictions] FAILED: $slug (continuing)"
    failures=$((failures + 1))
  fi
done <<<"$missing"

# Publish, unless the caller will emit once itself (SKIP_PUBLISH=1) — e.g.
# auto-ingest-scores.sh runs this for future-only regen, then does the single
# read-model publish so scores + refreshed forecasts ship together (review #1).
if [ "${SKIP_PUBLISH:-0}" = "1" ]; then
  echo "[nightly-predictions] SKIP_PUBLISH=1 — leaving the read-model publish to the caller."
else
  echo "[nightly-predictions] republishing prod read-model…"
  # Cap the emit heap and skip the media-cache sync (predictions don't change media).
  SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2048" bash "$repo_root/scripts/refresh-prod-read-model.sh"
fi

if [ "$failures" -gt 0 ]; then
  echo "[nightly-predictions] done with $failures failure(s)."
  exit 1
fi
echo "[nightly-predictions] done."
