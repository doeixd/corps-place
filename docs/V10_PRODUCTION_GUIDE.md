# V10 production guide — using the model and switching production over

Companion to `docs/V10_PRODUCTION_MANIFEST.md` (the deploy spec + evidence) and
`docs/plans/V10_MODEL_PLAN.md` (the full experiment trail). This guide is the
how-to: what V10 is, how to run it, and exactly what production code/data must
change to switch from final2 to V10.

Status: candidate ready. Nothing here is deployed. Read the "Switch checklist"
and do it in a branch with shadow validation before flipping live.

---

## 1. What V10 is (one paragraph)

V10 is a **multi-seed, identity-agnostic ensemble** of the clean-data control
trainer. Same architecture as final2 (128/64 BiLSTM, 512/256 dense, 270 accuracy
trunk, ~1.03M params per member). Its gains over final2 come entirely from
**data + serving**, not architecture:
- trained on the clean domain data (decontaminated `caption_scores`),
- **division-aware reference curves** (World vs Open Class) — fixes the Open
  Class baseline anchor bug,
- **zero-anchor curve fallback** for first-ever-appearance corps,
- served **identity-agnostic** (corps/judge/show embeddings hurt out-of-sample),
- **ensembled** across seeds (averages seed variance frozen validation can't
  predict).

Evidence: on the frozen 2026 out-of-sample cohort (161 rows / 26 shows), V10
recap MAE 0.379 vs final2 0.493 (~23% better), show-clustered 95% CI
[0.333, 0.441] entirely below final2, winning 21/26 shows. Capacity scaling
(1.9x) was tested and buys nothing, so the efficient size is the best size.

Predictions are generated in a **nightly batch** (`scripts/nightly-predictions.sh`
-> `sdk/scripts/predictEventRecap.ts --save-db`), so N-model ensemble inference
is affordable.

---

## 2. Artifacts (must ship together)

All under `sdk/` in the WSL checkout `/root/corps-place-v10` (git-ignored):
- **Ensemble member models**: 12 dirs listed in the manifest under
  `sdk/models/v10_clean_data_control/` and `sdk/models/v10_phase_aware_lr/`.
  (A fixed 5-7 subset captures nearly all the gain; do NOT frozen-rank-select —
  frozen composite is ~uncorrelated with 2026.)
- **dev3 identity maps + curves**: `sdk/src/training/v10/dev3/`
  (`corpsIndexMap.json` 42b972f3, `judgeIndexMap.json` 6c070478,
  `showIndexMap.json` 7d72af15, `referenceCurves.json` 96629851 — 1575 cells with
  `World Class|` + `Open Class|` + legacy keys).
- **Training/eval contract** (provenance only): source snapshot 5c7cd080,
  sequence payload eefd49d4, pinned in `sdk/src/training/baselines/`.

---

## 3. How to run a V10 prediction (dev / verification)

A single member, one event, identity-agnostic, dev3 curves:
```
cd sdk
npx tsx scripts/predictEventRecap.ts --event <event-slug> \
  --model-dir models/v10_clean_data_control/<a-member-dir> \
  # (after the code changes in section 4: agnostic + dev3 curves become defaults
  #  or flags; today predictEventRecap hard-codes final2 curves — see below)
```
To reproduce the 2026 evaluation number for any member (this already works):
```
npx tsx scripts/replayFinal2Baseline.ts --season 2026 \
  --db data/v10-training-dev3.db \
  --evaluation-db data/v10-evaluation-2026-07-17.db \
  --ml-table ml_sequence_rows_v10_clean_control \
  --model-dir <member-dir> --reference-model-dir <member-dir> \
  --curve-anchor-fallback --identity-agnostic --row-details --all-row-details \
  --output-json results/<name>.json
```
Ensemble a set of member result JSONs (recap/total vs final2):
```
python3 scripts/ensembleCombined.py            # globs results/v10-2026-*agnostic.json
python3 scripts/ensemble2026.py 42 43 44        # specific seeds
```

