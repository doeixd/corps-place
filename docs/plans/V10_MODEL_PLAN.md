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

Predeclared V9.5 replica tolerances (set before any reconstructed-trainer result):

- Run seeds 42 and 43. Both must complete without NaNs and select a real composite
  checkpoint; report each result plus the two-seed mean and range.
- Validation recap MAE: each seed no worse than final2 `0.34632 + 0.030`; two-seed
  mean no worse than `0.34632 + 0.020`.
- Validation total MAE: each seed no worse than final2 `0.96426 + 0.120`; two-seed
  mean no worse than `0.96426 + 0.080`.
- Calibrated validation coverage must be in `[0.78, 0.87]`; raw coverage must not
  fall below `0.93`. Compare interval width to final2, but do not accept narrower
  intervals as an improvement when coverage misses the band.
- Established-history total MAE must be no worse than final2 `0.84510 + 0.100`.
  Sparse-history and zero-history total MAE must each be no worse than their
  final2 values (`1.83824` and `3.21821`) by more than `0.300`; treat these small
  slices as guardrails rather than optimization targets.
- The best production-composite score must be at most final2
  `0.50257 + 0.050`. Any failed bound blocks V10 feature work until explained and
  either fixed or explicitly re-baselined with evidence.

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
- The exact anchor parses the recovered curriculum arguments but its
  `V9LossScheduler` still hard-codes the older 40/120 phase boundaries; parsed
  10/40 settings are therefore inert until scheduler integration is restored.
  Do not mistake argument presence for behavioral parity. The frozen transition
  policy now lives in `v95Curriculum.ts`, with max-epoch, min-age, plateau,
  improvement, and coverage gates pinned by `npm run test:v95-curriculum`.
- The curriculum transition checklist also omitted the scheduler/config and
  epoch-log patches that make `maybeAdvanceCurriculum` operative. The corrected
  chain now includes ten patches. V9.5's scheduler consumes the configured
  boundaries and scale ramps, the sequence provider switches from 5 to 15 steps
  at the actual A→B boundary, Open Class sampling uses the configured 0.35 share,
  and transitions reset monitor patience before LR reduction/early stopping.
- Forecast masking is more than zeroing static slots. The final2 chain first
  removes sequence/trend/history context, masks lineup and judge-Elo statics,
  clears the agnostic show embedding, and preserves cold-start/fingerprint slots;
  then May 28 patches replace the hidden history baseline with the rank-curve
  baseline plus a centered, confidence-scaled caption-fingerprint adjustment
  clamped to ±0.6 points. Using the earlier global EMA baseline would leak the
  supposedly hidden history. `npm run test:v95-masking` pins slot behavior,
  input immutability, zero-rate RNG consumption, the seeded 0.12 decision stream,
  and forecast-baseline construction.
- Architecture parity had the same parsed-but-inert failure mode as curriculum:
  the scaffold parsed/defaulted `accuracyTrunkUnits=270`, but graph construction
  still hard-coded 128 units and its capacity log still claimed Dense 256→128.
  The graph now consumes the argument and the log matches final2 (`256→128`
  BiLSTM, Dense `512→256`, AccuracyTrunk `270`). Run
  `npm run validate:v95-architecture` for the 16-check static graph/manifest
  gate; a native-backend runtime dry graph is still a separate pending gate.
- Checkpoint reconstruction exposed two more anchor defects: validation loss was
  accumulated but omitted from `monitoringStats`, making a best-loss checkpoint
  impossible, and an obsolete `epoch === 40 || epoch === 120` reset survived
  alongside the configurable 10/40 curriculum. V9.5 now tracks independent
  delta/loss/total/composite and per-phase weights/directories, uses the final
  production composite formula, removes the obsolete reset, and promotes the
  requested final mode with `composite` as final2's default. The synthetic gate
  exactly reproduces final2's saved composite score `0.5025684126513721`.
- The anchor's plateau LR reduction was ephemeral: it directly changed the
  optimizer LR, but the next epoch's cosine schedule overwrote it, and
  `currentLR` did not consistently track the scheduled base. V9.5 now keeps a
  persistent `plateauLrMultiplier`, applies it to every epoch's warmup/cosine
  base, clamps at `minLr`, and resets it only on a curriculum transition. The
  pure scheduler tests match preserved loss weights/scales at epochs 0, 39, 40,
  71, and 100 and pin width-floor and LR boundary behavior.
- Final-report reconstruction exposed another partially applied chain. The V9.5
  scaffold still used the anchor's random row split even when
  `valMode=date-forward`, its `lineupContextHidden` metadata was permanently
  false, and its terminal test block emitted only seven aggregate metrics. The
  preserved final2 card requires a show-grouped date-forward split, explicit
  lineup-unknown evaluation, raw plus calibrated sliced reports, artifact hashes,
  curriculum/checkpoint provenance, and a model card. Treat these as one connected
  evaluation-contract repair rather than copying only the final serializer.
- V9.5 configuration is now isolated in `v95Config.ts`, so it can be verified
  without loading TensorFlow or opening a DB. `npm run test:v95-config` explicitly
  passes and round-trips all 68 preserved final2 arguments and pins the exact
  historical capacity/curriculum summaries used by the trainer. When adding a V10
  option, extend this explicit contract instead of adding an untested parser
  default.
- The canonical frozen source DB is now byte-pinned in the baseline manifest:
  `sdk/dci-relational-scrape.db`, 3,621,408,768 bytes, SHA-256
  `59fc975037145a0450276bdd479a48d6d8c82e259ec8b3b9e2cff88f0f8303df`.
  Run `npm run train:v95:final2`; its `--reproduction-contract final2` gate hashes
  the DB before TensorFlow starts and then requires the exact 7,321-row division,
  split, and show counts. This deliberately fails rather than silently training
  against the mutable 7,470-row DB.
- The first native WSL graph smoke exposed two connected cardinality traps. A
  `--maxRows` run sized the show embedding from only its small sample, then failed
  on test show ID 158; sample construction must only increase, never shrink, the
  known show cardinality. More importantly, the current index-map files are not
  final2's maps: current counts are 356 judges/454 corps, while the frozen graph
  was built with input dimensions 245 judges, 709 corps, and 349 shows. Counting
  current map keys would both change graph parameters and fail on frozen corps ID
  548. V9.5 now pins the three dimensions from final2's model graph, validates all
  loaded IDs before construction, and records both frozen contract hashes and
  local-file hashes in its card. V10 must generate matched, versioned maps and use
  `max(index)+1`; never infer embedding size from object key count or a sample.
- Native verification uses the separate WSL checkout
  `/root/corps-place-v10` on branch `codex/v10-model-reconstruction`, with Node
  20.20.0 installed at `/opt/node-v20.20.0-linux-x64`. This avoids the Windows
  checkout's platform-mixed native `node_modules`. The frozen DB can be read from
  `/mnt/c/Users/Patrick/AppData/Local/Programs/Syncthing/corps-place/sdk/dci-relational-scrape.db`;
  copy it to WSL's native filesystem before long replicas for better I/O, then
  rely on the reproduction-contract hash to prove the copy is exact.
- Full replicas use `cd /root/corps-place-v10/sdk && npm run
  train:v95:replica -- <seed>`. The wrapper is versioned at
  `sdk/scripts/runV95Replica.sh`; it makes the final2 data contract, seed-specific
  trial ID, normalization path, and V9.5-only output root explicit. Override
  `V95_DB_PATH`, `V95_MODEL_DIR`, or `V95_NORM_PATH` only when the alternative is
  intentional and documented in the resulting run notes.
- The corrected WSL zero-epoch smoke graph contains exactly 1,048,639 trainable
  parameters, equal to the sum of final2's preserved weight shapes. It completed
  saving, calibration, and every non-empty final2 evaluation population. The
  compressed three-epoch fixture (phase ends 1/2, 16 samples, batch 8) exercised
  phases A, B, and C with finite values; saved delta, loss, total, composite, and
  A/B/C phase checkpoints; selected composite final weights; and emitted the full
  report/model-card path. Do not interpret its deliberately tiny-data metrics as
  model quality.
- Seed-42 replica execution completed 2026-07-15 as WSL systemd unit
  `v95-seed42.service`, using branch commit `1b89aa9` and run directory
  `sdk/models/v95_final2_reconstruction/v95_final2_seed42_1784145026981`.
  It early-stopped at epoch 100, selected a real composite checkpoint, and
  completed without NaNs. Validation recap MAE was `0.356027`, total MAE
  `0.889182`, raw coverage `0.984504`, calibrated coverage `0.826102`,
  established-history total MAE `0.793075`, zero-history total MAE `1.841322`,
  and best production-composite score `0.492927`; all of those clear their
  predeclared bounds. Sparse-history total MAE was `2.433649` on only nine rows,
  which fails the frozen `2.13824` ceiling by `0.295409`. This is a Milestone 1
  failure even though the aggregate result is healthy; do not rebaseline it from
  one run or begin V10 feature work. Preserve the small-slice row count when
  diagnosing whether this is seed variance, checkpoint selection, or a remaining
  reconstruction difference.
- Seed 43 started 2026-07-16 as sequential WSL systemd unit
  `v95-seed43.service` against the same commit and frozen-data contract. Startup
  reached phase A with the exact 1,048,639-parameter graph and finite derivation
  and scale checks. Monitor with `systemctl status v95-seed43.service` and
  `journalctl -u v95-seed43.service -f`. Do not run another full replica
  concurrently on this WSL instance.
- `replayFinal2Baseline.ts --row-details --json` now emits identity, actual and
  predicted totals, total error, and caption predictions for zero/sparse-history
  validation rows. It remains an opt-in diagnostic and does not alter training or
  the default baseline report. The replay reads each model card's own calibrated
  interval scale, so it verified both preserved final2 and seed 42 with all 167
  numeric checks passing.
- Row-level replay shows seed 42's sparse-history miss is not one anomalous row:
  it is worse than final2 on seven of nine rows. Its sparse total-MAE increase is
  `+0.595410`; the four largest per-row error increases are `+1.260318`,
  `+1.216170`, `+1.096108`, and `+1.067191` points. Two rows improve. Compare the
  same identities for seed 43 and across alternate checkpoint families before
  deciding whether the cause is seed variance or selection/training behavior.

- A seed-aware replay of seed 43's current epoch-46 composite checkpoint was run
  during training on 2026-07-16. The diagnostic now accepts `--seed`; this matters
  because deterministic validation-time agnostic-show masking otherwise uses seed
  42 and moves the metrics. With seed 43, aggregate validation recap MAE is
  `0.349293` and total MAE `0.938149`. Established-history total MAE is
  `0.844217`, short-history is `1.050941`, and zero-history is `2.314033`,
  all competitive with or better than the corresponding final2 values.
- The same checkpoint's nine-row sparse-history total MAE is `2.246757`: better
  than seed 42's `2.433649`, but worse than final2's `1.838239` and `0.108517`
  above the predeclared `2.13824` ceiling. It beats final2 on only three of nine
  rows and beats seed 42 on four. Three rows account for the largest regressions
  versus final2 (`+1.653807`, `+1.387505`, and `+0.958930` total-error
  points), so compare their histories, identities, divisions, and fallback values
  before changing a global loss. This replay is provisional: the final restored
  checkpoint and terminal report remain authoritative.

- The epoch-48 `best_total` checkpoint is a materially different and useful
  tradeoff. Seed-aware replay gives aggregate recap MAE `0.360088` and total MAE
  `0.912450`; established/short/zero/sparse total MAEs are `0.798448`,
  `1.089502`, `2.763687`, and `2.129719`. Sparse history therefore clears
  the predeclared `2.13824` guardrail by `0.008521`, although it still trails
  final2's `1.838239`. Relative to epoch 46 composite, it improves sparse total
  by `0.117037`, aggregate total by `0.025699`, and established total by
  `0.045770`, while worsening aggregate recap by `0.010794` and zero-history
  total by `0.449653`. This supports testing a constrained multi-slice checkpoint
  selector; do not promote it from this single provisional replay before terminal
  calibration, seed-mean reporting, and the declared composite-checkpoint gate.

## V10 improvement hypothesis log

Keep proposed V10 changes here as hypotheses until an ablation clears the frozen
V9.5 gates. Do not mix them into reconstruction commits. For every tested idea,
record the dataset version, seeds, relevant slices, result, and keep/reject
decision.

### 2026-07-15 — hypotheses suggested by final2 reconstruction

- **Condition interval calibration on evidence strength.** Final2 chooses one
  global interval scale (`0.6`), while its model card already shows materially
  different behavior for zero-history, established-history, World Class, and Open
  Class rows. Compare global calibration with history-bucket calibration and then
  a small learned or conformal calibrator. Require adequate sample counts and
  report coverage/width per slice so a small aggregate gain cannot hide a weak
  subgroup.
