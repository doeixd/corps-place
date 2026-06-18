# DCI V5 Plan (Updated)

## Summary
This update extends the V5 roadmap to incorporate richer historical context, opponent field dynamics, judge panel effects, and travel/logistics signals. The emphasis is on fixed-size, leakage-safe features computed “as‑of” each show.

## Guiding Principles
- Compute all features strictly **as‑of** the target show (no future leakage).
- Prefer **fixed-size aggregates** over per-corps padding.
- Add **ablation checkpoints** for each new feature group.
- Keep features explainable and aligned to existing training targets (residuals + quantiles).

## New Feature Expansion (Phase Addendum)

### 1) Opponent/Field History (As‑of Aggregates)
**Goal:** Give each corps a contextual snapshot of the full field without exploding input size.
- Opponent residual summary (as‑of): mean, median, std, min, max.
- Percentiles (p25/p75) of opponent residuals.
- Rank‑weighted opponent mean residual (weights by current rank or prior rank).
- Top‑K opponent snapshot (K=3–5): residual, slope, last‑show gap, rank delta.
- Field strength markers: top‑5/top‑12 count (as‑of), field median historical rank.

**Outputs:**
- New static feature block (`field_summary_*`).
- Optional small sequence block for top‑K rivals (fixed K, padded if needed).

### 2) Corps Rolling Form (As‑of Momentum)
**Goal:** Stabilize predictions by embedding recent trajectory.
- Per‑caption last residual (p50), EMA(α=0.3), slope over last 3–5 shows.
- Overall residual trend/volatility (std, slope).
- Rank EMA + rank delta streak (improving/declining).

**Outputs:**
- Static features for each caption + aggregate trend features.
- Optional “momentum flags” (peak reached, streak length).

### 3) Judge Panel Features
**Goal:** Capture panel bias/variance and missingness.
- Judge assignment per caption (hashed ID or learned prior).
- Judge bias priors (mean deviation vs overall) by caption/subcaption.
- Judge spread priors (variance/dispersion) by caption.
- Coverage flags for missing panel data or recap timing.

**Outputs:**
- Static features `judge_bias_*`, `judge_spread_*`, and `has_any_judge_info`.

### 4) Travel + Logistics
**Goal:** Quantify fatigue and logistics volatility.
- Days since last show, distance from last show (km/mi).
- Rolling travel load: distance last 7–14 days, show count in window.
- Optional timezone shift and venue type if available.

**Outputs:**
- Static travel block (`travel_*`).

## Data Sources & Tables (Mapping)
- **Competitions & lineups:** `competitions`, `corps_scores`, `caption_scores`.
- **As‑of ranks:** derive from prior shows within season or previous‑season finals.
- **Judge panels:** recap/judging tables (source TBD) → build `judge_priors_v5`.
- **Travel:** location fields + geo lookup (lat/lon), prior show dates.

## Build Steps (Implementation Plan)
1. **Build “as‑of” snapshots** for each competition and corps.
2. **Compute field aggregates** (opponents only, exclude target corps).
3. **Add rolling momentum features** (caption residual EMAs/slopes).
4. **Integrate judge priors** with coverage flags.
5. **Add travel features** derived from show schedule/location.
6. **Update feature store schema** and version bump (`featureStoreV5`).
7. **Rebuild sequences** and backfill validation splits.
8. **Ablations**: field only → +momentum → +judges → +travel.

## Evaluation Additions
- Add per-feature-group ablation in `evaluateAllModelsV5`.
- Compare metrics by caption and by field strength tiers.
- Track calibration drift when adding judge features.

## Risks & Guardrails
- Ensure all opponent stats exclude target corps (no leakage).
- Avoid variable-length per-opponent vectors.
- Judge features require good identifier hygiene (stable hashed IDs).
- Travel features depend on consistent location metadata.

## Suggested Order of Execution
1. **Field aggregates + momentum** (highest ROI, easiest to compute).
2. **Judge priors** (requires data lineage work).
3. **Travel features** (depends on geo availability).

## Success Criteria
- Net MAE/RMSE improvement over current LGB/XGB baselines.
- Ablations show incremental gain (no regressions).
- Calibration improves (coverage closer to target quantiles).
