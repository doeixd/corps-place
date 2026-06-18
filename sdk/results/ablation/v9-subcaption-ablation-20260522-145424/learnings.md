# V9 Subcaption Ablation Learnings

Session: results\ablation\v9-subcaption-ablation-20260522-145424
Started: 2026-05-22T18:54:24.552Z

## v9fix_datefwd_calib_auto_ctrl (interval-control)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.872743, val=1.252629.
- Last val snapshot: delta_mae_pts=0.3674, coverage=0.955, mon_score=3.7440.
- Test: delta=0.3110, coverage=0.974, width=1.8977.

## v9fix_datefwd_calib_auto_w1p0 (interval-w1p0)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.872079, val=1.259662.
- Last val snapshot: delta_mae_pts=0.3704, coverage=0.950, mon_score=3.7695.
- Test: delta=0.3370, coverage=0.964, width=1.8641.

## v9fix_datefwd_calib_auto_cov4 (interval-cov4)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.855944, val=1.260836.
- Last val snapshot: delta_mae_pts=0.3699, coverage=0.922, mon_score=3.7638.
- Test: delta=0.3052, coverage=0.981, width=1.8578.

## v9fix_datefwd_calib_auto_w1p0_cov4 (interval-w1p0-cov4)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.834561, val=1.286330.
- Last val snapshot: delta_mae_pts=0.3770, coverage=0.909, mon_score=3.8389.
- Test: delta=0.2932, coverage=0.974, width=1.9377.

## Interval selection

- Selected best interval config from v9fix_datefwd_calib_auto_w1p0_cov4.
- Carry-forward args: --base-width-multiplier 1.0 --coverage-sharpness 4.0.

## v9fix_datefwd_calib_auto_best_only (swa-vs-best)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.874623, val=1.280256.
- Last val snapshot: delta_mae_pts=0.3770, coverage=0.934, mon_score=3.8435.
- Test: delta=0.3090, coverage=0.983, width=1.8956.

## v9fix_datefwd_calib_auto_swa_train_best_export (swa-vs-best)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.890199, val=1.278273.
- Last val snapshot: delta_mae_pts=0.3763, coverage=0.926, mon_score=3.8334.
- Test: delta=0.3189, coverage=0.957, width=1.8985.

## v9fix_datefwd_calib_auto_idfloor0 (identity-floor)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.955851, val=1.215002.
- Last val snapshot: delta_mae_pts=0.3548, coverage=0.934, mon_score=3.6098.
- Test: delta=0.3681, coverage=0.935, width=1.9265.

## v9fix_datefwd_calib_auto_trunk256 (accuracy-trunk)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.957838, val=1.239989.
- Last val snapshot: delta_mae_pts=0.3637, coverage=0.929, mon_score=3.7022.
- Test: delta=0.3242, coverage=0.990, width=1.8882.

## v9fix_datefwd_calib_auto_mbmp14 (mbmp-emphasis)

- Run completed successfully.
- Last epoch observed: 119.
- Last losses: train=0.969590, val=1.215841.
- Last val snapshot: delta_mae_pts=0.3498, coverage=0.945, mon_score=3.5587.
- Test: delta=0.3130, coverage=0.971, width=1.8923.

## Final ranking

- 1. v9fix_datefwd_calib_auto_w1p0_cov4 | score=0.4942 | delta=0.2932 cov=0.974 width=1.9377
- 2. v9fix_datefwd_calib_auto_swa_train_best_export | score=0.4944 | delta=0.3189 cov=0.957 width=1.8985
- 3. v9fix_datefwd_calib_auto_mbmp14 | score=0.5095 | delta=0.3130 cov=0.971 width=1.8923
- 4. v9fix_datefwd_calib_auto_idfloor0 | score=0.5106 | delta=0.3681 cov=0.935 width=1.9265
- 5. v9fix_datefwd_calib_auto_ctrl | score=0.5120 | delta=0.3110 cov=0.974 width=1.8977
