# V9 Subcaption Fixed Ablation Plan

This plan targets interval calibration and MB/MP performance while preserving or improving delta MAE.

## Goals

- Move validation/test coverage from ~0.98-1.00 toward ~0.80-0.88.
- Reduce interval width while maintaining or improving `delta_mae_pts`.
- Confirm whether SWA or best-checkpoint gives better test performance.
- Improve MB/MP caption error and width without regressing GE/VA materially.

## Code knobs now available

- `--val-mode show-random|date-forward` (default `show-random`)
- `--val-date-cutoff YYYY-MM-DD` (optional explicit date-forward cutoff)
- `--division-filter all|"World Class"|"Open Class"` (default `all`)
- `--base-width-multiplier` (default `1.28`)
- `--coverage-sharpness` (default `2.0`)
- `--identity-dropout-floor` (default `0.05`)
- `--accuracy-trunk-units` (default `128`)
- `--mbmp-loss-boost` (default `1.0`)
- `--final-weights` (`swa_or_best` default, or `best`)

## Run order

1. Baseline control (current behavior).
2. Interval squeeze ablations (width prior and soft coverage sharpness).
3. SWA vs best-checkpoint comparison on best interval config.
4. Identity dropout floor ablation (0.05 vs 0.00).
5. Accuracy trunk width ablation (128 vs 256).
6. MB/MP emphasis ablation.

## Metrics to compare each run

- Validation and test: `delta_mae_pts`, `recap_mae_pts`, `total_mae_pts`, `coverage`, `width`, `width_floor_pct`.
- Slices emitted in each run report: by caption, division, early/mid/late season, panel-known/panel-unknown, and history depth.
- Named evaluation sets emitted when populated: validation, all test rows, World Class test, Open Class test, championship week, early season, sparse history.

## Command template

Run from `sdk` directory.

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts \
  --trial-id <trial_id> \
  --epochs 400 \
  --samples-per-epoch 4096 \
  --batch 128
```

## Screening runs (recommended)

### 0) Control

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_ctrl --epochs 400 --samples-per-epoch 4096 --batch 128
```

### 1) Tighter prior only

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_w1p0 --epochs 400 --samples-per-epoch 4096 --batch 128 --base-width-multiplier 1.0
```

### 2) Sharper coverage only

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_cov4 --epochs 400 --samples-per-epoch 4096 --batch 128 --coverage-sharpness 4.0
```

### 2b) Fallback sharper coverage

If `v9fix_cov4` shows instability (loss oscillation, NaN/Inf, unstable coverage), run:

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_cov3 --epochs 400 --samples-per-epoch 4096 --batch 128 --coverage-sharpness 3.0
```

### 3) Combined interval squeeze

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_w1p0_cov4 --epochs 400 --samples-per-epoch 4096 --batch 128 --base-width-multiplier 1.0 --coverage-sharpness 4.0
```

Fallback if unstable:

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_w1p0_cov3 --epochs 400 --samples-per-epoch 4096 --batch 128 --base-width-multiplier 1.0 --coverage-sharpness 3.0
```

## SWA vs best-checkpoint

Use the best config from runs 0-3.

```bash
# SWA disabled (pure best-checkpoint path)
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_best_only --epochs 400 --samples-per-epoch 4096 --batch 128 --swa false --base-width-multiplier 1.0 --coverage-sharpness 4.0

# SWA training enabled but force best checkpoint at final export
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_swa_train_best_export --epochs 400 --samples-per-epoch 4096 --batch 128 --swa true --final-weights best --base-width-multiplier 1.0 --coverage-sharpness 4.0
```

## Identity floor and trunk ablations

```bash
# Identity floor to 0.0
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_idfloor0 --epochs 400 --samples-per-epoch 4096 --batch 128 --base-width-multiplier 1.0 --coverage-sharpness 4.0 --identity-dropout-floor 0.0

# Accuracy trunk to 256
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_trunk256 --epochs 400 --samples-per-epoch 4096 --batch 128 --base-width-multiplier 1.0 --coverage-sharpness 4.0 --accuracy-trunk-units 256
```

## MB/MP emphasis

```bash
# Increase MB/MP caption weighting by 40%
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_mbmp14 --epochs 400 --samples-per-epoch 4096 --batch 128 --base-width-multiplier 1.0 --coverage-sharpness 4.0 --mbmp-loss-boost 1.4
```

## Quick smoke command before long runs

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts --trial-id v9fix_smoke --epochs 1 --maxRows 1024 --samples-per-epoch 1024 --batch 64 --swa false
```

## Automated orchestration (Effect-TS)

Run the full plan end-to-end with log watching and automatic fallback scheduling:

```bash
npx tsx scripts/runV9SubcaptionAblation.ts --epochs 400 --samples-per-epoch 4096 --batch 128 --poll-seconds 60
```

If a control run is already in progress/completed and you want to continue with the remaining plan:

```bash
npx tsx scripts/runV9SubcaptionAblation.ts --skip-control --epochs 400 --samples-per-epoch 4096 --batch 128 --poll-seconds 60
```

Enable built-in OpenCode analysis after each run:

```bash
npx tsx scripts/runV9SubcaptionAblation.ts --opencode-analyze --opencode-prompt-file prompts/v9-ablation-analysis.md
```

Fast wiring check (single tiny run):

```bash
npx tsx scripts/runV9SubcaptionAblation.ts --skip-control --limit-runs 1 --epochs 1 --samples-per-epoch 128 --batch 32 --maxRows 512 --poll-seconds 10
```

Date-forward validation wiring check:

```bash
npx tsx scripts/runV9SubcaptionAblation.ts --skip-control --limit-runs 1 --epochs 1 --samples-per-epoch 128 --batch 32 --maxRows 512 --val-mode date-forward --poll-seconds 10
```

Division ablation commands:

```bash
# Shared model with division-aware features/baselines
npx tsx scripts/runV9SubcaptionAblation.ts --prefix v9fix_shared_datefwd --val-mode date-forward --division-filter all --epochs 400 --samples-per-epoch 4096 --batch 128

# World Class only
npx tsx scripts/runV9SubcaptionAblation.ts --prefix v9fix_world_datefwd --val-mode date-forward --division-filter "World Class" --epochs 400 --samples-per-epoch 4096 --batch 128

# Open Class only
npx tsx scripts/runV9SubcaptionAblation.ts --prefix v9fix_open_datefwd --val-mode date-forward --division-filter "Open Class" --epochs 400 --samples-per-epoch 4096 --batch 128
```

Advanced mode: custom shell command with tokens `{run_id}`, `{log}`, `{summary}`, `{session_dir}`:

```bash
npx tsx scripts/runV9SubcaptionAblation.ts --opencode-cmd "opencode run --file {log} \"Analyze run {run_id}\""
```

## Monitoring guardrails

- `cov4` instability signs:
  - `loss = NaN` or `loss = Infinity`
  - `mon_cov` swings >0.15 over short windows with no `delta_mae_pts` gain
  - train loss oscillates while `mon_score` degrades for 10+ epochs
- If unstable, back off to `coverage-sharpness 3.0` (`v9fix_cov3` / `v9fix_w1p0_cov3`).
- `trunk256` overfit signs:
  - train loss keeps improving while validation `delta_mae_pts`/`mon_score` flatten or worsen earlier than baseline.
