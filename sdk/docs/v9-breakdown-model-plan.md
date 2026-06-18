# V9 Breakdown Model Plan

Updated: 2026-06-05

This plan describes a second-stage model that predicts the detailed recap breakdown beneath the existing V9 caption predictions. The active V9 model remains the primary score model. The V9 breakdown layer consumes V9 prediction anchors plus the same model context and predicts how each caption total should split into Content/Repertoire and Achievement/Performance.

## Implementation Status

Initial infrastructure is in place:

- Shared normalization/aggregation helper: `src/training/v9BreakdownData.ts`
- Coverage audit: `scripts/auditV9BreakdownCoverage.ts`
- Isolated table builder: `scripts/buildMlSequencesV9Breakdown.ts`
- Baseline evaluator: `scripts/evaluateV9BreakdownBaselines.ts`
- MVP trainer: `src/training/trainModelV9Breakdown.ts`
- Generated table: `ml_sequence_rows_v9_breakdown`

Synthetic generated-data snapshot:

```text
source V9 rows: 7,321
breakdown rows: 29,284
anchor modes: teacher_forcing, synthetic_noisy, baseline, partial_synthetic_dropout
rows with any valid target pair: 7,321 / 7,321
rows with all 8 target pairs: 7,316 / 7,321
scale repairs: 0
scale exclusions: 5
bad prior feature shape: 0
```

Current allocation baselines:

```text
50/50 split subcaption MAE: 0.3378
historical ratio subcaption MAE: 0.3163
blended prior ratio subcaption MAE: 0.3120
```

Real V9 anchor build:

```text
command: npx tsx scripts/buildMlSequencesV9Breakdown.ts --model-dir latest --apply --output results/v9-breakdown-real-anchor-build-report.json
source_v9_model_id: v9-real-v9_prod_fingerprint_preseason_final2_1779976626982-41dbeb985a04
source_v9_model_path: models/v9_subcaption_fixed/v9_prod_fingerprint_preseason_final2_1779976626982
anchor modes: v9_predicted, baseline, partial_synthetic_dropout
selected source rows: 7,321
breakdown rows: 21,963
scale repairs: 0
scale exclusions: 5
```

Real-anchor allocation baselines:

```text
command: npx tsx scripts/evaluateV9BreakdownBaselines.ts --source-model-id v9-real-v9_prod_fingerprint_preseason_final2_1779976626982-41dbeb985a04 --output results/v9-breakdown-real-anchor-baseline-eval.json
50/50 split subcaption MAE: 0.5896
historical ratio subcaption MAE: 0.5820
blended prior ratio subcaption MAE: 0.5802
```

Real-anchor date-forward smoke:

```text
command: npx tsx src/training/trainModelV9Breakdown.ts --source-model-id v9-real-v9_prod_fingerprint_preseason_final2_1779976626982-41dbeb985a04 --trial-id v9_breakdown_real_anchor_datefwd_smoke --epochs 3 --maxRows 4096 --batch 128 --val-mode date-forward --val-split 0.1 --eval-anchor-modes v9_predicted,baseline,partial_synthetic_dropout
saved model: models/v9_breakdown/v9_breakdown_real_anchor_datefwd_smoke
production-like validation subcaption MAE: 0.6143
production-like validation blended-prior MAE: 0.6149
production-like test subcaption MAE: 0.3766
production-like test blended-prior MAE: 0.3785
anchor sum error: ~0
```

The real-anchor smoke clears plumbing and barely beats blended-prior validation on a sampled date-forward run. This is not enough to ship; the next quality gate is a full, no-`maxRows` date-forward run.

Next full candidate command:

```bash
npx tsx src/training/trainModelV9Breakdown.ts \
  --source-model-id v9-real-v9_prod_fingerprint_preseason_final2_1779976626982-41dbeb985a04 \
  --trial-id v9_breakdown_real_anchor_datefwd_full \
  --epochs 80 \
  --batch 128 \
  --val-mode date-forward \
  --val-split 0.1 \
  --eval-anchor-modes v9_predicted,baseline,partial_synthetic_dropout
```

The first learned V9 breakdown model should beat the blended-prior baseline on date-forward production-like validation before it is considered worth integrating.

Trainer smoke status:

```text
command: npx tsx src/training/trainModelV9Breakdown.ts --trial-id v9_breakdown_fix_smoke_3 --epochs 1 --maxRows 2048 --batch 64 --val-mode split
saved model: models/v9_breakdown/v9_breakdown_fix_smoke_3
validation subcaption MAE: 0.3743
anchor sum error: ~0
```

The smoke run only verifies data loading, tensor shapes, sum-preserving output, checkpoint/report generation, and production-like evaluation excluding teacher-forcing rows. It is not a quality run and does not beat the blended-prior baseline yet.

Correctness fixes already applied:

- Synthetic anchors are labeled `synthetic_noisy` / `partial_synthetic_dropout`, not `v9_predicted*`.
- Generated table rebuilds are wrapped in a transaction.
- Trainer reports both final-model metrics and best-checkpoint metrics.
- Production-like evaluation excludes `teacher_forcing` by default.
- Baselines distinguish `historical_ratio` from `blended_prior_ratio`.
- Prior subcaption static features are extracted through `extractV9BreakdownPriorFeatures`; the audit fails if the static vector cannot contain that block.

Prior-aware date-forward smoke:

```text
command: npx tsx src/training/trainModelV9Breakdown.ts --trial-id v9_breakdown_datefwd_smoke --epochs 3 --maxRows 4096 --batch 128 --val-mode date-forward --val-split 0.1
saved model: models/v9_breakdown/v9_breakdown_datefwd_smoke
validation subcaption MAE: 0.3618
validation historical-ratio MAE: 0.3646
test subcaption MAE: 0.2690
test historical-ratio MAE: 0.2837
anchor sum error: ~0
```

This is still a smoke-scale run from before the blended-prior gate was added; it shows the residual-around-prior trainer can beat its matching historical-ratio allocator on a sampled date-forward split, but the real integration gate is now the blended-prior baseline.

## 1) Objective

The current active model path, `trainModelV9Subcaption-fixed.ts`, predicts the eight canonical caption totals:

```text
GE1, GE2, VP, VA, CG, MB, MA, MP
```

It then derives categories and total with DCI scoring math:

```text
GE     = GE1 + GE2
Visual = (VP + VA + CG) / 2
Music  = (MB + MA + MP) / 2
Total  = GE + Visual + Music
```

The V9 breakdown layer should predict the internal breakdown for each caption:

```text
Content/Repertoire + Achievement/Performance ~= Caption Total
```

The production output should be a richer predicted recap:

```ts
type V9Breakdown = {
  caption: "GE1" | "GE2" | "VP" | "VA" | "CG" | "MB" | "MA" | "MP";
  predictedCaptionTotal: number;
  predictedContent: number;
  predictedAchievement: number;
  contentShare: number;
  anchorMode: V9BreakdownAnchorMode;
  source: "model" | "ratio_baseline" | "unavailable";
};
```

## 2) Non-Goals

- Do not replace V9 as the primary caption/category/total predictor.
- Do not train the breakdown layer to explain penalties. Penalties affect official total but do not belong in caption/subcaption allocation.
- Do not mutate `ml_sequence_rows_v9_subcaption`.
- Do not depend on live scraping. The V9 breakdown layer should train from relational tables and cached/reingested recap data.
- Do not use true target caption totals as the only training anchors. That creates a teacher-forcing mismatch because production receives imperfect V9 predictions.

## 3) Core Modeling Framing

The V9 breakdown layer is an allocation model, not a full score model.

At inference:

1. Build V9 prediction features.
2. Run V9 and obtain predicted caption totals, categories, total, and uncertainty.
3. Feed those anchors plus the V9 feature context into the breakdown layer.
4. Project or constrain V9 breakdown output so each predicted breakdown sums to the V9 caption anchor.
5. Persist/display the enriched recap.

The important production invariant is:

```text
predictedContent[caption] + predictedAchievement[caption] = V9_predictedCaptionTotal[caption]
```

Training can also measure consistency against the true caption total, but production display should stay coherent with V9 because V9 is the upstream authority for predicted scores.

## 4) Source Data

The V9 breakdown layer uses the same cleaned model-facing context as V9, plus normalized target subcaptions from `subcaption_scores`.

Primary source rows:

- `ml_sequence_rows_v9_subcaption`
  - `x_sequence_json`
  - `x_static_json`
  - `judge_indices_json`
  - `y_recap_json`
  - `y_total`
  - `corps_id`
  - `division_name`
  - `competition_slug`
  - `competition_date`
  - `agnostic_show_id`