- **Make thin-history robustness an explicit selection objective.** The final2
  composite checkpoint is dominated by aggregate validation delta/total error and
  coverage. Test a constrained selector that minimizes zero/sparse-history error
  subject to no regression beyond the predeclared established-history margin.
  This may be safer than changing the training loss first.
- **Retain a bounded checkpoint frontier, not only one winner per metric.** The
  reconstructed trainer already maintains rolling `best`, `best_loss`,
  `best_total`, `best_composite`, and phase-best directories, which is why the
  useful epoch-48 snapshot survived. Each directory is still overwritten when its
  metric improves, and the terminal card fully evaluates only the selected final
  weights. V10 should preserve immutable snapshots whenever a checkpoint is
  non-dominated across recap, total, established, sparse, zero-history, coverage,
  and width; attach epoch, curriculum state, seed, hashes, and validation metrics.
  Cap the frontier and remove dominated snapshots rather than saving every epoch.
- **Evaluate and package frontier candidates uniformly.** At training end, replay
  every retained frontier checkpoint through the same calibrated slice suite and
  write a compact comparison table. Choose production weights with a selector
  declared before viewing the results, and package the selected model plus any
  named fallback checkpoint needed for audit. Do not use the early-2026 holdout to
  cherry-pick among snapshots after the fact; checkpoint selection remains on the
  frozen development validation contract, with 2026 used as an out-of-time gate.

- **Treat sparse-slice variance as a first-class diagnostic.** Seed 42's aggregate
  reconstruction metrics passed while its nine-row sparse-history total MAE
  missed the guardrail. After seed 43, compare row-level errors and checkpoint
  predictions for this exact slice before changing loss weights. Report bootstrap
  uncertainty or per-row errors alongside the point estimate; a nine-row slice
  can identify a real failure, but cannot reliably distinguish a systemic defect
  from a few unstable examples by its mean alone.
- **Test identity reliance directly.** Final2 schedules corps-identity scale and
  dropout globally, but the useful amount of corps prior should depend on current
  season evidence. Ablate history-conditioned identity gating/dropout against the
  fixed schedule, especially for Open Class, season debuts, and returning corps.
- **Separate field pace from corps trajectory.** Add the same-date, pre-show field
  distribution/rank context described in Milestone 3 and ablate it before adding
  more recurrent capacity. It should explain season-wide scoring drift without
  forcing the corps embedding or short sequence to absorb field movement.
- **Prefer a versioned clean training view over trainer-side filtering.** The
  current builder mixes raw caption rows with clean reference-curve features. A
  materialized, audited model-training view would make score exclusions, timing,
  and row identity reproducible and would prevent mutable SQL joins from silently
  changing the experiment population.
- **Revisit the plateau policy only after faithful replay.** Persistent plateau
  reduction fixes an obvious implementation defect, but its interaction with
  cosine decay and curriculum transitions was never measured by final2. Compare
  persistent multiplicative reduction, cosine restarts at phase boundaries, and
  no plateau scheduler using identical seeds; do not assume the repaired behavior
  is automatically the best V10 regimen.

### 2026-07-16 — durability, missing evidence, and identity considerations

- **Treat the curriculum as a coordinated system, not independent knobs.** The
  reconstructed trainer restores A/B/C loss ramps, short-to-full sequence growth,
  judge and corps scale ramps, history hiding, baseline noise/dropout, identity
  dropout, width-floor scheduling, and checkpoint families. Their ordering is a
  plausible source of final2's durability: learn general score movement before
  allowing identity corrections. Preserve that ordering as the control and
  ablate one schedule dimension at a time; changing dropout, identity scale, and
  loss weights together would make any gain uninterpretable.
- **Separate missing history from unknown identity.** A corps with no current-
  season shows but a known multi-year identity is different from a truly unseen
  corps, and both differ from a known corps whose history was intentionally
  masked. Add a crossed evaluation matrix for history present/hidden/absent,
  corps known/unknown, judges known/unknown, and lineup context known/unknown.
  Aggregate "cold start" metrics can otherwise conceal which prior the model is
  using.
- **Make identity trust conditional on evidence.** Test a learned or deterministic
  gate that shrinks corps and judge residuals toward zero when history is thin,
  identity is unknown, the panel is unavailable, or the identity's training
  support is weak. Compare it with final2's global epoch-based scale. The goal is
  to retain useful known-corps priors without allowing an embedding to dominate a
  one-show trajectory or invent confidence for a new corps.
- **Match augmentation to real serving-time missingness.** Random history hiding
  is useful but is not automatically representative of season debuts, incomplete
  recaps, changed lineups, unknown panels, or a new corps key. Measure those
  production frequencies, then test targeted masks and mixtures that reproduce
  them. Keep mask provenance in evaluation so synthetic robustness is not
  mistaken for real walk-forward performance.
- **Preserve a conservative fallback path.** For zero and sparse history, compare
  the neural prediction with global/division/reference-curve and last-known-corps
  baselines. Test history-conditioned shrinkage or blending, with the blend
  chosen without target-date information. A small model should have to earn its
  deviation from the robust fallback instead of always replacing it.
- **Do not assume the future judge panel is known.** Retrospective rows contain
  judge identities that may be unavailable when a forecast is actually served.
  Judge embeddings may improve recap reconstruction while harming true forecasts.
  Select production candidates on both panel-known and panel-unknown paths, and
  treat the unknown-panel path as the default unless scheduling data proves the
  panel was available at prediction time.
- **Version identity maps with the dataset and model.** Final2's graph dimensions
  are recovered, but today's map files do not describe final2's frozen integer
  IDs. V10 must generate corps, judge, and show maps from its versioned training
  view, reserve explicit unknown IDs, size embeddings with `max(index) + 1`, hash
  the maps into the model card, and test unseen and remapped keys. Cardinality
  parity alone does not prove semantic identity parity.
- **Select for durability across seeds and slices.** Report mean, range, and
  row-level changes across multiple seeds; constrain established-history quality
  while optimizing sparse/zero-history behavior. Do not tune directly to the nine
  frozen sparse rows. Use them as a regression guardrail, then confirm decisions
  on walk-forward years or resampled groups with uncertainty intervals.
- **Audit stochastic training when replicas diverge.** If seed 43 differs
  materially from seed 42, record sampled history/identity masks, curriculum
  transition epochs, learning rates, and which checkpoint wins. A deterministic
  one-epoch trace using a fixed sample order can distinguish an RNG/order mismatch
  from legitimate optimizer variance before V10 experiments begin.
- **Calibrate uncertainty separately from the mean.** Missing history, identity,
  judges, or lineup should normally widen uncertainty even when a fallback keeps
  MAE acceptable. Require coverage and width reports for every crossed missing-
  evidence mode; a narrow interval is not a durable improvement when it hides
  epistemic uncertainty.

### 2026-07-16 — recovered V9 ablation archive and usable lessons

- **An ablation archive exists and should not be rediscovered from scratch.**
  `sdk/results/ablation/` contains 16 session directories and 57 recorded runs:
  28 completed executions and 29 explicit dry-run placeholders. The useful
  sessions preserve manifests, arguments, logs, `runs.json`, and generated
  `learnings.md`; dry runs contain no evidence and must never enter rankings.
- **The closest pre-final2 matrix is
  `v9-subcaption-ablation-20260522-145424`.** It ran nine 120-epoch variants on
  the same 6,906/363/52 date-forward populations with auto curriculum, final2-like
  coverage targets, and 15% history hiding. It still predates the fully
  reconstructed trainer/model-card contract and reports one run per treatment, so
  use its results to choose experiments, not to choose a production model.
- **Do not remove late identity dropout based on the older headline result.** In
  the May 22 history-hiding matrix, `identity-dropout-floor=0` regressed test
  recap MAE from control `0.3110` to `0.3681` and total MAE from `0.6359` to
  `0.9996`, with coverage falling from `0.974` to `0.935`. An immediately
  earlier May 21 matrix without the logged 15% history-hide augmentation ranked
  the same flag first (`0.2869` recap, `0.6498` total). This reversal is
  evidence of either a strong history-hide × identity-dropout interaction or
  uncontrolled run variance. Keep final2's nonzero floor as the control and test
  the two factors as a crossed, paired-seed ablation.
- **More capacity did not help in the saved comparison.** Reducing the accuracy
  trunk from final2's 270 units to 256 produced `0.3242` recap and `0.8549`
  total MAE versus the May 22 control's `0.3110` and `0.6359`. This does not
  prove 270 is globally optimal, but it argues against capacity tuning as V10's
  first lever.
- **SWA was not supported by these runs.** Training with SWA but exporting best
  weights produced `0.3189` recap and `0.8358` total MAE; the comparable
  best-only variant produced `0.3090` and `0.6767`. Preserve ordinary best/
  composite checkpointing as the control unless a paired multi-seed experiment
  shows SWA helps the difficult history slices.
- **MB/MP emphasis is a narrow tradeoff worth retesting, not adopting.** A
  `1.4` MB/MP loss boost changed test recap from `0.3110` to `0.3130` while
  improving total MAE from `0.6359` to `0.6247`. The archive summary lacks the
  full modern per-caption/history reports, so require MB/MP-specific gains,
  no sparse-history harm, and replication across seeds before keeping it.
- **Interval-training flags mixed accuracy and calibration effects.** The saved
  width/coverage variants retrained the network rather than calibrating a fixed
  checkpoint. The best recap variant (`base-width-multiplier=1.0` plus
  `coverage-sharpness=4.0`) reached `0.2932` recap but had `0.6685` total
  versus control `0.6359`; all raw coverages remained far above the target.
  Prefer post-hoc calibration of the same frozen mean checkpoint when the question
  is interval scale, and evaluate width only at matched coverage.
- **The February matrix is historical evidence only.** Five long completed runs
  used the older non-date-forward contract and produced raw coverage near
  `0.97–1.00` with widths around `3.2–4.2`. They demonstrate stable training
  and that sharper coverage penalties widened already-overcovered intervals, but
  they are not comparable to final2 or V10 quality gates.
- **Re-run only the informative matrix under the modern experiment contract.**
  Every V10 ablation must pin commit, DB/view hash, map hashes, row/split
  populations, seed, sample order, masks, and selected checkpoint; run the
  control and treatment with paired seeds and modern history/forecast/2026 slices.
  First priorities suggested by the archive are the history-hide × identity-floor
  interaction, MB/MP emphasis, and best/composite versus SWA. Do not spend initial
  budget repeating the unsupported 256-unit trunk change.


### 2026-07-16 — 1.9× capacity ablation (paired seed 43)

- **Question:** does substantially more general sequence/trunk capacity improve the
  reconstructed final2 recipe, especially its sparse-history behavior? This is a
  scale-recipe ablation, not proof for or against the Bitter Lesson: only one
  point on a scaling curve is being tested, with the same finite data and compute
  schedule.
- **Predeclared treatment:** increase BiLSTMs from `128/64` to `192/96`, dense
  layers from `512/256` to `768/384`, and the accuracy trunk from `270` to `405`.
  Keep judge/corps/show embedding dimensions unchanged so the treatment tests
  general capacity rather than adding identity memorization capacity. The graph
  has **1,976,938 trainable parameters**, versus **1,048,639** for the replica
  (**1.885×**).
- **Hold the experiment contract fixed:** paired seed `43`, frozen final2 DB and
  7,321-row population/splits/maps, curriculum, history/judge/context hiding,
  dropout, regularization, samples per epoch, epoch ceiling, checkpoint policy,
  and terminal evaluation suite. Lower only the initial learning rate from
  `0.00075` to `0.00055` (approximately inverse-square-root scaling) because that
  is a capacity-following stability adjustment, and record it as part of the
  treatment.
- **Decision evidence:** compare composite checkpoint score, recap and total MAE,
  established/short/zero/sparse history slices, caption metrics, calibration,
  wall time, and resource use against the seed-43 replica. The early 2026 gate is
  still a later untouched evaluation and must not select this checkpoint.
- **Interpretation guardrail:** a win earns a multi-seed confirmation and a small
  clean-data scaling curve. A loss does not alone establish that capacity is
  useless; first distinguish optimization/undertraining (still improving at the
  epoch ceiling) from data-limited overfit. Do not compensate after seeing results
  by changing dropout, curriculum, identity scales, or training duration inside
  this paired comparison.
- **Interim epoch-15 observation (do not select on this):** the large run's best
  recap MAE was `0.465` versus `0.423` for standard seed 43 at the same point,
  while best total MAE was marginally better (`1.310` versus `1.333`). Its best
  composite was worse (`0.680` versus `0.633`). It led during five-step phase A,
  then became unstable/slow to adapt after phase B switched to 15-step history;
  epoch-15 current recap/total were `0.465`/`1.682` versus standard
  `0.430`/`1.437`. Continue to the predeclared stopping rule: this may be slower
  optimization from the larger graph and lower learning rate, not a final result.
