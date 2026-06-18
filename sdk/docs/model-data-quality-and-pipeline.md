# DCI Model Data Pipeline and Quality Notes

Updated: 2026-05-21

This note documents how the current model data is produced, what was learned while auditing it, which anomalies matter for model training, and what cleaning rules are now enforced.

## Executive Summary

The active model path is the V9 subcaption fixed model. It trains from `ml_sequence_rows_v9_subcaption` in `sdk/dci-relational.db`, not directly from raw API or website data.

The raw relational database still contains many known anomalies: zero scores, performers showcase entries, non-corps divisions, partial captions, placeholder judges, and some rank inconsistencies. The ML sequence builder now filters or corrects the model-facing cases that matter most.

After cleanup, the rebuilt ML table has:

```text
ml_sequence_rows_v9_subcaption: 7,321 rows
bad target captions: 0
bad judge vectors: 0
bad target totals: 0
bad sequence dimensions: 0
bad static dimensions: 0
missing corps map entries: 0
missing show map entries: 0
missing provenance rows: 0
unknown judge Elo IDs: 0
invalid judge Elo divisions: 0
reference curve rank inversions: 0
reference curve progress inversions: 0
```

## Main Files

- `sdk/dci-relational.db`: active relational database and cache-backed source for model prep.
- `sdk/dci-relational.old.db`: backup of the previous relational DB.
- `sdk/dci-scores.db`: older database referenced by historical data-quality notes; not the active model DB.
- `sdk/src/buildMlSequencesV9Subcaption.ts`: primary sequence builder for `ml_sequence_rows_v9_subcaption`.
- `sdk/scripts/buildMlSequencesV9All.ts`: wrapper that runs the V9 subcaption builder.
- `sdk/src/training/trainModelV9Subcaption-fixed.ts`: latest active trainer.
- `sdk/scripts/computeReferenceCurvesV4.ts`: rank/season-progress/caption baseline generator.
- `sdk/scripts/testReferenceCurveViews.ts`: tests cleaned reference-curve SQLite views.
- `sdk/scripts/plotReferenceCurves.py`: generates the HTML reference-curve viewer.
- `sdk/src/training/referenceCurvesV4.json`: generated baseline curves.
- `sdk/scripts/buildCorpsIndexMap.ts`: generates `corpsIndexMap.json`.
- `sdk/scripts/buildJudgeIndexMap.ts`: generates `judgeIndexMap.json`.
- `sdk/scripts/generateShowMap.ts`: generates `showIndexMap.json`.
- `sdk/src/reingestFromCache.ts`: re-parses cached website recaps and ingests them without scraping.
- `sdk/src/websiteRecap.ts`: parses DCI recap HTML.
- `sdk/src/relational.ts`: relational schema and ingest/upsert logic.

## Data Flow

Raw data enters the project through several paths:

1. DCI API ingest fills `competitions`, `corps_scores`, API-derived score data, and `api_responses`.
2. Website recap scraping stores raw recap HTML in `website_recaps`.
3. Website recap reingest parses cached recap HTML and fills `corps_scores`, `category_scores`, `caption_scores`, `judge_assignments`, `judge_scores`, and `subcaption_scores`.
4. Event page scraping and lineup ingestion fill `event_page_scrapes`, `event_lineup_entries`, and `event_participants`.
5. Derived feature scripts build maps, reference curves, show aggregates, historical features, and Elo tables.
6. `buildMlSequencesV9Subcaption.ts` converts relational data into model rows.
7. `trainModelV9Subcaption-fixed.ts` trains from `ml_sequence_rows_v9_subcaption`.

The model does not train from raw website HTML or raw API responses directly. Those are cache and ingest sources.

## Active ML Table Contract

Each row in `ml_sequence_rows_v9_subcaption` represents one corps at one target competition.

Columns used by the latest trainer:

