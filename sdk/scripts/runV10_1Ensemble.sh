#!/bin/bash
# v10.1 ensemble training driver. Balanced 6-seed set (3 control + 3 phase-aware),
# seeds matched to the frozen V10 ensemble for a paired same-seed comparison.
# Threads pinned so concurrent runs don't oversubscribe the 16 cores.
set -u
cd /root/corps-place-v10/sdk
export TF_NUM_INTRAOP_THREADS=5
export TF_NUM_INTEROP_THREADS=1
export OMP_NUM_THREADS=5
MAXJOBS=3
mkdir -p logs results models

JOBS=(
  "clean-data-control 42"
  "clean-data-control 43"
  "clean-data-control 44"
  "phase-aware-lr 42"
  "phase-aware-lr 43"
  "phase-aware-lr 44"
)

run_one() {
  local profile="$1" seed="$2"
  local slug="${profile//-/_}"
  npx tsx src/training/trainModelV10Final.ts --profile "$profile" --seed "$seed" \
    --db ./data/v10-training-dev4.db \
    --model-dir "./models/v10_1_${slug}" \
    --norm-path "./results/v10_1-${profile}-seed-${seed}-target-norm.json" \
    --log-csv "./results/v10_1-${profile}-seed-${seed}-training-log.csv" \
    --trial-id "v10_1_${slug}_seed${seed}" \
    --train-after-date 2025-12-31 --patience 35 \
    > "logs/v10_1_${slug}_seed${seed}.log" 2>&1
  echo "DONE ${profile} seed${seed} $(date -u)" >> logs/v10_1_driver.log
}

echo "driver start $(date -u) intraop=$TF_NUM_INTRAOP_THREADS maxjobs=$MAXJOBS" > logs/v10_1_driver.log
for job in "${JOBS[@]}"; do
  set -- $job
  while [ "$(jobs -r | wc -l)" -ge "$MAXJOBS" ]; do sleep 30; done
  echo "launch $1 seed$2 $(date -u)" >> logs/v10_1_driver.log
  run_one "$1" "$2" &
  sleep 15
done
wait
echo "ALL_V10_1_TRAINING_DONE $(date -u)" >> logs/v10_1_driver.log
touch logs/v10_1_training_DONE.flag