- **Interim epoch-23 lessons:** the large graph recovered sharply at epoch 16 to
  `0.388` recap / `1.167` total, almost exactly the standard run's `0.386` /
  `1.143` at that epoch. It then oscillated while standard seed 43 reached
  `0.377` / `1.114` at epoch 23; best composite through that point was `0.575`
  large versus `0.557` standard. Thus 1.885× parameters have not improved sample
  efficiency under the same 7,321 rows and epoch/sample budget. Treat data
  quality/coverage, optimization, and curriculum transitions as earlier V10
  levers than width.
- The phase-A lead followed by phase-B disruption shows that the abrupt 5→15
  sequence-length change is itself a major optimization event, especially for a
  wider recurrent stack. A future experiment may ramp or mix sequence lengths,
  but do not introduce that change into this capacity comparison. Always save a
  checkpoint immediately before and for several epochs after a curriculum
  boundary.
- This treatment also lowered learning rate to `0.00055`, so a final loss cannot
  be attributed to parameter count alone. If scale remains promising enough to
  revisit, run a small paired learning-rate/warmup sweep rather than assuming the
  inverse-square-root heuristic transfers to this recurrent curriculum. Scaling
  only parameters is not the Bitter Lesson: useful tests should eventually scale
  clean data and optimization steps alongside capacity.
- **Paired learning-rate isolation started:** repeat the exact 1.885× seed-43
  treatment with final2's original `0.00075` learning rate. Keep architecture,
  data, seed, masks, curriculum, sample budget, and checkpoint rules identical to
  the `0.00055` run. This is the clean comparison that can attribute delayed
  phase-B adaptation to learning rate. It started concurrently with the original
  scale run at the user's direction on 2026-07-16; therefore compare metrics and
  seeded trajectories, but not wall-clock time. The fixed-curriculum job now
  waits for both large runs to exit so it will not become a third training job.
- **Status at low-LR epoch 34 / baseline-LR epoch 3:** the `0.00055` large run
  recovered to a best composite of `0.5046`, essentially tied with historical
  final2 (`0.5026`) and completed standard seed 43 (`0.5002`). Its epoch-34
  best-total checkpoint reached `0.8985` total MAE with `0.3575` recap, a better
  total/worse recap Pareto point than standard seed 43's final best-total value
  (`0.9156`). Do not promote it before terminal history/division evaluation.
  The `0.00075` run is only at epoch 3: versus low LR at epoch 3 it has worse
  recap/composite (`0.517`/`0.731` vs `0.482`/`0.716`) but better total
  (`1.377` vs `1.561`). This is an early tradeoff, not yet evidence for either
  learning rate.
- The large low-LR run was still in phase B at epoch 34 because continuing gains
  reset its auto-curriculum plateau counter; standard seed 43 entered phase C at
  epoch 32. Endogenous transition timing now confounds same-epoch comparisons and
  further justifies the queued fixed-boundary experiment. Compare within phase
  and at terminal checkpoints, not epoch number alone.
- **Status at low-LR epoch 45 / baseline-LR epoch 13:** the `0.00055` run finally
  entered phase C at epoch 39 and has not beaten its epoch-34 composite/total
  checkpoint (`0.5046` / `0.8985`) since the transition. Preserve that phase-B
  checkpoint. The `0.00075` run is learning materially faster: at matched epoch
  10 it reached `0.429` recap / `1.284` total versus low LR's `0.507` / `1.541`,
  and its epoch-6 composite was `0.6189`. This supports the hypothesis that
  `0.00055` under-optimized the larger graph early.
- Higher LR is also more volatile: after the strong epoch 6, epochs 7–9 regressed
  sharply before recovering in phase B. For V10, prefer adequate peak LR plus
  warmup/plateau control and robust checkpointing over simply lowering the whole
  schedule. Do not declare `0.00075` the winner until it reaches comparable phase
  B/C checkpoints and terminal missing-history slices.
- **V10 learning-rate design note:** treat `0.00075` as the peak after warmup, not
  a constant rate or a value that must be stepped down exactly at each curriculum
  boundary. Preserve adequate learning rate through the disruptive A→B 5→15-step
  sequence transition, then strengthen decay after phase B has stabilized and use
  a low rate for phase-C refinement. Test a brief transition re-warm or hold before
  a phase-specific drop; an immediate drop at the same moment the input/objective
  changes may prevent adaptation. Keep the existing continuous cosine schedule as
  the control and compare any phase-aware schedule with paired seeds.
- **Status at low-LR epoch 52+ / baseline-LR epoch 21:** at the clean matched
  epoch-16 comparison, `0.00075` wins recap, total, and composite
  (`0.367`/`1.097`/`0.5446`) over `0.00055`
  (`0.388`/`1.167`/`0.5752`) and also beats standard-size seed 43 at epoch 16
  (`0.386`/`1.143`/`0.5695`). This is the strongest evidence so far that the
  inverse-square-root learning-rate reduction was harmful to sample efficiency.
  The high-LR run has not improved since epoch 16 by epoch 21, so terminal and
  later-phase evidence remains required.
- Low LR's best phase-C recap improved to `0.3578` at epoch 52, but with total
  `1.005`; its epoch-34 phase-B composite/total checkpoint remains the better
  balanced Pareto point. Phase C has not yet demonstrated that its changing loss
  emphasis produces a superior production checkpoint for the wider model.
- Epoch-to-epoch validation movement is large enough that single-epoch headlines
  are unreliable. Retain composite and total checkpoint tracks, report a Pareto
  set, and require multi-seed terminal slice evaluation before promoting a V10
  recipe.

### 2026-07-16 — completed seed-43 replica diagnosis

- The paired standard-capacity seed-43 replica stopped at epoch 92 and selected
  the epoch-46 composite checkpoint (best-total was epoch 48). Its held-out test
  result was `0.3117` recap MAE and `0.7183` total MAE versus final2's `0.2924`
  and `0.7090`; this is a credible reconstruction-level result, not a new
  champion. Calibrated coverage/width were `0.820`/`1.108`, inside the target
  band and slightly narrower than final2.
- The regression is localized. Seed 43 improved World Class total MAE to `0.55`
  from final2's `0.62`, but Open Class worsened to `1.01` from `0.86`. Caption
  error was particularly worse in MP and GE1, while GE2, MB, and MA improved.
  Treat the 52-row test headline as noisy and retain division/caption slices in
  every decision.
- Seed 43 auto-transitioned B→C at epoch 32 on a delta plateau; final2 and the
  seed-42 replica both remained in B until the epoch-40 maximum. Because this
  changes loss weights, identity dropout, and the late learning trajectory, test
  a fixed `A=10/B=40` schedule as the next targeted stability ablation rather
  than changing several curriculum/dropout knobs together.
- Seed-aware missing-history replay remained mixed: epoch-46 improved short- and
  zero-history totals versus final2, approximately tied established history, but
  sparse-history total was `2.247` versus final2's `1.838`. Epoch-48 reduced it
  to `2.130` at an aggregate tradeoff. Preserve both checkpoints and do not infer
  durable missing-history superiority from the aggregate test score.
- Same-seed seed-42 reconstruction still differs from historical final2 despite
  identical recorded seed and 7,321-row population. Recorded arguments are not a
  complete determinism contract: recovered implementation/runtime details,
  stochastic sample/mask order, and checkpoint path can still differ. Before
  attributing a small gain to V10, estimate multi-seed variance and log sample/
  mask-order hashes or deterministic fixtures.
- **Next run queued:** standard-capacity seed 43 with auto curriculum disabled,
  forcing the recovered final2 boundaries A→B at epoch 10 and B→C at epoch 40.
  All other frozen-contract arguments stay unchanged. Its systemd queue waits
  until both 1.9× learning-rate treatments exit, avoiding a third concurrent
  training job. Compare it directly with standard automatic seed 43.

### 2026-07-16 — clean-data rebuild and early-2026 out-of-time gate

- **Make the cleaned domain layer the V10 source of truth.** Final2/V9 rows were
  built from raw `caption_scores`, which includes roughly 1,250 known poison rows:
  off-domain I&E/individual totals stored as captions, zero/DNP panels, caption-name
  drift, and judge names in the caption field. Build a new versioned V10 training
  view from `clean_reference_curve_metric_scores` or a purpose-built view with the
  same domain guarantees; never mutate or silently reinterpret the V9 table.
- **Carry the cleanup through the entire row, not only the reference curve.** The
  clean layer normalizes caption aliases, restricts model divisions/events, applies
  domain score bounds, excludes missing zero panels, requires the eight-caption
  total to reconcile within `0.05`, and derives a bounded rank. Targets, baselines,
  historical sequences, fingerprints, and reference curves must all come from one
  consistent snapshot. A clean curve paired with dirty targets is not a clean
  training set.
- **Use canonical event/corps semantics deliberately.** Incorporate repaired
  event-to-competition mappings, duplicate-event handling, score-source merging,
  caption aliases, and reviewed related-corps aliases when building V10 rows.
  Version the alias/mapping policy and retain original source keys for audit. Do
  not blindly merge two competitive units merely because the website groups them;
  every identity union needs an explicit modeling rule and effective history.
- **Measure the data improvement before adding architecture features.** First train
  the reconstructed V9.5 architecture and regimen on the clean V10 row set with
  newly matched identity maps. Compare it with frozen V9.5 on identical temporal
  evaluations. This data-only control tells us whether a gain comes from cleanup,
  a new feature, or changed optimization and prevents several changes from being
  credited to the model at once.
- **Freeze the current early-2026 cohort as an out-of-time artifact.** As observed
  2026-07-16, mutable `sdk/dci-relational.db` contains 153 complete model rows from
  25 shows dated 2026-06-27 through 2026-07-14: 63 zero-history, 26 sparse-history,
  57 short-history, and 7 established-history rows. Materialize/export the exact
  row identities and feature-source snapshot, record hashes and builder/map
  versions, and never add this cohort to training. Future database rebuilds must
  reproduce the frozen cohort or explain every difference.
- **Use 2026 as an out-of-time gate, not the ordinary checkpoint selector.** Keep
  the 2025 date-forward validation set for curriculum/checkpoint selection. Report
  final2, both V9.5 replicas, the clean-data control, and every V10 candidate on the
  locked early-2026 cohort. Once results guide decisions, the cohort is development
  validation; reserve later 2026 shows as the next untouched rolling test set.
- **Repair identity semantics before comparing models.** The current 2026 rows use
  `map_version=current-json-files`, not final2's frozen maps. Although their corps
  and show integers fit final2's graph, positional meaning is not proven; 264 of
  1,224 stored judge indices exceed final2's 245-entry judge embedding. Never feed
  these integers directly to final2. Provide an identity-agnostic mode that maps
  corps/judges/show to explicit unknown IDs, plus a known-identity mode reconstructed
  from frozen training keys where possible; genuinely new identities remain
  unknown. V10 uses its own dataset-matched, hashed maps.
- **Audit every 2026 feature as-of the prediction timestamp.** Rebuild chronologically
  with explicit `--as-of-date` semantics and verify that target-show scores,
  later-show results, final ranks, future panels, and later alias corrections do
  not enter features. Store feature provenance with the cohort. Evaluate the real
  serving modes separately: panel unknown by default, lineup unknown when needed,
  preseason/zero history, and identity agnostic.
- **Respect the cohort's dependence structure and small slices.** Rows from the
  same show and repeated corps are correlated. Report show-grouped or date-grouped
  bootstrap intervals, per-show/per-corps errors, division slices, history-depth
  slices, and coverage/width—not only a 153-row aggregate. The seven established-
  history rows are descriptive, not a stable optimization target.


## Immediate next task

Let the two running 1.885x seed-43 capacity/LR treatments finish, preserving the
epoch-43 baseline-LR snapshot, then run the already queued fixed-curriculum
standard-capacity seed-43 control. Compare terminal checkpoints on the frozen
validation contract; a capacity recipe must clear sparse history and then repeat
across seeds before it can close V9.5. Do not use the inspected early-2026 cohort
to choose among checkpoints.

### 2026-07-16 — V9.5 qualification reports and early-2026 reference

- `npm run report:v95-parity` now applies the predeclared Milestone 1 gates to
  any set of completed model cards. The committed seed-42/43 report currently
  **fails only the sparse-history guardrail for both seeds**: aggregate recap,
  total, coverage, established/zero history, composite, and two-seed mean gates
  pass. This is the concrete remaining reconstruction blocker; do not describe
  Milestone 1 as complete until it is resolved or explicitly rebaselined.
- `replayFinal2Baseline.ts` now supports arbitrary checkpoints plus a separate
  season/evaluation database and identity-agnostic inference. Its original final2
  mode still passes all 167 exact replay checks. For current 2026 maps, agnostic
  mode disables corps/judge/show residual paths rather than feeding semantically
  incompatible integer IDs.
- The early-2026 cohort is now frozen by row identity hash
  `76f068d17180be594608d1fffabe778f35c3cc8119ed4422c1600c0c6c41dd1e`:
  153 rows, 25 shows, 2026-06-27 through 2026-07-14. Final2 establishes the
  agnostic reference at `0.4930` recap and `1.5141` total MAE. Replica seed 42
  improves both (`0.4692`/`1.4378`), while seed 43 is mixed/worse
  (`0.5034`/`1.8061`), confirming material seed variance. The full tables live in
  `docs/V95_2026_COMPARISON.md`.
