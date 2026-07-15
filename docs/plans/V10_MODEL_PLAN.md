# V10 prediction model plan

Date: 2026-07-15

Status: active — Milestone 0 complete; Milestone 1 next

Implementation progress:

- 2026-07-15: Milestone 0 complete. The artifact validator passes 102 checks and
  the independent prediction replay passes 167 data, split, normalization,
  aggregate-metric, history-slice, and forecast-mode checks.
- 2026-07-15: Added the Milestone 1 trainer reconstruction checklist with exact
  patch chains and static, behavioral, and full-reproduction gates.
- 2026-07-15: Milestone 1 scaffold started from the exact anchor. The 212 raw +
  8 trend = 220 static wiring is ported into the versioned `trainModelV95.ts`,
  which passes its focused TypeScript check and uses isolated output paths.

Related:

- `docs/MODEL_IMPROVEMENT_NOTES.md`
- `docs/DATA_QUALITY_NOTES.md`
- `docs/PREDICTION_FEATURE_CODE_REVIEW.md`
- `docs/plans/V10_TRAINER_RECONSTRUCTION_CHECKLIST.md`
- `doeixd/recovered-ml-212` (private GitHub recovery repository)
- `sdk/models/v9_subcaption_fixed/v9_prod_fingerprint_preseason_final2_1779976626982/model-card.json`

## Goal

Build a production-worthy V10 model as a direct descendant of the deployed V9
`final2` pipeline. V10 should preserve `final2`'s established-history accuracy
while materially improving season-debut and thin-history predictions, adapting
to the pace of the current field, and reporting uncertainty honestly.

The first milestone is deliberately not a new model. It is a reproducible,
auditable `final2`-compatible training pipeline (informally, “V9.5”). This
separates trainer-reconstruction errors from actual V10 improvements.

## Non-goals and invariants

- Do not use `sdk/src/training/trainModelV10.ts` as the starting point. Despite
  its filename, it is an older pre-V9 experiment: its header calls it V8, it
  reads `ml_sequence_rows_v10`, and it expects 136 raw / 144 total static
  features. It is not in the `final2` lineage.
- Do not overwrite the V9 training table, V9 feature constants, frozen V9 index
  maps, or the deployed `final2` artifact. V10 receives new versioned names.
- Do not judge a change only on `target` or `curve` mode. The production P2
  ensemble is the decision metric.
- Do not regenerate index maps for inference against `final2`. A from-scratch
  V10 may generate fresh maps, but its model, maps, curves, normalization, and
  feature layout must ship as one matched artifact set.
- All target-date features must use information strictly before the target
  competition. No scored-event live reruns may be used as accuracy evidence.
- Data quality is checked before model logic when a prediction looks wrong.

## Current baseline

`final2` was trained on 7,321 rows (5,086 World Class and 2,235 Open Class),
with a 15 × 101 sequence and a 220-wide static input:

```
169 base static features
 10 cold-start features                         = 179
 33 caption-fingerprint features                = 212 raw static
+  8 caption-trend features                     = 220 model static input
```

Its architecture is two bidirectional LSTMs (128 then 64 units), attention
pooling, a 512 → 256 dense trunk, a 270-unit accuracy trunk, judge/corps/show
embeddings, and caption-level residual quantiles. Recap, category, and total
scores are deterministically derived from the eight caption predictions.

Baseline metrics from the model card:

| slice | total MAE |
|---|---:|
| established history | 0.845 |
| short history | 1.171 |
| sparse history | 1.838 |
| zero history | 3.218 |
| season debut | 3.636 |

Other baseline facts:

- Validation recap/caption MAE: 0.346
- Improvement over inertia: 0.810 points
- Improvement over quadratic: 0.300 points
- Selected interval scale: 0.6
- Calibrated validation coverage: 82.99%
- Calibrated validation width: 1.189 points
- Validation contains 363 rows; the held-out test is only 52 rows / four shows,
  so it is not sufficient by itself for V10 selection.

