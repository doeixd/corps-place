# V9.5 early-2026 out-of-time comparison

Generated: 2026-07-16T14:46:51.531Z

Frozen cohort: 153 rows / 25 shows, 2026-06-27T00:00:00.000Z through 2026-07-14T00:00:00.000Z

Cohort identity SHA-256: `76f068d17180be594608d1fffabe778f35c3cc8119ed4422c1600c0c6c41dd1e`

All models are evaluated identity-agnostically: corps, judge, and show residual paths are disabled because current 2026 integer maps are not semantically compatible with final2's frozen maps.

| Model | Recap MAE | Δ final2 | Total MAE | Δ final2 | Raw coverage | Cal coverage |
|---|---:|---:|---:|---:|---:|---:|
| final2 | 0.4930 | +0.0000 | 1.5141 | +0.0000 | 0.9183 | 0.7492 |
| seed42 | 0.4692 | -0.0238 | 1.4378 | -0.0763 | 0.9608 | 0.8472 |
| seed43 | 0.5034 | +0.0104 | 1.8061 | +0.2920 | 0.9412 | 0.7990 |
| scale_lr550 | 0.4588 | -0.0341 | 1.4974 | -0.0167 | 0.9641 | 0.8644 |
| scale_lr750_e43 | 0.4572 | -0.0358 | 1.4788 | -0.0353 | 0.9714 | 0.8611 |

| Model | Zero-history total | Sparse total | Short total | Established total* |
|---|---:|---:|---:|---:|
| final2 | 2.1738 | 1.3827 | 0.9112 | 0.9736 |
| seed42 | 2.0954 | 1.1273 | 0.9336 | 0.7792 |
| seed43 | 2.3447 | 1.5439 | 1.4498 | 0.8349 |
| scale_lr550 | 2.1159 | 1.2120 | 0.9834 | 1.1761 |
| scale_lr750_e43 | 1.9724 | 1.3594 | 1.0629 | 0.8662 |

*Established history contains only seven rows and is descriptive.

These results are an out-of-time generalization comparison, not a checkpoint selector. The cohort has now been inspected and is development validation; later 2026 shows must provide the next untouched test.
