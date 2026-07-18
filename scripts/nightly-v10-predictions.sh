#!/usr/bin/env bash
# Nightly V10 (clean-v10) prediction orchestration.
#
# Produces V10 predictions for upcoming events by: building clean-v10 INFERENCE
# feature rows from each event's lineup (Phase A2, branch builder), serving them
# through the identity-agnostic ensemble at the trained contract (cleanV10Serve),
# and saving in the standard model_event_prediction_runs format the read-model
# consumes (newest-run-per-event wins — no API change needed).
#
# STATUS: the build->serve->save->publish path is proven end-to-end. The ONE piece
# not yet automated is the temporal-contract REFRESH (see A1 below): the existing
# prepare scripts are hash-locked to the frozen training snapshot and cannot run on
# live data. Until a serving-refresh variant exists, this script only serves events
# whose corps history is within the current (frozen 07-17) temporal contract in prod.
#
# Usage: nightly-v10-predictions.sh <event-slug> [<event-slug> ...]
set -euo pipefail

PROD_DB="/root/corps-place/sdk/dci-relational.db"
BRANCH_SDK="/home/patrick/cp-branch/sdk"                 # builder (branch-only deps)
SERVE_SDK="/home/patrick/cp-v10-serving/sdk"             # cleanV10Serve (master)
TEMPORAL_BASE="/home/patrick/cp-v10-serving/sdk/data/v10-eval-clean2.db"  # has v10_temporal_* + schema
ENS=$(ls -d "$SERVE_SDK"/models/v10_clean_data_control/*/ "$SERVE_SDK"/models/v10_phase_aware_lr/*/ | sed 's:/$::' | paste -sd,)

if [ "$#" -lt 1 ]; then echo "usage: $0 <event-slug> [<event-slug> ...]"; exit 1; fi
EVENTS="$*"

# ── A1 (TODO: serving-temporal refresh) ───────────────────────────────────────
# The prod temporal contract (v10_temporal_*) must cover each corps' history up to
# the target event. Currently frozen at 07-17. A serving variant of
# prepareV10TrainingData/prepareV10TemporalFeatures (relax the source hash + fixed
# 7317-row invariants; compute current-season temporal incrementally) must run here
# nightly and land fresh v10_temporal_* into $PROD_DB. Skipped for now.

# ── A2: build clean-v10 inference rows for the target events ──────────────────
SERVING_DB="/tmp/v10-serving-$$.db"
cp "$TEMPORAL_BASE" "$SERVING_DB"    # carries v10_temporal_* + clean_control schema
INF_ARG=$(echo "$EVENTS" | tr ' ' ',')
( cd "$BRANCH_SDK" && NODE_OPTIONS="--max-old-space-size=3072" vp exec tsx src/buildMlSequencesV9Subcaption.ts \
    --data-contract clean-v10 --db "$PROD_DB" --output-db "$SERVING_DB" \
    --seasons 2026 --inference-events "$INF_ARG" )

# Land the freshly-built inference rows into prod so cleanV10Serve can read them.
sqlite3 "$SERVING_DB" ".dump ml_sequence_rows_v10_clean_control" \
  | sed 's/ml_sequence_rows_v10_clean_control/ml_sequence_rows_v10_inference/g' \
  | grep -vE '^(PRAGMA|BEGIN|COMMIT)' \
  | ( sqlite3 "$PROD_DB" "DROP TABLE IF EXISTS ml_sequence_rows_v10_inference;"; sqlite3 "$PROD_DB" )

# ── A3: serve each event + save the prediction run ───────────────────────────
for slug in $EVENTS; do
  echo "[nightly-v10] serving $slug"
  ( cd "$SERVE_SDK" && NODE_OPTIONS="--max-old-space-size=2560" vp exec tsx scripts/cleanV10Serve.ts \
      --event "$slug" --db "file:$PROD_DB" \
      --template-table ml_sequence_rows_v10_inference \
      --ensemble-dirs "$ENS" --save-db )
done
rm -f "$SERVING_DB"

# ── Publish read-model ────────────────────────────────────────────────────────
echo "[nightly-v10] republishing read-model"
SKIP_MEDIA_SYNC=1 NODE_OPTIONS="--max-old-space-size=2048" bash /root/corps-place/scripts/refresh-prod-read-model.sh
echo "[nightly-v10] done."