- These 2026 results are never checkpoint selectors. Now that they have been
  inspected, this cohort is development validation; later 2026 shows are the next
  untouched rolling test. Before final claims, audit all stored 2026 features for
  strict as-of correctness and add show/date-grouped uncertainty intervals.

### 2026-07-16 — first scale checkpoint to cross final2 composite

- The 1.885x-capacity, original-learning-rate (`0.00075`) seed-43 run produced a
  frozen-validation composite checkpoint at epoch 43 with composite `0.498524`,
  recap MAE `0.349484`, and total MAE `0.899568`. This is the first current V9.5
  candidate below final2's historical composite `0.502568`; it is provisional
  until the run terminates and all history slices are replayed. The checkpoint was
  copied to `snapshot_epoch_43_composite` so later improvements cannot overwrite
  the evidence.
- The paired 1.885x low-LR (`0.00055`) best-composite checkpoint and the preserved
  original-LR epoch-43 checkpoint were evaluated on the frozen early-2026 cohort.
  Both improve final2's identity-agnostic aggregate (`0.4930` recap / `1.5141`
  total): low LR reaches `0.4588` / `1.4974`, and original LR reaches `0.4572` /
  `1.4788`. The original-LR snapshot also improves zero-history and established-
  history totals versus final2, while sparse total is slightly better and short-
  history total is worse. See `docs/V95_2026_COMPARISON.md` for all slices.
- This supports the user's learning-rate hypothesis: added capacity did not need
  the lowered peak LR to become competitive, and the original LR currently has
  the stronger frozen composite and 2026 aggregate. It does not yet isolate
  capacity from optimization or establish a winner: wait for terminal results,
  compare the queued standard-capacity fixed-curriculum control, and repeat the
  selected recipe across seeds.

### 2026-07-16 — same-parameter V9.5 improvement lane

- Keep a distinct optimization lane at final2's exact `1,048,639` trainable
  parameters. Standard seed 43 already reached frozen-validation composite
  `0.500202`, nominally better than final2's `0.502568`, but it did not qualify as
  parity because sparse-history total MAE remained above the predeclared ceiling.
  The objective is therefore not merely a lower aggregate; it is a repeatable
  composite improvement that also clears sparse history without sacrificing the
  durable zero/short/established-history behavior.
- The first treatment is already queued as `v95-fixed-seed43.service`: identical
  graph, frozen rows/maps, seed, `0.00075` peak LR, losses, masking, dropout ramps,
  checkpoint rules, and sample budget, with only auto curriculum replaced by
  fixed A/B boundaries at epochs `10/40`. This tests whether seed-dependent early
  transitions caused the sparse regression. If it wins, repeat the same treatment
  with seed 42 before changing another knob.
- If fixed boundaries do not qualify, retain the same graph and test one change at
  a time: first a phase-aware LR schedule that holds the peak through the A→B
  sequence-length transition and decays after phase-B stabilization; second,
  checkpoint/SWA weight averaging using the same inference graph. Do not combine
  these treatments initially. Preserve composite selection as the primary rule,
  report every history slice, and require multi-seed plus later-2026 confirmation.
- Cleaned/merged/alias-corrected data can improve a model with the same parameter
  count, but that is the V10 clean-data control, not frozen-data V9.5 parity. Keep
  it separate so optimization gains are not incorrectly attributed to cleanup.

#### Prioritized extensions if the fixed-boundary control is insufficient

1. **Smooth the A→B optimization shock.** Keep the exact graph and losses, but
   compare the current abrupt 5→15-step switch with a short deterministic mix/ramp
   of 5/10/15-step batches. Pair this with the separately tested phase-aware LR
   hold or brief re-warm, never both in the first run. The recovered logs identify
   this boundary as the largest repeatable instability.
2. **Average nearby good solutions without enlarging inference.** After each run,
   evaluate a small predeclared soup/EMA of the best adjacent composite
   checkpoints. Weight averaging still exports one graph with `1,048,639`
   parameters. It is distinct from deploying an ensemble. Historical SWA was weak,
   so ordinary composite selection remains the control and averaging must win
   paired seeds and history slices.
3. **Match augmentation to evidence regimes.** Cross final2's history hiding with
   its nonzero identity-dropout floor using paired seeds, then stratify masks to
   resemble zero/sparse/short-history and missing-panel serving cases. Do not tune
   against the nine frozen sparse validation rows themselves. The treatment must
   improve held-out history buckets and early-2026 behavior, not just the selector.
4. **Gate identity residuals by evidence, with no new learned weights.** Use current-
   season history depth, known/unknown panel state, and frozen-map support to scale
   existing corps/judge residual paths deterministically. Train under the same
   gating distribution. This retains the graph's parameter count while reducing
   brittle identity memorization for season debuts and sparse histories.
5. **Use robust group-aware training, not lucky seed selection.** Test bounded
   reweighting or sampling across history depth, division, and caption groups, with
   the global composite still primary. Prefer fixed predeclared weights or a
   training-only worst-group objective; require that aggregate recap/total and
   established history do not regress. Retest the archived MB/MP `1.4` emphasis
   only inside this modern slice report.
6. **Distill capacity back into the same-size student.** If the 1.885x model proves
   a repeatable teacher, generate out-of-fold/cross-fitted soft targets and train
   the exact final2-sized graph on a blend of actual labels and teacher outputs.
   The deployed student remains `1,048,639` parameters. Never use in-sample teacher
   predictions without cross-fitting, and compare against a same-seed student on
   identical real labels to measure the distillation contribution.
7. **Calibrate uncertainty after mean-model selection.** History-conditioned or
   conformal interval calibration adds no neural parameters and may improve honest
   coverage/width, but it cannot count as a recap/total MAE gain. Freeze the mean
   checkpoint first and report calibration separately.

#### Same-size experiment queue started 2026-07-16

- The fixed-boundary control remains first and is already waiting for the two
  capacity jobs. Two independent seed-43 treatments are implemented behind it:
  `npm run train:v95:phase-aware-lr -- 43` holds the `0.00075` peak through fixed
  phase B and begins cosine decay at epoch 40; `npm run
  train:v95:smooth-sequence -- 43` keeps the control cosine LR but inserts four
  epochs of 10-step history between the 5-step and 15-step regimes. Both preserve
  the exact `1,048,639`-parameter graph, frozen final2 rows/maps, fixed `10/40`
  phase boundaries, losses, masking, sample budget, and checkpoint policy.
- Run these sequentially, not concurrently, and compare each directly with the
  fixed-boundary control. The phase-aware LR treatment changes only LR shape; the
  smooth-sequence treatment changes only sequence exposure. Do not combine them
  unless one independently qualifies and repeats across seed 42.
- At the user's direction, the fixed-boundary control was released to run alongside
  the two capacity jobs at 2026-07-16 11:04 EDT. It reached epoch 0 with the exact
  graph and contract; initialization peaked near 4.4 GiB while WSL retained about
  8.4 GiB available and used no swap. `v95-phase-aware-lr-seed43.service` and
  `v95-smooth-sequence-seed43.service` remain sequential waiters. Do not release
  both while the capacity jobs are active: their initialization peaks can overlap.

#### Model-local training source snapshots

- Every new V9.5 run now creates `training-source/` inside its run/model directory
  immediately after the directory is created, before the first epoch. It contains
  the exact trainer and helper sources, V9.5 launch scripts, package/TypeScript
  manifests, reference curves, and frozen identity maps. `provenance.json` records
  the Git commit, dirty-worktree state, launch arguments, runtime, and a SHA-256 for
  every copied file. `training-args.json` is also written at run start rather than
  only after successful completion, so interrupted runs retain their contract.
- `npm run snapshot:v95-training-source -- <run-dir> --git-ref <commit>` backfills
  an older artifact from its historical commit without substituting current code.
  Snapshots were added to replica seeds 42/43 (`1b89aa9`), scale LR `0.00055`
  (`02b9415`), scale LR `0.00075` (`50f6aed`), and the active fixed-curriculum run
  (`aabeb52`). These model directories remain ignored artifacts and are not added
  to Git; the snapshot travels with the model wherever the run directory is copied.

#### Live ablation status at 2026-07-16 11:15 EDT

- The 1.885x low-LR run reached epoch 99. Its best composite improved again at
  epoch 61 to `0.4999` (`0.3490` recap / `0.9115` total), and its best recap
  reached `0.3466` at epoch 97. The latter is not automatically the production
  winner because its total/composite tradeoff must be replayed.
- The 1.885x original-LR run reached epoch 68. Its preserved epoch-43 composite
  remains best at `0.498524` (`0.3495` recap / `0.8996` total); twelve epochs
  without monitor improvement reduced its plateau multiplier again. It still has
  the strongest composite, but the low-LR run has nearly closed the gap and now
  has the better single recap checkpoint.
- The exact-size fixed-boundary run reached epoch 6 in phase A with `0.4462` recap,
  `1.3720` total, and composite `0.6587`. The original same-size seed-43 run at
  epoch 6 reported `0.5145` recap and `1.8287` total, so the fixed treatment has a
  strong early lead consistent with avoiding a premature auto transition. This is
  not yet a selection result; compare after the fixed epoch-10 A→B boundary and
  through phases B/C.
- All three trainers remain healthy. WSL had roughly 8.2 GiB available and no swap
  use; the phase-aware-LR and smooth-sequence services remain idle sequential
  waiters.

#### Live ablation status at 2026-07-16 11:45 EDT

- The 1.885x low-LR run completed normally after early stopping at epoch 101 and
  selected its epoch-61 composite checkpoint. Terminal validation is `0.3505`
  recap, `0.9257` total, calibrated coverage `0.8237`, composite `0.499940`, and
  history totals `1.7425` zero / `1.5765` sparse / `1.2189` short / `0.8381`
  established. It **passes every predeclared single-run V9.5 parity gate**, and
  test-all is `0.3049` recap / `0.6916` total. Milestone 1 still fails globally
  until a second seed confirms the treatment; this is a qualifying candidate,
  not a completed multi-seed result.
- The 1.885x original-LR run is at epoch 88 without improving its preserved
  epoch-43 composite `0.498524`. The fixed-boundary same-size treatment is at
  epoch 28 in phase B; its current best composite is `0.5173` at epoch 26
  (`0.3516` recap / `1.0153` total). It remains promising but has not yet reached
  the fixed epoch-40 phase-C transition.
- With the low-LR run exited, WSL has roughly 9.9 GiB available and no swap use.
  The phase-aware-LR and smooth-sequence treatments remain correctly queued behind
  the fixed control.

- After the low-LR capacity run exited, the freed slot was assigned to
  `v95-phase-aware-lr-seed43.service` at 11:48 EDT. It reached epoch 0 with the
  exact `1,048,639`-parameter graph, fixed `10/40` curriculum, phase-aware LR, and
  a verified model-local training-source snapshot. WSL retained about 8.5 GiB
  available with no swap use. The smooth-sequence treatment remains the sole
  queued waiter and should take the next freed slot.

#### Live ablation status at 2026-07-16 12:02 EDT

- The 1.885x original-LR run completed and selected its preserved epoch-43
  composite checkpoint: composite `0.498524`, terminal validation `0.3580` recap /
  `0.9213` total, calibrated coverage `0.8220`, and history totals `2.0453` zero /
  `2.1227` sparse / `1.0632` short / `0.8327` established. It passes every
  single-run gate, but sparse history clears the `2.1382` ceiling by only `0.0155`;
  the completed low-LR treatment is much more robust on sparse history (`1.5765`).
  Original LR has the better composite and test total (`0.6294`), while low LR has
  better terminal validation/test recap (`0.3505`/`0.3049` versus
  `0.3580`/`0.3315`). Neither treatment is confirmed until repeated across seeds.
- The fixed-boundary same-size run crossed into phase C at epoch 40 and initially
  regressed (`0.3982` recap / `1.1798` total); its best production composite remains
  epoch 26 at `0.5173`. The phase-aware-LR run reached epoch 9, with an early best
  composite `0.6778` at epoch 8; phase-A volatility makes this non-comparable yet.
- The second capacity run freed another slot, so the smooth-sequence treatment was
  released at 12:01 EDT. Fixed-boundary, phase-aware LR, and smooth-sequence are now
  the three active exact-size jobs. WSL retained about 9.5 GiB available and no
  swap use at startup.

#### Large-model learning-rate follow-up

- The endpoint results justify testing a midpoint peak LR around `0.00065`, not
  declaring that value optimal. `0.00075` has the better composite/test total,
  while `0.00055` has better validation/test recap and a much stronger sparse-
  history margin. A midpoint is therefore a plausible Pareto improvement.
