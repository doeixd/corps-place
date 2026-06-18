# V9 Subcaption Ablation Analysis Prompt

You are analyzing one training run from the V9 subcaption ablation pipeline.

Use the attached run log as the source of truth. Focus on:

1. Stability

- Note any NaN/Inf, divergence, oscillation, or suspicious regime shifts.

2. Validation trend

- Track `delta_mae_pts`, `mon_cov`, `mon_score` through phases.
- Call out phase transitions and whether metrics improved or regressed.

3. Interval behavior

- Assess whether coverage is over/under target and whether width is too wide/narrow.
- Comment on likely calibration quality.

4. MB/MP behavior

- If caption stats appear, compare MB/MP against GE/VA and call out gaps.

5. Recommendation

- Give the best next action in one sentence (continue, fallback to cov3, adjust weights, etc.).

Return concise bullets only:

- Stability
- Metric trend
- Calibration
- MB/MP
- Next action
