# V10 trainer reconstruction checklist

Date: 2026-07-15

Purpose: reconstruct a clean 220-input `final2`-compatible trainer before adding
V10 data or features. This implements Milestone 1 of `V10_MODEL_PLAN.md`.

## Trusted inputs

- Frozen contract: `sdk/src/training/baselines/final2-baseline.json`
- Validator: `sdk/scripts/validateFinal2Baseline.ts`
- Exact early anchor in `doeixd/recovered-ml-212`:
  `reference/trainModelV9Subcaption-fixed.EXACT-2026-05-26-187dim.ts`
- Committed 220-dimensional wiring reference:
  `reference/trainModelV9Subcaption-judges-test.COMMITTED-220dim-minus-regimen.ts`
- Conservative 3,393-line reconstruction:
  `sdk/src/training/trainModelV9Subcaption-fixed.ts` in the recovery repository
- Ordered history: `reference/trainer-apply-patches/`
- Drift audit: `reference/trainer-reconstruction-drifted-hunks.txt`
- Behavioral truth: `final2/training.log`, `training-args.json`,
  `model-card.json`, and `model.json`

Do not edit the existing local 169-wide trainer in place. Create a new versioned
baseline trainer so V9 serving and historical evidence remain untouched.

## Reconstruction order

### 1. Trusted base and wiring

- [x] Start from the exact 2026-05-26 trainer anchor.
- [x] Port 212 raw + 8 trend = 220 static wiring from the committed reference.
- [x] Import shared dimensions from `v9FeatureModes.ts`.
- [x] Confirm 15 × 101 sequence input and 220 static input statically.
- [x] Confirm topology statically: BiLSTM 128/64, dense 512/256, accuracy trunk 270,
  and eight-caption heads.

Progress note (2026-07-15): the versioned scaffold is
`sdk/src/training/trainModelV95.ts`, invoked with `npm run train:v95`. It defaults
to a new model root, normalization file, and CSV log, and accepts `--db`,
`--model-dir`, and `--norm-path`; it cannot overwrite V9 artifacts by default.
The exact anchor contained a partially applied row-identity change (the `DataRow`
type required `season`, `competitionSlug`, and `corpsKey`, but `buildDataRows`
did not populate them) and omitted `agnostic_show_id` from its SQL projection.
Those fields were ported from the conservative recovery only after confirming
them against the committed table schema. The focused TypeScript check now passes.

### 2. Metrics and sliced reporting

Replay chronologically:

1. `01352_2026-05-21T18-46-29.166Z.patch`
2. `01360_2026-05-21T18-46-40.559Z.patch`
3. `01365_2026-05-21T18-47-29.243Z.patch`
4. `01608_2026-05-21T19-03-06.840Z.patch`
5. `01617_2026-05-21T19-03-16.912Z.patch`
6. `02975_2026-05-23T12-02-41.043Z.patch`
7. `02979_2026-05-23T12-02-55.379Z.patch`
8. `02983_2026-05-23T12-03-08.674Z.patch`
9. `03480_2026-05-23T12-36-47.883Z.patch`
10. `03484_2026-05-23T12-36-53.169Z.patch`
11. `03488_2026-05-23T12-37-06.264Z.patch`
12. `09397_2026-05-28T13-43-46.354Z.patch`
13. `09401_2026-05-28T13-44-00.731Z.patch`

The original four-entry list omitted required precursor and calibration patches;
the expanded order above was recovered by tracing symbols through the patch set.

- [x] Restore final `MetricBucket`, `mapBuckets`, and summary shapes.
- [x] Verify history and forecast-mode buckets match the model card.
- [x] Preserve raw and calibrated interval metrics in the evaluator.
- [x] Add a focused bucket accumulation/serialization test.

Progress note (2026-07-15): the connected evaluation contract is now restored.
`v95Evaluation.ts` owns show-grouped date-forward/show-random splitting, the 16
preserved evaluation populations, and their panel/lineup/preseason mask modes.
The trainer emits raw and calibrated slice trees, split and artifact provenance,
curriculum/checkpoint metadata, `eval_report.json`, `test-results.json`, and a
model card. `npm run test:v95-evaluation` pins the split isolation, label set,
row selection, and mask modes; the masking test additionally pins final2's
reduced forecast/history masking rates for established-history rows.

