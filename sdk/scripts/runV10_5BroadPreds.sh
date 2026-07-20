#!/bin/bash
# v10.5: generate v10.4 8-seed predictions on the FULL 2026 eval set (06-27..07-16) so the
# leakage-safe division recal can be FIT on resolved shows strictly BEFORE each holdout target.
# Same contract as runV10_4Eval.sh (field-pace, STATIC_DIM 216, identity-agnostic, per-seed norm)
# but eval-from-date pulled back to capture the pre-holdout shows. --all-row-details emits every
# scored row (leakage-safe baselines computed strictly-before-target inside the replay).
set -u
cd /root/corps-place-v10/sdk
OUT=results/v10_5_eval
EVDB=data/v10-evaluation-2026-07-17.db
DEV6=data/v10-training-dev6.db
FP=ml_sequence_rows_v10_field_pace
COMMON="--season 2026 --evaluation-db $EVDB \
  --eval-from-date 2026-06-01 --curve-anchor-fallback --identity-agnostic \
  --row-details --all-row-details"
mkdir -p $OUT
: > $OUT/broad_errors.log

latest() { ls -dt $1 2>/dev/null | head -1; }
for s in 42 43 44 45 46 47 48 49; do
  d=$(latest "models/v10_4_field_pace/*seed${s}_*/model.json"); d=${d%/model.json}
  if [ -z "$d" ]; then echo "MISSING v10.4 fp s$s"; continue; fi
  timeout 900 npx tsx scripts/replayFinal2Baseline.ts $COMMON --ml-table "$FP" \
    --raw-static-dim 216 \
    --db "$DEV6" --norm-path results/v10_4-field-pace-seed-${s}-target-norm.json \
    --model-dir "$d" --reference-model-dir "$d" --seed "$s" \
    --output-json "$OUT/v10_4-fp-s${s}-broad.json" > /dev/null 2>> $OUT/broad_errors.log \
    && echo "ok  v10_4-fp-s${s}-broad.json" || echo "FAIL v10_4-fp-s${s}-broad.json"
done
echo "BROAD_DONE"
