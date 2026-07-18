# V10 flip runbook — turning the ensemble on in production

Companion to `V10_PRODUCTION_GUIDE.md`. The serving code (4a–4e) is implemented on
branch `v10-serving` and validated; this is the operational checklist to actually
serve V10, and to roll back. **Nothing here is live until step 3 is run.**

Selection mechanism (important): the app serves the **most recent** saved run per
event (`latestSavedPrediction`, `ORDER BY predicted_at DESC`, model-agnostic). So
the "selector" is simply *which model the nightly batch runs* — no API change is
needed. Once the nightly writes V10 runs, the site serves them; revert the nightly
and re-run to roll back.

## 0. Prerequisites (one-time, on the prod box)
- Deploy the artifacts into `/root/corps-place/sdk`:
  - the 12 member dirs under `models/v10_clean_data_control/` and
    `models/v10_phase_aware_lr/` (verified tarball `v10-handoff.tar.gz`,
    sha256 `88a8a545…`), and
  - `src/training/v10/dev3/` (curves + maps; committed on this branch).
- The dev3 serving table `ml_sequence_rows_v10_serving` is already built in the
  live DB (all seasons; 2025/2026 complete). The nightly must **also** build 2026
  into it each night (see step 2).
- Merge branch `v10-serving` to `master` and deploy the code.

## 1. Verify (no writes)
```
cd /root/corps-place/sdk
ENS=$(ls -d models/v10_clean_data_control/*/ models/v10_phase_aware_lr/*/ | sed 's:/$::' | paste -sd,)
vp exec tsx scripts/predictEventRecap.ts --event <an-upcoming-2026-event> --season 2026 \
  --ensemble-dirs "$ENS" --agnostic \
  --reference-curves src/training/v10/dev3/referenceCurves.json \
  --template-table ml_sequence_rows_v10_serving --output /tmp/v10-check.json
```
Confirm sane totals and that Open Class corps have reasonable baselines.

## 2. Nightly: keep the dev3 serving table fresh
In `scripts/nightly-predictions.sh`, the existing 2026 sequence build (the
`buildMlSequencesV9Subcaption.ts --seasons 2026` line) should ALSO build the v10
table, e.g. add alongside it:
```
vp exec tsx src/buildMlSequencesV9Subcaption.ts --seasons 2026 \
  --reference-curves src/training/v10/dev3/referenceCurves.json \
  --table ml_sequence_rows_v10_serving
```
(Same builder, extra flags; default run still refreshes the final2 table untouched.)

## 3. Flip: point the nightly predict at V10
In `scripts/nightly-predictions.sh` line ~109, add the V10 flags to the predict
call (raise the heap — 12-member inference needs more than 1536):
```
ENS=$(ls -d "$repo_root"/sdk/models/v10_clean_data_control/*/ \
             "$repo_root"/sdk/models/v10_phase_aware_lr/*/ | sed 's:/$::' | paste -sd,)
NODE_OPTIONS="--max-old-space-size=2560" vp exec tsx scripts/predictEventRecap.ts \
  --event "$slug" --save-db \
  --ensemble-dirs "$ENS" --agnostic \
  --reference-curves src/training/v10/dev3/referenceCurves.json \
  --template-table ml_sequence_rows_v10_serving
```
The saved run's `model_dir` becomes the ensemble label, and the input signature /
fingerprint change busts the read-model cache. Run the nightly (or trigger it) to
generate V10 runs, then publish per `DATA_QUALITY_NOTES.md` §8.

## 4. Rollback
Revert the line-109 change (drop the V10 flags) and re-run the nightly. final2
runs write newer `predicted_at` rows and the site serves them again. The v10 table
and member dirs can stay; they're inert when unused. Fully reversible.

## 5. After V10 is validated live — retire the correction layers
Per `MODEL_IMPROVEMENT_NOTES.md` §5, once a walk-forward confirms V10 matches/beats
them, drop the in-season bias correction (commit 3d5bf03) and thin-history
comparable-revert (a5a6abd) rather than stacking them on V10.

## Notes / caveats
- Interval *widths* use member[0]'s calibration (4f pending); means are correct.
- Historical (pre-2025) rows in `ml_sequence_rows_v10_serving` are sparser than the
  legacy final2 table (the current builder's judge-completeness skip); 2025/2026 —
  all that 2026 forecasts use — are complete and row-for-row matched.