### 3. Auto-curriculum constants and configuration

Replay chronologically:

1. `02493_2026-05-22T18-34-02.399Z.patch`
2. `02497_2026-05-22T18-34-10.551Z.patch`
3. `03464_2026-05-23T12-36-20.085Z.patch`
4. `03472_2026-05-23T12-36-29.994Z.patch`
5. `04066_2026-05-26T11-04-26.504Z.patch`
6. `04214_2026-05-26T11-35-26.864Z.patch`

- [x] Parse every preserved `final2` argument without relying on a default.
- [x] Pin phase ends 10/40, patience 6, coverage 0.9, delta gain 0.002,
  phase-A minimum 6, and phase-B minimum 18.
- [x] Match the preserved startup `Curriculum:` values.

Progress note (2026-07-15): `v95Curriculum.ts` now contains the frozen final2
configuration and a pure transition state machine. `npm run test:v95-curriculum`
pins max-epoch A→B at 10, B→C at 40, plateau patience/min-age behavior, and the
coverage gate. Trainer integration remains part of section 4.

Configuration parsing now lives in the TensorFlow-free `v95Config.ts`.
`npm run test:v95-config` constructs a CLI containing all 68 fields from the
preserved `training-args.json`, round-trips each value without using defaults,
and pins the exact historical `Curriculum:` and `Model Capacity:` lines. The
trainer uses those same parser/formatter functions at runtime.

### 4. Auto-curriculum transition behavior

Replay chronologically:

1. `02418_2026-05-22T18-31-13.900Z.patch`
2. `02501_2026-05-22T18-34-20.636Z.patch`
3. `02518_2026-05-22T18-35-00.950Z.patch`
4. `02527_2026-05-22T18-35-10.812Z.patch`
5. `02542_2026-05-22T18-35-27.133Z.patch`
6. `02629_2026-05-22T18-38-10.109Z.patch`
7. `02694_2026-05-22T18-40-42.878Z.patch`
8. `02795_2026-05-22T19-22-02.692Z.patch`
9. `02800_2026-05-22T19-22-10.596Z.patch`
10. `02804_2026-05-22T19-22-14.386Z.patch`

The scheduler/config and logging prerequisites above were missing from the
original five-entry list and are required for the transition function to have
any effect.

- [x] Restore `maybeAdvanceCurriculum` and monitor reset behavior.
- [x] Unit-test age, coverage, improvement, stall, and max-epoch gates.
- [x] Reproduce A→B at epoch 10 and B→C at epoch 40 (`max_epoch`).
- [x] Reproduce the fields and decisions in preserved `[curriculum]` lines.

### 5. Forecast-context masking

Replay chronologically:

1. `04218_2026-05-26T11-35-39.179Z.patch`
2. `04227_2026-05-26T11-35-49.672Z.patch`
3. `04235_2026-05-26T11-36-09.807Z.patch`
4. `04250_2026-05-26T11-36-29.200Z.patch`
5. `04409_2026-05-26T11-44-29.881Z.patch`
6. `04413_2026-05-26T11-44-38.261Z.patch`
7. `08638_2026-05-28T11-12-22.643Z.patch`
8. `08676_2026-05-28T11-14-09.468Z.patch`
9. `08897_2026-05-28T11-26-21.846Z.patch`
10. `08901_2026-05-28T11-26-29.307Z.patch`

The May 28 baseline/fingerprint tail is required for the actual `final2`
forecast behavior; the earlier mask alone still used a history-derived baseline.

- [x] Restore final forecast masking using normalization-aware values.
- [x] Verify only intended slots change; preserve fingerprint/cold-start blocks.
- [x] Test deterministic seeded masking and pin the reproduction rate to 0.12.

### 6. Accuracy-trunk capacity

Replay chronologically:

1. `02414_2026-05-22T18-30-49.742Z.patch`
2. `02430_2026-05-22T18-31-34.948Z.patch`
3. `04752_2026-05-26T13-20-58.745Z.patch`
4. `04875_2026-05-26T13-39-24.769Z.patch`
5. `04879_2026-05-26T13-39-31.687Z.patch`
6. `09583_2026-05-28T13-53-48.172Z.patch`