- `subcaption_scores`
  - `competition_slug`
  - `corps_key`
  - `caption_name`
  - `subcaption_name`
  - `score`
- V9 model outputs generated for historical rows
  - q10/q50/q90 caption predictions
  - derived categories
  - derived total
  - interval widths
  - model/version metadata

The current experimental MTL path already has relevant pieces:

- `sdk/scripts/buildMlSequencesV9SubcaptionMTL.ts`
- `sdk/src/training/trainModelV9SubcaptionMTL.ts`
- `sdk/v9subcaption_mtl_plan.md`

The V9 breakdown layer should borrow the useful subcaption normalization and target extraction ideas, but it should not inherit the full MTL architecture unchanged. The mature V9 fixed model should stay upstream, and The V9 breakdown layer should explicitly condition on V9 anchors.

## 5) Canonical Captions And Subcaption Normalization

Canonical captions:

```ts
const V9_BREAKDOWN_CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
```

Canonical subcaption groups:

```ts
type V9BreakdownSubcaptionKind = "content" | "achievement";
```

Known label families:

```text
content:
  content, repertoire, composition, rep, comp, design,
  repertoire/composition, design development, composition development,
  repertoire effect, design effect

achievement:
  achievement, performance, execution, perf, excellence,
  clarity & excellence, performer excellence, performance/showmanship,
  performer effect, accuracy, technique, intonation, tone, expression
```

Normalization requirements:

- Use exact canonical caption mapping before fuzzy matching.
- Treat unknown/ambiguous subcaption labels as unavailable, not zero.
- Normalize subcaption scale so valid `content + achievement` matches the canonical caption total scale.
- Keep provenance for raw labels and scale repairs in the build/audit report.

## 6) Data Contract

Create an isolated table:

```text
ml_sequence_rows_v9_breakdown
```

Recommended schema:

```sql
CREATE TABLE IF NOT EXISTS ml_sequence_rows_v9_breakdown (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  season TEXT NOT NULL,
  competition_slug TEXT NOT NULL,
  competition_date TEXT NOT NULL,
  division_name TEXT NOT NULL,
  corps_key TEXT NOT NULL,
  corps_id INTEGER NOT NULL,

  x_sequence_json TEXT NOT NULL,
  x_static_json TEXT NOT NULL,
  judge_indices_json TEXT NOT NULL,
  agnostic_show_id INTEGER NOT NULL DEFAULT 0,

  baseline_recap_json TEXT NOT NULL,
  v9_pred_recap_json TEXT NOT NULL,
  v9_pred_q10_json TEXT NOT NULL,
  v9_pred_q90_json TEXT NOT NULL,
  v9_pred_category_json TEXT NOT NULL,
  v9_pred_total REAL NOT NULL,
  v9_interval_width_json TEXT NOT NULL,

  anchor_mode TEXT NOT NULL,
  anchor_dropout_mask_json TEXT NOT NULL,
  anchor_noise_std REAL NOT NULL DEFAULT 0,

  y_caption_json TEXT NOT NULL,
  y_subcaption_json TEXT NOT NULL,
  y_subcaption_mask_json TEXT NOT NULL,
  y_category_json TEXT NOT NULL,
  y_total REAL NOT NULL,

  split TEXT NOT NULL,
  builder_version TEXT NOT NULL,
  source_v9_model_id TEXT NOT NULL,
  source_v9_model_path TEXT,
  source_v9_model_card_sha256 TEXT,
  created_at TEXT NOT NULL,

  UNIQUE (competition_slug, corps_key, source_v9_model_id, anchor_mode)
);
```

Target JSON:

```ts
type V9BreakdownSubcaptionTarget = Record<
  V9BreakdownCaption,
  {
    content: number;
    achievement: number;
  }
>;

type V9BreakdownSubcaptionMask = Record<
  V9BreakdownCaption,
  {
    content: boolean;
    achievement: boolean;
    pair: boolean;
  }
>;
```

Rows may have valid targets for some captions and missing targets for others. Missing subcaption values should be masked in loss, not encoded as zero targets.

## 7) V9 Prediction Anchors

The V9 breakdown layer must be trained with anchors that resemble production anchors.

Anchor inputs:

```text
v9_pred_recap:       [8]
v9_pred_q10:         [8]
v9_pred_q90:         [8]
v9_interval_width:   [8]
v9_pred_category:    [3]
v9_pred_total:       [1]
baseline_recap:      [8]
anchor_mask:         [8]
anchor_confidence:   optional [8] or scalar
```

Anchor modes:

```ts
type V9BreakdownAnchorMode =
  | "v9_predicted"
  | "synthetic_noisy"
  | "baseline"
  | "partial_synthetic_dropout"
  | "full_dropout"
  | "teacher_forcing";
```

Training mix target:

```text
60% real v9_predicted, or synthetic_noisy until real out-of-fold V9 predictions exist
15% baseline
15% partial_synthetic_dropout
5% full_dropout
5% teacher_forcing
```

Teacher forcing should be rare and used only to stabilize early training. The model must not depend on perfect target caption totals.

Preferred anchor generation quality:

1. Best: out-of-fold V9 predictions from date-forward or season-fold models.
2. Good: active V9 predictions with realistic noise/dropout added.
3. MVP: true captions with V9-like noise/dropout, explicitly labeled `synthetic_noisy` or `partial_synthetic_dropout`.

If using active V9 predictions for rows the V9 model trained on, record this as `source_v9_model_id` provenance and treat metrics as optimistic. Date-forward validation must remain the serious quality gate.

## 8) Leakage Controls

The V9 breakdown layer inherits all V9 as-of requirements:

- Sequence features must use shows strictly before the target show.
- Judge/corps Elo features must be `elo_before`, not season-final ratings.
- Current rank/context features must match the declared prediction mode.
- Target subcaption values must never enter `x_sequence_json`, `x_static_json`, or anchors except in the rare explicit `teacher_forcing` anchor mode.
- If target caption totals are used as anchors for augmentation, the row must be labeled `teacher_forcing`, `synthetic_noisy`, or `partial_synthetic_dropout` according to how the anchor was created.

Specific V9 breakdown leakage risk:

```text
true caption total -> subcaption allocation
```

This is acceptable only for a small teacher-forcing slice. Production receives predicted caption totals, so validation should prioritize predicted-anchor rows.

## 9) Builder Plan

Add:

```text
sdk/scripts/buildMlSequencesV9Breakdown.ts
```

The builder should:

1. Read valid rows from `ml_sequence_rows_v9_subcaption`.
2. Join target subcaptions from `subcaption_scores`.
3. Canonicalize caption names.
4. Normalize subcaption labels to `content` / `achievement`.
5. Aggregate double panels correctly.
6. Validate subcaption scale and caption consistency.
7. Load or generate V9 prediction anchors.
8. Write `ml_sequence_rows_v9_breakdown`.
9. Emit a coverage and data-quality report.

Double-panel aggregation:

- If a caption has multiple judges, aggregate at the judge level first when possible.
- The final normalized pair should correspond to the averaged caption total.
- A row is valid for a caption only if both content and achievement are present after aggregation.

Scale validation:

```text
abs((content + achievement) - y_caption[caption]) <= tolerance
```

Recommended tolerance:

```text
strict: 0.05
repairable: 0.20
exclude: > 0.20
```

For repairable rows, allow a scale projection:

```text
scale = y_caption / max(content + achievement, epsilon)
content *= scale
achievement *= scale
```

Record repair counts in the report.

## 10) Coverage Audit

Add:

```text
sdk/scripts/auditV9BreakdownData.ts
```

The audit should report:

```text
total rows
rows with any valid subcaption pair
rows with all 8 valid pairs
valid pairs by caption
valid pairs by season
valid pairs by division
valid pairs by source era
scale repairs
scale exclusions
unknown subcaption labels
caption aliases not mapped
target caption mismatch count
sequence/static dimension checks
anchor dimension checks
anchor mode distribution
source_v9_model_id distribution
```

Hard failures:

- bad sequence dimension
- bad static dimension
- missing `y_caption_json`
- missing all subcaption targets
- non-finite anchors
- non-finite targets
- negative repaired targets
- impossible caption totals

Soft warnings:

- partial subcaption targets
- sparse Open Class coverage
- old seasons with label drift
- high repair rate for a caption/source

## 11) Model Architecture

Add:

```text
sdk/src/training/trainModelV9Breakdown.ts
```

Recommended inputs:

```ts
sequence: [15, 101]
static: [V9_STATIC_DIM]
mask: [15]
judge_ids: [8]
corps_id: [1]
agnostic_show_id: [1]

pred_recap: [8]
pred_q10: [8]
pred_q90: [8]
baseline_recap: [8]
pred_category: [3]
pred_total: [1]
anchor_mask: [8]
history_len: [1]
mode_flags: optional
```

Recommended architecture:

```text
sequence -> BiLSTM or lightweight attention pooling
judge/corps/show ids -> embeddings
anchors -> anchor projection dense block
static + context + embeddings + anchors -> shared trunk
shared trunk -> ratio head + residual head
projection layer -> content/achievement outputs
```

Preferred parameterization:

```text
content_share = sigmoid(ratio_head[caption])
base_content = pred_caption * content_share
base_achievement = pred_caption * (1 - content_share)

residual_content, residual_achievement = residual_head

raw_content = base_content + residual_content
raw_achievement = base_achievement + residual_achievement
```

Then project:

```text
raw_content = max(raw_content, 0)
raw_achievement = max(raw_achievement, 0)
sum = raw_content + raw_achievement

content = pred_caption * raw_content / max(sum, epsilon)
achievement = pred_caption * raw_achievement / max(sum, epsilon)
```

This guarantees sum coherence with V9 anchors at inference.

Output:

```text
content:      [8]
achievement:  [8]
contentShare: [8] optional, can be derived
```

MVP alternative:

- Direct 16-value output with strong consistency loss.
- Easier to build, but less robust. Use only as a baseline.

## 12) Loss Function

Use masked losses because not every row will have every subcaption pair.

Primary:

```text
subcaption_loss =
  maskedHuber(pred_content, true_content)
  + maskedHuber(pred_achievement, true_achievement)
```

Consistency with anchor:

```text
anchor_consistency_loss =
  Huber(pred_content + pred_achievement, anchor_caption_total)
```

Consistency with true caption:

```text
true_caption_consistency_loss =
  maskedHuber(pred_content + pred_achievement, true_caption_total)
```

Ratio prior:

```text
ratio_prior_loss =
  Huber(pred_content_share, historical_content_share[caption, division, phase])
```

Bounds:

```text
bounds_loss =
  relu(-content)^2
  + relu(-achievement)^2
  + relu(content - anchor_caption)^2
  + relu(achievement - anchor_caption)^2
```

Suggested initial weights:

```text
subcaption_loss:                 1.00
anchor_consistency_loss:         0.50
true_caption_consistency_loss:   0.20
ratio_prior_loss:                0.05
bounds_loss:                     0.10
```

Curriculum:

```text
Phase A: ratio/subcaption basics
  subcaption 1.0, anchor consistency 0.2, ratio prior 0.1

Phase B: stronger anchor coherence
  subcaption 1.0, anchor consistency 0.5, ratio prior 0.05

Phase C: production robustness
  increase dropout/noise, keep anchor consistency 0.5-1.0
```

## 13) Prediction Modes

The V9 breakdown layer must support the same availability modes as V9:

```text
as_of_show_date
panel_unknown
lineup_unknown
preseason_forecast
```

Mode behavior:

```text
as_of_show_date:
  use prior sequence, lineup/order if known, judges if known, V9 anchors

panel_unknown:
  zero judge IDs/Elo-derived judge features, keep V9 anchors

lineup_unknown:
  mask performance order and opponent context, keep V9 anchors

preseason_forecast:
  hide same-season sequence/current-rank/current-form
  hide judges and lineup unless explicitly known
  rely on V9 anchors, baseline recap, historical fingerprints, and ratio priors
```

The V9 prediction mode and provenance should be passed through to the breakdown layer. A V9 breakdown row produced from a preseason V9 forecast should not be treated as equivalent to an as-of-show-date prediction.

## 14) Baselines

The V9 breakdown layer must beat simple allocation baselines before it is worth shipping.

Baseline 1: fixed 50/50 split.

```text
content = caption / 2
achievement = caption / 2
```

Baseline 2: historical caption ratio.

```text
content = caption * mean_content_share[caption, division, season_phase]
achievement = caption * (1 - share)
```

Baseline 3: corps/caption historical ratio.

```text
content share = prior-season or multi-year content share for this corps/caption
fallback = Baseline 2
```

Baseline 4: existing V9 MTL experimental model, if runnable and comparable.