The live source DB currently contains 7,470 V9 subcaption rows through 2026, all
212-wide. The current 212-wide builder was ported on 2026-07-08 and is protected
by `v9FeatureParity.test.ts` and `v9InferenceParity.test.ts`. The current local
trainer, however, is still the obsolete 169-wide implementation.

## Recovered-code assessment

The private `doeixd/recovered-ml-212` repository contains:

- A 212-wide builder reconstructed and validated against the original stored
  training rows. This has already been ported into the main repository, with a
  small set of later fixes.
- A 3,393-line, 220-input trainer reconstruction. Its dimensions and core graph
  are credible, but 73 of roughly 600 replayed hunks drifted.
- The full ordered set of 138 trainer patches, a byte-exact 2026-05-26
  187-dimensional trainer checkpoint, and a committed 220-dimensional wiring
  reference.
- The original `final2` training arguments, model card, model graph, checkpoints,
  evaluation report, and training log on the main checkout.

The recovered trainer must not be treated as executable truth. The drift is
concentrated in behavior that materially shaped `final2`: auto-curriculum,
forecast-context masking, composite checkpoint selection, the 270-unit accuracy
trunk option, multi-checkpoint saving, and metric/reporting code. These regions
must be reconstructed deliberately and verified against the preserved run log.

## Definition of done

V10 is ready to replace `final2` only when all of the following are true:

1. The training pipeline is committed, type-checks, is repeatable from a
   documented command, and emits a complete model card with artifact hashes.
2. Builder and inference feature layouts are shared/versioned and pass parity
   tests, including target-time and leakage checks.
3. Training data is sourced through the clean domain semantic layer rather than
   raw contaminated `caption_scores`.
4. The candidate beats or matches `final2` on the 2025 frozen-cutoff replay and
   improves the targeted 2026 thin-history slices without regressing the
   established-history majority.
5. Prediction intervals meet coverage targets by history slice, not merely in
   aggregate.
6. The model, index maps, reference curves, normalization data, feature schema,
   training arguments, evaluation reports, and hashes are stored together.
7. Inference can load the new matched artifact without changing or corrupting
   the `final2` fallback path.

## Milestone 0 — Freeze the experiment contract

Before changing training code, create a machine-readable baseline manifest from
the `final2` model card, training arguments, model graph, and training log.

Deliverables:

- A versioned experiment/config schema and one canonical command for each run.
- Stable definitions for the primary metrics and every required slice:
  division, season phase, in-season history depth, forecast mode, and caption.
- A record of the `final2` artifact hashes and baseline metrics above.
- Deterministic seed handling and environment capture (Node, tfjs-node, SQLite,
  platform, CPU/GPU backend).
- A run directory convention that never overwrites a prior artifact.

Acceptance gate: an evaluation-only command loads `final2` and reproduces its
saved metrics within floating-point tolerance without retraining.

## Milestone 1 — Reconstruct a clean `final2`-compatible trainer (V9.5)

Build a new trainer from trusted pieces instead of copying the conservative
reconstruction wholesale:

1. Use the exact 2026-05-26 trainer snapshot as the trusted training-loop base.
2. Use the committed 220-dimensional reference for the input wiring.
3. Replay the relevant patch chains in order for:
   - `maskForecastContext`
   - `AUTO_CURRICULUM_*` and `maybeAdvanceCurriculum`
   - `finalWeightsMode` / production-composite selection
   - `accuracyTrunkUnits`
   - best-loss, best-total, best-delta, phase, and best-composite checkpoints
   - `MetricBucket` / sliced evaluation reporting
4. Port the result cleanly to current Effect v4 conventions where the trainer or
   data-loading boundary touches Effect.
5. Parameterize paths and version identifiers; remove V9-specific output
   overwrites.

The preserved `final2` log is behavioral ground truth. A short dry run must emit
the same parsed hyperparameters, model capacity, curriculum phase schedule,
weight/scale ramps, checkpoint decisions, and composite-score calculation.

