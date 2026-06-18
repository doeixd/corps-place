# V7–V9 Model Guide (Features, Data, Training, Inference)

This document explains what the V7–V9 models are trained on, how the data and features are built, where they come from, how to regenerate and verify them, and what inputs are needed at inference time.

## 1) Overview

**Model family**
- **V7 / V7-performant / V7-performant-stable**: Curriculum-style LSTM models that ingest a 15‑step sequence + a static feature vector, plus corps/judge embeddings. Targets include per-caption residuals and recap scores.
- **V8 / V9**: Same sequence dataset (V7 sequences) with additional loss design. V9 adds a per-corps EMA baseline and predicts delta-to-baseline + recap/category/total targets.

**Primary goals**
- Predict **caption scores**, **category aggregates**, and **total** from historical context, competition context, and judge/corps priors.
- Use **as‑of** semantics (no same-show leakage). All “prior” features are built using shows strictly earlier than the target show date.

## 2) Core Data Tables and Artifacts

These tables and files are required to build sequences and train V7–V9:

**Source tables (SQLite)**
- `competitions`, `corps_scores`, `caption_scores` – raw recap data by show.
- `appearances` – performance order metadata.
- `judge_assignments` – judges per show/caption.
- `judge_elo_ratings`, `corps_elo_ratings`, `corps_elo_history` – Elo priors.
- `corps_historical_features_v6` – corps history features.
- `show_aggregates_v7` – show-level aggregate stats (avg/stdev totals + per-caption avg).

**Training sequences table**
- `ml_sequence_rows_v7`: V7–V9 training/inference dataset.
  - `x_sequence_json`: 15×98 feature matrix.
  - `x_static_json`: 131‑dim vector.
  - `judge_indices_json`: 8 ints (per caption judge ID index).
  - `y_residuals_json`: baseline residual per caption.
  - `y_recap_json`: recap per caption.
  - `y_total`: total score from source table.
  - `division_name`, `season`, `competition_slug`, `competition_date`, `corps_key`, `corps_id`, `split`.

**Artifacts / configs**
- `sdk/src/training/referenceCurvesV4.json`: baseline curves used to compute residuals and rank baselines.
- `sdk/src/training/judgeIndexMap.json`: judge → index mapping.
- `sdk/src/training/corpsIndexMap.json`: corps → index mapping.

## 3) Sequence Builder (V7) — Feature Generation

Sequence building is done in:
- `sdk/src/buildMlSequencesV7.ts` (called by `sdk/scripts/buildMlSequencesV7All.ts`).

### 3.1 Divisions and Seasons
- Builds **World Class** and **Open Class** data.
- Each division is processed independently (ranks and baselines are division‑scoped).

### 3.2 Overall Rank (Season‑to‑Date)
- For each division, the builder computes an **overall season rank as‑of each show date**, based only on prior shows.
- A corps’ **entering rank** is the rank as‑of the previous show date. This avoids leakage.
- Corps without prior shows fall back to the previous season’s final rank, or the current field size.

### 3.3 Rank Baseline Curves
Rank‑baseline features come from `referenceCurvesV4.json`:
- Baselines are keyed by **rank** and **percent through season** (bucketed to 5%).
- For each caption, we compute `baseline(rankEntering, pctThrough, caption)`.
- This baseline is used for:
  - `y_residuals_json` targets (actual − baseline).
  - Static **rank‑baseline feature vector** (8 values, one per caption).

### 3.4 Sequence Features (x_sequence_json)
Each show gets a 15‑step sequence (older→newer), padded if fewer than 15 prior shows.
Feature count per timestep = **98**.

**A) Temporal (7)**
- Percent through season
- Days since previous show (clipped)
- Position in sequence
- Padding flag
- Days since season start
- Past show index fraction
- Remaining‑shows fraction

**B) Performance context (7)**
- Total score (normalized)
- Rank (normalized)
- Rank delta
- Gap to leader
- Gap to next
- Percentile in field
- Total score delta vs previous

