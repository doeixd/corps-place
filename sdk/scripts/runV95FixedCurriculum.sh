#!/usr/bin/env bash
set -euo pipefail

seed="${1:-43}"
db_path="${V95_DB_PATH:-./dci-relational-scrape.db}"
model_dir="${V95_FIXED_MODEL_DIR:-./models/v95_fixed_curriculum}"
norm_path="${V95_FIXED_NORM_PATH:-./results/v95-fixed-curriculum-seed-${seed}-target-norm.json}"

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
  --log-csv "./results/v95-fixed-curriculum-seed-${seed}-training-log.csv" \
  --reproduction-contract final2 \
  --seed "$seed" \
  --trial-id "v95_fixed_curriculum_seed${seed}" \
  --auto-curriculum false \
  --curriculum-phase-a-end 10 \
  --curriculum-phase-b-end 40
