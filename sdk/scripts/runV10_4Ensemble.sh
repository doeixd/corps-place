#!/bin/bash
# v10.4 ensemble training driver. CONTROL lane, FIELD-PACE profile + P2 aug (IDENTICAL to v10.3),
# on dev6 (field-pace + 2026<=07-11). The ONLY change vs v10.3 is the C1 spread-preserving /
# high-end-aware LOSS, so the 4-way holdout eval ISOLATES the loss change. On the honest holdout
# the dominant miss is the SIGNED BIAS (spread ratio is already ~1), so we sweep asym-tau strength
# at fixed high-end 2.0 to bracket the bias correction (overshoot is the main risk per guardrails):
#   SHIP    (v10_4,  seeds 42-49): --high-end-weight 2.0 --asym-tau 0.70   -> models/v10_4_field_pace
#   GENTLER (v10_4b, seeds 42-44): --high-end-weight 2.0 --asym-tau 0.60   -> models/v10_4b_field_pace
#   PURE-HE (v10_4c, seeds 42-43): --high-end-weight 2.0 (tau=0.5, no asym)-> models/v10_4c_field_pace
# C2 (full-2026) has no honest headroom right now: the only post-07-11 data IS the holdout shows
# (training source maxes at 07-14) and no August finals exist yet -> dev7==dev6 (see v10.4-status).
# Phase-aware-lr NOT used (buggy with date-gated training). After all seeds finish, this driver
# RUNS THE EVAL ITSELF and publishes docs/V10_4_EVAL_REPORT.txt -- no external watcher.
set -u
cd /root/corps-place-v10/sdk
export TF_NUM_INTRAOP_THREADS=5
export TF_NUM_INTEROP_THREADS=1
export OMP_NUM_THREADS=5
MAXJOBS=3
mkdir -p logs results models results/v10_4_eval

PROFILE=field-pace
DEV6=./data/v10-training-dev6.db

run_one() {  # $1=slug(model subdir tag) $2=seed $3="extra C1 flags"
  local slug="$1" seed="$2" extra="$3"
  npx tsx src/training/trainModelV10Final.ts --profile "$PROFILE" --seed "$seed" \
    --db "$DEV6" \
    --model-dir "./models/${slug}_field_pace" \
    --norm-path "./results/${slug}-field-pace-seed-${seed}-target-norm.json" \
    --log-csv "./results/${slug}-field-pace-seed-${seed}-training-log.csv" \
    --trial-id "${slug}_field_pace_seed${seed}" \
    --train-after-date 2025-12-31 --patience 35 \
    --thin-history-sample-fraction 0.45 --thin-history-truncation-rate 0.25 \
    $extra \
    > "logs/${slug}_field_pace_seed${seed}.log" 2>&1
  echo "DONE ${slug} seed${seed} $(date -u)" >> logs/v10_4_driver.log
}

echo "driver start $(date -u) intraop=$TF_NUM_INTRAOP_THREADS maxjobs=$MAXJOBS" > logs/v10_4_driver.log

# Job list: PRIMARY (v10_4) seeds 42-49, then ABLATION (v10_4b) seeds 42-44.
# Format: "slug seed :: extra flags"
JOBS=(
  "v10_4 42 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 43 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 44 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 45 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 46 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 47 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 48 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4 49 :: --high-end-weight 2.0 --asym-tau 0.70"
  "v10_4b 42 :: --high-end-weight 2.0 --asym-tau 0.60"
  "v10_4b 43 :: --high-end-weight 2.0 --asym-tau 0.60"
  "v10_4b 44 :: --high-end-weight 2.0 --asym-tau 0.60"
  "v10_4c 42 :: --high-end-weight 2.0"
  "v10_4c 43 :: --high-end-weight 2.0"
)

for job in "${JOBS[@]}"; do
  slug="${job%% *}"
  rest="${job#* }"; seed="${rest%% *}"
  extra="${job#*:: }"
  while [ "$(jobs -r | wc -l)" -ge "$MAXJOBS" ]; do sleep 30; done
  echo "launch ${slug} seed${seed} [${extra}] $(date -u)" >> logs/v10_4_driver.log
  run_one "$slug" "$seed" "$extra" &
  sleep 15
done
wait
echo "ALL_V10_4_TRAINING_DONE $(date -u)" >> logs/v10_4_driver.log
touch logs/v10_4_training_DONE.flag

# ---- EVAL (built into the driver; this -p session will have exited) ----
echo "eval start $(date -u)" >> logs/v10_4_driver.log
bash scripts/runV10_4Eval.sh >> logs/v10_4_driver.log 2>&1
python3 scripts/evalV10_4.py > results/v10_4_eval/REPORT.txt 2>> logs/v10_4_driver.log
echo "ALL_V10_4_EVAL_DONE $(date -u)" >> logs/v10_4_driver.log
touch logs/v10_4_eval_DONE.flag

# publish a TRACKED copy of the report and auto-commit+push (best-effort).
{
  cp results/v10_4_eval/REPORT.txt ../docs/V10_4_EVAL_REPORT.txt
  cd /root/corps-place-v10
  git add docs/V10_4_EVAL_REPORT.txt sdk/scripts/runV10_4Ensemble.sh sdk/scripts/runV10_4Eval.sh \
          sdk/scripts/evalV10_4.py sdk/src/training/trainModelV95.ts sdk/src/training/v95Config.ts
  git commit -m "v10.4 eval: C1 spread-preserving/high-end-aware loss vs V10/v10.2/v10.3 (decompression report)

Auto-committed by runV10_4Ensemble.sh after unattended training+eval.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  git push origin codex/v10.4-spread-loss
} >> /root/corps-place-v10/sdk/logs/v10_4_driver.log 2>&1
echo "REPORT_PUBLISHED $(date -u)" >> /root/corps-place-v10/sdk/logs/v10_4_driver.log
