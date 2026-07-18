# V10 production manifest — overnight build 2026-07-17

Status: CANDIDATE READY FOR REVIEW. Not deployed. This is the deploy spec + the
go/no-go input. The actual production switch is left for user review.

## What V10 is

The V10 production model is a **multi-seed, identity-agnostic ensemble** of the
clean-data control trainer (dev3 contract). The improvements over final2 are:
- clean domain data (decontaminated `caption_scores` -> clean view)
- **division-aware reference curves** (World vs Open Class), fixing the Open
  Class anchor bug
- **zero-anchor curve fallback** for first-ever-appearance corps
- **train-window identity vocabulary** (val/test-only corps -> unknown)
- **identity-agnostic serving** (corps/judge/show embeddings hurt out-of-sample)
- **multi-seed ensemble** (averages the seed variance frozen validation cannot
  predict)
- some members use the **phase-aware LR schedule** (best single seeds)

## Evidence (real 2026 out-of-sample walk-forward)

Frozen 2026 cohort, 161 rows, identity-agnostic, curve-anchor fallback:

| model | recap MAE | total MAE |
|---|---:|---:|
| final2 (production, as deployed) | 0.4930 | 1.5141 |
| V10 ensemble (12-model, agnostic) | **0.3790** | **1.1709** |

~23% better caption accuracy and total MAE on data the model never trained on.
On the 63 rows final2 actually forecast in production (with its correction
layers), a single dev3 checkpoint already beat it 1.53 vs 2.04 total MAE.
Recap (caption) MAE is the fundamental metric — total is a fixed derivation.



## Robustness (show-clustered bootstrap)

The 161 rows span 26 correlated shows. Bootstrapping over shows (2000 resamples):
ensemble recap MAE 0.3790, 95% CI [0.3325, 0.4412]. The CI UPPER bound (0.441)
is well below final2 agnostic (0.493), and the ensemble beats final2 on 21/26
shows. The ~23% win is statistically robust and broad-based, not a few-show
artifact.

## Ensemble members (dev3 contract, trained 2026-07-17)

Average the 8 caption p50 predictions across these models (agnostic mode), then
derive category/total by the fixed formula. Control seeds:
  seed42 v10_clean_data_control_seed42_1784310309665
  seed43 v10_clean_data_control_seed43_1784309180483
  seed44 v10_clean_data_control_seed44_1784319040206
  seed45 v10_clean_data_control_seed45_1784328103278
  seed46 v10_clean_data_control_seed46_1784328117722
  seed47 v10_clean_data_control_seed47_1784328282076
  seed48 v10_clean_data_control_seed48_1784337979944
  seed49 v10_clean_data_control_seed49_1784338135014
Phase-aware-LR seeds:
  seed42 v10_phase_aware_lr_seed42_1784328262113
  seed43 v10_phase_aware_lr_seed43_1784328243411
  seed44 v10_phase_aware_lr_seed44_1784338287990
  seed45 v10_phase_aware_lr_seed45_1784338304752
All under sdk/models/ in the WSL checkout /root/corps-place-v10 (git-ignored
artifacts; copy on deploy). A ~5-7 model subset captures nearly all the gain
(5-seed 0.3875 -> 12-seed 0.3790); if inference cost matters use a FIXED subset,
NOT a frozen-ranked one (frozen composite is ~uncorrelated with 2026).

## Matched artifacts (dev3, hash prefixes)

- corpsIndexMap.json  42b972f3  (56 inputs incl unknown=0; 54 known + 2 novel->0)
- judgeIndexMap.json  6c070478  (211 inputs)
- showIndexMap.json   7d72af15  (290 inputs)
- referenceCurves.json 96629851 (1575 cells: World Class| + Open Class| + legacy)
- training sequence payload  eefd49d4  (7317 rows, 2013-2025 clean contract)
- immutable source snapshot  5c7cd080 (v10-source-2026-07-16.db, hash-pinned)
All in sdk/src/training/v10/dev3/ and sdk/data/. Curves+maps MUST ship with the
model.

## Serving integration (bounded; touches live prediction API — review first)

Serving code is already zero-history-safe AND division-aware (see plan serving
audit). Steps:
1. Package each ensemble member dir with the dev3 curves + maps.
2. Thread `referenceCurvesPath` (dev3 curves) + dev3 maps through
   predictEventRecap / event-prediction-api model resolution (currently
   hard-codes referenceCurvesV4.json which lacks Open Class keys).
3. Serve IDENTITY-AGNOSTIC (corps/judge/show scale = 0) for future-season
   forecasts.
4. Ensemble at inference: run each member, average the 8 caption p50s, derive
   total. Predictions are a NIGHTLY BATCH job, so Nx inference is acceptable.

## Remaining before ship (recommended, not blockers to the go decision)

- History/division/split-conformal INTERVAL CALIBRATION of the ensemble
  (post-hoc; the ensemble's residuals differ from any single model). Free, no
  retrain. Compute ensemble errors on frozen validation, fit scale by
  history-depth + division.
- SHADOW: run the ensemble side-by-side with final2 on the next untouched 2026
  shows (the July-16 8-row gate + later), store both, compare, then switch.
- Optional: distill the ensemble into one graph if Nx batch inference is a
  problem (it likely is not).

## Go/no-go

GO signals: ensemble beats final2 ~23% on real out-of-sample 2026; serving is
already zero-safe + division-aware in code; every fix is data/eval-level and
reproducible with hashed artifacts. RESIDUAL RISK before flipping live: the
serving wiring (step 2) changes how any model resolves its baseline curve, so
review it; intervals not yet ensemble-calibrated; only ~160 2026 rows of
out-of-sample evidence (strong but not huge). Recommendation: wire the artifacts,
run the shadow for the next shows, review the serving diff, then switch the
selector. All reversible; final2 stays as the rollback.
