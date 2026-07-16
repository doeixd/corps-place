#!/usr/bin/env bash
set -euo pipefail

seed="${1:-43}"
db_path="${V95_DB_PATH:-./dci-relational-scrape.db}"
model_dir="${V95_SCALE_MODEL_DIR:-./models/v95_scale_ablation}"
norm_path="${V95_SCALE_NORM_PATH:-./results/v95-scale2x-seed-${seed}-target-norm.json}"

case "$seed" in
  ''|*[!0-9]*)
    echo "seed must be a non-negative integer: $seed" >&2
    exit 2
    ;;
esac

exec npm run train:v95 -- \
  --db "$db_path" \
  --model-dir "$model_dir" \
  --norm-path "$norm_path" \
  --log-csv "./results/v95-scale2x-seed-${seed}-training-log.csv" \
  --reproduction-contract final2 \
  --seed "$seed" \
  --trial-id "v95_scale2x_seed${seed}" \
  --lstm1-units 192 \
  --lstm2-units 96 \
  --dense1-units 768 \
  --dense2-units 384 \
  --accuracy-trunk-units 405 \
  --lr 0.00055
