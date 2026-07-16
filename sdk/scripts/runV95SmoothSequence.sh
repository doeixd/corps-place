#!/usr/bin/env bash
set -euo pipefail

seed="${1:-43}"
db_path="${V95_DB_PATH:-./dci-relational-scrape.db}"

exec npm run train:v95 -- \
  --db "$db_path" \
  --model-dir "${V95_SMOOTH_SEQ_MODEL_DIR:-./models/v95_smooth_sequence}" \
  --norm-path "${V95_SMOOTH_SEQ_NORM_PATH:-./results/v95-smooth-sequence-seed-${seed}-target-norm.json}" \
  --log-csv "./results/v95-smooth-sequence-seed-${seed}-training-log.csv" \
  --reproduction-contract final2 \
  --seed "$seed" \
  --trial-id "v95_smooth_sequence_seed${seed}" \
  --auto-curriculum false \
  --curriculum-phase-a-end 10 \
  --curriculum-phase-b-end 40 \
  --sequence-transition-epochs 4
