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
- [ ] Confirm topology: BiLSTM 128/64, dense 512/256, accuracy trunk 270,
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

1. `01365_2026-05-21T18-47-29.243Z.patch`
2. `03488_2026-05-23T12-37-06.264Z.patch`
3. `09397_2026-05-28T13-43-46.354Z.patch`
4. `09401_2026-05-28T13-44-00.731Z.patch`

- [ ] Restore final `MetricBucket`, `mapBuckets`, and summary shapes.
- [ ] Verify history and forecast-mode buckets match the model card.
- [ ] Preserve raw and calibrated interval metrics.
- [ ] Add a focused bucket accumulation/serialization test.

### 3. Auto-curriculum constants and configuration

Replay chronologically:

1. `02493_2026-05-22T18-34-02.399Z.patch`
2. `02497_2026-05-22T18-34-10.551Z.patch`
3. `03464_2026-05-23T12-36-20.085Z.patch`
4. `03472_2026-05-23T12-36-29.994Z.patch`
5. `04066_2026-05-26T11-04-26.504Z.patch`
6. `04214_2026-05-26T11-35-26.864Z.patch`

- [ ] Parse every preserved `final2` argument without relying on a default.
- [ ] Pin phase ends 10/40, patience 6, coverage 0.9, delta gain 0.002,
  phase-A minimum 6, and phase-B minimum 18.
- [ ] Match the preserved startup `Curriculum:` values.

### 4. Auto-curriculum transition behavior

Replay chronologically:

1. `02518_2026-05-22T18-35-00.950Z.patch`
2. `02527_2026-05-22T18-35-10.812Z.patch`
3. `02542_2026-05-22T18-35-27.133Z.patch`
4. `02629_2026-05-22T18-38-10.109Z.patch`
5. `02795_2026-05-22T19-22-02.692Z.patch`

- [ ] Restore `maybeAdvanceCurriculum` and monitor reset behavior.
- [ ] Unit-test age, coverage, improvement, stall, and max-epoch gates.
- [ ] Reproduce A→B at epoch 10 and B→C at epoch 40 (`max_epoch`).
- [ ] Reproduce the fields and decisions in preserved `[curriculum]` lines.

### 5. Forecast-context masking

Replay chronologically:

1. `04218_2026-05-26T11-35-39.179Z.patch`
2. `04227_2026-05-26T11-35-49.672Z.patch`
3. `04235_2026-05-26T11-36-09.807Z.patch`
4. `04409_2026-05-26T11-44-29.881Z.patch`
5. `04413_2026-05-26T11-44-38.261Z.patch`

- [ ] Restore final `maskForecastContext` using normalization-aware values.
- [ ] Verify only intended slots change; preserve fingerprint/cold-start blocks.
- [ ] Test deterministic seeded masking and pin the reproduction rate to 0.12.

### 6. Accuracy-trunk capacity

Replay chronologically:

1. `02414_2026-05-22T18-30-49.742Z.patch`
2. `02430_2026-05-22T18-31-34.948Z.patch`
3. `04752_2026-05-26T13-20-58.745Z.patch`
4. `04875_2026-05-26T13-39-24.769Z.patch`
5. `04879_2026-05-26T13-39-31.687Z.patch`
6. `09583_2026-05-28T13-53-48.172Z.patch`

- [ ] Restore parsing/construction and verify `accuracy_trunk` has 270 units.
- [ ] Match the startup `Model Capacity:` line.
- [ ] Remove or explain intermediate 128/192-unit defaults.

### 7. Composite selection and checkpoints

Final-weights chain:

1. `02318_2026-05-22T18-01-49.101Z.patch`
2. `04092_2026-05-26T11-05-18.981Z.patch`

Multi-checkpoint chain:

1. `04078_2026-05-26T11-04-40.334Z.patch`
2. `04087_2026-05-26T11-05-11.295Z.patch`
3. `08990_2026-05-28T11-51-28.962Z.patch`

- [ ] Restore final production-composite formula.
- [ ] Restore best delta/loss/total/composite and per-phase checkpoints.
- [ ] Prevent one epoch from overwriting the wrong checkpoint.
- [ ] Restore `finalWeights=composite` promotion.
- [ ] Test checkpoint gates with synthetic metrics and match preserved log values.

### 8. Loss scheduler and phase ramps

The drift audit shows connected failures around patches 2418–2629. Audit these
as a region rather than trusting fuzzy replay.

- [ ] Restore final `V9LossScheduler` and phase boundaries.
- [ ] Match loss weights and judge/corps scale ramps at representative epochs.
- [ ] Verify LR warmup/plateau behavior across curriculum transitions.
- [ ] Unit-test phase boundaries and ramp endpoints.

## Gates

### Static

- [x] Focused TypeScript check passes with no dangling symbols.
- [x] No V9 output path is overwritten by default.
- [x] `npm run validate:v10-baseline` remains green.
- [ ] Dry-run graph matches manifest dimensions/layers.

### Behavioral dry run

- [ ] Startup arguments, capacity, and curriculum match preserved evidence.
- [ ] A fixture run exercises all phases without NaNs.
- [ ] Curriculum/checkpoint tests pass and report contains all final2 slices.

### Full V9.5

- [ ] Select the frozen 7,321-row cutoff explicitly; do not silently use the
  current 7,470 rows.
- [ ] Define tolerances before seeing results.
- [ ] Run at least two seeds and compare mean/spread with the manifest.
- [ ] Resolve any out-of-tolerance result before adding V10 features.

## Traps

- Compiling does not validate regimen behavior.
- The conservative recovered trainer is partial precisely in the regions above.
- Patch files are incremental; replay every named chain chronologically.
- Current DB row drift can masquerade as trainer drift.
- Old judge/corps maps are incomplete; document this for reproduction and
  generate a fresh matched set for V10.
- Never use the legacy file named `trainModelV10.ts` for this effort.
