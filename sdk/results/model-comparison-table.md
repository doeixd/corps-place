# Model Comparison - V5

## Overall Performance

| Model | MAE | RMSE | QL | p10 cov | p50 cov | p90 cov | Width | R² |
|-------|-----|------|----|---------|---------|---------| ------|----|
| Baseline Zero | 0.6181 | 1.7843 | 0.3091 | 78.9% | 78.9% | 78.9% | 0.000 | -0.000 |
| Baseline Last | 0.7453 | 2.4979 | 0.3726 | 80.9% | 80.9% | 80.9% | 0.000 | -0.960 |
| Baseline EMA | 0.6425 | 1.8924 | 0.3213 | 21.1% | 83.6% | 87.2% | 0.921 | -0.125 |
| Baseline Linear | 1.0128 | 3.1921 | 0.5064 | 14.5% | 80.2% | 83.5% | 1.000 | -2.201 |
| LSTM V5 Fixed | 0.4194 | 1.4926 | 0.2097 | 5.9% | 46.7% | 95.3% | 1.292 | 0.300 |
| XGBoost Quantile V5 | 0.4749 | 1.5513 | 0.2374 | N/A | N/A | N/A | N/A | N/A |
| LightGBM Quantile V5 | 0.4703 | 1.5555 | 0.2352 | N/A | N/A | N/A | N/A | N/A |
| Ridge Per Caption V5 | 0.6575 | 1.7728 | 0.3288 | N/A | N/A | N/A | N/A | N/A |

## Total Residual Performance

| Model | MAE | RMSE | QL | p10 cov | p50 cov | p90 cov | Width | R² |
|-------|-----|------|----|---------|---------|---------| ------|----|
| Baseline Zero | 4.8151 | 8.5339 | 2.4076 | 43.0% | 43.0% | 43.0% | 0.000 | -0.000 |
| Baseline Last | 5.7859 | 11.9724 | 2.8929 | 49.4% | 49.4% | 49.4% | 0.000 | -0.968 |
| Baseline EMA | 5.0003 | 9.0215 | 2.5001 | 26.6% | 57.8% | 77.3% | 7.369 | -0.118 |
| Baseline Linear | 7.8957 | 15.2897 | 3.9479 | 27.1% | 47.9% | 69.6% | 8.000 | -2.210 |
| LSTM V5 Fixed | 3.1498 | 7.1070 | 1.5749 | 5.3% | 43.1% | 90.0% | 10.334 | 0.306 |
| XGBoost Quantile V5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| LightGBM Quantile V5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Ridge Per Caption V5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

## Ranking Metrics

| Model | Rank MAE | Spearman | Top3 | Top5 | Finals | Pairwise |
|-------|----------|----------|------|------|--------|----------|
| Baseline Zero | 3.172 | 0.269 | 62.6% | 79.5% | 71.5% | 54.5% |
| Baseline Last | 2.762 | 0.324 | 65.6% | 81.0% | 75.7% | 61.0% |
| Baseline EMA | 2.819 | 0.321 | 66.7% | 80.2% | 73.6% | 61.2% |
| Baseline Linear | 3.044 | 0.247 | 60.7% | 77.9% | 75.7% | 56.8% |
| LSTM V5 Fixed | 2.102 | 0.601 | 77.0% | 86.2% | 77.8% | 72.3% |
| XGBoost Quantile V5 | N/A | N/A | N/A | N/A | N/A | N/A |
| LightGBM Quantile V5 | N/A | N/A | N/A | N/A | N/A | N/A |
| Ridge Per Caption V5 | N/A | N/A | N/A | N/A | N/A | N/A |

## Per-Caption Performance (MAE)

| Model | GE1 | GE2 | VP | VA | CG | MB | MA | MP |
|-------| -----| -----| -----| -----| -----| -----| -----| ----- |
| Baseline Zero | 1.9647 | 0.0000 | 1.5221 | 0.0000 | 0.0000 | 1.4581 | 0.0000 | 0.0000 |
| Baseline Last | 2.3973 | 0.0000 | 1.7973 | 0.0000 | 0.0000 | 1.7674 | 0.0000 | 0.0000 |
| Baseline EMA | 2.0493 | 0.0000 | 1.5290 | 0.0000 | 0.0000 | 1.5621 | 0.0000 | 0.0000 |
| Baseline Linear | 3.2594 | 0.0000 | 2.4411 | 0.0000 | 0.0000 | 2.4023 | 0.0000 | 0.0000 |
| LSTM V5 Fixed | 1.3062 | 0.0005 | 1.0475 | 0.0006 | 0.0004 | 0.9989 | 0.0002 | 0.0009 |
| XGBoost Quantile V5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| LightGBM Quantile V5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Ridge Per Caption V5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

## Significance vs Baselines (Abs Error)

| Model | Baseline | Mean Δ | p-value | 95% CI | n |
|-------|----------|--------|---------|--------|---|
| XGBoost Quantile V5 | Baseline EMA | -0.1245 | 0.0000 | [-0.1785, -0.0731] | 6792 |
| LightGBM Quantile V5 | Baseline EMA | -0.1290 | 0.0000 | [-0.1831, -0.0701] | 6792 |
| Ridge Per Caption V5 | Baseline EMA | 0.0582 | 0.0250 | [0.0087, 0.1059] | 6792 |