- `season`
- `competition_slug`
- `competition_date`
- `corps_key`
- `corps_id`
- `division_name`
- `x_sequence_json`
- `x_static_json`
- `judge_indices_json`
- `y_residuals_json`
- `y_recap_json`
- `y_total`
- `agnostic_show_id`
- `builder_version`
- `reference_curves_version`
- `map_version`
- `split`

Feature/target shapes:

- `x_sequence_json`: 15 timesteps by 101 features.
- `x_static_json`: 169 static features.
- `judge_indices_json`: 8 judge IDs, one per caption.
- `y_recap_json`: 8 caption scores: `GE1`, `GE2`, `VP`, `VA`, `CG`, `MB`, `MA`, `MP`.
- `y_residuals_json`: target caption score minus division-aware rank baseline.
- `y_total`: official target total.
- `builder_version`, `reference_curves_version`, `map_version`: generated-data provenance for reproducibility.

Captions use this total formula:

```text
total = GE1 + GE2 + (VP + VA + CG) / 2 + (MB + MA + MP) / 2
```

## Model Framing

The current model is not simply predicting total score. It predicts caption deltas against a baseline, then derives recap/category/total outputs.

Important architecture choices:

- Predicts q10/q50/q90 residual deltas per caption.
- Uses `baseline_recap` as an input.
- Derives recap output from `delta_q50 + baseline`.
- Derives category and total heads from recap through custom deterministic layers.
- Uses judge embeddings, corps embeddings, and show embeddings.
- Uses a split accuracy trunk for q50 and separate width heads for uncertainty.

This architecture is domain-appropriate because DCI scoring is structured by captions and categories. It also means leakage and baseline construction are high-risk areas.

## Prediction Modes and Feature Availability

Production predictions must declare a feature-availability mode. The canonical mode contract lives in `src/training/v9FeatureModes.ts`; production feature assembly lives in `src/training/v9PredictionFeatures.ts`; caption baselines live in `src/training/v9Baselines.ts`.

| Mode                 | Intended Use                                                    | Allowed Inputs                                                                                 | Masked or Estimated Inputs                                                                                                             |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `as_of_show_date`    | In-season prediction using results known before the target show | prior same-season sequence, current rank as of the prediction date, known lineup, known judges | future shows and target-show results                                                                                                   |
| `preseason_forecast` | Predicting a future show before the season starts               | previous-season/historical rank, optional seed rank, target date/progress, division            | same-season sequence, current rank, rank EMA, residual trends, opponent current form, performance order, judge IDs/Elo, show embedding |
| `panel_unknown`      | Show context is known but judge panel is not                    | same-season history, lineup/opponent context, baseline rank                                    | judge IDs and judge Elo                                                                                                                |
| `lineup_unknown`     | Corps/show target is known but full lineup/order is not         | same-season history and known judges if available                                              | performance order, opponent current form, field-strength context                                                                       |

This distinction matters because historical replay rows contain fields like current overall rank entering the target show. Those fields are legitimate for `as_of_show_date` prediction but unavailable for a May prediction of a mid-season July regional. Preseason forecasts should use seed/prior-season/historical rank baselines, not current-season rank.

Mode-aware baseline provenance is explicit:

```ts
{
  captions: { GE1, GE2, VP, VA, CG, MB, MA, MP },
  rankSource: "current_rank" | "seed_rank" | "prior_season_rank" | "historical_mean_rank",
  confidence: "actual" | "estimated"
}
```

Use `scripts/auditV9PredictionModes.ts` to verify that these mode masks and baseline provenance stay intact.

### Caption Fingerprints and Preseason Training

The V9 subcaption row builder now adds a caption-fingerprint block to `x_static_json` after the original 179 static features. The current static dimension is 212.

For each corps/division/target season, the fingerprint block uses only prior seasons and encodes, per caption:

- prior-season residual versus the division/rank/progress caption curve
- weighted multi-year residual
- early-to-late season residual growth
- residual volatility

The block also includes one confidence value based on historical sample count. These features are meant to expose persistent corps/caption identity, such as a corps tending to overperform its rank baseline in brass, guard, percussion, or GE.

