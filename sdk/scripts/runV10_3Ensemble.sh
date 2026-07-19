#!/bin/bash
# v10.3 ensemble training driver. CONTROL lane, FIELD-PACE profile + P2 thin-history
# augmentation, 8 seeds 42-49 on dev6 (field-pace features + 2026 thru 07-11). This is the
# "all model-side improvements" model: P1 field-pace (216-dim) + P2 truncation aug + 2026 data.
# P3 baseline-blend is DEFERRED (train/serve mismatch; see /root/v10.3-status.md).
# Phase-aware-lr is NOT used (buggy with date-gated training, proven on v10.1).
# After all seeds finish, this driver RUNS THE 4-WAY EVAL ITSELF and writes
# results/v10_3_eval/REPORT.txt + touches logs/v10_3_eval_DONE.flag -- no external watcher.
# Threads pinned so 3 concurrent runs don't oversubscribe the 16 cores.
set -u
cd /root/corps-place-v10/sdk
export TF_NUM_INTRAOP_THREADS=5
export TF_NUM_INTEROP_THREADS=1
export OMP_NUM_THREADS=5
MAXJOBS=3
mkdir -p logs results models results/v10_3_eval

SEEDS=(42 43 44 45 46 47 48 49)
PROFILE=field-pace
SLUG=field_pace

run_one() {
  local seed="$1"
  npx tsx src/training/trainModelV10Final.ts --profile "$PROFILE" --seed "$seed" \
    --db ./data/v10-training-dev6.db \
    --model-dir "./models/v10_3_${SLUG}" \
    --norm-path "./results/v10_3-${PROFILE}-seed-${seed}-target-norm.json" \
    --log-csv "./results/v10_3-${PROFILE}-seed-${seed}-training-log.csv" \
    --trial-id "v10_3_${SLUG}_seed${seed}" \
    --train-after-date 2025-12-31 --patience 35 \
    --thin-history-sample-fraction 0.45 --thin-history-truncation-rate 0.25 \
    > "logs/v10_3_${SLUG}_seed${seed}.log" 2>&1
  echo "DONE ${PROFILE} seed${seed} $(date -u)" >> logs/v10_3_driver.log
}

echo "driver start $(date -u) intraop=$TF_NUM_INTRAOP_THREADS maxjobs=$MAXJOBS" > logs/v10_3_driver.log
for seed in "${SEEDS[@]}"; do
  while [ "$(jobs -r | wc -l)" -ge "$MAXJOBS" ]; do sleep 30; done
  echo "launch seed$seed $(date -u)" >> logs/v10_3_driver.log
  run_one "$seed" &
  sleep 15
done
wait
echo "ALL_V10_3_TRAINING_DONE $(date -u)" >> logs/v10_3_driver.log
touch logs/v10_3_training_DONE.flag

# ---- EVAL (built into the driver; this -p session will have exited) ----
echo "eval start $(date -u)" >> logs/v10_3_driver.log
bash scripts/runV10_3Eval.sh >> logs/v10_3_driver.log 2>&1
python3 scripts/evalV10_3.py > results/v10_3_eval/REPORT.txt 2>> logs/v10_3_driver.log
echo "ALL_V10_3_EVAL_DONE $(date -u)" >> logs/v10_3_driver.log
touch logs/v10_3_eval_DONE.flag

# results/ is gitignored, so publish a TRACKED copy of the report and auto-commit+push
# (best-effort; the report + flag remain on disk regardless of git success).
{
  cp results/v10_3_eval/REPORT.txt ../docs/V10_3_EVAL_REPORT.txt
  cd /root/corps-place-v10
  git add docs/V10_3_EVAL_REPORT.txt
  git commit -m "v10.3 eval: 4-way holdout report (V10 vs v10.1 vs v10.2 vs v10.3 field-pace)

Auto-committed by runV10_3Ensemble.sh after unattended training+eval.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  git push origin codex/v10.3-field-pace
} >> /root/corps-place-v10/sdk/logs/v10_3_driver.log 2>&1
echo "REPORT_PUBLISHED $(date -u)" >> /root/corps-place-v10/sdk/logs/v10_3_driver.log
