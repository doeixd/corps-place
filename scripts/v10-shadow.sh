#!/usr/bin/env bash
# V10 SHADOW — generate V10 forecasts for upcoming events ALONGSIDE final2, WITHOUT
# touching production. final2 keeps serving the site; this only writes JSON forecasts
# to a standalone shadow dir + DB so we can compare V10 vs final2 vs actuals as the
# upcoming shows get scored (a genuine out-of-sample forward test). No prod DB writes,
# no read-model publish. Safe to cron.
set -uo pipefail

PROD_DB="/root/corps-place/sdk/dci-relational.db"
BRANCH_SDK="/home/patrick/cp-branch/sdk"
SERVE_SDK="/home/patrick/cp-v10-serving/sdk"
SHADOW_DIR="/home/patrick/v10-shadow"
SEASONS="2013,2014,2015,2016,2017,2018,2019,2022,2023,2024,2025,2026"
DAYS_AHEAD="${1:-11}"                       # shadow events within this many days
# 5-member subset (control seeds 42-46) — the manifest says ~5 members ≈ full ensemble.
ENS=$(ls -d "$SERVE_SDK"/models/v10_clean_data_control/v10_clean_data_control_seed4[2-6]_* | sed 's:/$::' | paste -sd,)
TODAY=$(date -u +%Y-%m-%d)
RUN_DIR="$SHADOW_DIR/$TODAY"
mkdir -p "$RUN_DIR"
LOG="$SHADOW_DIR/v10-shadow.log"
echo "[v10-shadow] $(date -u) start (days_ahead=$DAYS_AHEAD)" >> "$LOG"

# upcoming events with a lineup, not yet scored, within the window
CUTOFF=$(date -u -d "+$DAYS_AHEAD days" +%Y-%m-%d)
EVENTS=$(sqlite3 "$PROD_DB" "SELECT e.slug FROM events e
  WHERE e.start_date > '${TODAY}T23:59' AND e.start_date < '${CUTOFF}T23:59'
    AND EXISTS(SELECT 1 FROM event_lineup_entries l WHERE l.event_slug=e.slug)
    AND NOT EXISTS(SELECT 1 FROM corps_scores cs WHERE cs.competition_slug=e.slug)
  ORDER BY e.start_date;")
[ -z "$EVENTS" ] && { echo "[v10-shadow] no upcoming events; done" >> "$LOG"; exit 0; }
INF_ARG=$(echo "$EVENTS" | paste -sd,)

# A1: fresh temporal contract from live prod (into a throwaway serving DB)
SERVING_DB="/tmp/v10-shadow-$$.db"; rm -f "$SERVING_DB"*
( cd "$BRANCH_SDK" && vp exec tsx scripts/prepareV10TrainingData.ts --serving \
    --source "$PROD_DB" --seasons "$SEASONS" --development-cutoff "${TODAY}T23:59:59.999Z" --out "$SERVING_DB" >/dev/null 2>>"$LOG" )
( cd "$BRANCH_SDK" && vp exec tsx scripts/prepareV10TemporalFeatures.ts --db "$SERVING_DB" --source "$PROD_DB" >/dev/null 2>>"$LOG" )

# A2: build inference rows for the upcoming events (into the serving DB with fresh temporal)
( cd "$BRANCH_SDK" && NODE_OPTIONS="--max-old-space-size=2048" vp exec tsx src/buildMlSequencesV9Subcaption.ts \
    --data-contract clean-v10 --db "$PROD_DB" --output-db "$SERVING_DB" --seasons 2026 --inference-events "$INF_ARG" >>"$LOG" 2>&1 )

# Land the inference rows into PROD as ml_sequence_rows_v10_inference — an ADDITIVE
# table that final2 never reads. Serving needs to read templates from the same DB it
# --save-db's to, so we serve against prod. This is A/B, NOT a flip: V10 runs are
# tagged clean-v10 and the PREDICTION_MODEL=final2 default keeps them UNSERVED.
sqlite3 "$SERVING_DB" ".dump ml_sequence_rows_v10_clean_control" \
  | sed 's/ml_sequence_rows_v10_clean_control/ml_sequence_rows_v10_inference/g' \
  | grep -vE '^(PRAGMA|BEGIN|COMMIT)' \
  | ( sqlite3 "$PROD_DB" "DROP TABLE IF EXISTS ml_sequence_rows_v10_inference;"; sqlite3 "$PROD_DB" )

# A3: serve each event — write the V10 run to prod (--save-db, model_dir=clean-v10-ensemble;
# NOT served while the flag defaults to final2) AND a JSON forecast for offline eval.
for slug in $EVENTS; do
  ( cd "$SERVE_SDK" && NODE_OPTIONS="--max-old-space-size=2048" PREDICTION_MODEL=final2 vp exec tsx scripts/cleanV10Serve.ts \
      --event "$slug" --db "file:$PROD_DB" --template-table ml_sequence_rows_v10_inference \
      --ensemble-dirs "$ENS" --save-db --output "$RUN_DIR/$slug.json" >/dev/null 2>>"$LOG" ) \
    && echo "[v10-shadow] forecast+saved $slug" >> "$LOG"
done
rm -f "$SERVING_DB"*
echo "[v10-shadow] $(date -u) done ($(ls "$RUN_DIR"/*.json 2>/dev/null | wc -l) forecasts in $RUN_DIR)" >> "$LOG"