- LR changed the learned curriculum trajectory as well as optimizer step size:
  the low-LR run entered phase C at epoch 39, versus epoch 32 for original LR.
  Consequently, an auto-curriculum midpoint run is a useful pragmatic candidate
  but does not isolate LR. The clean scientific comparison is `0.00055` /
  `0.00065` / `0.00075` under the same fixed `10/40` boundaries, paired seed and
  sample contract. Do not transfer this conclusion to the exact-size graph until
  its running fixed/phase-aware treatments finish.

#### Live exact-size status at 2026-07-16 12:24 EDT

- Fixed curriculum recovered after the phase-C shock and improved its composite to
  `0.5044` at epoch 54 (`0.3494` recap / `0.9438` total), nearly matching final2
  `0.5026` but not surpassing the completed standard seed-43 `0.5002` result yet.
- Phase-aware LR reached epoch 26 with best composite `0.5814` at epoch 25
  (`0.3868` recap / `1.2057` total). Smooth sequence reached epoch 16 with best
  composite `0.5830` at epoch 15 (`0.3946` / `1.1760`). Their quality is similar,
  but the smooth transition reached it in ten fewer epochs, an early sample-
  efficiency signal rather than a terminal win.
- All three jobs remain healthy with about 8.7 GiB available and no swap use.

- By 12:41 EDT, fixed curriculum improved at epoch 59 to composite `0.5006`
  (`0.3462` recap / `0.9359` total), crossing final2's historical `0.5026` and
  nearly tying standard seed 43 `0.5002`. Phase-aware LR reached best composite
  `0.5125` at epoch 32 (`0.3531` / `0.9706`), while smooth sequence reached
  `0.5178` at epoch 25 (`0.3590` / `0.9688`). Smooth remains more sample-efficient,
  but phase-aware currently leads it in absolute composite. Terminal history slices
  and multi-seed repeatability remain decisive.

- By 13:13 EDT, fixed curriculum remained best at `0.5006` through epoch 95.
  Phase-aware LR improved sharply after phase-C decay began, reaching composite
  `0.5034` at epoch 59 (`0.3533` recap / `0.9063` total), now nearly matching
  final2. Smooth sequence retained composite `0.5081` but found a stronger
  best-total checkpoint of `0.8943` at epoch 50. This suggests phase-aware decay
  improves the balanced objective, while smoothing may favor total accuracy; wait
  for terminal selected checkpoints and history slices before combining them.

#### V10 implementation start (2026-07-16)

- V10 is now a separate, canonical training line rather than a rename of the old
  pre-V9 `trainModelV10.ts`. `trainModelV10Final.ts` reuses the verified V9.5
  engine while pinning the first evidence-backed candidate: the 1.885x graph
  (`192/96` BiLSTM, `768/384` dense, `405` accuracy trunk; expected `1,976,938`
  trainable parameters), midpoint peak LR `0.00065`, fixed `10/40` curriculum,
  four-epoch sequence-length transition, and phase-aware LR. This combination is
  a candidate assembled from the ablations, not yet a proven winner; preserve
  component controls so attribution is not lost.
- The trainer now records explicit model-version, parent, data-contract,
  feature-profile, and ML-table lineage in its model card. Every V10 run also
  inherits the model-local source snapshot/provenance behavior. The original V9.5
  defaults and the archaeological pre-V9 V10 file remain untouched.
- V10 has a dedicated clean-data query and target table
  (`ml_sequence_rows_v10_clean_control`); reserve
  `ml_sequence_rows_v10_final` for the later feature-bearing build. Its source is the canonical
  `clean_reference_curve_entries` view, which resolves domain aliases, filters
  excluded events and non-model divisions, enforces caption bounds and complete
  eight-caption recaps, reconciles caption and official totals within `0.05`, and
  recomputes field ranks. This is deliberately separate from V9's raw
  `caption_scores` query so a data-only control remains possible.
- The first executable contract check passed against the current relational DB for
  2025 World Class: `375` clean performances expanded to exactly `3,000` caption
  rows, with all eight canonical captions and valid overall/caption ranks on every
  performance. The underlying clean view contains `523` eligible 2025
  performances across both model divisions (`4,184` long caption rows). Use
  `npm run test:v10-data` before materializing and `npm run build:v10-data-control` to
  populate the isolated table.
- Important attribution order: materialize and hash the clean table; train a
  clean-data-only exact-feature control; then add evidence/pace/identity/panel
  features; then run the combined scaled optimizer candidate. Do not interpret a
  combined V10 gain as a scaling result unless these controls are retained.
- **Do not train the first clean-table attempt.** The 2026-07-16 materialization
  completed successfully but produced only `1,485` rows across 2013–2025 versus
  final2's `7,321`: 2017 disappeared entirely and early seasons fell from roughly
  600–800 rows each to single/double digits. The reference-curve view is therefore
  too restrictive or incomplete as a drop-in model-training population even
  though its individual rows pass the clean-panel contract. Audit every exclusion
  by season/source and build a purpose-built V10 training view that preserves
  legitimate historical coverage; do not mistake drastic population attrition for
  cleanup.
- The same attempt also demonstrated why the mutable Windows
  `dci-relational.db` cannot itself be the versioned experiment artifact. Shortly
  after the successful build and inspection, the DB file was replaced/updated and
  the newly created table was no longer present. Copy/snapshot the source DB to a
  stable experiment path first, record its SHA-256 and cutoff, build there, and
  hash/export the resulting row manifest before training.
- Follow-up against the completed immutable snapshot corrected the initial
  attrition diagnosis: the canonical clean view contains `7,317` legitimate
  2013–2025 rows with normal coverage in every modeled season. The earlier
  `1,485` result came from the mutable DB changing underneath the build, not from
  the view's domain rules. Final2's extra four rows are duplicate 2019 Encorps
  performances stored under both GUID `0010a00001itge1aah` and canonical key
  `encorps`; the current source retains the four canonical copies. The source
  snapshot is 5,221,109,760 bytes, SHA-256
  `5c7cd0807e1c05896f42ef7aedd8a2c8edd3bcd988739a21f45e2b1be5df3bcb`,
  passes `quick_check`, and is pinned by
  `baselines/v10-source-2026-07-16.json`. Build derived V10 tables in a separate
  DB so this source hash remains immutable.
- Correction to the initial scaffold interpretation: the scaled `0.00065`
  phase-aware + smooth-sequence profile is only a future combined candidate.
  The plan explicitly requires phase-aware LR and smooth sequence exposure to
  qualify independently (and repeat across seeds) before combining them. The
  clean-data control must use the V9.5/final2 core graph and regimen with newly
  matched maps; it must not use the scaled combined defaults. Per the 2026-07-16
  identity decision below, V10 does not retain final2's unrelated global-map
  embedding cardinalities, so total parameter count is not exactly identical.

#### V9.5 fixed-boundary terminal result and V10 profile correction

- The exact-size fixed-boundary seed-43 run completed and selected composite
  `0.500568`. Its terminal validation is `0.348322` recap / `0.950032` total;
  history totals are `2.121598` zero / `1.688805` sparse / `1.171453` short /
  `0.861644` established; calibrated coverage is `0.815771`; test-all is
  `0.277327` recap / `0.628097` total. It clears every predeclared single-run
  V9.5 gate, including the sparse-history ceiling that blocked the two automatic
  replicas. Seed 42 fixed-boundary confirmation started as
  `v95-fixed-curriculum-seed42.service`; Milestone 1 remains open until that
  paired result completes and qualifies.
- `v10Config.ts` now exposes seven isolated, named experiment profiles:
  clean-data control, field pace, thin history, scaled control, phase-aware LR,
  smooth sequence, and combined candidate. There is no implicit V10 default.
  Every profile is intentionally non-runnable until the stable data snapshot,
  audited view, matched maps/curves, and row manifest qualify; the combined
  candidate has the stronger additional requirement that its components qualify
  independently. `npm run test:v10-config` pins these boundaries.
- The phase-aware-LR seed-43 treatment completed with composite `0.497535`,
  validation `0.344611` recap / `0.938384` total, history totals `2.462580`
  zero / `2.137414` sparse / `1.122280` short / `0.832605` established,
  calibrated coverage `0.819559`, and test-all `0.306316` recap / `0.612724`
  total. It clears every single-run gate, although sparse history clears by only
  `0.000826`; seed-42 confirmation is mandatory and has been started.
- The source-freezing path is now reproducible via `npm run freeze:v10-source`.
  `npm run prepare:v10-data` verifies that source hash, creates a compact derived
  database rather than duplicating the 5.2 GB source, materializes the versioned
  `v10_training_performances` table, and emits row/hash/invariant provenance. Its
  7,317 rows have identity hash
  `96b4d40541f7c927bbe6a68740ee766916f027ff75916bcb8417c6531bbba37d`,
  zero incomplete panels/total mismatches/invalid ranks, 55 corps identities, and
  864 shows. The contract is pinned by
  `baselines/v10-training-performances-dev1.json`.
- Operational lesson: creating a second full 5.2 GB DB exhausted the host C:
  drive and stopped WSL. This interrupted fixed seed 42 and smooth seed 43 before
  terminal cards; both were restarted as new runs, and phase-aware seed 42 was
  started. Keep the immutable source once, materialize compact derived tables,
  and monitor host-disk—not only Linux `df`—before large artifacts.
- Dataset-matched V10 artifact generation now lives in
  `scripts/generateV10Artifacts.ts`. The `dev1` set is pinned to the source and
  7,317-row contract and contains 55 known corps, 213 known judges, 300 agnostic
  show identities, 25 reviewed corps aliases, and a complete 525-cell clean
  reference curve. Every identity map reserves `unknown=0`, assigns sorted known
  identities to contiguous `1..N`, and therefore sizes embeddings as
  `max(index)+1`. The builder selects these files only under `clean-v10`; V9 keeps
  its global files unchanged.
- The shared `v10FeatureSchema.ts` now declares the clean-control feature names,
  blocks, normalization rules, availability regimes, and dimensions (`101`
  sequence, `212` raw static, `8` derived trend, `220` total static). This is the
  clean-control schema, not yet the field-pace/thin-history final schema.
- Integration testing with the matched maps/curves exposed the next qualification
  blocker clearly: the recovered builder still loads legacy
  `corps_historical_features_v6`, `show_aggregates_v7`, and precomputed V9 Elo
  histories from the source snapshot. Its clean local show aggregates cover the
  tested rows, but the legacy historical/Elo fallbacks make the resulting table
  unqualified. Rebuild these from the V10 row contract, fail instead of falling
  back, and make reference-curve/range lookups target-date-as-of before training
  the clean-data control.
- The temporal rebuild now resolves that blocker. `prepare:v10-temporal`
  materializes 58,536 row/caption cells, 7,317 row-specific corps histories, and
  10,600 judge/show/caption states using a strict date-before-target boundary;
  all shows on one date are snapshotted before any same-date update. The full
  builder then produced all 7,317 clean rows at `15×101` sequence, `212` raw
  static, and eight judge slots. `test:v10-temporal` and
  `test:v10-sequences` verify dimensions, target/residual/reference parity,
  corps-Elo parity, identity maps, first-observation neutrality, and prior-season
  dates. The sequence payload hash is
  `b2a4d2c4505c1780497371d9a28e14c05b7b3e290709e079a3532e34f79d008d`.
- Do not drop a clean score row merely because its historical panel contains an
  unknown judge. Final2 assigned source placeholders ordinary learned IDs; V10
  instead retains all 7,317 performances and encodes the 489 affected rows with
  explicit judge ID `0`. Later evidence features/gating must distinguish this
  observed-unknown state from augmentation-hidden identity.
- **User decision, 2026-07-16 — let cleaned data define V10 embeddings.** Do not
  preserve final2's 245/709/349 global-map cardinalities and do not invent
  reserved identities. V10 uses compact maps derived from the clean snapshot:
  214 judge inputs, 56 corps inputs, and 301 agnostic-show inputs, each including
  `unknown=0` and sized exactly as `max(index)+1`. The clean control keeps the
  same recurrent/dense core and training regimen, but its expected total is
  `1,034,259` parameters rather than `1,048,639`; this deliberate identity/data
  improvement must be called out when attributing the control result.
- `identitySupport.json` records clean-snapshot appearance/show/season/date and
  panel support for every mapped corps, judge, and agnostic show, plus reviewed
  corps-alias resolution. It is the vocabulary audit and packaged provenance,
  not permission to expose lifetime counts to historical rows. Training must
  reconstruct support strictly before each target date for deterministic
  low-support identity-residual gating and support-aware dropout; a known but
  one-show identity must not receive the same trust as a deeply observed one.
- **Data-native embedding contract (V10 invariant).** Fresh map cardinalities are
  only the first step. Canonicalize reviewed aliases before assigning IDs, train
  every corps/judge/show embedding from scratch only on temporally valid rows in
  the clean V10 contract, and never import final2 embedding weights. Use the
  cleaned support metadata to set identity dropout/unknown substitution and to
  gate low-support residuals, so rare identities cannot be memorized as if they
  were well established. Evaluate known, unknown, low-support, and hidden-
  identity slices separately. Package the exact maps, alias policy, support
  metadata, and augmentation settings with the model so inference reconstructs
  the same identity semantics. A candidate does not qualify as full V10 merely
  because it has newly sized embedding tables; it must actually use the repaired
  identities and evidence regimes during training.