---

## 4. Switch checklist — production code + data changes

Do these in a branch. Each item lists the file and the change. Marked
[VERIFY] where a line/behavior should be re-confirmed during implementation.

### 4a. Data: rebuild the production template table on the dev3 contract
The prediction path reads corps templates from `ml_sequence_rows_v9_subcaption`
(via `buildV9PredictionFeatures` in `sdk/src/training/v9PredictionFeatures.ts`).
Those templates carry the **static rank-baseline block (indices 121-128)** and
sequences, which for V10 must be **division-aware (dev3)**. Today's table was
built with World-Class-only curves, so Open Class templates carry the wrong
anchor.
- Rebuild the production `ml_sequence_rows_v9_subcaption` (or a new
  `ml_sequence_rows_v10_serving` table) using the dev3 builder + dev3 curves/maps,
  over the live DB, for all seasons through present.
  Reference: `sdk/src/buildMlSequencesV9Subcaption.ts --data-contract clean-v10
  --artifact-dir src/training/v10/dev3`. [VERIFY] the builder runs against the
  live prod DB shape, not just the frozen snapshot.
- If you create a new table, point `buildV9PredictionFeatures`' template queries
  at it (the `FROM ml_sequence_rows_v9_subcaption` reads in
  `predictEventRecap.ts` ~lines 793-848 and in `v9PredictionFeatures.ts`).

### 4b. Reference curves -> dev3 (two load sites)
- `sdk/scripts/predictEventRecap.ts` ~line 869 hard-codes
  `src/training/referenceCurvesV4.json`. Point it at
  `src/training/v10/dev3/referenceCurves.json`.
- `sdk/src/training/v9Baselines.ts` `getV9CaptionBaseline` defaults to
  `referenceCurvesV4.json` (its `getDefaultReferenceCurvesPath`). Either change
  the default for V10 or thread `referenceCurvesPath` from the caller. This is
  the function that ALREADY does division-aware lookup
  (`${division}|${rank}-${bucket}`) and the zero-history curve fallback — it just
  needs the curve file that HAS `Open Class|` keys.
- Net effect: Open Class corps stop getting the World Class anchor. This is the
  single highest-value serving change.

### 4c. Identity-agnostic serving
V10's win requires disabling the identity embeddings at serve time. In
`sdk/src/training/v9PredictionFeatures.ts` the feature builder returns
(~lines 515-518): `corpsScale: template ? 1 : 0`, `judgeBiasScale: judgesUnknown
? 0 : 1`, `agnosticShowId: ... template.agnostic_show_id`.
- Add an agnostic serving mode (flag or config) that forces
  `corpsScale = 0`, `judgeBiasScale = 0`, `agnosticShowId = 0`.
- BONUS: because embeddings are then disabled, the corps/judge/show **map-integer
  mismatch does not matter** — you do NOT need to rebuild corps_ids to dev3 maps
  for correctness of agnostic inference. (You still want 4a for the division-aware
  static/curve baseline.) [VERIFY] `predictOne` in `v9SubcaptionInference.ts`
  respects `corpsScale`/`judgeBiasScale` = 0 as a hard gate (it does for the
  replay path via the LambdaScale gates).

### 4d. Model resolution -> V10 members + ensemble averaging
- `sdk/scripts/predictEventRecap.ts` resolves the model via `--model-dir`
  (default `latest` -> `findLatestV9SubcaptionModelDir('models/v9_subcaption_fixed')`
  in `sdk/src/training/v9ModelPaths.ts`). For a single-model swap, pass
  `--model-dir <v10 member>` (or repoint the default).
