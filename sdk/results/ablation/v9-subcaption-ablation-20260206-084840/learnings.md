# V9 Subcaption Ablation Learnings

Session: results\ablation\v9-subcaption-ablation-20260206-084840
Started: 2026-02-06T13:48:40.594Z

## v9fix_w1p0 (interval-w1p0)

- Run completed successfully.
- Last epoch observed: 376.
- Last val snapshot: delta_mae_pts=0.4379, coverage=0.963, mon_score=4.9016.
- Test: delta=0.3363, coverage=0.991, width=3.2237.

## v9fix_w1p0 opencode

- OpenCode analysis recorded in results\ablation\v9-subcaption-ablation-20260206-084840\opencode-notes.md.

## v9fix_cov4 (interval-cov4)

- Run completed successfully.
- Last epoch observed: 377.
- Last val snapshot: delta_mae_pts=0.4372, coverage=0.979, mon_score=5.3818.
- Test: delta=0.3177, coverage=1.000, width=4.1688.

## v9fix_cov4 opencode

- OpenCode analysis recorded in results\ablation\v9-subcaption-ablation-20260206-084840\opencode-notes.md.

## v9fix_w1p0_cov4 (interval-w1p0-cov4)

- Run completed successfully.
- Last epoch observed: 399.
- Last val snapshot: delta_mae_pts=0.4423, coverage=0.965, mon_score=4.9403.
- Test: delta=0.3605, coverage=0.991, width=3.2728.

## v9fix_w1p0_cov4 opencode

- OpenCode analysis recorded in results\ablation\v9-subcaption-ablation-20260206-084840\opencode-notes.md.

## Interval selection

- Selected best interval config from v9fix_w1p0.
- Carry-forward args: --base-width-multiplier 1.0.

## v9fix_best_only (swa-vs-best)

- Run completed successfully.
- Last epoch observed: 399.
- Last val snapshot: delta_mae_pts=0.4309, coverage=0.969, mon_score=4.8192.
- Test: delta=0.3231, coverage=1.000, width=3.2189.

## v9fix_best_only opencode

- OpenCode analysis recorded in results\ablation\v9-subcaption-ablation-20260206-084840\opencode-notes.md.

## v9fix_swa_train_best_export (swa-vs-best)

- Run completed successfully.
- Last epoch observed: 399.
- Last val snapshot: delta_mae_pts=0.4502, coverage=0.970, mon_score=5.0157.
- Test: delta=0.3463, coverage=0.969, width=3.2414.

## v9fix_swa_train_best_export opencode

- OpenCode analysis recorded in results\ablation\v9-subcaption-ablation-20260206-084840\opencode-notes.md.