Acceptance gate: train at least two baseline replicas with the original 7,321-row
cutoff and `final2` arguments. They do not need byte-identical weights, but their
validation, forecast, coverage, and history-slice metrics must land inside
predeclared tolerances. If they do not, stop here; do not attribute the difference
to a V10 feature.

## Milestone 2 — Version and clean the V10 training data

Create a new builder/table (for example `ml_sequence_rows_v10_subcaption`) and a
new feature-schema module. Do not mutate the V9 table.

Required changes:

- Replace the raw `querySeasonCaptionsV6` / `caption_scores` feature source with
  `clean_reference_curve_metric_scores` or a purpose-built clean training view
  with equivalent domain guarantees.
- Preserve the necessary corps total, division, rank, date, and competition
  fields while using normalized caption slugs from the semantic layer.
- Require complete, sum-reconciled eight-caption panels.
- Exclude I&E/individual/showcase rows, zero/DNP panels, out-of-domain values,
  and unknown caption names structurally.
- Keep schedule/calendar-based percent-through semantics identical for complete
  and in-progress seasons.
- Generate fresh V10 index maps only as part of the matched V10 artifact set.
- Store builder version, feature-schema version, curve hash, map hashes, source
  cutoff, and row provenance on every run.

Tests:

- Builder/inference byte or tolerance parity for every self-contained feature.
- All rows have the exact declared sequence/static dimensions.
- No target-date or future-event leakage.
- Clean-panel reconciliation and caption-name alias coverage.
- Current-season and historical rows exercise nonzero cold-start fields.

Acceptance gate: a V9.5 model trained on the clean V10 dataset is compared with
the raw-data baseline. Any metric movement must be explained by an audited set
of rows, not treated as an unexplained model improvement.

## Milestone 3 — Add field-pace context (V10 P1)

Add a small, explicit block shared by every corps at a target date, computed only
from shows strictly before that date. Initial candidates:

- Field level versus the historical reference curve.
- Shrunk field slope in points per percent-through.
- Field residual EMA.
- Sample size/effective confidence so the model can distinguish a stable slope
  from an early-season estimate.

Compute the block by division (at minimum World and Open) and over a stable
competitive core such as the top 25. Shrink early estimates toward the historical
division mean as a function of available corps/shows.

The feature must be represented in one shared schema used by training and
inference. Adding it changes the model input dimension and therefore requires a
new artifact; it cannot be bolted onto `final2`.

Acceptance gate: frozen-cutoff evaluation shows reduced signed bias during
fast/slow season regimes without regressing established-history MAE. Inspect
ablation results to prove that the model uses the new block rather than merely
benefiting from unrelated retraining variance.

## Milestone 4 — Improve thin-history learning (V10 P2/P3)

Treat history depth as a first-class training regime.

Experiments, in order:

1. Stratified sampling or loss weighting that gives season-debut and show-1/2/3
   rows meaningful optimizer weight without swamping the majority regime.
2. Targeted history-truncation augmentation that simulates thin current-season
   history while retaining valid prior-season context.
3. A history-aware baseline anchor that blends recent recap and prior-season
   comparable for 1–3 in-season shows, applied consistently at both training and
   inference time.

Do not conflate existing random `historyHideRate` augmentation with the targeted
thin-history requirement. Record the target's in-season show count explicitly so
sampling, weighting, baseline blending, and evaluation use the same definition.

Acceptance gate: meaningful MAE reduction in zero/sparse/short-history and 2026
walk-forward slices, with no material regression in established history. Compare
against the currently deployed thin-history comparable-revert layer; V10 must
earn its removal rather than stack another correction on top.

## Milestone 5 — History-aware uncertainty (V10 P4)

Replace the single global interval scale with calibration that can widen forecasts
when evidence is thin. Candidate approaches:

