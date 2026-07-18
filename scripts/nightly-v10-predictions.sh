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
BRANCH_SDK="/home/patrick/cp-branch/sdk"                 # builder + prepare scripts (branch-only deps)
SERVE_SDK="/home/patrick/cp-v10-serving/sdk"             # cleanV10Serve (master)
SEASONS="2013,2014,2015,2016,2017,2018,2019,2022,2023,2024,2025,2026"
ENS=$(ls -d "$SERVE_SDK"/models/v10_clean_data_control/*/ "$SERVE_SDK"/models/v10_phase_aware_lr/*/ | sed 's:/$::' | paste -sd,)

if [ "$#" -lt 1 ]; then echo "usage: $0 <event-slug> [<event-slug> ...]"; exit 1; fi
EVENTS="$*"
INF_ARG=$(echo "$EVENTS" | tr ' ' ',')
TODAY=$(date -u +%Y-%m-%dT23:59:59.999Z)

# ── A1: refresh the clean-v10 temporal contract from LIVE prod data ───────────
# Keeps v10_temporal_* fresh through the latest scored show so the inference build
# has feature coverage for the target events' corps histories.
SERVING_DB="/tmp/v10-serving-$$.db"
rm -f "$SERVING_DB" "$SERVING_DB.manifest.json"
( cd "$BRANCH_SDK" && vp exec tsx scripts/prepareV10TrainingData.ts --serving \
    --source "$PROD_DB" --seasons "$SEASONS" --development-cutoff "$TODAY" --out "$SERVING_DB" >/dev/null )
( cd "$BRANCH_SDK" && vp exec tsx scripts/prepareV10TemporalFeatures.ts \
    --db "$SERVING_DB" --source "$PROD_DB" >/dev/null )

# ── A2: build clean-v10 inference rows for the target events ──────────────────
# The builder reads the temporal contract from --output-db (the fresh SERVING_DB).
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
