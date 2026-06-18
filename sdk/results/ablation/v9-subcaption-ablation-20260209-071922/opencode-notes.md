## v9fix_w1p0

```text
- Stability
  - Run completed but effectively failed to train (halted after Epoch 0).
  - No NaN/Inf observed, but training duration (30s) is insufficient for convergence.

- Metric trend
  - No trend established (single epoch).
  - Validation MAE (1.87) improves on mean baseline (2.55), but `mon_score` (7.52) is poor due to coverage penalties.

- Calibration
  - Critical under-coverage: 17.2% test coverage (vs likely 68% target).
  - Intervals are extremely narrow (avg width 0.91) with high floor saturation (56%).

- MB/MP
  - MB shows specific collapse: 4% coverage and 0.44 width (lowest of all captions).
  - Large gap between Music/Visual captions and General Effect (GE coverage ~25%).

- Next action
  - Discard this configuration; investigate why training stopped immediately and increase width initialization priors.

[stderr]
[0m

> build · gemini-3-pro-preview
[0m
```