- Calibrate scale by history-depth bucket and division.
- Predict a bounded scale adjustment from history depth and field-pace
  uncertainty.
- Use conformal calibration on the date-forward validation set if sample sizes
  support it, with pooled/shrunk buckets for sparse regimes.

Report empirical coverage and width for established, short, sparse, zero-history,
and season-debut slices. Avoid claiming precise slice coverage where the sample
count is tiny; include confidence intervals or pooled estimates.

Acceptance gate: each supported history slice is close to its declared coverage
target, and thin-history intervals are wider when their observed error warrants
it. Overall coverage alone is insufficient.

## Milestone 6 — Evaluation and candidate selection

Every candidate must run through the same protocol:

1. `final2` baseline with the real recent-form baseline.
2. V9.5 reconstructed-trainer baseline.
3. V10 ablations: clean data only, field pace only, thin-history strategy only,
   interval strategy only, and the combined candidate.
4. 2025 frozen-cutoff replay at July 1, July 15, and July 30.
5. 2026 strict walk-forward: last pre-show prediction versus actual.
6. Slices by division, caption, season phase, in-season show count, and known vs
   unknown judge panel.
7. P2 ensemble metrics and pairwise/rank accuracy in addition to caption and
   total MAE, signed bias, coverage, and width.

Primary selection rule: improve the thin-data regimes and current-season bias
while staying within a predeclared non-inferiority margin for established-history
total MAE. Do not select on one favorable small test split.

Because training is stochastic, run multiple seeds for finalists and report
mean, spread, and worst seed. A gain smaller than run-to-run variance is not a
shipping result.

## Milestone 7 — Package and integrate

A V10 model directory must contain:

- `model.json` and weights
- all selected checkpoints
- training arguments
- model card and evaluation report
- feature-schema/version manifest
- normalization statistics
- reference curves
- judge/corps/show index maps
- SHA-256 hashes for every input artifact
- data cutoff, source row counts, division counts, and git commit
- exact training and evaluation commands

Add a V10 model-path resolver and V10 inference loader without changing the V9
fallback. Run shadow predictions first and store V9/V10 outputs side by side.
Only switch the production selector after the full gate passes.

After production validation:

- Retire the in-season bias correction only if field-pace V10 removes its need.
- Retire the thin-history comparable-revert only if V10 matches or beats it in
  strict walk-forward evaluation.
- Keep `final2` available for immediate rollback.

## Suggested implementation sequence

1. Commit the baseline manifest/evaluator.
2. Implement and verify the clean 220-input V9.5 trainer.
3. Reproduce baseline training behavior across multiple seeds.
4. Add the versioned clean V10 data view/builder and parity tests.
5. Train the clean-data-only candidate.
6. Add and ablate field-pace features.
7. Add and ablate thin-history sampling/baseline changes.
8. Add history-aware interval calibration.
9. Run the complete 2025/2026 evaluation matrix.
10. Package a matched V10 artifact and shadow it against `final2`.
11. Ship only after explicit review of the model card and slice regressions.

## Open decisions

- Exact non-inferiority margin for established-history total MAE.
- Whether the field core is top 25 overall or separately parameterized by
  division and season.
- Whether V10 remains TFJS or moves training to Python/JAX/PyTorch while retaining
  an export-compatible inference artifact. Changing frameworks adds reproduction
  risk and should be justified independently of feature improvements.
- Whether history-aware intervals use bucketed calibration, a learned scale, or
  conformal calibration.
- Whether the clean training source should reuse the reference-curve view or add
  a dedicated model-training view with the same domain rules and richer columns.

## Notes for future implementers

This is a living handoff section. Update it whenever implementation or evaluation
reveals a non-obvious invariant, trap, useful command, artifact fact, or rejected
approach. Date entries so later readers can distinguish current facts from old
pipeline state.

### 2026-07-15 — initial inventory