- The foreground `v10_clean_smoke_tiny` run completed the entire trainer and
  packaging path against the 7,317-row clean contract. It built the intended
  `1,034,259`-parameter graph with V10's `214/56/301` identity inputs and wrote
  the selected map, curve, schema, support, sequence-manifest, and source hashes
  into its model-local snapshot. Its 64-row/one-epoch metrics are deliberately
  non-qualifying; this proves wiring and provenance, not model quality.
- **V9.5 gate closure, 2026-07-17.** The completed fixed-curriculum seed-42 run
  scored `0.3607` recap / `0.9818` total / `0.498921` composite, with `3.2940`
  zero-history, `2.2660` sparse-history, and calibrated coverage `0.8258`.
  Paired with seed 43, the treatment passes every main per-seed bound and the
  two-seed recap/total means are `0.3545`/`0.9659`. The sole individual miss is
  seed 42 on the nine-row sparse slice; its paired mean is `1.9774`, only `0.1392`
  above deployed final2 and substantially better than the reconstructed-replica
  mean. Because this same tiny slice swings `0.5772` between seeds, its stability
  gate is explicitly rebaselined to the predeclared threshold on the pooled
  two-seed mean, while all larger/core and zero-history gates remain per-seed.
  `V95_FIXED_CURRICULUM_QUALIFICATION_REPORT.md` records the executable policy.
  This closes the reconstruction prerequisite and unblocks the clean-data V10
  control; it does not claim that fixed curriculum itself beats final2.
- **Field-pace P1 implementation, 2026-07-17.** The independent field-pace
  contract now adds four division-aware static features to the clean rows: field
  level versus the clean reference total, a confidence-shrunk residual slope,
  residual EMA, and evidence confidence. Every snapshot is computed from shows
  strictly before the target date, freezes all corps in a division/date to one
  value, uses a top-25 core, and shrinks early slopes toward earlier-season
  division behavior. The temporal table retains prior observation/corps/date
  counts and `max_source_date` for leakage audits. On the isolated
  `v10-field-dev1.db`, all 7,317 rows pass same-date, first-date, dimensional,
  provenance, builder-parity, and strict-date tests. The profile is `216` raw /
  `224` total static features and its graph smoke produced exactly `1,037,451`
  trainable parameters. This proves the ablation is runnable after the clean
  control qualifies; its one-epoch smoke metrics are not quality evidence.
- **Thin-history P2/P3 implementation, 2026-07-17.** The independent treatment
  now uses the same clean 220-input graph and changes only the training/evidence
  regimen: show-grouped sampling targets a 45% thin-history share, 25% of rows
  with four-plus observations are truncated to one-to-three recent observations,
  and the trainer masks/recomputes recency-derived static state while retaining
  prior-season rank/fingerprint evidence. For actual or augmented show 1/2/3,
  the baseline blends the prior-season curve/fingerprint anchor at
  `.50/.30/.15`; the same deterministic blend is used in validation/evaluation.
  Epoch logs record sampled, truncated, and blended counts, and model cards store
  the treatment settings. Unit tests pin the blend and masking behavior, the
  V10 profile remains a `1,034,259`-parameter ablation, and a complete one-epoch
  graph/package smoke passed. Full training remains blocked until the clean-data
  control supplies the comparison baseline.
- **Support-aware data-native identities, 2026-07-17.** The independent identity
  treatment keeps the clean control's `1,034,259`-parameter graph, fresh
  `214/56/301` embedding tables, and sole `unknown=0` fallback. For every target
  row it now reconstructs corps, judge, and agnostic-show observations and season
  support strictly before the target date, freezing every performance on one
  date before updating state. Low-support identities receive stronger unknown
  substitution; corps and judge residual branches are also deterministically
  gated by their as-of evidence. The lifetime `identitySupport.json` is loaded
  to validate/package the clean vocabulary but is not used as a historical
  feature, preventing future appearances from leaking into validation. Tests pin
  same-date freezing, unseen identity behavior, and invariance of earlier trust
  when a future season is appended. A 64-row/one-epoch graph/package smoke passed
  at exactly `1,034,259` parameters and emitted corps/judge/show trust
  diagnostics (the early chronological smoke rows correctly had zero prior show
  support). Its metrics are wiring evidence only; full comparison remains
  blocked until the clean-data control completes and qualifies.
- **Identity evidence evaluation contract, 2026-07-17.** Uniform sliced
  evaluation now reports corps, judge-panel, and agnostic-show availability as
  `known`, `source_unknown`, `augmentation_hidden`, `explicitly_hidden`, or
  `explicitly_hidden_source_unknown`; absence in the clean source is therefore
  no longer conflated with a training mask. The same reports bucket each
  identity type by target-date-as-of support (`no_prior_support`, `low_support`,
  `medium_support`, and `established_support`) whether or not the model uses
  support gating, preserving a fair
  control-versus-treatment comparison. A full graph/package smoke verified all
  six model-card views and the explicit panel-hidden mode. Apply this evaluator
  uniformly to retained clean-control and treatment checkpoints; old cards that
  predate these views are not sufficient evidence by themselves.
- **Bounded checkpoint frontier, 2026-07-17.** V10 profiles now preserve at most
  eight nondominated checkpoints across recap MAE, total MAE, zero-history MAE,
  sparse-history MAE, established-history MAE, distance from the declared
  coverage band, and interval width. When more candidates survive, the
  predeclared selector
  `recap+.15total+.10zero+.10sparse+.05established+.20coverage_gap+.02width`
  deterministically retains objective winners and fills the remaining slots.
  Dominated/pruned directories are removed, while every retained checkpoint
  carries its full metric vector and selector score. A graph/package smoke wrote
  `pareto/epoch_0` and the matching model-card manifest.
- **Uniform frontier evaluation, 2026-07-17.** After training, the trainer now
  reloads every retained Pareto checkpoint, independently calibrates its
  intervals on the same validation cohort, and runs the identical named matrix
  including identity/support slices. Each checkpoint receives a local
  `uniform-evaluation.json`; the model card records completion, selector score,
  and the deterministic recommended epoch. Production weights are cloned and
  restored in a `finally` path so auditing cannot silently replace the selected
  model. A one-checkpoint graph/package smoke completed with
  `uniformly_evaluated=true` and a valid recommendation. Recommendation is not
  automatic promotion: the final V10 candidate still must pass the frozen-2025,
  walk-forward-2026, cross-seed, sparse-history, and uncertainty gates before
  the recommended frontier checkpoint becomes the packaged production model.
- **Evidence-regime uncertainty comparison, 2026-07-17.** The selected mean
  model now reports the legacy validation-grid interval scale beside a
  finite-sample split-conformal symmetric scale. Nonconformity is the observed
  error divided by the appropriate lower/upper predicted half-width, and the
  quantile uses the finite-sample `ceil((n+1)×coverage)` rank. The report also
  fits and evaluates separate history-depth and division scales; buckets with
  fewer than 64 caption observations explicitly fall back to the pooled scale.
  Every method records scale, rows/caption values, achieved coverage, and width
  in test results and the model card. The one-epoch smoke reached the requested
  marginal coverage only by expanding an untrained model to an enormous width,
  which is correct diagnostic behavior and not quality evidence. Select the
  uncertainty policy only after trained candidates are compared on both
  coverage and width across zero/sparse/established history and division slices.
- **Clean data is the embedding/training intervention, not merely an input-table
  replacement (user reaffirmed 2026-07-17).** V10 must derive canonical identity
  vocabulary, aliases, support counts, temporal examples, dropout/unknown
  substitution, residual trust, and every embedding weight from the repaired
  database contract. It must not copy final2's embedding weights, positional
  meanings, map capacity, or placeholder identities. Index `0` is the sole
  operational fallback for a genuinely absent/hidden/unseen identity at
  inference or augmentation time; it is not a legacy final2 identity and does
  not consume model capacity for hypothetical future entities. The purpose of
  the clean-data control is to measure this whole data/identity repair while
  holding the recurrent/dense core and regimen steady.
- **Frozen 2026 evaluation data, 2026-07-17.** A second immutable relational
  snapshot through July 16 is pinned at 5,227,692,032 bytes and SHA-256
  `13ed3628cc309a145ee46827c27608298f5359d522336263330edb33ca58768a`.
  Its evaluation contract contains the unchanged, hash-identical 7,317-row
  2013–2025 training population plus 161 clean 2026 rows across 26 shows. The
  July-14 development cohort has 153 rows/25 shows; the later July-16 show is an
  untouched eight-row gate. Clean sequences use the frozen V10 training maps,
  not newly refit 2026 maps: two rows have unseen corps, six have unseen show
  identities, and all 161 have unavailable judge panels and therefore explicit
  unknown judge slots. Dimensions, targets, temporal as-of boundaries, history
  and field source dates, population hashes, and both cohort hashes are pinned
  by `test:v10-evaluation`. Do not train on these 2026 rows or regenerate the
  identity maps from them.

### 2026-07-17 — dev1 clean-control failure, dev2 identity-vocabulary repair

- **The first clean-data control run (seed 43, auto curriculum, dev1 maps) is
  invalid as a control.** Aggregate results looked plausible (validation recap
  `0.3749`, total `1.0164`, test total `0.5716`), but zero-history total MAE was
  `5.562`. Row-level replay (new `V95_ROW_DETAILS_PATH` dump in the trainer,
  driven through an `--epochs 0 --load-model` eval-only pass) showed the entire
  failure came from four rows: `calgary-round-up-band` and
  `high-school-affiliated-to-bit` at the 2025 OC championships, over-predicted
  by `+7` to `+15` points. The other four zero-history rows erred `<= 1.3`.
- **Root cause: evaluation-only identities received trained embedding IDs.**
  dev1 built identity maps from the full clean snapshot, so corps whose only
  appearances fall inside the date-forward validation window got real IDs whose
  embeddings never receive a gradient; inference reads random-init vectors on
  exactly the rows with no other evidence. Final2 predicted these same rows far
  better precisely because its frozen maps lacked these keys (they fell back to
  index 0). This is the literal instance of the recorded warning that a known
  but unsupported identity must not receive trust.
- **dev2 rule: the identity vocabulary is built only from rows strictly before
  the trainer's validation boundary** (`--vocab-cutoff 2025-07-15` on
  `generateV10Artifacts.ts`). Post-cutoff-only identities map to `unknown=0`.
  dev2 has 53 corps / 210 judges / 289 shows known (embedding inputs
  54/211/290, graph-verified `1,034,015` parameters). The clean-control table
  was rebuilt on dev2 maps (payload sha `f4c74350…`, six unknown-corps rows),
  the builder now reads `map_version` from the artifact manifest, and pinned
  config/sequence/identity tests were updated. Any future map regeneration must
  preserve this rule; V10 serving maps may include newer identities only when a
  matching retrain actually trains them.
- **The V10 family now trains under fixed `10/40` curriculum boundaries** — the
  regimen that closed the V9.5 qualification gate — instead of final2's auto
  curriculum. The dev1 control's auto run transitioned B→C at 39 via
  `delta_plateau`, so it also did not match the qualified baseline regimen.
  This is a deliberate config decision recorded in `v10Config.ts`; the auto
  regimen remains available for reference runs only.
- **The frozen 2026 evaluation DB was rebuilt on dev2 maps** from the
  hash-verified evaluation source snapshot. Only `unknown_show_rows` (6→11)
  and `max_show_id` changed; the sequence payload hash is unchanged because all
  161 rows already carried fully-unknown judge panels and map-dependent ID
  columns are outside the payload. Cohort identity hashes are untouched.
- **Operational: the immutable source snapshots are stored gzip-compressed**
  (`sdk/data/*.db.gz` in the WSL checkout) to reclaim disk; decompress and
  verify the pinned SHA-256 before any rebuild, and delete the decompressed
  copy afterward. tfjs-node has no Windows prebuilt binaries (all versions
  404), so WSL remains the only native training environment on this machine.
- dev2 clean-control replicas: seed 43 started 11:20 EDT and passed its fixed
  A→B boundary at epoch 10; seed 42 started concurrently at the user's
  direction (~10 GiB RAM headroom). Compare both against the V9.5
  fixed-curriculum pair on every history slice, and replay the eight
  zero-history validation rows row-by-row before declaring the repair
  successful.

### 2026-07-17 — second zero-history cause, dev3 division-aware curves

- **The identity-vocabulary repair (dev2) was necessary but not sufficient.**
  The early dev2 seed-43 replay (epoch-45 composite snapshot) still produced
  `+15` to `+18`-point errors on the same two first-ever-appearance corps at
  the 2025 OC championships. Baseline capture in the row dump identified the
  second, dominant cause: those rows carried an **all-zero baseline anchor**.
  A corps with no last recap, no prior season, and no fingerprint bottomed out
  the fallback chain at zeros, which the model has essentially never seen.