- For the **ensemble**, add a path that loads N member models and averages their
  8 caption p50 predictions BEFORE deriving category/total. The single-model call
  is `loadV9SubcaptionModel` (~line 1515) + `model.predictOne(...)` (~line 1650).
  Wrap: load N models once, in the per-corps loop call each `predictOne`, average
  `captions[c].p50` across members, then run the existing
  derive-total/scale-to-total logic on the averaged captions. Keep intervals from
  a calibrated ensemble scale (4f).
- `judgeIndexMap` is also read at `predictEventRecap.ts` ~line 766 from
  `src/training/judgeIndexMap.json` (used for judge display/lookup, not the model
  in agnostic mode). Point at dev3 or leave — [VERIFY] it is display-only under
  agnostic serving.

### 4e. Model-path/version plumbing (app API)
- `app/lib/event-prediction-api.ts` resolves `modelDir` and computes a model
  fingerprint for cache-keying (`resolveRequestedModelDir`, `modelFileFingerprint`,
  `modelStaticDimFromManifest`). For an ensemble, decide the identity: either a
  synthetic "ensemble" model dir with a manifest listing members, or an env/config
  that names the member set. Ensure the fingerprint changes when the member set
  changes so cached predictions invalidate.

### 4f. Interval calibration for the ensemble (recommended before ship)
- `loadIntervalScale` (`predictEventRecap.ts` ~line 749) reads a single model's
  calibration file. The ensemble's residuals differ from any single member, so
  compute an ensemble interval scale on the FROZEN validation set (2025), by
  history-depth + division, and load that. Free (no retrain). Until then the
  mean predictions are correct but interval widths are approximate.

---

## 5. Test / shadow / rollback

1. **Unit/parity**: after 4a-4d, run a single event through
   `predictEventRecap.ts` and confirm Open Class corps get sane baselines
   (no 15-20pt debut errors) and the agnostic path zeros the identity scales.
2. **Shadow**: generate V10 predictions side-by-side with final2 for the next
   untouched 2026 shows (the July-16 8-row gate + later), store both, compare
   total/recap. Do NOT switch the selector yet. Reuse the
   `model_event_prediction_runs`/`rows` tables (final2's production predictions
   are already there; write V10 under a distinct `model_dir` tag).
3. **Backtest guard**: run `scripts/backtestPredictionModes.ts` (2025 replay) and
   the 2026 walk-forward as in `docs/MODEL_IMPROVEMENT_NOTES.md` section 4 — judge
   on the P2 ensemble, not `target` mode alone.
4. **Switch**: repoint the production model resolution to the V10 ensemble; keep
   final2 as the rollback (it stays available; the change is a selector/config
   flip). Re-emit predictions (`scripts/nightly-predictions.sh` /
   publish per `docs/DATA_QUALITY_NOTES.md` section 8).
5. **Rollback**: revert the model-dir/curve config to final2; re-run the nightly
   batch. All changes are config/data, reversible.

---

## 6. Retire the post-hoc correction layers (after V10 is live and validated)
Per `docs/MODEL_IMPROVEMENT_NOTES.md` section 5:
- The in-season bias correction (commit 3d5bf03) and thin-history
  comparable-revert (a5a6abd) exist to patch final2's tail. V10 fixes the tail at
  the data/curve level, so after a walk-forward confirms V10 matches/beats those
  corrections, remove them rather than stacking them on V10.

---

## 7. Open verification points (do during implementation, don't assume)
- [ ] 4a: dev3 builder runs cleanly against the LIVE prod DB (not only the frozen
  snapshot); row counts/divisions sane; parity guards pass.
- [ ] 4c: `corpsScale`/`judgeBiasScale` = 0 is a true hard gate in the graph
  (LambdaScale) so agnostic inference is identity-free.
- [ ] 4d: averaging the 8 caption p50s (then deriving total) reproduces the
  `ensembleCombined.py` numbers on a known event.
- [ ] 4f: ensemble interval coverage on 2025 validation lands near target after
  recalibration.
- [ ] Inference time for N members in the nightly batch is acceptable (it should
  be; predictions are batch, not per-request).