- The file named `sdk/src/training/trainModelV10.ts` is not the V10 described by
  this plan. It is a pre-V9 experiment restored on 2026-06-18; its header calls
  it V8, it reads `ml_sequence_rows_v10`, and its dimensions are 136 raw / 144
  total static with a 102-wide sequence step. Do not port or “finish” it for this
  effort. A new V10 must descend from V9 `final2`.
- The current main-repo builder is already the recovered 212-wide builder. It was
  ported in commit `b3a1808` and received an inference-parity guard in `47d29b9`.
  The recovery repository's statement that main is still 169-wide is historical.
- The current main-repo `trainModelV9Subcaption-fixed.ts` is still 169-wide. The
  3,393-line trainer in `doeixd/recovered-ml-212` is the 220-input reconstruction,
  but it is evidence/reference material, not safe executable truth.
- The recovered trainer's 73 drifted hunks are concentrated in material regimen
  behavior: auto-curriculum, forecast-context masking, composite selection,
  configurable accuracy-trunk capacity, multi-checkpoint saving, and sliced
  metrics. A trainer that merely compiles is not sufficient.
- `final2`'s `training.log` is useful behavioral evidence, not just diagnostics.
  It pins parsed arguments, capacity (`AccuracyTrunk 270`), curriculum decisions,
  phase weights/scales, and checkpoint selection. Use it to test reconstruction.
- `final2`'s model-card/test split is small: 52 rows across four shows. Never use
  that split alone to select V10. The 2025 frozen-cutoff replay and strict 2026
  walk-forward are mandatory.
- As of this inventory, `sdk/dci-relational.db` contains 7,470
  `ml_sequence_rows_v9_subcaption` rows spanning 2013–2026, and all are 212-wide.
  This differs from `final2`'s frozen 7,321-row, 2013–2025 training set.
- The current V9 builder still obtains its main caption rows through
  `MlQueries.querySeasonCaptionsV6`, which joins raw `caption_scores`. Only the
  reference-curve generator has moved to `clean_reference_curve_metric_scores`.
  V10 training-data cleanup is therefore real work, not already completed by the
  clean reference-curve change.
- `final2`'s preserved top-level artifact hashes are being pinned by Milestone 0.
  Do not casually reformat its JSON or logs: byte hashes are part of the baseline
  contract even when semantic values are unchanged.
- Milestone 0 now has a frozen manifest at
  `sdk/src/training/baselines/final2-baseline.json` and a lightweight validator at
  `sdk/scripts/validateFinal2Baseline.ts`. Run it from `sdk/` with
  `npm run validate:v10-baseline`; add `-- --json` for machine-readable output.
  On 2026-07-15 it passed all 102 artifact, topology, configuration, split,
  curriculum, and metric checks.
- The baseline validator intentionally does not initialize TensorFlow or query
  the mutable source DB. It proves that the preserved baseline is intact; it does
  not recompute predictions. Keep this distinction explicit in reports.
- The exact frozen `final2` training table is recoverable from
  `sdk/dci-relational-scrape.db`: it has 7,321 rows with the exact documented
  season/division counts. Do not substitute the mutable
  `sdk/dci-relational.db`; even filtering that DB to `season <= 2025` produces
  7,317 rows because four historical rows have changed or disappeared.
- `sdk/scripts/replayFinal2Baseline.ts` is the independent Milestone 0 inference
  gate. From `sdk/`, run `npm run replay:v10-baseline`; use `-- --json` for the
  full report. It rebuilds the date-forward split and training-only EMA/trend
  state, recomputes normalization, loads the preserved model, and checks global,
  history, and forecast-mode results. On 2026-07-15 it passed 167 checks and
  reproduced validation recap MAE `0.346316613` and test recap MAE
  `0.292354477`.
- Recomputing normalization from the frozen DB produces the exact preserved hash
  `a1775567abe100abbf8c821b92de0ddeda6d325c156ea85adddadb44bca69b8e`.
  The standard deviation is the sample statistic (`n - 1`), not population
  standard deviation. The current normalization JSON may be semantically close
  but is not byte-identical, so reproduction must use the recomputed stats.