- **dev3 trainer fallback:** when the stored global baseline is all-zero, the
  sample anchors to the rank-curve forecast baseline (`buildForecastBaseline`,
  the same path masked-forecast augmentation uses). The other zero-history rows
  were already fine because the prior-season-comparable fallback works for any
  corps with earlier-season history.
- **dev3 data contract: the reference curve is division-keyed**
  (`division × rank(1-25) × percent-bucket(0-100 step 5) × caption`), built
  from both model divisions of the clean contract. The temporal as-of curve in
  `prepareV10TemporalFeatures.ts` uses nearest-same-division fallback with a
  large cross-division penalty; the artifact curve in `generateV10Artifacts.ts`
  emits 525 cells per division plus legacy unprefixed keys aliasing World
  Class (1,575 total). The builder's `getBaseline` already accepted
  division-prefixed keys and passes the row division. Rationale: OC rows were
  anchored to the WC curve at their own division rank, which at championship
  week sits 15–20 points above OC reality (calgary prelims caption-sum anchor
  dropped from `130.0` to `110.1` under dev3).
- **dev3 artifacts/DB:** `src/training/v10/dev3` (identity vocabulary and
  dimensions unchanged from dev2: 53/210/289 known, cutoff 2025-07-15) and the
  isolated `data/v10-training-dev3.db` (payload sha `eefd49d4…`, temporal
  identity sha `2b784a17…`), leaving the dev2 table intact for the in-flight
  training pair. Reference baselines, residual targets, and rank-baseline
  statics change for Open Class rows only.
- **Percent-bucket granularity decision (2026-07-17):** keep 5% buckets. At 1%
  each cell would average ~1.4 World Class rows and under one Open Class row —
  noise, not signal — while 5% ≈ 3.5 days matches show cadence and caps
  rounding error near 0.3 points. If that last margin matters, the planned
  improvement is **lookup-time linear interpolation between neighboring 5%
  buckets at exact percent-through** (statistical stability of coarse cells,
  precision of a fine grid), scheduled after the dev3 confirmation run so only
  one contract change lands at a time. A 2.5% World-Class-only grid is a
  possible middle option if clean OC coverage grows.
- The dev2 clean-control pair (seeds 42/43) continues training and remains the
  identity/curriculum control; dev3 requires its own confirmation run and
  attribution step once the pair completes.

### 2026-07-17 — dev2 seed-43 terminal card and queued suggestions

- **dev2 clean-control seed 43 completed** (fixed 10/40 boundaries fired
  exactly; composite `0.521731` selected at epoch 45, inside phase C).
  Terminal validation: `0.3711` recap / `1.0224` total; history totals
  `5.7868` zero / `1.5674` sparse / `1.1047` short / `0.8656` established;
  test-all `0.2973` / `0.7873`; calibrated scale `0.475` with test calibrated
  coverage `0.8462` at width `1.1360`. Sparse history is the best of any
  V9.5/V10 run so far; established is at parity with V9.5-fixed.
- **Interpretation: parity with a known, already-fixed defect attached.** The
  zero bucket is the dev2-era anchor bug (dev3 fixes it); those eight rows
  alone inflate validation total by roughly `+0.08`, putting the corrected
  equivalent near V9.5-fixed's `0.9500`. The division split makes the cause
  visible: World Class validation is strong (`0.3210` recap / `0.8457` total,
  265 rows) while Open Class is weak (`0.5067` / `1.5002`, 98 rows) —
  consistent with every OC row being anchored/normalized against World Class
  curve values in dev2. The dev3 division-aware contract is the direct test.
- **Seed variance is large and must gate claims.** Mid-run, dev2 seed 42's
  best composite (`0.5607` at epoch 49) trails seed 43's `0.5217`
  substantially. When the pair completes, record the terminal spread
  explicitly as the minimum detectable effect: any treatment gain smaller
  than the paired-seed spread is not a shippable result.
- **SWA decision (2026-07-17): do not adopt classic SWA.** It lost in the May
  archive, and the curriculum changes the objective mid-run, so a tail
  average mixes solutions to different problems. The variance-reduction idea
  survives in a constrained form: a small predeclared **soup/EMA of adjacent
  best-composite checkpoints within one phase**. Test it post hoc on already
  finished checkpoint families first (zero training cost); adopt only if it
  beats the selected checkpoint on frozen validation across both seeds.
- **Queued one-knob treatment: `--phase-b-total-weight`** (implemented,
  default `0` preserves the frozen regimen; blocked dev3 profile at `0.05`).
  Rationale: phase B trains with the total-score loss off while the
  production composite selector weights total MAE heavily; aligning the
  training objective with the selector is a minimal, predeclared change.
- **Phase C earned its keep under the fixed schedule with clean data**: the
  seed-43 composite improved from `0.5308` (epoch 36, phase B) to `0.5217`
  (epoch 45, phase C). The earlier suspicion that phase C only hurts was an
  auto-curriculum-era observation; keep phase C in the control regimen.
- **Post-run analysis worth doing once several dev3 runs exist**: compare the
  retained checkpoint frontiers across runs (phase/epoch of each nondominated
  checkpoint) to see whether specific regimes systematically win specific
  slices; that shapes any later selector change without new training.
- The 2026 evaluation contract was rebuilt on dev3 (division-aware baselines
  for its OC rows); only the sequence payload hash changed, cohort identity
  hashes untouched. dev3 confirmation runs (seeds 43 and 42) and the dev2
  seed-42 terminal are in flight concurrently.

### 2026-07-17 — post-hoc checkpoint-soup result (dev2 seed 43)

- A predeclared 50/50 weight average of the epoch-36 best_total (phase B) and
  epoch-45 best_composite (phase C) checkpoints was evaluated post hoc on the
  frozen dev2 validation. It beat the selected checkpoint on validation recap
  (0.3711 -> 0.3627), total (1.0224 -> 0.9734), established history
  (0.8656 -> 0.8391), zero history (5.787 -> 3.958), and test total
  (0.7873 -> 0.7664), while worsening only the unstable nine-row sparse slice
  (1.567 -> 1.986). Zero training cost; even a cross-phase pair averaged well.
- Consequence: add a small predeclared soup (best_total + best_composite, and
  optionally adjacent Pareto checkpoints) to the post-training uniform
  evaluation for every dev3 run. Selection still requires both-seed
  confirmation and the standard gates; classic tail-averaged SWA remains
  rejected. The soup lives beside, not instead of, the selected checkpoint.

### 2026-07-17 — dev2 clean-control pair complete: variance yardstick

- Both dev2 seeds finished under fixed 10/40 curriculum. seed 43 composite
  0.5217 (val recap 0.3711 / total 1.0224); seed 42 composite 0.5499 (0.3746 /
  1.1069). Two-seed means: recap 0.3729, total 1.0647, established 0.887.
- **Minimum detectable effect (paired-seed spread), to gate every future
  treatment claim:** recap 0.004 (tight — a >0.01 recap move is real), total
  0.085 (need >~0.09), established 0.041, World Class total 0.029. The tiny
  slices are noise floors and cannot select from a single pair: sparse spread
  0.90 (nine rows), zero spread 0.65 (eight rows, both carry the dev2 anchor
  defect). Any V10 gain smaller than the relevant spread is not shippable.
- Both seeds show the OC-vs-WC split the dev3 contract targets: World Class
  validation total ~0.86 vs Open Class ~1.6 (nearly 2x), driven by anchoring
  OC rows to World Class curve values. dev3s

### 2026-07-17 — dev2 clean-control pair complete: variance yardstick

- Both dev2 seeds finished under fixed 10/40 curriculum. seed 43 composite
  0.5217 (val recap 0.3711 / total 1.0224); seed 42 composite 0.5499 (0.3746 /
  1.1069). Two-seed means: recap 0.3729, total 1.0647, established 0.887.
- **Minimum detectable effect (paired-seed spread), to gate every future
  treatment claim:** recap 0.004 (tight — a >0.01 recap move is real), total
  0.085 (need >~0.09), established 0.041, World Class total 0.029. The tiny
  slices are noise floors and cannot select from a single pair: sparse spread
  0.90 (nine rows), zero spread 0.65 (eight rows, both carry the dev2 anchor
  defect). Any V10 gain smaller than the relevant spread is not shippable.
- Both seeds show the OC-vs-WC split the dev3 contract targets: World Class
  validation total ~0.86 vs Open Class ~1.6 (nearly 2x), driven by anchoring
  OC rows to World Class curve values. dev3's division-aware curves + zero
  anchor fallback are the direct fix; the dev3 pair is training now.
- **Checkpoint-soup caveat (both-seed check):** the best_total+best_composite
  soup only has diversity to average when those heads land at different epochs.
  seed 43 (total@36, composite@45) diverged and the soup helped; seed 42 had
  best_total==best_composite==epoch 68, so that specific soup is a no-op (safe
  but uninformative). A defensible soup must average genuinely distinct
  checkpoints (e.g. best_phase_b vs best_composite); adopt only the variant
  that helps or is neutral across both seeds on frozen validation.

### 2026-07-17 — checkpoint-soup both-seed confirmation

- seed 42 cross-phase soup (best_phase_b@34 + best_composite@68) vs its
  selected epoch-68 checkpoint: recap 0.3725 vs 0.3746, total 1.088 vs 1.107,
  zero 4.73 vs 6.44, sparse 2.21 vs 2.47 — all better — but established 0.945
  vs 0.907, worse by 0.038 (right at the 0.041 established MDE).
- Combined with seed 43 (soup helped recap/total/established/zero, hurt sparse):
  across both seeds the soup consistently improves recap, total, and
  zero-history; established and sparse are mixed within the noise floor. seed
  42 averaged checkpoints 34 epochs apart across the B->C boundary and still
  won the aggregate — weight averaging is robust in this regimen.
- Decision: adopt the soup as a post-training candidate evaluated alongside
  the selected checkpoint (never silently replacing it). Guardrail: because it
  nicked established on seed 42, the established-history non-inferiority margin
  must be checked per-seed before a soup can be the shipped checkpoint. Classic
  tail-averaged SWA remains rejected.

### 2026-07-17 — dev3 vs final2 on real 2026 walk-forward (preliminary)

**Headline:** on the 63 rows final2 actually forecast pre-show in production
(12 shows, leakage-guarded to predictions dated before each show), dev3's raw
model beats final2 as-deployed by 25%:

| model | total MAE | rows |
|---|---:|---:|
| final2 (production, with bias-correction + comparable-revert) | 2.041 | 63 |
| dev3 (preliminary epoch-64 checkpoint, raw, no corrections) | 1.533 | 63 |

dev3 wins 39/63 rows and wins every history bucket present:
zero-history 2.215 -> 1.662 (48 rows), sparse 1.417 -> 1.022 (9),
short 1.582 -> 1.268 (6). The matched set is zero-history-heavy because final2
forecast many debut corps at these shows — precisely where dev3's zero-anchor
+ division-aware-curve fixes apply.

On the full frozen 161-row 2026 cohort dev3 also edges final2 on recap
(0.472 vs 0.493) at near-parity total (1.544 vs 1.514).

**Load-bearing caveats — this is directional, not the shipping verdict:**
- dev3 is a non-terminal mid-training checkpoint (epoch-64 best_composite), one
  seed. Needs the terminal pair before any claim.
- 63 rows / 12 shows is a modest walk-forward sample.
- It is raw-dev3 vs corrected-final2; that framing favors "dev3 is strong" but
  a fully fair fight would also test dev3 + the correction layers.

**Harness note (important):** the replay's own baseline recompute does NOT
include dev3's zero-anchor curve fallback, so it initially scored zero-history
2026 rows at 12.4 total MAE (predicting ~48 for a corps that scored ~72 by
anchoring to a zero recent-form baseline). The correct division-aware curve
anchor is stored in the static block (indices 121-128, points/20). Added
`--curve-anchor-fallback` (off by default so final2's 167-check replay is
byte-identical) to use it for all-zero-baseline rows, matching the trainer.
Also added `--ml-table` (read V10 clean-contract table) and `--all-row-details`
(per-row dump for every bucket). Without the fallback the replay understates
any dev3-lineage model on thin-history cohorts.

### 2026-07-17 — next-step suggestions (post 2026 preliminary)

Ordered by leverage. The first two are about *trusting* the 2026 result before
building on it; both are cheap and do not need the terminal models.

1. **Audit the serving/inference path for the zero-anchor fix before trusting
   any 2026 result as shippable.** The zero-anchor curve fallback was added to
   the trainer (`buildSamples`) and the replay harness (`--curve-anchor-fallback`),
   but production inference runs through `v9PredictionFeatures` /
   `predictEventRecap`, a separate path. If that path still anchors a
   first-ever-appearance corps to a zero baseline, V10 will reproduce the exact
   12.4-point zero-history blowup in production that the harness exposed — the
   same class of failure that made final2 need the comparable-revert correction.
   Confirm the serving path applies the division-aware rank-curve baseline when
   recent-form is absent, and package that behavior with the V10 artifact.

