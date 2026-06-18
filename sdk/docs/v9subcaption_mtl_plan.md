# Plan: V9Subcaption-MTL (Multi-Task Learning)

This document outlines the strategy for implementing Multi-Task Learning for the V9 Subcaption model to achieve higher accuracy and stability.

## Goals
- Improve model stability and accuracy (target < 0.2 MAE) by predicting **Residuals of Baseline/Inertia** across all heads.
- Force internal logic consistency: `Content Residual + Achievement Residual = Caption Total Residual`.
- Transition to a non-destructive v9subcaption-mtl infrastructure.

## Infrastructure (Non-Destructive)
- **Table**: `ml_sequence_rows_v9subcaption_mtl` (isolated from V9).
- **Builder**: `scripts/buildMlSequencesV9SubcaptionMTL.ts`.
- **Trainer**: `src/training/trainModelV9SubcaptionMTL.ts`.

## Critical Considerations & Gotchas

### 🚨 Data Rebuild Required (High Priority)
The current `ml_sequence_rows_v9_subcaption` table **does not** include the target subcaption breakdowns in `y_recap_json`. 
- **Action**: Modify the builder to include `y_subcaption_json` containing the Content/Achievement breakdown for the target show.

### 🧩 Consistency Loss Noise
Legacy DCI data occasionally contains minor rounding errors where `Content + Achievement` does not exactly match the `CaptionTotal`.
- **Note**: The Consistency Loss will use **Huber Loss** to be robust against these minor discrepancies.

### ⚖️ Normalization Strategy
- **Decision**: Content and Achievement targets will be normalized using **Global Caption Statistics** to preserve the physical relationship between sub-scores and the total.

### 🏗️ Model Branching
Branching too early can lead to divergent heads.
- **Design**: Use a **Shared Bottleneck Layer** (Dense 256) after the BiLSTM/Attention block before splitting into the three specific heads (Total/Content/Achievement).

### 📉 Subcaption Inertia Strategy
To correctly "provide inertia" to sub-tasks:
- **Baseline Splitting**: Use **Global Subcaption Ratios** derived from the database (e.g., GE1 Repertoire is ~50.2% of Total) to split the existing caption baselines.
- **Residual Center**: Subcaption residuals calculated as: `actualValue - (captionBaseline * ratio)`.

## Proposed Changes

### 1. Data Pipeline Enhancements
- Modify the sequence generation to extract target subcaption values (Content/Achievement) for the "today" show being predicted.
- Standardize these 16 new sub-residuals using global caption metrics.

### 2. Model Architecture
- **Shared Backbone**: Existing BiLSTM and Attention layers.
- **Triple Parallel Heads**:
    - **Total Head**: Predicts the 8 caption residuals.
    - **Content Head**: Predicts 8 sub-residuals for Repertoire/Design.
    - **Achievement Head**: Predicts 8 sub-residuals for Performance/Execution.

### 3. Loss Function Evolution
- `Total MAE Loss * 1.0`
- `Content MAE Loss * 0.5`
- `Achievement MAE Loss * 0.5`
- **Consistency Constraint**: `HuberLoss( (PredContent + PredAchievement), PredTotal ) * 0.2`

### 4. Training & Monitoring
- Track `recap_mae`, `content_mae`, and `achievement_mae` independently.
- Monitor "Consistency Deviation" to ensure the heads remain logically aligned.

## Verification Plan
- **Scale Check**: Verify that predicted Content + Achievement ≈ Total in the logs.
- **Convergence Audit**: Ensure all three tasks (heads) are learning simultaneously.
