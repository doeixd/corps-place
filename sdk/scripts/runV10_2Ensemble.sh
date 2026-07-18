#!/bin/bash
# v10.2 ensemble training driver. CONTROL LANE ONLY, 8 seeds 42-49 (mirrors the frozen
# V10 control ensemble) on dev5 (+2026 thru 07-11). Phase-aware-lr is DROPPED (buggy with
# date-gated training). After all seeds finish, this driver RUNS THE EVAL ITSELF and writes
# results/v10_2_eval/REPORT.txt + touches logs/v10_2_eval_DONE.flag -- no external watcher.
# Threads pinned so 3 concurrent runs don't oversubscribe the 16 cores.
set -u
cd /root/corps-place-v10/sdk
export TF_NUM_INTRAOP_THREADS=5
export TF_NUM_INTEROP_THREADS=1
export OMP_NUM_THREADS=5
MAXJOBS=3
mkdir -p logs results models results/v10_2_eval

SEEDS=(42 43 44 45 46 47 48 49)
PROFILE=clean-data-control
SLUG=clean_data_control

run_one() {
  local seed="$1"
  npx tsx src/training/trainModelV10Final.ts --profile "$PROFILE" --seed "$seed" \
    --db ./data/v10-training-dev5.db \
    --model-dir "./models/v10_2_${SLUG}" \
    --norm-path "./results/v10_2-${PROFILE}-seed-${seed}-target-norm.json" \
    --log-csv "./results/v10_2-${PROFILE}-seed-${seed}-training-log.csv" \
    --trial-id "v10_2_${SLUG}_seed${seed}" \
    --train-after-date 2025-12-31 --patience 35 \
    > "logs/v10_2_${SLUG}_seed${seed}.log" 2>&1
  echo "DONE ${PROFILE} seed${seed} $(date -u)" >> logs/v10_2_driver.log
}

echo "driver start $(date -u) intraop=$TF_NUM_INTRAOP_THREADS maxjobs=$MAXJOBS" > logs/v10_2_driver.log
for seed in "${SEEDS[@]}"; do
  while [ "$(jobs -r | wc -l)" -ge "$MAXJOBS" ]; do sleep 30; done
  echo "launch seed$seed $(date -u)" >> logs/v10_2_driver.log
  run_one "$seed" &
  sleep 15
done
wait
echo "ALL_V10_2_TRAINING_DONE $(date -u)" >> logs/v10_2_driver.log
touch logs/v10_2_training_DONE.flag

# ---- EVAL (built into the driver; this -p session will have exited) ----
echo "eval start $(date -u)" >> logs/v10_2_driver.log
bash scripts/runV10_2Eval.sh >> logs/v10_2_driver.log 2>&1
python3 scripts/evalV10_2.py > results/v10_2_eval/REPORT.txt 2>> logs/v10_2_driver.log
echo "ALL_V10_2_EVAL_DONE $(date -u)" >> logs/v10_2_driver.log
touch logs/v10_2_eval_DONE.flag

# results/ is gitignored, so publish a TRACKED copy of the report and auto-commit+push
# (best-effort; the report + flag remain on disk regardless of git success).
{
  cp results/v10_2_eval/REPORT.txt ../docs/V10_2_EVAL_REPORT.txt
  cd /root/corps-place-v10
  git add docs/V10_2_EVAL_REPORT.txt
  git commit -m "v10.2 eval: 3-way holdout report (V10 vs v10.1 vs v10.2, +2026 thru 07-11)

Auto-committed by runV10_2Ensemble.sh after unattended training+eval.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  git push origin codex/v10.2-2026-fulldata
} >> /root/corps-place-v10/sdk/logs/v10_2_driver.log 2>&1
echo "REPORT_PUBLISHED $(date -u)" >> /root/corps-place-v10/sdk/logs/v10_2_driver.log