2. **Isolate why dev3 beats final2 on 2026 — repeat the 63-row comparison
   identity-agnostic.** dev3 uses cleaner, different identity maps than final2,
   so part of the 1.53-vs-2.04 win could be identity resolution on 2026 debut
   corps rather than the generalizable data/curve/anchor fixes. If dev3 still
   wins with corps/judge/show residual paths disabled, the win is the durable
   stuff; if the margin collapses, the win is partly identity bookkeeping and
   must be scrutinized before it counts. Run both the stored-identity and
   agnostic 63-row comparisons and report the split.

3. **Reconsider the checkpoint-selection metric now that total is a derived
   rollup.** Only the 8 caption deltas are learned; recap/category/total are
   fixed derivation layers, so the fundamental quantity is recap MAE and the
   composite selector's heavy total weight is partly redundant. Check post hoc
   (on checkpoints already saved) whether a recap-weighted selector picks a
   different, better checkpoint than the current total-heavy composite. Free —
   no new training.

4. **Expand the 2026 evaluation beyond the 63-row eval-cohort overlap.** final2
   has ~15k saved production predictions across the full season; only the 12
   overlapping shows were used. Building dev3 sequences for every 2026 scored
   show turns a directional 63-row read into a few-hundred-row verdict with
   show-clustered bootstrap intervals — the difference between encouraging and
   conclusive. Keep the strict as-of build and the leakage guard
   (predictions dated before each show).

5. **History-aware interval width (P4) is now the natural next feature.** The
   zero-history mean is fixed (12.4 -> 1.6), but a first-ever-appearance
   forecast is still inherently uncertain while the interval scale is global,
   so thin-history forecasts advertise the same tightness as data-rich ones.
   Calibrate interval scale by history-depth bucket (and division), now that we
   have clean thin-history predictions to calibrate against. Pairs naturally
   with the thin-history treatment and must be selected on coverage/width at
   matched coverage, not on MAE.

6. **Consequential-metric hygiene going forward.** Report recap (caption) MAE as
   the headline and treat total MAE as the derived summary it is. For any
   treatment claim, require the gain to clear the measured paired-seed MDE
   (recap 0.004, total 0.085, established 0.041) and to hold across both seeds
   and show-clustered intervals — a single-seed single-cohort number is
   directional only.

### 2026-07-17 — queued LR-schedule ablation: match cosine period to run length

**Observation.** Under the fixed 10/40 regimen the validation metrics settle by
epoch ~45–64 and then oscillate in a band (recap ~0.37–0.39, total ~1.0–1.13)
to early stop. This is not "LR never lowers": the persistent plateau multiplier
drives the effective LR to the `minLr` floor (0.00075 → 0.00031 → 0.00014 →
0.000057 → 0.00003) and the band persists at the floor, so the oscillation is
dominated by the stochastic regime (4,096 resampled, re-augmented rows/epoch on
a 363-row validation set), not step size.

**The real defect is decay *shape*, not floor.** `cosineBaseLearningRate` is
computed with `epochs = args.epochs = 160` (the max), while runs early-stop
near epoch ~120. The cosine therefore never finishes: at the epoch that
produces the best composite (~64) the base LR is still ~0.00054 (72% of peak),
and real late decay comes only reactively from the plateau multiplier, whose
first reduction (~epoch 76) lands *after* the best checkpoint. During the
productive window (epochs ~40–70) the LR is too high to settle, so the model
bounces across equally-good solutions instead of tightening into one.

**Queued ablation (one knob, paired seeds 42/43, fixed 10/40, dev3 contract):**
set the cosine period to the expected run length rather than the epoch ceiling
— e.g. compute `cosineBaseLearningRate` with `epochs ≈ 110` (or add an explicit
`--cosine-period` arg) so LR is ~0.0003 at epoch 64 instead of ~0.00054. Keep
the peak (0.00075) and warmup unchanged; this steepens the mid-run decay only.

**Guardrails / do-not-confuse.**
- This is *not* a lower peak. The archive's 0.00055 scale run under-optimized
  early and lost; lowering the whole schedule is rejected. Preserve peak +
  warmup and change only the decay period.
- Distinct from the queued phase-aware-LR treatment, which *holds* the peak
  through phase B and decays after — the opposite direction. Test both against
  the fixed-cosine control; do not combine them in the first run.
- Selection stays on the composite metric; report recap MAE headline, every
  history slice, and the checkpoint-soup candidate. A win must clear the
  paired-seed MDE (recap 0.004, total 0.085) across both seeds before it counts.
- Expected upside is a tighter, higher single checkpoint (less reliance on the
  soup), not necessarily a large aggregate MAE move; judge it on whether the
  selected checkpoint improves and whether the band narrows.

### 2026-07-17 — queued experiment: clean-contract capacity re-test (tail-focused)

**Why revisit.** The 2026-07-16 "capacity didn't help" conclusion is only half
the story. On the frozen final2 contract the 1.885x graph (1,976,938 params)
scored composite 0.4999 (low-LR 0.00055) and 0.4985 (orig-LR 0.00075) — better
than final2 (0.5026) but *not* better than the same-size V9.5-fixed runs
(0.4989–0.5002), so capacity was not the aggregate lever. However that headline
averaged away a real signal: the low-LR scale run's thin-history tail was the
best of any run — zero-history 1.7425 and sparse 1.5765, beating both final2
(3.218 / 1.838) and the same-size runs on those slices. The tail is exactly
V10's target, and the scale runs were single-seed on the old dirty dev1-era
contract with auto-curriculum. We never got a clean, multi-seed capacity read.

**Queued experiment (after the dev3 clean-data control qualifies).** Run the
existing `scaled-control` profile (192/96 BiLSTM, 768/384 dense, 405 trunk;
~1.96M params) on the clean dev3 contract, paired seeds 42/43, fixed 10/40
curriculum, at the midpoint peak LR 0.00065 (the archive endpoint analysis
favored a midpoint over both 0.00055 and 0.00075). Compare against the
qualified same-size dev3 control on identical data/splits/maps.

**Decision rule — judge on the tail, not aggregate.** Capacity earns a place in
V10 only if it materially improves zero/sparse/short-history (and 2026
thin-history) beyond the same-size control by more than the paired-seed MDE,
without regressing established history past its non-inferiority margin. A tie on
aggregate composite is not enough to justify ~1.9x params/compute; a repeatable
tail win is. If the tail edge from the old low-LR run reproduces on clean data
across both seeds, capacity becomes a real V10 lever (and a distillation-back-to-
same-size student per the existing hypothesis-log entry becomes worthwhile).

**Guardrails.**
- Do not combine with the phase-aware-LR or cosine-period LR ablations in the
  same run; capacity must be isolated first. The midpoint 0.00065 is part of the
  capacity treatment (capacity-following stability), recorded as such.
- All prior scale evidence is dirty-contract single-run and is superseded by
  this clean multi-seed test for any V10 decision; keep it only as motivation.
- If capacity wins the tail, still prefer distilling it into the deployed
  1.03M-param student before shipping a larger inference graph.

### 2026-07-17 — cost-free / near-free performance wins (apply to the shipped model)

These require no new architecture and little or no training. They stack on top
of the qualified clean-data control and are the fastest path to the best
shippable model. Applied and evaluated autonomously overnight.

1. **Multi-seed prediction ensemble (biggest free win).** Average the per-caption
   predictions of the trained seeds (42, 43, and any further seeds trained
   overnight). Ensembling independent seeds almost always beats the best single
   seed and directly attacks the run-to-run variance that is our largest source
   of noise (paired-seed spread: recap 0.004, total 0.085, sparse 0.90). Cost is
   Nx inference (cheap, N small) and zero extra training beyond seeds we already
   run. Report the ensemble vs best-single-seed on frozen validation + 2026,
   recap MAE headline. This is the default production candidate's mean model.

2. **Checkpoint soup (validated both seeds).** Average best_total + best_composite
   (and adjacent Pareto checkpoints) within a run before ensembling. Helped
   recap/total/zero on both dev2 seeds; established guardrail must hold per seed.
   Exports one graph — no inference cost. Compose with the multi-seed ensemble
   (soup each seed, then average seeds).

3. **Post-hoc checkpoint re-selection on recap.** Total is a fixed derivation of
   the captions, so the composite selector's heavy total weight is partly
   redundant. Re-rank the already-saved checkpoints by a recap-weighted score
   and by the declared Pareto selector; pick the best on frozen validation. Free
   (no training).

4. **History-aware + conformal interval calibration (P4, post-hoc).** The mean is
   now good on thin history (zero 12.4 -> 1.6) but the interval scale is global,
   so debut forecasts advertise data-rich tightness. Calibrate scale by
   history-depth bucket and division on the frozen validation, and compute a
   split-conformal scale; select on coverage/width at matched coverage. No
   training, no MAE change — pure honesty/coverage win. The trainer already emits
   the evidence-regime uncertainty comparison; use it.

5. **Already-banked data-level free wins (in dev3).** Division-aware reference
   curves and the zero-anchor curve fallback cost nothing at inference and were
   the difference between a 12.4 and 1.6 zero-history 2026 MAE. Ensure the serving
   path carries them (see the serving-audit suggestion) so the win transfers to
   production.

**Selection discipline:** every free win must be applied and then evaluated on
the frozen validation and the 2026 walk-forward; keep any that helps or is
neutral and does not regress established history past its margin. The final
shipped model is: {clean-data + division curves + zero-anchor} control, best
checkpoint (soup + recap/Pareto re-selection), multi-seed ensembled, with
history/division/conformal interval calibration — plus any treatment that
independently cleared the paired-seed MDE overnight.

### 2026-07-17 — free training-speed wins (WSL, 16 cores, no GPU)

Measured: each `trainModelV10Final` job uses ~1.2 cores and ~1.3 GB RSS; with
two jobs the 16-core box sits at load ~2.2 (≈85% idle). Training is RAM-limited,
not CPU-limited, and each job is effectively single-threaded (JS data pipeline /
per-epoch eval dominates, not TF matmuls). No NVIDIA GPU present, so the GPU
path is closed.

1. **Run 5–6 jobs concurrently, not 2–3 (biggest lever).** ~1.3 GB/job into
   ~10.5 GB free = ~6 with headroom; 16 cores means no CPU contention at that
   count. Roughly triples overnight throughput — the whole experiment matrix
   (control seeds, treatments ×2 seeds, LR ablations, capacity) can run largely
   in parallel instead of serially. Watch RAM (keep >~2 GB free) and host C:
   disk; do not exceed ~6 without re-checking `free -m`.

2. **Tighten early-stop patience 60 → ~35 for experiment runs.** The plateau LR
   multiplier reaches the `minLr` floor and the monitor flatlines by ~epoch 76;
   patience 60 then burns ~25 confirmed-flat epochs (~33 min/run) after the best
   checkpoint is already saved. The composite selector + checkpoint soup capture
   the best point, so this is safe wall-clock savings. Pass `--patience 35` (do
   not retro-apply to the in-flight control pair; use for all new runs).

3. **(near-free, small code change) Cut per-epoch eval cost.** Each epoch scores
   the full 16-population sliced suite; that is likely a large share of the
   ~80 s/epoch. Run the full slice suite only every N epochs (keep the single
   monitor metric per-epoch for early-stop/LR), and the full suite at terminal.
   Real speedup but touches the training loop — validate the monitor still
   drives early-stop/LR before trusting it; do not do this mid-matrix without a
   focused check.

Not worth it: forcing more TF intra-op threads (jobs are data-pipeline-bound;
extra threads add contention once 5–6 jobs run) and any GPU path (none).

Overnight policy: default to 5–6 concurrent, `--patience 35` on new runs, RAM
and disk checked before each launch batch.

### 2026-07-17 — identity-isolation result: agnostic beats stored on 2026

Terminal dev3 seed-43 on the frozen 2026 cohort (161 rows), with the zero-anchor
fallback: identity-AGNOSTIC outperforms stored-identity — recap 0.4334 vs
0.4723, total 1.3140 vs 1.5441. On the matched-63 vs final2 production (2.041)
both win (agnostic 1.4937 / stored 1.5331). Conclusion for suggestion #2: the
win over final2 is the generalizable data/curve/anchor repair, NOT identity
resolution — the corps/judge/show embeddings (fit on 2013-2025) are a net
negative out-of-sample, adding noise on unknown/thin-history 2026 corps. This
(a) strengthens the robustness claim, (b) directly motivates the support-aware
identity treatment (gate identity by as-of evidence), and (c) suggests the
production forecasting path should run identity-agnostic or evidence-gated, not
raw stored embeddings, for future-season predictions. Full-cohort recap 0.4334
agnostic already beats final2 agnostic 0.4930.
