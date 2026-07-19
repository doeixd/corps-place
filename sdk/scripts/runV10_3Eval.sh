#!/bin/bash
# 4-way eval on the identical held-out 2026 slice (2026-07-12 .. 07-16, 39 rows/6 shows):
#   V10   (frozen, 2013-2025)  control seeds 42-49  (dev3 db,  clean_control table)
#   v10.1 (+2026 thru 07-06)   control seeds 42/43/44 (dev4 db, clean_control table)
#   v10.2 (+2026 thru 07-11)   control seeds 42-49  (dev5 db,  clean_control table)
#   v10.3 (+2026 thru 07-11, FIELD-PACE + P2 aug) seeds 42-49 (dev6 db, field_pace table)
# Agnostic ensemble eval; each model uses its EXACT saved training norm (--norm-path) and
# its OWN ml-table (V10/v10.1/v10.2 = clean_control 212-dim; v10.3 = field_pace 216-dim).
# All models score the SAME 39 (slug,corps) holdout keys in the same eval DB.
# competition_date carries a T00:00:00Z suffix, so --eval-from-date 2026-07-12 alone is
# correct (07-16 is the max date; a lexical --eval-to-date 2026-07-16 would drop 07-16).
set -u
cd /root/corps-place-v10/sdk
OUT=results/v10_3_eval
EVDB=data/v10-evaluation-2026-07-17.db
COMMON="--season 2026 --evaluation-db $EVDB \
  --eval-from-date 2026-07-12 --curve-anchor-fallback --identity-agnostic \
  --row-details --all-row-details"
mkdir -p $OUT
: > $OUT/eval_errors.log

# Ground-truth cohort for the 39 holdout rows (identical rows all 4 models score).
# Regenerated from the eval DB clean_control table (y_total = actual total).
sqlite3 -header -csv "$EVDB" \
  "SELECT competition_slug, corps_key, y_total, division_name, competition_date
   FROM ml_sequence_rows_v10_clean_control
   WHERE competition_date >= '2026-07-12' ORDER BY competition_date, competition_slug, corps_key;" \
  > $OUT/holdout_cohort.csv

replay() {  # $1=modeldir $2=seed $3=trainingdb $4=normpath $5=outfile $6=mltable
  # field-pace tables are 216-wide; the replay drop-guard must match or it silently
  # drops every row. clean_control stays 212 (the --raw-static-dim default).
  local staticdim=212
  [ "$6" = "$FP" ] && staticdim=216
  timeout 900 npx tsx scripts/replayFinal2Baseline.ts $COMMON --ml-table "$6" \
    --raw-static-dim "$staticdim" \
    --db "$3" --norm-path "$4" --model-dir "$1" --reference-model-dir "$1" --seed "$2" \
    --output-json "$OUT/$5" > /dev/null 2>> $OUT/eval_errors.log \
    && echo "ok  $5" || echo "FAIL $5"
}

CTRL=ml_sequence_rows_v10_clean_control
FP=ml_sequence_rows_v10_field_pace
M=models/v10_clean_data_control
DEV3=data/v10-training-dev3.db
DEV4=data/v10-training-dev4.db
DEV5=data/v10-training-dev5.db
DEV6=data/v10-training-dev6.db
latest() { ls -dt $1 2>/dev/null | head -1; }

# ---- V10 frozen control members (exact dirs = the frozen V10 control ensemble)
replay $M/v10_clean_data_control_seed42_1784310309665 42 $DEV3 results/v10-clean-data-control-seed-42-target-norm.json V10-ctrl-s42-holdout.json $CTRL
replay $M/v10_clean_data_control_seed43_1784309180483 43 $DEV3 results/v10-clean-data-control-seed-43-target-norm.json V10-ctrl-s43-holdout.json $CTRL
replay $M/v10_clean_data_control_seed44_1784319040206 44 $DEV3 results/v10-clean-data-control-seed-44-target-norm.json V10-ctrl-s44-holdout.json $CTRL
replay $M/v10_clean_data_control_seed45_1784328103278 45 $DEV3 results/v10-clean-data-control-seed-45-target-norm.json V10-ctrl-s45-holdout.json $CTRL
replay $M/v10_clean_data_control_seed46_1784328117722 46 $DEV3 results/v10-clean-data-control-seed-46-target-norm.json V10-ctrl-s46-holdout.json $CTRL
replay $M/v10_clean_data_control_seed47_1784328282076 47 $DEV3 results/v10-clean-data-control-seed-47-target-norm.json V10-ctrl-s47-holdout.json $CTRL
replay $M/v10_clean_data_control_seed48_1784337979944 48 $DEV3 results/v10-clean-data-control-seed-48-target-norm.json V10-ctrl-s48-holdout.json $CTRL
replay $M/v10_clean_data_control_seed49_1784338135014 49 $DEV3 results/v10-clean-data-control-seed-49-target-norm.json V10-ctrl-s49-holdout.json $CTRL

# ---- v10.1 control members (resolve newest run dir per seed)
for s in 42 43 44; do
  d=$(latest "models/v10_1_clean_data_control/*seed${s}_*")
  [ -n "$d" ] && replay "$d" $s $DEV4 results/v10_1-clean-data-control-seed-${s}-target-norm.json v10_1-ctrl-s${s}-holdout.json $CTRL || echo "MISSING v10.1 ctrl s$s"
done

# ---- v10.2 control members (resolve newest run dir per seed)
for s in 42 43 44 45 46 47 48 49; do
  d=$(latest "models/v10_2_clean_data_control/*seed${s}_*")
  [ -n "$d" ] && replay "$d" $s $DEV5 results/v10_2-clean-data-control-seed-${s}-target-norm.json v10_2-ctrl-s${s}-holdout.json $CTRL || echo "MISSING v10.2 ctrl s$s"
done

# ---- v10.3 field-pace members (resolve newest run dir per seed) -- FIELD-PACE ml-table
for s in 42 43 44 45 46 47 48 49; do
  d=$(latest "models/v10_3_field_pace/*seed${s}_*")
  [ -n "$d" ] && replay "$d" $s $DEV6 results/v10_3-field-pace-seed-${s}-target-norm.json v10_3-fp-s${s}-holdout.json $FP || echo "MISSING v10.3 fp s$s"
done
echo "EVAL_DONE"
