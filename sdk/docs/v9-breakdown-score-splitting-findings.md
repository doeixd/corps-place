# V9 Breakdown Score-Splitting Findings

Updated: 2026-06-05

This note captures what we learned from the V9 breakdown work: how DCI caption scores split into Content/Repertoire and Achievement/Performance, how much better a learned splitter can be than simple ratios, and what the practical ceiling is when the V9 caption total remains fixed.

## Core Framing

The V9 model predicts the eight caption totals:

```text
GE1, GE2, VP, VA, CG, MB, MA, MP
```

The breakdown layer does not improve those caption totals. It only splits each V9 caption prediction:

```text
Content + Achievement = V9 predicted caption total
```

Example:

```text
V9 predicts VP = 17.20
splitter predicts:
  Content     = 8.72
  Achievement = 8.48
```

Because the splitter must preserve the V9 anchor, point MAE is partly controlled by V9 caption-total error. The cleaner splitter metric is:

```text
content_share = Content / (Content + Achievement)
```

## Empirical Ratio

Across normalized recap targets, Content/Repertoire is consistently above Achievement/Performance.

Overall:

```text
avg Content:                    7.5902
avg Achievement:                7.3680
avg Content - Achievement:     +0.2222 points
mean Content share:             0.50815
Content/Achievement ratio:      1.03016
```

So the global split is roughly:

```text
50.8% Content / 49.2% Achievement
```

This confirms the domain intuition: judges tend to put Content/Repertoire a few tenths above Achievement/Performance. It is not exactly 50/50.

## Division Differences

World Class is closer to 50/50 than Open Class.

```text
World Class:
  avg Content - Achievement: +0.2000
  mean Content share:         0.50669
  C/A ratio:                  1.02547
  practical dumb split:       ~50.7 / 49.3

Open Class:
  avg Content - Achievement: +0.2728
  mean Content share:         0.51148
  C/A ratio:                  1.04351
  practical dumb split:       ~51.1 / 48.9
```

Open Class has a stronger Content-over-Achievement bias, likely because lower-achievement performances leave more room for Achievement/Performance to trail repertoire/content.

## Caption Differences

All canonical captions lean Content/Repertoire over Achievement/Performance.

```text
GE1  share 0.50717, gap +0.1926
GE2  share 0.50740, gap +0.2023
VP   share 0.50923, gap +0.2504
VA   share 0.50754, gap +0.2034
CG   share 0.50941, gap +0.2524
MB   share 0.50786, gap +0.2175
MA   share 0.50845, gap +0.2329
MP   share 0.50816, gap +0.2263
```

Highest Content bias:

```text
CG, VP, MA, MP
```

Lowest Content bias:

```text
GE1, GE2, VA
```

Division plus caption has more structure. Examples:

```text
Open Class|CG   share 0.51358, gap +0.3201
Open Class|VP   share 0.51297, gap +0.3054
World Class|GE1 share 0.50571, gap +0.1691
World Class|GE2 share 0.50601, gap +0.1804
```

## Recent Season Pattern

Recent seasons still show Content above Achievement, but 2025 is slightly closer to 50/50.

```text
2023: share 0.50778, gap +0.2224
2024: share 0.50709, gap +0.2035
2025: share 0.50631, gap +0.1843
```

This suggests a static historical ratio is useful, but should not be treated as permanent or universal.

## Baselines

Important split baselines:

```text
50/50:
  Content share = 0.50000

global empirical:
  Content share from train rows, about 0.5084 in the date-forward split

division empirical:
  Content share by division

caption empirical:
  Content share by caption

division+caption empirical:
  Content share by division and caption

blended prior:
  division+caption historical ratio blended with prior row features:
    historical * 0.5 + EMA share * 0.3 + last share * 0.2
  with fallbacks when prior shares are missing

learned model:
  predicts Content share from V9 anchors plus sequence/static/judge/corps/show/prior features
```

The blended prior is a strong simple production fallback. It captures most of the practical value without model-serving complexity.

## Finished Model Result

Full real-anchor run:

```text
trial id: v9_breakdown_real_anchor_datefwd_diag_full
source V9: v9-real-v9_prod_fingerprint_preseason_final2_1779976626982-41dbeb985a04
primary metric: content_share_mae
best epoch: 7
```

Production-like validation, all anchor modes:

