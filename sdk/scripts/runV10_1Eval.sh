#!/bin/bash
# Evaluate V10 (frozen, 2013-2025) and v10.1 (+2026 thru 07-06) on the identical
# held-out 2026 slice (2026-07-07 .. 07-16). Same agnostic-ensemble eval method.
# V10 models get dev3 training stats; v10.1 models get dev4 training stats.
set -u
cd /root/corps-place-v10/sdk
OUT=results/v10_1_eval
EVDB=data/v10-evaluation-2026-07-17.db
COMMON="--season 2026 --evaluation-db $EVDB --ml-table ml_sequence_rows_v10_clean_control \
  --eval-from-date 2026-07-07 --curve-anchor-fallback --identity-agnostic \
  --row-details --all-row-details"
mkdir -p $OUT

replay() {  # $1=modeldir $2=seed $3=trainingdb $4=outfile
  timeout 600 npx tsx scripts/replayFinal2Baseline.ts $COMMON \
    --db "$3" --model-dir "$1" --reference-model-dir "$1" --seed "$2" \
    --output-json "$OUT/$4" > /dev/null 2>> $OUT/eval_errors.log \
    && echo "ok  $4" || echo "FAIL $4"
}

# ---- V10 frozen members (manifest dirs). Matched 8 -> V10-*, extra 4 -> V10x-*
M=models/v10_clean_data_control
P=models/v10_phase_aware_lr
replay $M/v10_clean_data_control_seed42_1784310309665 42 data/v10-training-dev3.db V10-ctrl-s42-holdout.json
replay $M/v10_clean_data_control_seed43_1784309180483 43 data/v10-training-dev3.db V10-ctrl-s43-holdout.json
replay $M/v10_clean_data_control_seed44_1784319040206 44 data/v10-training-dev3.db V10-ctrl-s44-holdout.json
replay $M/v10_clean_data_control_seed45_1784328103278 45 data/v10-training-dev3.db V10-ctrl-s45-holdout.json
replay $M/v10_clean_data_control_seed46_1784328117722 46 data/v10-training-dev3.db V10-ctrl-s46-holdout.json
replay $P/v10_phase_aware_lr_seed42_1784328262113 42 data/v10-training-dev3.db V10-pa-s42-holdout.json
replay $P/v10_phase_aware_lr_seed43_1784328243411 43 data/v10-training-dev3.db V10-pa-s43-holdout.json
replay $P/v10_phase_aware_lr_seed44_1784338287990 44 data/v10-training-dev3.db V10-pa-s44-holdout.json
# extra V10 seeds (full-12 context only)
replay $M/v10_clean_data_control_seed47_1784328282076 47 data/v10-training-dev3.db V10x-ctrl-s47-holdout.json
replay $M/v10_clean_data_control_seed48_1784337979944 48 data/v10-training-dev3.db V10x-ctrl-s48-holdout.json
replay $M/v10_clean_data_control_seed49_1784338135014 49 data/v10-training-dev3.db V10x-ctrl-s49-holdout.json
replay $P/v10_phase_aware_lr_seed45_1784338304752 45 data/v10-training-dev3.db V10x-pa-s45-holdout.json

# ---- v10.1 members (resolve newest run dir per seed/lane)
latest() { ls -dt $1 2>/dev/null | head -1; }
for s in 42 43 44 45 46; do
  d=$(latest "models/v10_1_clean_data_control/*seed${s}_*")
  [ -n "$d" ] && replay "$d" $s data/v10-training-dev4.db v10_1-ctrl-s${s}-holdout.json || echo "MISSING v10.1 ctrl s$s"
done
for s in 42 43 44; do
  d=$(latest "models/v10_1_phase_aware_lr/*seed${s}_*")
  [ -n "$d" ] && replay "$d" $s data/v10-training-dev4.db v10_1-pa-s${s}-holdout.json || echo "MISSING v10.1 pa s$s"
done
echo "EVAL_DONE"