**C) Performance order (4)**
- Order in class, order in class normalized
- Order overall, order overall normalized

**D) Per-caption features (4 × 8 = 32)**
For each caption:
- Score minus rank‑baseline
- Caption rank / field size
- Normalized caption score
- Caption score delta vs previous show

**E) Opponent summary (7)**
From opponents’ most recent prior show:
- Residual mean + std
- Rank mean + best
- Top‑3 opponent residuals

**F) Opponent last‑3 summary (27)**
From opponents’ prior 3 shows:
- Total mean / slope / volatility
- Caption means / slopes / volatilities (8×3)

**G) Show context (4)**
- Finals / semis / regional flags
- Early season flag

**H) Comparative features (10)**
From `show_aggregates_v7`:
- Relative total (z-score vs show avg)
- Relative caption scores (8)
- Show competitiveness (std total)

### 3.5 Static Features (x_static_json)
Static vector length = **131**. Built from corps history, season context, opponent context, Elo priors, and baseline curves.

**A) Corps historical (8)**
- Previous season rank
- Years in World Class
- Historical mean rank
- Historical std rank
- Historical best rank
- Best rank recency
- Finals rate
- Is new corps

**B) Season progression (8)**
- Sequence length fraction
- Rank EMA (entering rank history)
- Residual EMA mean
- Residual slope
- Residual volatility
- Rank vs historical
- Days since season start
- Shows remaining (approx)

**C) Field & competition context (8)**
- Field size
- Performance order (in‑class + overall + normalized)
- Top corps present
- Division strength
- Major show flag

**D) Caption score ranges (16)**
- Min/max per caption at current percent‑through (from season‑wide history)

**E) Residual history (17)**
- Last residual mean
- Last residual by caption (8)
- EMA residual by caption (8)

**F) Opponent context (14)**
- Residual stats (mean/median/std/min/max/p25/p75)
- Weighted residual mean
- Rank mean / rank best
- Top‑3 opponent residuals
- Top‑3 opponent ranks

**G) Opponent last‑3 (27)**
- Total mean/slope/volatility
- Caption mean/slope/volatility (8×3)

**H) Judge Elo (12)**
- Per‑caption average judge Elo (8)
- Panel mean/std/min/max

**I) Corps Elo (8)**
- Per‑caption corps Elo

**J) Rank‑baseline vector (8)**
- Baseline caption scores for **entering overall rank** at current percent‑through

**K) Division flags (3)**
- World / Open / All‑Age

### 3.6 Targets
- `y_recap_json`: actual caption recap scores.
- `y_residuals_json`: `recap − baseline(rankEntering, pctThrough)`. Baselines come from `referenceCurvesV4.json`.
- `y_total`: raw total from `corps_scores` (not re‑computed in the builder).

## 4) Model Inputs and Targets (V7–V9)

### 4.1 Inputs
All models use:
- `x_sequence_json` (15×98)
- `x_static_json` (131)
- `judge_indices_json` (8)
- `corps_id` (embedding index)

Additional V9 input:
- **EMA baseline vector** derived during training from prior shows per corps.

### 4.2 Targets
**V7 / V7‑performant / V7‑performant‑stable**
- Residual targets: 8 captions (from `y_residuals_json`).
- Recap targets: 8 captions (from `y_recap_json`).
- Total target: **sum of the 8 caption scores** (note: this is not the DCI 80‑point formula).

**V9**
- Delta targets: `recap − EMA baseline` (per caption).
- Recap targets: per caption (absolute).
- Category targets: GE, Visual, Music (derived from recap).
- Total target: **DCI formula**: `GE1+GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2`.

### 4.3 Baselines
- **Rank baseline** (static) comes from reference curves and **entering overall rank**.
- **EMA baseline** (V9) is per‑corps and computed on training data only by default.
  - Controlled by `--baseline-scope train|global`.

## 5) Regenerating the Data