The trainer also has a true preseason-style masking path. When `forecast_context_hide_rate` triggers, samples hide same-season sequence/history, current-rank form, lineup/opponent context, judges, and show embedding. The residual baseline for those samples is now the same kind of caption-aware rank/progress curve used by production preseason inference, not a global caption mean.

For preseason point estimates, caption fingerprints are centered and capped before being applied to the baseline. This lets fingerprints reshape the recap by caption without simply adding a large corps-wide historical residual to the total score.

Relevant checks:

- `scripts/auditV9SubcaptionData.ts` verifies static dimensions and fingerprint bounds/population.
- `scripts/auditV9PredictionModes.ts` verifies preseason/panel/lineup masking.
- Production feature assembly recomputes the fingerprint block from historical ML rows so future-event predictions do not depend on stale template-row fingerprints.

## Data Anomalies Found

The raw database still contains anomalies:

- Zero `corps_scores.total_score` rows.
- Performers showcase entries mixed into raw corps-like tables.
- Non-corps divisions such as Individual, All Age, SoundSport, Exhibition.
- Caption scores greater than normal corps-caption scale from individual showcase events.
- Zero judge scores.
- Placeholder or unknown judge IDs.
- Partial caption panels where a valid total exists but one or more of the 8 model captions are missing.
- Same-division rank inversions in some source rows.
- Some caption-derived totals disagreeing with official totals.
- Some slug-only corps keys missing from the old corps map.
- Some show slugs missing from the old show map.
- The old baseline curves were World Class only and sparse in some caption cells.

The most dangerous training issue was partial caption data being converted into zero target captions. That makes the model learn impossible `0` scores for otherwise valid corps performances. This is now fixed in the builder.

## Cleaning Now Enforced for V9 Subcaption Data

`buildMlSequencesV9Subcaption.ts` now enforces model-facing cleanliness:

- Target rows require all 8 caption scores.
- Caption scores must be finite, positive, and no more than 20.
- Target official total must be finite, positive, and no more than 100.
- Caption-derived total must match official total within `0.05`.
- Prior shows used in `x_sequence_json` must pass the same caption/total consistency checks.
- Rows with missing/zero judge indices are skipped.
- Same-show rank features are recomputed from `total_score` before feature generation.
- Sequence and static feature dimensions are checked.
- `agnostic_show_id` is selected by the trainer and no longer silently defaults to zero.
- Generated rows include builder, reference-curve, and map provenance metadata.

The sequence builder filters out model-facing showcase/non-corps contamination by only processing `World Class` and `Open Class`.

## Baselines and Reference Curves

Reference curves live at `sdk/src/training/referenceCurvesV4.json` and are generated by `sdk/scripts/computeReferenceCurvesV4.ts`.

The cleaned source rows now live in SQLite views created by `ensureRelationalSchema`:

- `clean_reference_curve_entries`: one cleaned corps/show row with 8 pivoted captions, official total, caption-derived total, percent bucket, and recomputed division rank.
- `clean_reference_curve_metric_scores`: long-form rows for `GE1`, `GE2`, `VP`, `VA`, `CG`, `MB`, `MA`, `MP`, and `TOTAL`.
- `reference_curve_metric_stats`: observed `avg_score`, `min_score`, `max_score`, and `sample_count` by `division_name`, `rank_bucket`, `percent_bucket`, and `metric_name`.

These views are the shared source for the reference curve generator and the HTML viewer's min/max bands.

The database also contains small domain tables so rules are inspectable in SQL:

- `domain_divisions`: model-eligible divisions and score-system notes.
- `domain_captions`: canonical captions, category, total weight, score range, and display order.
- `domain_caption_aliases`: raw API/website caption names mapped to canonical caption keys.
- `domain_event_exclusion_patterns`: event slug patterns excluded from model data, with reasons.

Data-quality views expose raw anomalies without changing raw tables:

- `dq_zero_scores`
- `dq_invalid_caption_scores`
- `dq_missing_caption_panels`
- `dq_caption_total_mismatches`
- `dq_unknown_judges`
- `dq_showcase_rows`
- `dq_rank_inversions`
- `dq_duplicate_score_entries`