Production acceptance should require beating Baseline 2. Beating only 50/50 is not enough to justify model complexity.

## 15) Evaluation

Primary metrics:

```text
content_mae_pts
achievement_mae_pts
subcaption_mae_pts
content_share_mae
caption_sum_error_pts
valid_pair_coverage
```

Secondary metrics:

```text
by_caption
by_division
by_season_phase
by_history_depth
by_forecast_mode
by_judge_mode
by_anchor_mode
by_anchor_error_bucket
by_v9_width_bucket
```

Anchor error buckets:

```text
0.00 - 0.25
0.25 - 0.50
0.50 - 1.00
1.00+
```

V9 width buckets:

```text
narrow
medium
wide
very_wide
```

Named evaluation sets:

```text
validation_date_forward
test_2024_finals
test_world_class
test_open_class
test_preseason_forecast
test_panel_unknown
test_partial_subcaption_coverage
```

Report files:

```text
sdk/models/v9_breakdown/<run_id>/model-card.json
sdk/models/v9_breakdown/<run_id>/eval_report.json
sdk/results/v9-breakdown-training-log.csv
```

## 16) Persistence

Do not overload V9 prediction rows unless the current schema naturally supports breakdowns. Prefer a separate table:

```text
model_event_prediction_breakdown_rows
```

Recommended schema:

```sql
CREATE TABLE IF NOT EXISTS model_event_prediction_breakdown_rows (
  prediction_id TEXT NOT NULL,
  corps_key TEXT NOT NULL,
  caption TEXT NOT NULL,
  predicted_caption_total REAL NOT NULL,
  predicted_content REAL NOT NULL,
  predicted_achievement REAL NOT NULL,
  content_share REAL NOT NULL,
  anchor_mode TEXT NOT NULL,
  source TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (prediction_id, corps_key, caption)
);
```

Fallback rows may use:

```text
source = "ratio_baseline"
```

## 17) Inference Integration

Add a feature-gated second step:

```text
getOrCreate2026EventPrediction
  -> run V9 caption model
  -> optionally run V9 breakdown model
  -> persist V9 breakdown rows
  -> return enriched recap
```

Fallback order:

1. V9 breakdown model output if model loads and outputs valid values.
2. Corps/caption historical ratio baseline.
3. Division/caption/phase ratio baseline.
4. 50/50 split.

Validity repair at inference:

```text
content = max(content, 0)
achievement = max(achievement, 0)
if content + achievement <= epsilon:
  content = caption * fallback_share
  achievement = caption - content
else:
  scale = caption / (content + achievement)
  content *= scale
  achievement *= scale
```

## 18) UI Considerations

The UI should not imply V9 breakdown confidence equals V9 total-score confidence.

Recommended display:

- Keep existing V9 caption totals as the primary recap.
- Add expandable caption detail rows or stacked subcaption bars.
- Use subdued styling for model-derived breakdowns.
- If `source = ratio_baseline`, label internally in data and consider a lower-confidence visual treatment.
- Avoid showing breakdowns when all values are pure fallback unless the UI clearly treats them as estimated allocation.

## 19) Edge Cases

### Missing subcaption data

- Mask missing pairs in loss.
- Do not encode missing targets as zero.
- If an entire row has no valid subcaption pairs, skip it for V9 breakdown training.

### Partial captions

- Train on valid caption pairs in the row.
- Exclude invalid pairs from loss and per-caption metrics.

### Double panels

- Aggregate subcaption values so the pair corresponds to the averaged caption score.
- Validate after aggregation.

### Scale mismatch

- Detect whether raw subcaption values are already caption-scale or need projection.
- Repair only within a small tolerance.
- Exclude large mismatches and report them.

### Penalties

- Do not allocate penalties into subcaption values.
- Use V9 caption anchors, not official total, as the sum constraint.

### Open Class

- Keep division-aware priors and metrics.
- Consider separate heads or separate models if Open Class materially lags World Class.

### Preseason

- Use masked sequence/current-form features.
- Rely more on V9 anchors, baseline recap, and historical ratio/fingerprint features.
- Expect lower reliability and measure separately.

### Bad V9 anchors

- Use V9 interval width and prediction mode as confidence inputs.
- Train with noisy anchors and dropout so the breakdown layer does not overfit to perfect anchors.
- Production output should still sum to V9 anchors for coherence.

### Historical scoring drift