- Evaluation consumes three seeded RNG draws per row: the epoch-zero leakage
  audit draw, identity-dropout draw, then agnostic-show dropout draw. Omitting
  the first apparently unused draw shifts every later stochastic decision and
  changes slice metrics. Preserve call order, not only effective probabilities.
- The interval heads are residual-anchor quantiles, while the reported caption
  median is replaced by the separate recap head. Interval coverage/width must be
  centered on the residual head's p50. `v9SubcaptionInference.ts` now exposes
  that value as optional `residualP50` for faithful evaluation.
- A real inference parity bug was found in the shared loader: numeric zero
  baselines were treated as missing via truthiness fallback. The loader now uses
  an explicit finite-number check. This matters for zero-history/season-debut
  rows and should remain covered by the replay gate.
- On this Windows checkout, the native LibSQL/better-sqlite3 bindings are not
  usable under the active Node 25 shell, despite the SDK's Node 20 Volta pin.
  The replay evaluator intentionally calls the available `sqlite3 -json` CLI.
  TensorFlow runs on the pure JS CPU backend here; the 3e-6 metric tolerance
  accommodates harmless backend floating-point differences.
- The top-level `final2/weights.bin` is byte-identical to the preserved
  `best_composite/weights.bin`; the deployed artifact really is the composite
  checkpoint requested by its training arguments.
- Full `sdk/npm run check` currently stops on the pre-existing NodeNext JSON
  import error in `src/readModel/builders/vs.ts:25` (missing JSON import
  attribute). The new validator independently passes a focused TypeScript check.
- The exact incremental patch chains and verification gates for reconstructing
  the trainer are recorded in
  `docs/plans/V10_TRAINER_RECONSTRUCTION_CHECKLIST.md`. Later patches are not
  standalone final functions; replay each named chain chronologically.
- Milestone 1's versioned scaffold is `sdk/src/training/trainModelV95.ts` and its
  entrypoint is `npm run train:v95`. It starts from the exact 2026-05-26 anchor,
  imports the shared 212-wide dimension, adds the eight trends for a 220-wide
  model input, and defaults to V9.5-specific model/normalization/log paths.
- “Exact anchor” means exact for that recovered point in history, not internally
  complete. Its `DataRow` type required season/competition/corps identity fields
  that `buildDataRows` did not populate, and its query omitted
  `agnostic_show_id`. The committed 220 reference also retained the omission.
  The later conservative recovery contains the coherent row construction and SQL
  projection, which were ported as a narrowly verified wiring repair. Expect more
  partially applied cross-hunk changes; a green diff provenance alone is not a
  substitute for focused compilation and behavioral tests.
- The initial metrics reconstruction checklist was itself incomplete: the four
  obvious sliced-report patches depend on row/sample metadata, show-grouped
  batching, interval scaling, calibration, and history metadata introduced by
  nine earlier patches. The corrected 13-patch order is now recorded in the
  checklist. When recovering behavior, search backward for every newly referenced
  symbol; patch filenames identified by the final function alone are insufficient.
- Metric accumulation/classification now lives in the testable
  `sdk/src/training/v95Metrics.ts` instead of being buried entirely inside the
  trainer. `npm run test:v95-metrics` pins serialized field names, denominators,
  season boundaries, history buckets, forecast-mode precedence, and correlation
  edge cases. The trainer's reconstructed evaluator retains show-grouped batching,
  residual-centered interval scaling, raw/calibrated summaries, and caption
  fingerprint diagnostics.

## Immediate next task

Begin Milestone 1 by scaffolding the clean V9.5 trainer from the trusted exact
anchor and the committed 220-dimensional wiring reference. Restore and test the
recovered regimen in the checklist's chronological order. Do not start field-pace
or thin-history experiments until the V9.5 baseline gate passes.
