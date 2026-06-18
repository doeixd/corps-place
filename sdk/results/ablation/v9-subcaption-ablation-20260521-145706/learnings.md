# V9 Subcaption Ablation Learnings

Session: results\ablation\v9-subcaption-ablation-20260521-145706
Started: 2026-05-21T18:57:06.226Z

## v9fix_shared_datefwd_ctrl (interval-control)

- Run completed successfully.
- Last epoch observed: 211.
- Last val snapshot: delta_mae_pts=0.3931, coverage=0.945, mon_score=3.9886.
- Test: delta=0.3252, coverage=0.974, width=1.8991.

## v9fix_shared_datefwd_w1p0 (interval-w1p0)

- Run completed successfully.
- Last epoch observed: 220.
- Last val snapshot: delta_mae_pts=0.3784, coverage=0.958, mon_score=3.8511.
- Test: delta=0.3019, coverage=0.988, width=1.8923.

## v9fix_shared_datefwd_cov4 (interval-cov4)

- Run completed successfully.
- Last epoch observed: 214.
- Last val snapshot: delta_mae_pts=0.3964, coverage=0.943, mon_score=4.0320.
- Test: delta=0.3016, coverage=0.976, width=1.8651.

## v9fix_shared_datefwd_w1p0_cov4 (interval-w1p0-cov4)

- Run completed successfully.
- Last epoch observed: 213.
- Last val snapshot: delta_mae_pts=0.3926, coverage=0.934, mon_score=3.9950.
- Test: delta=0.3002, coverage=0.976, width=1.8973.

## Interval selection

- Selected best interval config from v9fix_shared_datefwd_w1p0_cov4.
- Carry-forward args: --base-width-multiplier 1.0 --coverage-sharpness 4.0.

## v9fix_shared_datefwd_best_only (swa-vs-best)

- Run completed successfully.
- Test: delta=0.2964, coverage=0.981, width=1.8930.

## v9fix_shared_datefwd_swa_train_best_export (swa-vs-best)

- Run completed successfully.
- Test: delta=0.3247, coverage=0.988, width=1.9571.

## v9fix_shared_datefwd_idfloor0 (identity-floor)

- Run completed successfully.
- Test: delta=0.2869, coverage=0.959, width=1.7288.

## v9fix_shared_datefwd_trunk256 (accuracy-trunk)

- Run completed successfully.
- Test: delta=0.2969, coverage=0.983, width=1.9002.

## v9fix_shared_datefwd_mbmp14 (mbmp-emphasis)

- Run completed successfully.
- Test: delta=0.3110, coverage=0.950, width=1.7143.

## Final ranking

- 1. v9fix_shared_datefwd_idfloor0 | score=0.4654 | delta=0.2869 cov=0.959 width=1.7288
- 2. v9fix_shared_datefwd_mbmp14 | score=0.4760 | delta=0.3110 cov=0.950 width=1.7143
- 3. v9fix_shared_datefwd_w1p0_cov4 | score=0.5042 | delta=0.3002 cov=0.976 width=1.8973
- 4. v9fix_shared_datefwd_cov4 | score=0.5056 | delta=0.3016 cov=0.976 width=1.8651
- 5. v9fix_shared_datefwd_best_only | score=0.5079 | delta=0.2964 cov=0.981 width=1.8930