These are intentionally diagnostic. Some can contain rows in the raw database; clean/model views should not overlap critical DQ views.

They are now division-aware:

```text
World Class|rank-percent_bucket
Open Class|rank-percent_bucket
```

Example key:

```text
World Class|12-80
Open Class|5-60
```

The generated curve file includes:

- `version`
- `dimensions`
- `divisions`
- `captions`
- `curves`

The builder calls:

```ts
getBaseline(rankEntering, percentThrough, caption, division);
```

This matters because Open Class scores are materially lower than World Class scores at similar ranks and season progress. Using World Class curves for Open Class rows produced biased residuals.

The generator now:

- Includes World Class and Open Class rows.
- Filters invalid totals and invalid caption scores.
- Excludes performers showcase rows.
- Requires all 8 captions and a caption-derived total within `0.05` of the official total.
- Recomputes rank within each competition/division from official `total_score`.
- Clamps generated baseline ranks to 1-25; ranks beyond 25 contribute to rank 25.
- Uses round-to-nearest-5 percent buckets, matching the V9 builder consumer.
- Handles caption-name aliases such as `Visual - Analysis`, `Visual - Proficiency`, `Music Brass`, `Brass`, and `Percussion`.
- Produces dense cells for all divisions, ranks 1-25, buckets 0-100, and all 8 captions.
- Enforces monotonicity so expected captions do not increase as rank worsens and do not decrease as season progress advances.
- Preserves legacy World Class keys for older consumers.

The V9 builder clamps baseline lookup ranks to 1-25 and percent buckets to 0-100 before reading `referenceCurvesV4.json`, so missing high-rank lookups no longer fall back to a flat `15.0`.

## Maps

### Corps Map

`corpsIndexMap.json` is generated by `buildCorpsIndexMap.ts`.

It now includes keys from both:

- `corps`
- `corps_scores`

This fixed missing slug-only corps keys used in score rows but absent from the canonical corps table.

### Judge Map

`judgeIndexMap.json` is generated by `buildJudgeIndexMap.ts`.

The V9 builder also extends this map if it sees new judge IDs for included seasons. Current rebuilt ML rows have no missing/zero judge indices.

### Show Map

`showIndexMap.json` is generated by `generateShowMap.ts`.

It maps yearless slugs to stable IDs, for example:

```text
2024-dci-world-championship-finals -> dci-world-championship-finals
```

After regeneration, all current ML rows have nonzero `agnostic_show_id`.

## Division Handling

Division matters in several places:

- Source rows are processed as `World Class` and `Open Class`.
- Canonical division is chosen per corps/season based on most common division to avoid mixed division contamination.
- Baselines are division-aware.
- Caption range features are division-specific.
- Show aggregate fallback features are computed division-locally inside the V9 builder.
- Judge and corps Elo generation for the V9 rebuild path is division-aware.

This prevents World Class and Open Class from sharing score distributions in baseline residuals and relative-score features.

## Elo Tables

`judge_elo_ratings`, `judge_elo_history`, `corps_elo_ratings`, and `corps_elo_history` now include `division_name` when rebuilt through:

```bash
npx tsx scripts/buildMlSequencesV9All.ts --rebuild
```

The V9 Elo rebuild filters:

- only `World Class` and `Open Class`
- `judge_scores.score > 0`
- `judge_scores.score <= 20`
- judge IDs not matching `%unknown%`

The V9 builder uses the history tables for model features, not the season-final rating tables:

- judge Elo: `judge_id + season + division_name + competition_slug + caption_name -> elo_before`
- corps Elo: `corps_key + season + division_name + competition_slug + caption_name -> elo_before`

That timing matters. Season-final Elo is still useful for reporting, but it is not a valid pre-show model feature because it includes future shows.

For rolling in-season rebuilds, use the V9 builder cutoff:

```bash
npx tsx scripts/buildMlSequencesV9All.ts --as-of-date 2026-07-05 --rebuild
```

