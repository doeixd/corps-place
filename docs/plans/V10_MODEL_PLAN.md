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

Finish the running seed-43 full frozen-data V9.5 replica, then summarize both
seeds' mean/range against every predeclared tolerance. Diagnose seed 42's
sparse-history failure at row and checkpoint level and resolve it before closing
Milestone 1. Do not start field-pace or thin-history experiments until that V9.5
baseline gate passes.