- Include season/date/progress features.
- Downweight very old seasons if date-forward validation improves.
- Report by season bucket.

## 20) Implementation Milestones

### Milestone A: Documentation And Audits

- Add this plan.
- Add `scripts/auditV9BreakdownCoverage.ts`.
- Report subcaption coverage before building any model table.
- Decide whether enough valid target coverage exists by caption/division.

Acceptance:

```text
coverage report exists
unknown labels listed
scale mismatch counts known
valid pair counts known by caption/division/season
```

### Milestone B: V9 Breakdown Table Builder

- Add `scripts/buildMlSequencesV9Breakdown.ts`.
- Build `ml_sequence_rows_v9_breakdown`.
- No destructive writes outside the V9 breakdown table.
- Prefer `--dry-run` and `--apply`.

Acceptance:

```text
valid rows inserted
sequence/static/anchor dimensions verified
subcaption masks populated
builder report written
```

### Milestone C: Baseline Evaluator

- Add `scripts/evaluateV9BreakdownBaselines.ts`.
- Evaluate 50/50, historical ratio, and corps/caption ratio baselines.

Acceptance:

```text
baseline metrics by caption/division/phase
production threshold established
```

### Milestone D: MVP Trainer

- Add `src/training/trainModelV9Breakdown.ts`.
- Use predicted/noisy anchors, ratio-plus-residual output, masked Huber losses.
- Save model card and eval report.

Acceptance:

```text
smoke training completes
saved model loads
inference output sums to anchors
beats 50/50 validation baseline
```

### Milestone E: Honest Anchors

- Generate V9 predicted anchors for historical rows.
- Add out-of-fold/date-forward anchor generation if practical.
- Record source model metadata.

Acceptance:

```text
anchor provenance present
anchor mode distribution reported
date-forward validation available
```

### Milestone F: Production Evaluation

- Compare against historical ratio baseline.
- Evaluate all named slices.
- Tune dropout/noise/curriculum only against validation, not test.

Acceptance:

```text
beats historical ratio baseline overall
no severe caption/division regression
caption sum error near zero after projection
preseason/panel_unknown fallback behavior acceptable
```

### Milestone G: Inference And Persistence

- Add V9 breakdown inference loader.
- Add optional persistence table.
- Integrate behind a feature flag.

Acceptance:

```text
V9-only path still works
V9 breakdown optional path returns enriched recap
fallback path works when model unavailable
prediction rows include model version/provenance
```

### Milestone H: UI

- Add expandable/staged breakdown display only after production evaluation passes.
- Keep V9 totals visually primary.

Acceptance:

```text
UI handles model/fallback/unavailable sources
no overlap with existing prediction controls
```

## 21) Suggested Commands

Run from `sdk/`.

Coverage audit:

```bash
npx tsx scripts/auditV9BreakdownCoverage.ts
```

Build V9 breakdown rows dry-run:

```bash
npx tsx scripts/buildMlSequencesV9Breakdown.ts --dry-run
```

Build V9 breakdown rows:

```bash
npx tsx scripts/buildMlSequencesV9Breakdown.ts --apply
```

Evaluate baselines:

```bash
npx tsx scripts/evaluateV9BreakdownBaselines.ts
```

Smoke train:

```bash
npx tsx src/training/trainModelV9Breakdown.ts --trial-id v9_breakdown_smoke --epochs 1 --maxRows 512 --batch 32
```

Date-forward training:

```bash
npx tsx src/training/trainModelV9Breakdown.ts --trial-id v9_breakdown_datefwd --val-mode date-forward --epochs 200 --batch 128
```

## 22) Acceptance Criteria

MVP:

```text
V9 breakdown table builds without destructive writes
audit has no hard failures
model trains and saves
inference output is non-negative
content + achievement sums to anchor caption total
validation beats 50/50 baseline
fallback works when model is missing
```

Production:

```text
beats historical ratio baseline by a meaningful margin
date-forward validation is stable
World Class and Open Class slices are reported
no caption slice is clearly worse than baseline without fallback
preseason and panel_unknown modes are explicitly evaluated
model-card includes data/model provenance
prediction persistence includes source/model version
```

Recommended go/no-go:

```text
Ship the V9 breakdown layer only if it beats blended-prior allocation on date-forward production-like validation.
If it only beats 50/50, keep the ratio baseline and do not add model complexity.
```