```text
model share MAE:          0.00391
model subcaption MAE:     0.6038
blended-prior share MAE:  0.00438
blended-prior point MAE:  0.6057
50/50 share MAE:          0.00701
50/50 point MAE:          0.6106
oracle point MAE:         0.5987
anchor caption MAE:       1.1974
```

Actual `v9_predicted` anchors only, validation:

```text
model share MAE:              0.00391
model point MAE:              0.5535
50/50 share MAE:              0.00701
50/50 point MAE:              0.5579
division+caption share MAE:   0.00509
division+caption point MAE:   0.5557
blended-prior share MAE:      0.00438
blended-prior point MAE:      0.5544
oracle point MAE:             0.5502
```

Actual `v9_predicted` anchors only, test:

```text
model share MAE:              0.00317
model point MAE:              0.4619
50/50 share MAE:              0.00446
50/50 point MAE:              0.4628
division+caption share MAE:   0.00618
division+caption point MAE:   0.4691
blended-prior share MAE:      0.00441
blended-prior point MAE:      0.4644
oracle point MAE:             0.4586
```

The learned model is the best non-oracle splitter in these results. It beats 50/50, static empirical ratios, and blended prior in share MAE. However, the point-value gain is small.

## Ceiling

The theoretical ceiling for a breakdown-only model is the oracle target-share baseline:

```text
oracle Content = V9 caption total * true Content share
oracle Achievement = V9 caption total * (1 - true Content share)
```

This is the best any model can do if it must preserve the V9 caption total. It still cannot fix V9 caption-anchor error.

For actual `v9_predicted` anchors:

```text
Validation:
  50/50 point MAE:  0.5579
  model point MAE:  0.5535
  oracle point MAE: 0.5502

  max possible gain over 50/50: 0.0077 points = 0.077 tenths
  model captured:               0.0044 points = 0.044 tenths
  remaining possible gain:      0.0033 points = 0.033 tenths

Test:
  50/50 point MAE:  0.4628
  model point MAE:  0.4619
  oracle point MAE: 0.4586

  max possible gain over 50/50: 0.0042 points = 0.042 tenths
  model captured:               0.0009 points = 0.009 tenths
  remaining possible gain:      0.0033 points = 0.033 tenths
```

If the ceiling is treated as 100% of possible improvement over 50/50:

```text
Validation captured: ~57%
Test captured:       ~22%
```

The model learns real signal, but the available point-MAE improvement is very small.

## Practical Interpretation

The breakdown split is real but subtle.

Key conclusions:

- 50/50 is already a strong point-value baseline.
- A better static split is roughly 50.8/49.2 overall.
- World Class is about 50.7/49.3.
- Open Class is about 51.1/48.9.
- Caption-specific ratios improve the domain realism but not always the held-out point MAE.
- Blended prior is a strong simple fallback.
- The learned model is best in share-space but only improves displayed subcaption points by hundredths.
- Most displayed point error comes from V9 caption-anchor error, not breakdown allocation.

Recommended production stance:

```text
Default simple path:
  Use deterministic split curves:
    content_share = f(division, caption, percent_through_season)

  The production artifact is:
    results/v9-breakdown-split-curves.json

Optional advanced path:
  Use the learned breakdown model only if serving complexity is acceptable and
  share-realism matters more than point-MAE improvement.

Future corps/show-specific path:
  Blend curve share with prior same-season breakdown shares when available:
    final_share = curve_share * (1 - prior_weight) + prior_share * prior_weight

  Guardrails needed before this should become production behavior:
    - no leakage when evaluating historical rows
    - minimum prior recap count per corps/caption
    - recency weighting
    - fallback to pure curves when same-season recap data is missing or sparse
    - explicit reporting of curve_share, prior_share, and final_share

Do not expect:
  The breakdown model to improve V9 caption/total MAE.
```

## What To Track Later

If this is revisited:

- Track `content_share_mae` as the primary breakdown metric.
- Track `subcaption_mae_pts` only as a display metric.
- Always include `oracle_target_share` to expose the ceiling.
- Always include `anchor_caption_mae_pts` to show upstream V9 error.
- Report `v9_predicted` separately from synthetic/dropout anchor modes.
- Compare against:
  - 50/50
  - global empirical ratio
  - division empirical ratio
  - caption empirical ratio
  - division+caption empirical ratio
  - blended prior
  - oracle target share
