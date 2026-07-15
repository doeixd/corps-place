#!/usr/bin/env bash
set -euo pipefail

seed="${1:?usage: bash scripts/runV95Replica.sh <seed>}"
db_path="${V95_DB_PATH:-./dci-relational-scrape.db}"
model_dir="${V95_MODEL_DIR:-./models/v95_final2_reconstruction}"
norm_path="${V95_NORM_PATH:-./results/v95-final2-seed-${seed}-target-norm.json}"

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
  --reproduction-contract final2 \
  --seed "$seed" \
  --trial-id "v95_final2_seed${seed}"