`--as-of-date` excludes target rows after the cutoff and rebuilds show aggregate/Elo cache tables only through that date. This is required when the local DB may already contain later 2026 results.

## Current Split Logic

The V9 subcaption builder currently uses:

```text
2024 world/open championship finals -> test
2023 -> val
everything else -> train
```

The latest trainer can create validation sets two ways, always grouped by `showKey` so the same competition cannot appear in both train and validation:

- `--val-mode show-random` keeps the existing grouped random validation behavior.
- `--val-mode date-forward` validates on the latest grouped shows, or on shows at/after `--val-date-cutoff YYYY-MM-DD`.

There are still two validation concepts:

- Builder-level `split = val` for 2023.
- Trainer-level show-grouped validation split from all non-test rows.

Date-forward validation is now the stricter mode to use for future-prediction claims.

## Remaining Caveats

These are not currently blocking, but they matter:

- Raw tables are still not globally clean. The ML builder filters relevant cases, but raw analytical queries still need filters.
- Older sequence builders and standalone Elo scripts may still expect the previous broad Elo table shape. The active V9 rebuild path and schema are now division-aware.
- `show_aggregates_v7` is still competition-level in the database, but V9 now computes local division-specific show aggregates during sequence generation.
- `judge_elo_ratings` and `corps_elo_ratings` are season-final reporting tables. Model features should continue to use `*_elo_history.elo_before`.
- Full project `tsc --noEmit` is blocked by an unrelated syntax error in `src/training/trainModelV9-improved.ts`; targeted checks for touched files pass.
- 2020 and 2021 are sparse/atypical COVID seasons and are not included in the V9 season list.
- 2025 has changed tour and championship structure, so cross-year comparisons need caution.
- Score granularity is coarser than decimal precision implies. Quarter-point and clean-number clustering are real domain features.

## Useful Commands

Run from `sdk/`.

Regenerate reference curves:

```bash
npx tsx scripts/recreateViews.ts
npx tsx scripts/computeReferenceCurvesV4.ts
```

Test reference curve views:

```bash
npx tsx scripts/testDomainSemanticLayer.ts
npx tsx scripts/testReferenceCurveViews.ts
```

Generate the HTML reference curve viewer:

```bash
python scripts/plotReferenceCurves.py
```

Regenerate maps:

```bash
npx tsx scripts/buildCorpsIndexMap.ts
npx tsx scripts/buildJudgeIndexMap.ts
npx tsx scripts/generateShowMap.ts
```

Rebuild V9 subcaption ML rows:

```bash
npx tsx scripts/buildMlSequencesV9All.ts --rebuild
```

Audit V9 subcaption ML rows:

```bash
npx tsx scripts/auditV9SubcaptionData.ts
```

The audit also checks reference-curve density and monotonicity.

Train latest fixed model:

```bash
npx tsx src/training/trainModelV9Subcaption-fixed.ts
```

Targeted type check:

```bash
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck scripts/computeReferenceCurvesV4.ts scripts/buildCorpsIndexMap.ts scripts/buildMlSequencesV9All.ts scripts/auditV9SubcaptionData.ts src/buildMlSequencesV9Subcaption.ts src/training/trainModelV9Subcaption-fixed.ts
```

## Recommended Next Work

1. Run the date-forward division ablation: shared, World-only, and Open-only.
2. Compare calibration slices from `model-card.json`, especially by division, caption, season phase, panel-known/panel-unknown, and sparse-history rows.
3. Build the second-stage V9 breakdown layer described in `docs/v9-breakdown-model-plan.md`: keep V9 as the caption/total predictor, then predict Content/Achievement allocation from V9 anchors plus the same context features.
4. Update older V7/V9 builders or standalone Elo tooling if they need to consume the new division-aware Elo schema.
5. Decide whether Open Class should train in the same model or a separate model based on date-forward per-division MAE and calibration.
6. Add richer generated-data provenance, such as exact map file hashes and builder option JSON.