**Full refresh pipeline** (recommended):
```bash
npx tsx scripts/refreshV7.ts
```
This runs:
1) `scripts/reingest2024.ts` (optional if data already loaded)
2) `scripts/computeEloRatingsV7.ts`
3) `scripts/buildShowAggregatesV7.ts`
4) `scripts/buildMlSequencesV7All.ts`

**Direct sequence rebuild**:
```bash
npx tsx scripts/buildMlSequencesV7All.ts
```

**Important**: After adding rank‑baseline features, you **must rebuild** `ml_sequence_rows_v7` so `x_static_json` has 131 values.

## 6) Verifying Data Integrity

**Database checks** (example SQL):
```sql
-- Validate sequence/static lengths (spot check)
SELECT json_array_length(x_sequence_json) AS seq_len,
       json_array_length(json_extract(x_sequence_json, '$[0]')) AS feat_dim,
       json_array_length(x_static_json) AS static_dim
FROM ml_sequence_rows_v7
LIMIT 5;
```
Expected:
- `seq_len = 15`
- `feat_dim = 98`
- `static_dim = 131`

**Programmatic checks**
- Sequence builder throws if `x_static_json.length !== 131`.
- Training scripts throw if static length mismatches expected dimensions.

**Leakage checks**
- V8/V9 explicitly zero caption features on the final timestep to prevent target leakage.

## 7) Training the Models

**V7‑performant‑stable**
```bash
npx tsx src/training/trainModelV7-performant-stable.ts
```
Uses `ml_sequence_rows_v7` and the 131‑dim static vector.

**V9**
```bash
npx tsx src/training/trainModelV9.ts
```
Uses `ml_sequence_rows_v7`, static features, and EMA baseline vectors.

## 8) Inference: What to Provide and How to Build It

### 8.1 Required Inputs (V7–V9)
To run inference, you must construct the same inputs as training:
- `x_sequence_json` (15×98) built from **prior shows only**
- `x_static_json` (131) built from same show context + historical features
- `judge_indices_json` (8) for the target show’s judges
- `corps_id` (index from `corpsIndexMap.json`)

### 8.2 Where the Inputs Come From
You can generate inference‑ready rows with the same pipeline used for training:
- `scripts/buildMlSequencesV7All.ts` (batch regeneration)
- `scripts/refreshV7.ts` (full refresh)

For live prediction at a specific competition, you must supply:
- **Prior show history** for the corps and its opponents
- **Competition metadata**: percent‑through season, performance orders, division
- **Judge panel** assignments for the target show
- **Elo ratings** for judges and corps
- **Show aggregates** from `show_aggregates_v7`
- **Rank‑baseline curves** from `referenceCurvesV4.json`

### 8.3 Rank Baseline at Inference
The rank‑baseline vector must use **overall season‑to‑date rank** as‑of the prior show. This is computed in `buildMlSequencesV7.ts` and should be reproduced in any custom inference builder.

## 9) Common Pitfalls / Gotchas

- **Static vector length**: must be 131; old rows with 123 are not compatible with V7/V8/V9 after this change.
- **Rank leakage**: do not use the current show’s rank in features. Only use rank as‑of prior shows.
- **Totals**: V7 total is sum of caption scores; V9 total follows the DCI formula.
- **Penalties**: DCI penalties are not included unless they exist inside `y_recap_json`/`total_score`.

## 10) Quick Reference – Key Files
- Feature generation: `sdk/src/buildMlSequencesV7.ts`
- Sequence rebuild: `sdk/scripts/buildMlSequencesV7All.ts`
- Full refresh pipeline: `sdk/scripts/refreshV7.ts`
- V7 training: `sdk/src/training/trainModelV7-performant-stable.ts`
- V9 training: `sdk/src/training/trainModelV9.ts`
- Baseline curves: `sdk/src/training/referenceCurvesV4.json`
- Judge/corps indices: `sdk/src/training/judgeIndexMap.json`, `sdk/src/training/corpsIndexMap.json`