- [x] Restore parsing/construction and verify `accuracy_trunk` has 270 units.
- [x] Match the startup `Model Capacity:` line.
- [x] Remove or explain intermediate 128/192-unit defaults.

`npm run validate:v95-architecture` pins the source graph contract and frozen
manifest dimensions without initializing the unavailable native TFJS backend.
The runtime dry-graph gate below remains separate.

The native WSL smoke test also pinned final2's embedding input dimensions from
`model.json`: 245 judges, 709 corps, and 349 shows. Current map key counts are not
valid substitutes. The trainer now validates loaded IDs against the frozen
dimensions and initializes show cardinality from the full population, preventing
small `--maxRows` fixtures from undersizing the graph.

### 7. Composite selection and checkpoints

Final-weights chain:

1. `02318_2026-05-22T18-01-49.101Z.patch`
2. `04092_2026-05-26T11-05-18.981Z.patch`

Multi-checkpoint chain:

1. `04078_2026-05-26T11-04-40.334Z.patch`
2. `04087_2026-05-26T11-05-11.295Z.patch`
3. `08990_2026-05-28T11-51-28.962Z.patch`

- [x] Restore final production-composite formula.
- [x] Restore best delta/loss/total/composite and per-phase checkpoints.
- [x] Prevent one epoch from overwriting the wrong checkpoint.
- [x] Restore `finalWeights=composite` promotion.
- [x] Test checkpoint gates with synthetic metrics and match preserved log values.

`npm run test:v95-checkpoints` reproduces the final2 epoch-71 composite score
`0.5025684126513721`, verifies independent metric gates, and pins requested-mode
fallback behavior. Checkpoint directories are written through unique temporary
directories and atomically promoted; each metric owns separate weights and epoch
state.

### 8. Loss scheduler and phase ramps

The drift audit shows connected failures around patches 2418–2629. Audit these
as a region rather than trusting fuzzy replay.

- [x] Restore final `V9LossScheduler` and phase boundaries.
- [x] Match loss weights and judge/corps scale ramps at representative epochs.
- [x] Verify LR warmup/plateau behavior across curriculum transitions.
- [x] Unit-test phase boundaries and ramp endpoints.

The curriculum test pins preserved-log values at epochs 0, 39, 40, 71, and
100, including the 39→40 width-floor boundary, judge/corps scales, phase-C
identity dropout, warmup endpoints, plateau multiplication, and minimum LR.

## Gates

### Static

- [x] Focused TypeScript check passes with no dangling symbols.
- [x] No V9 output path is overwritten by default.
- [x] `npm run validate:v10-baseline` remains green.
- [ ] Dry-run graph matches manifest dimensions/layers.

### Behavioral dry run

- [x] Startup arguments, capacity, and curriculum match preserved evidence.
- [ ] A fixture run exercises all phases without NaNs.
- [ ] Curriculum/checkpoint tests pass and report contains all final2 slices.

### Full V9.5

- [x] Select the frozen 7,321-row cutoff explicitly; do not silently use the
  current 7,470 rows.
- [x] Define tolerances before seeing results.
- [ ] Run at least two seeds and compare mean/spread with the manifest.
- [ ] Resolve any out-of-tolerance result before adding V10 features.

`npm run train:v95:final2` selects the 3,621,408,768-byte frozen DB explicitly.
The `final2` reproduction contract verifies its SHA-256 before TensorFlow starts,
then asserts exact row/division and train/validation/test show populations. The
numeric two-seed acceptance bands are predeclared in `V10_MODEL_PLAN.md` under
Milestone 1; they were written before running any V9.5 replica.

## Traps

- Compiling does not validate regimen behavior.
- The conservative recovered trainer is partial precisely in the regions above.
- Patch files are incremental; replay every named chain chronologically.
- Current DB row drift can masquerade as trainer drift.
- Old judge/corps maps are incomplete; document this for reproduction and
  generate a fresh matched set for V10.
- Never use the legacy file named `trainModelV10.ts` for this effort.
