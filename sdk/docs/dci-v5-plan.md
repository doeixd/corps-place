# DCI Score Prediction V5: Technical Plan

## Executive Summary

**Goal: Maximum prediction accuracy with in-season adaptability.**

**Secondary goal:** Accurate absolute score prediction (residual + baseline), not just residuals.

V4 demonstrated that sequence modeling of DCI caption scores is feasible, achieving validation loss around 0.44 on quantile regression. The architecture has potential but is undermined by fixable issues: embedding leakage, insufficient regularization, and no online adaptation.

V5 takes an aggressive approach to accuracy:
- Fix and enhance the LSTM architecture (not abandon it)
- Test multiple model families and ensemble the winners
- Add online Bayesian updates for in-season adaptation without sacrificing the learned patterns
- Squeeze every fraction of a point through careful feature engineering, calibration, and ensembling

Philosophy: **Prove what works through rigorous comparison, then combine the best of everything.**

---

## V4 Issues to Address

### Critical Problems

1. **Embedding leakage**: Season embeddings have indices unseen during training (2022-2024 not in 2015-2019 training set). The model receives random/initialized embeddings for all validation and test data.

2. **Corps cold-start**: Corps not present in training years get uninformative embeddings. This affects new corps and corps that skipped years.

3. **Early-season degeneracy**: Shows 1-3 have mostly padding in the 15-step sequence. The model has almost no signal for early-season predictions but is trained and evaluated on them equally.

4. **Baseline inconsistency**: Feature residuals use `show.rank` (achieved rank), but target residuals use `rankAsOf` (entering rank). Minor but creates a mismatch between what the model sees and what it predicts.

5. **No baseline comparison**: We don't know if val_loss of 0.44 is good. Could a trivial predictor (predict 0, or mean of recent residuals) achieve similar performance?

### Architectural Concerns

6. **Overparameterized**: BiLSTM(64) → BiLSTM(32) → Dense(128) → Dense(64) → 24 outputs, plus embeddings. Estimated ~100k+ parameters for ~2,500 training sequences.

7. **Insufficient regularization**: Single dropout(0.2) layer. No LSTM dropout, no recurrent dropout, no weight decay.

8. **Quantile calibration unknown**: We output p10/p50/p90 but haven't verified calibration (do 10% of actuals fall below p10?).

---

<current_state_and_notes>
- Feature expansion implemented in `src/buildMlSequencesV5.ts`: opponent field aggregates + top‑3 snapshots, per‑caption last residuals, per‑caption EMA residuals, plus helper stats utilities.
- Static feature width updated from 20 → 53 in `src/buildMlSequencesV5.ts` and `src/training/trainModelV5.ts`.
- Sequences rebuilt for 2013–2024; `ml_sequence_rows_v5` backfilled with new static vectors.
- LSTM retrain started with new features but was interrupted by CLI timeouts after ~3 epochs; model artifacts not saved yet.
- Evaluation script `scripts/evaluateAllModelsV5.ts` now loads baselines + LSTM + classical error logs (XGB/LGB/Ridge) and prints N/A for unavailable metrics.
- Latest observed classical MAE from error logs: LGB ≈ 0.47, XGB ≈ 0.47, Ridge ≈ 0.66.
- Next actions: finish LSTM training, regenerate `results/model-comparison-table.md`, and re‑compare against classical models.
</current_state_and_notes>

## Model Hygiene & Reproducibility

- Persist a feature spec (ordered feature names + defaults) alongside model artifacts.
- Hash the feature spec and record in model metadata for inference safety.
- Apply numeric/embedding dropout to reduce reliance on any single signal.
- Momentum masking: randomly zero momentum features during training.
- Judge masking: randomize or drop judge IDs to handle panel cold-starts.

## V5 Architecture

### Design Principles

1. **Accuracy first**: Use whatever model complexity is justified by the data
2. **Prove value empirically**: Every model competes; winners get ensembled
3. **Fix V4, don't abandon it**: The LSTM approach may be correct; the implementation had bugs
4. **Ensemble everything that helps**: Different models capture different patterns
5. **Online adaptation**: Update predictions as season progresses without retraining

### Model Candidates (All Compete)

#### Tier 0: Baselines (Establish Floor)

These set the minimum bar. Any real model must convincingly beat these.

```typescript
baseline_zero:     predict residual = 0 (reference curve is prediction)
baseline_last:     predict residual = last observed residual  
baseline_ema:      predict residual = EMA(α=0.3) of recent residuals
baseline_lr:       predict residual = linear extrapolation of last 3
```

#### Tier 1: Classical ML (Fast to Train, Strong Baselines)

```typescript
// Gradient Boosting - often wins on tabular data
XGBoostQuantile: {
  features: aggregated sequence stats + static features,
  loss: quantile regression (α = 0.1, 0.5, 0.9),
  hyperparams: tune depth, learning rate, regularization
}

// Per-caption specialists
RidgePerCaption: {
  features: caption-specific history + cross-caption signals,
  separate model per caption,
  fast retraining for online updates
}

// Gradient boosting with sequence features
LightGBMSequence: {
  features: flattened sequence + aggregates,
  captures nonlinear interactions XGBoost might miss
}
```

#### Tier 2: Fixed LSTM (V4 Done Right)

```typescript
// V4 architecture with fixes
const FixedBiLSTM = {
  // REMOVED: season/corps embeddings (caused leakage)
  // ADDED: proper regularization throughout
  
  layers: [
    // Input: [batch, 15, 30] - enhanced features
    bidirectionalLSTM({ 
      units: 64, 
      returnSequences: true,
      dropout: 0.3,
      recurrentDropout: 0.3,
      kernelRegularizer: l2(1e-4)
    }),
    layerNorm(),  // Stabilizes training
    
    bidirectionalLSTM({ 
      units: 32, 
      returnSequences: false,
      dropout: 0.3,
      recurrentDropout: 0.3,
      kernelRegularizer: l2(1e-4)
    }),
    
    // Static features concatenated here
    concatenate([lstmOutput, staticFeatures]),
    
    dense({ units: 128, activation: 'relu', kernelRegularizer: l2(1e-4) }),
    dropout(0.4),
    dense({ units: 64, activation: 'relu', kernelRegularizer: l2(1e-4) }),
    dropout(0.3),
    dense({ units: 24 })  // 8 captions × 3 quantiles
  ],
  
  training: {
    optimizer: adam(0.0005),  // Lower LR than V4
    epochs: 200,
    patience: 20,
    reduceLROnPlateau: { factor: 0.5, patience: 10 },
    batchSize: 32
  }
};
```

#### Tier 3: Enhanced Sequence Models

```typescript
// Attention-based LSTM - learns which past shows matter most
const AttentionLSTM = {
  layers: [
    bidirectionalLSTM({ units: 64, returnSequences: true }),
    selfAttention({ heads: 4, keyDim: 32 }),  // Attend over timesteps
    globalAveragePooling(),  // Or learned weighted sum
    // ... dense layers
  ]
};

// Temporal Convolutional Network - sometimes beats LSTM
const TCN = {
  layers: [
    // Dilated causal convolutions
    conv1d({ filters: 64, kernel: 3, dilation: 1, causal: true }),
    conv1d({ filters: 64, kernel: 3, dilation: 2, causal: true }),
    conv1d({ filters: 64, kernel: 3, dilation: 4, causal: true }),
    globalMaxPooling(),
    // ... dense layers
  ]
};

// Transformer encoder (if data supports it)
const TransformerEncoder = {
  layers: [
    positionalEncoding(),
    transformerBlock({ heads: 4, ffDim: 128 }),
    transformerBlock({ heads: 4, ffDim: 128 }),
    globalAveragePooling(),
    // ... dense layers
  ],
  // May be overparameterized for ~3k sequences - test empirically
};
```

#### Tier 4: Multi-Task & Structured Output

```typescript
// Captions are correlated - model them jointly
const MultiTaskLSTM = {
  // Shared encoder
  encoder: bidirectionalLSTM({ units: 64 }),
  
  // Per-caption heads with shared representation
  heads: {
    GE1: dense([32, 3]),  // 3 quantiles
    GE2: dense([32, 3]),
    // ... etc
  },
  
  // Cross-caption attention (optional)
  // GE1 prediction informs GE2, etc.
};

// Explicitly model quantile ordering
const MonotonicQuantiles = {
  // Ensure p10 < p50 < p90 by construction
  output: {
    p50: dense(8),  // Median prediction
    p10_delta: softplus(dense(8)),  // Always positive
    p90_delta: softplus(dense(8)),  // Always positive
  },
  // p10 = p50 - p10_delta, p90 = p50 + p90_delta
};
```

### Ensemble Strategy

**Don't pick one winner - combine them all.**

```typescript
interface EnsembleConfig {
  // Level 1: Model diversity
  models: [
    { name: 'xgboost', weight: 'learned' },
    { name: 'fixed_bilstm', weight: 'learned' },
    { name: 'attention_lstm', weight: 'learned' },
    { name: 'tcn', weight: 'learned' },
  ],
  
  // Level 2: Combination strategies
  combination: 
    | 'simple_average'           // Baseline
    | 'weighted_average'         // Weights from validation performance
    | 'stacking'                 // Meta-model learns to combine
    | 'dynamic_weights'          // Weights vary by context (early/late season)
}

// Stacking meta-learner
const StackingMeta = {
  // Input: predictions from all base models + features
  // Output: final prediction
  // Learns which models to trust in which situations
  
  features: [
    ...baseModelPredictions,     // [xgb_p50, lstm_p50, ...]
    shows_completed,             // Early season: trust prior-heavy models
    corps_historical_volatility, // Volatile corps: trust recent-heavy models
    is_finals,                   // Finals: may need adjustment
  ],
  
  model: XGBoostRegressor,  // Or small neural net
};
```

### Online Adaptation Layer

**Key insight: Keep the trained ensemble, add Bayesian updates on top.**

```typescript
interface OnlineAdaptation {
  // The offline ensemble captures complex patterns
  // The online layer adapts to this specific corps' current season
  
  predict(corps: string, show: ShowContext): Prediction {
    // 1. Get ensemble prediction (trained offline)
    const ensemblePred = ensemble.predict(features);
    
    // 2. Get Bayesian adjustment (updated online)
    const bayesianState = getBayesianState(corps);
    const adjustment = bayesianState.getMeanAdjustment();
    const additionalUncertainty = bayesianState.getUncertainty();
    
    // 3. Combine
    return {
      p50: ensemblePred.p50 + adjustment,
      p10: ensemblePred.p10 + adjustment - additionalUncertainty,
      p90: ensemblePred.p90 + adjustment + additionalUncertainty,
    };
  }
  
  update(corps: string, actual: ShowResult, predicted: Prediction): void {
    // Update Bayesian state based on prediction error
    const error = actual.residual - predicted.p50;
    bayesianState.update(error);
    
    // This learns: "the ensemble is systematically 0.5 points low for this corps"
    // Without retraining the ensemble
  }
}

// Bayesian state per corps per caption
interface BayesianAdjustment {
  // Tracks: how wrong is the ensemble for this corps?
  mean_error: number;      // Running estimate of systematic bias
  error_variance: number;  // Uncertainty in that estimate
  
  // Conjugate Normal-Normal update
  update(newError: number): void;
  
  // Returns adjustment to apply to ensemble prediction
  getMeanAdjustment(): number;
  getUncertainty(): number;
}
```

This gives you **maximum accuracy from the ensemble** plus **adaptability from Bayesian updates**. The ensemble learns complex patterns offline; the Bayesian layer corrects for corps-specific drift online.

---

## Full Recap Prediction

### Output Format

Instead of just residuals, the model outputs complete predicted recaps:

```typescript
interface PredictedRecap {
  // Per-caption predictions (8 captions × 3 quantiles)
  captions: {
    GE1: { p10: number, p50: number, p90: number },
    GE2: { p10: number, p50: number, p90: number },
    VP:  { p10: number, p50: number, p90: number },
    VA:  { p10: number, p50: number, p90: number },
    CG:  { p10: number, p50: number, p90: number },
    MB:  { p10: number, p50: number, p90: number },
    MA:  { p10: number, p50: number, p90: number },
    MP:  { p10: number, p50: number, p90: number },
  },
  
  // Derived totals
  subtotals: {
    GE:     { p10: number, p50: number, p90: number },  // GE1 + GE2
    visual: { p10: number, p50: number, p90: number },  // VP + VA + CG
    music:  { p10: number, p50: number, p90: number },  // MB + MA + MP
  },
  
  // Total score prediction
  total: { p10: number, p50: number, p90: number },
  
  // Predicted placement
  predictedRank: { p10: number, p50: number, p90: number },
  
  // Metadata
  corps_key: string,
  competition_slug: string,
  generated_at: string,
}
```

### Why Joint Prediction Helps Accuracy

```
Caption correlations in DCI:
┌─────────────────────────────────────────────────────┐
│  GE1  ←→  GE2    (r ≈ 0.85)   Same judge family    │
│  VP   ←→  VA     (r ≈ 0.75)   Visual family         │
│  MB   ←→  MP     (r ≈ 0.70)   Music family          │
│  GE   ←→  Music  (r ≈ 0.65)   Design quality        │
│  GE   ←→  Visual (r ≈ 0.60)   Design quality        │
└─────────────────────────────────────────────────────┘

A corps that's +0.5 on GE1 is likely +0.4 on GE2.
Modeling jointly captures this → better predictions.
```

### Architecture: Multi-Output with Shared Encoder

```typescript
const MultiOutputModel = {
  // Shared encoder learns corps "state"
  encoder: {
    sequence: bidirectionalLSTM({ units: 64, returnSequences: true }),
    attention: selfAttention({ heads: 4 }),
    static: denseEncoder(staticFeatures),
    
    // Output: learned corps representation [batch, 128]
    corpsState: concatenate([sequenceOutput, staticOutput]),
  },
  
  // Per-caption heads (specialization)
  captionHeads: {
    GE1: dense([64, 32, 3]),  // 3 outputs: p10, p50, p90
    GE2: dense([64, 32, 3]),
    VP:  dense([64, 32, 3]),
    VA:  dense([64, 32, 3]),
    CG:  dense([64, 32, 3]),
    MB:  dense([64, 32, 3]),
    MA:  dense([64, 32, 3]),
    MP:  dense([64, 32, 3]),
  },
  
  // Cross-caption attention (lets captions inform each other)
  crossCaptionRefinement: {
    // GE1 prediction attends to GE2, Visual, Music predictions
    // "if predicting high GE, probably high Music too"
    enabled: true,
    layers: 1,
  },
};
```

### Hybrid Approach: Residuals Internally, Scores Externally

```typescript
// Model predicts residuals (normalized, stable training)
// Converts to scores for output (human-readable)

const HybridModel = {
  // Internal: predict residuals
  forward(features: Features): Residuals {
    const encoded = this.encoder(features);
    const residuals = {};
    for (const caption of CAPTIONS) {
      residuals[caption] = this.captionHeads[caption](encoded);
    }
    return residuals;
  },
  
  // External: convert to scores
  toScores(residuals: Residuals, context: ShowContext): Scores {
    const scores = {};
    for (const caption of CAPTIONS) {
      const baseline = getBaseline(context.rankEntering, context.pctThrough, caption);
      scores[caption] = {
        p10: baseline + residuals[caption].p10,
        p50: baseline + residuals[caption].p50,
        p90: baseline + residuals[caption].p90,
      };
    }
    return scores;
  },
};
```

### Joint Loss Function

```typescript
function multiCaptionLoss(yTrue: FullRecap, yPred: FullRecap): tf.Tensor {
  return tf.tidy(() => {
    let totalLoss = tf.scalar(0);
    
    // 1. Per-caption quantile loss (primary objective)
    for (const caption of CAPTIONS) {
      const captionLoss = quantileLoss(yTrue[caption], yPred[caption]);
      totalLoss = totalLoss.add(captionLoss);
    }
    
    // 2. Total score consistency loss
    // Ensures caption predictions sum to reasonable total
    const predTotal = sumCaptions(yPred);
    const trueTotal = sumCaptions(yTrue);
    const totalLoss = quantileLoss(trueTotal, predTotal);
    totalLoss = totalLoss.add(totalLoss.mul(0.5));
    
    // 3. Correlation preservation loss (optional)
    // Penalize if predicted GE1/GE2 correlation deviates from historical
    if (config.correlationLoss) {
      const corrLoss = correlationPreservationLoss(yPred);
      totalLoss = totalLoss.add(corrLoss.mul(0.1));
    }
    
    return totalLoss;
  });
}
```

### Generating Full Predicted Recaps

```typescript
async function generatePredictedRecap(
  corps_key: string,
  competition_slug: string,
  showContext: ShowContext
): Promise<PredictedRecap> {
  // 1. Build features
  const features = await buildFeatures(corps_key, showContext);
  
  // 2. Get ensemble prediction (residuals)
  const residualPred = await ensemble.predict(features);
  
  // 3. Apply Bayesian adjustment
  const adjusted = await bayesianLayer.adjust(corps_key, residualPred);
  
  // 4. Convert to scores
  const scores = convertToScores(adjusted, showContext);
  
  // 5. Compute subtotals and total
  const subtotals = {
    GE: addQuantiles(scores.GE1, scores.GE2),
    visual: addQuantiles(scores.VP, scores.VA, scores.CG),
    music: addQuantiles(scores.MB, scores.MA, scores.MP),
  };
  const total = addQuantiles(subtotals.GE, subtotals.visual, subtotals.music);
  
  return {
    captions: scores,
    subtotals,
    total,
    corps_key,
    competition_slug,
    generated_at: new Date().toISOString(),
  };
}
```

### Full Show Prediction with Rankings

```typescript
async function predictFullShow(
  competition_slug: string,
  participating_corps: string[]
): Promise<ShowPrediction> {
  // 1. Generate recap for each corps
  const recaps = await Promise.all(
    participating_corps.map(corps => 
      generatePredictedRecap(corps, competition_slug, showContext)
    )
  );
  
  // 2. Sort by predicted total (p50)
  const ranked = recaps.sort((a, b) => b.total.p50 - a.total.p50);
  
  // 3. Monte Carlo for rank uncertainty
  // Sample from predicted distributions, count rank frequencies
  const rankDistributions = monteCarloRankings(recaps, nSamples: 10000);
  
  // 4. Attach rank predictions
  const withRanks = ranked.map((recap, idx) => ({
    ...recap,
    predictedRank: {
      p50: idx + 1,
      p10: rankDistributions[recap.corps_key].percentile10,
      p90: rankDistributions[recap.corps_key].percentile90,
    },
  }));
  
  return {
    competition_slug,
    predictions: withRanks,
    insights: {
      tightestRaces: findCloseGaps(withRanks),
      upsetCandidates: findUpsetPotential(withRanks, rankDistributions),
      captionLeaders: findCaptionLeaders(recaps),
    },
  };
}
```

### Example User-Facing Output

```
╔══════════════════════════════════════════════════════════════╗
║  PREDICTED RECAP: Blue Devils                                ║
║  DCI Southwestern Championship - July 19, 2025               ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  GENERAL EFFECT                                              ║
║    GE1:  18.4  (17.9 - 18.8)                                ║
║    GE2:  18.2  (17.7 - 18.6)                                ║
║    ─────────────────────────                                 ║
║    Subtotal: 36.6  (35.6 - 37.4)                            ║
║                                                              ║
║  VISUAL                                                      ║
║    VP:   17.8  (17.2 - 18.3)                                ║
║    VA:   17.6  (17.0 - 18.1)                                ║
║    CG:   17.2  (16.5 - 17.8)                                ║
║    ─────────────────────────                                 ║
║    Subtotal: 52.6  (50.7 - 54.2)                            ║
║                                                              ║
║  MUSIC                                                       ║
║    MB:   18.0  (17.5 - 18.5)                                ║
║    MA:   17.7  (17.1 - 18.2)                                ║
║    MP:   17.5  (16.9 - 18.0)                                ║
║    ─────────────────────────                                 ║
║    Subtotal: 53.2  (51.5 - 54.7)                            ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  TOTAL:  94.8  (93.2 - 96.1)                                ║
║  PREDICTED RANK:  1st  (1st - 2nd)                          ║
║                                                              ║
║  Trend: ↑ +0.8 from last show                               ║
║  Confidence: HIGH (12 shows completed)                       ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Feature Engineering V5

### Philosophy: More Signal, Properly Aligned

V4 had 40 features, some redundant, some misaligned. V5 uses ~50 carefully designed features organized into clear categories.

### Sequence Features (per timestep): 30 features

```typescript
interface TimestepFeatures {
  // === TEMPORAL (4) ===
  pct_through_season: number;        // 0-1
  days_since_last: number;           // normalized, capped at 14
  show_index: number;                // 1-15, normalized
  is_padding: number;                // 1 if padding, 0 if real (CRITICAL)
  
  // === PERFORMANCE CONTEXT (6) ===
  total_score_norm: number;          // (score - 75) / 25
  rank_norm: number;                 // rank / 25
  rank_delta: number;                // change from previous show
  gap_to_leader: number;             // points behind #1, normalized
  gap_to_next: number;               // points behind rank-1, normalized
  percentile: number;                // 1 - (rank-1)/(field_size-1)
  
  // === PER-CAPTION FEATURES (8 captions × 2 = 16) ===
  // Using rank_entering for residuals (FIXED from V4)
  residual_GE1: number;              // actual - baseline(rank_entering, pct)
  rank_norm_GE1: number;             // caption rank / field_size
  // ... same for GE2, VP, VA, CG, MB, MA, MP
  
  // === SHOW CONTEXT (4) ===
  is_finals: number;
  is_semifinals: number;
  is_regional: number;
  is_early_season: number;           // before July 1
}
// Total: 30 features per timestep
```

### Static Features (per sequence): 20 features

```typescript
interface StaticFeatures {
  // === HISTORICAL CORPS IDENTITY (8) ===
  prev_season_rank: number;          // normalized, 0.5 if unknown
  years_in_world_class: number;      // count, normalized
  historical_mean_rank: number;      // mean final rank all years
  historical_std_rank: number;       // volatility measure
  historical_best_rank: number;      // best ever finish
  best_rank_recency: number;         // years since best finish
  made_finals_rate: number;          // % of years making finals
  is_new_to_wc: number;              // first WC season flag
  
  // === CURRENT SEASON STATE (8) ===
  sequence_length: number;           // actual non-padded shows (CRITICAL)
  current_rank_ema: number;          // EMA of ranks this season
  current_residual_ema_mean: number; // mean EMA across captions
  current_residual_slope: number;    // are they improving?
  current_volatility: number;        // std of residuals this season
  rank_vs_historical: number;        // current rank - historical mean
  days_since_season_start: number;   // normalized
  shows_remaining_approx: number;    // estimated shows left
  
  // === COMPETITION CONTEXT (4) ===
  field_size: number;                // corps competing at this show
  top_corps_present: number;         // count of top-5 historical corps
  division_strength: number;         // mean historical rank of field
  is_major_show: number;             // championships, regionals
}
// Total: 20 static features
```

### Derived / Interaction Features (for XGBoost)

```typescript
interface DerivedFeatures {
  // === MOMENTUM FEATURES ===
  residual_3show_slope_GE1: number;  // linear fit of last 3
  residual_5show_slope_GE1: number;  // linear fit of last 5
  residual_acceleration: number;     // is slope increasing?
  // ... per caption
  
  // === RELATIVE FEATURES ===
  rank_vs_expectation: number;       // current rank - prev_season_rank
  residual_vs_historical: number;    // current mean residual - historical
  
  // === CROSS-CAPTION SIGNALS ===
  ge_vs_visual_gap: number;          // GE residuals - Visual residuals
  music_vs_visual_gap: number;       // Music residuals - Visual residuals
  caption_consistency: number;       // std across caption residuals
  
  // === TRAJECTORY PATTERNS ===
  has_peaked: number;                // best residual was 3+ shows ago
  improving_streak: number;          // consecutive improving shows
  declining_streak: number;          // consecutive declining shows
}
```

### Feature Alignment Fix (CRITICAL)

```typescript
// CONSISTENT baseline computation everywhere:
function computeResidual(
  actualScore: number,
  rankEntering: number,  // rank BEFORE this show
  pctThrough: number,
  caption: string
): number {
  const baseline = getBaseline(rankEntering, pctThrough, caption);
  return actualScore - baseline;
}

// For show i:
// - rankEntering = shows[i-1].rank (or prev_season_rank if i=0)
// - Features use rankEntering
// - Target uses rankEntering
// - NO MISMATCH
```

### Data Augmentation (If Needed)

```typescript
// Option 1: Jittered sequences
// Add small noise to features during training
// Reduces overfitting to exact feature values

// Option 2: Subsequence training
// Train on subsequences (shows 1-5, 3-8, etc.)
// More training examples from same data

// Option 3: Cross-caption transfer
// Corps A's GE trajectory might inform Corps B's prediction
// Careful: may introduce leakage
```

---

## Training Protocol

### Data Splits

| Split | Seasons | Purpose | Size (approx) |
|-------|---------|---------|---------------|
| Train | 2015-2019 | Model fitting | ~1,800 sequences |
| Val | 2022-2023 | Hyperparameter tuning, early stopping, ensemble weights | ~600 sequences |
| Test | 2024 | Final evaluation only (NEVER touch during development) | ~300 sequences |

**Validation strategy**: Use 2022-2023 for all tuning. The 2020-2021 gap is a feature, not a bug—it tests temporal generalization.

### Hyperparameter Optimization

**Don't guess—search.**

```typescript
// For each model family, run systematic search
const hyperparamSearch = {
  // XGBoost
  xgboost: {
    n_estimators: [100, 200, 500, 1000],
    max_depth: [3, 4, 5, 6, 8],
    learning_rate: [0.01, 0.03, 0.05, 0.1],
    subsample: [0.7, 0.8, 0.9],
    colsample_bytree: [0.7, 0.8, 0.9],
    reg_alpha: [0, 0.1, 1.0],
    reg_lambda: [1.0, 2.0, 5.0],
  },
  
  // LSTM
  lstm: {
    units_l1: [32, 48, 64, 96],
    units_l2: [16, 24, 32, 48],
    dropout: [0.2, 0.3, 0.4, 0.5],
    recurrent_dropout: [0.2, 0.3, 0.4],
    l2_reg: [1e-5, 1e-4, 1e-3],
    learning_rate: [0.0001, 0.0003, 0.0005, 0.001],
    batch_size: [16, 32, 64],
  },
  
  // Search method
  method: 'bayesian',  // Optuna or similar
  n_trials: 200,
  pruning: true,  // Stop bad trials early
};
```

### Training Configuration (LSTM)

```typescript
const lstmConfig = {
  optimizer: tf.train.adam(0.0005),
  
  epochs: 300,  // High ceiling - early stopping will handle it
  
  callbacks: [
    // Early stopping on validation loss
    tf.callbacks.earlyStopping({
      monitor: 'val_loss',
      patience: 25,
      restoreBestWeights: true,
      minDelta: 0.0001
    }),
    
    // Reduce LR when stuck
    tf.callbacks.reduceLROnPlateau({
      monitor: 'val_loss',
      factor: 0.5,
      patience: 10,
      minLr: 0.00001
    }),
    
    // Save checkpoints
    tf.callbacks.modelCheckpoint({
      filepath: 'models/lstm_best.h5',
      monitor: 'val_loss',
      saveBestOnly: true
    }),
  ],
  
  // Batch size affects generalization
  batchSize: 32,
  
  // Shuffle each epoch
  shuffle: true,
};
```

### Cross-Validation for Robustness

```typescript
// Time-series aware CV (no future leakage)
const timeSeriesCV = {
  folds: [
    { train: ['2015', '2016', '2017'], val: ['2018'] },
    { train: ['2015', '2016', '2017', '2018'], val: ['2019'] },
    { train: ['2015', '2016', '2017', '2018', '2019'], val: ['2022'] },
    { train: ['2015', '2016', '2017', '2018', '2019', '2022'], val: ['2023'] },
  ],
  
  // Average performance across folds
  // High variance across folds = unstable model
};
```

### Loss Function Refinement

```typescript
// V4 loss - equal weight to all quantiles
function multiQuantileLossV4(yTrue, yPred) {
  return quantileLoss(0.1) + quantileLoss(0.5) + quantileLoss(0.9);
}

// V5 options - experiment with these

// Option A: Weight median more (we care about point prediction)
function weightedQuantileLoss(yTrue, yPred) {
  return 0.25 * quantileLoss(0.1) 
       + 0.50 * quantileLoss(0.5)  // Double weight on median
       + 0.25 * quantileLoss(0.9);
}

// Option B: Add sharpness penalty (tighter intervals = better, if calibrated)
function sharpnessAwareLoss(yTrue, yPred) {
  const ql = multiQuantileLoss(yTrue, yPred);
  const width = mean(p90 - p10);
  return ql + 0.1 * width;  // Penalize wide intervals
}

// Option C: Huber-style quantile loss (robust to outliers)
function huberQuantileLoss(q, yTrue, yPred, delta = 1.0) {
  const e = yTrue - yPred;
  const absE = abs(e);
  const quadratic = 0.5 * e * e;
  const linear = delta * absE - 0.5 * delta * delta;
  return mean(where(absE < delta, quadratic, linear) * where(e > 0, q, 1 - q));
}
```

### Regularization Checklist

| Technique | LSTM | XGBoost | MLP |
|-----------|------|---------|-----|
| L2 weight decay | ✓ 1e-4 | ✓ reg_lambda | ✓ 1e-4 |
| Dropout | ✓ 0.3-0.4 | N/A | ✓ 0.3-0.4 |
| Recurrent dropout | ✓ 0.3 | N/A | N/A |
| Early stopping | ✓ | ✓ | ✓ |
| Data augmentation | Optional | Optional | Optional |
| Label smoothing | Optional | N/A | Optional |
| Batch norm / Layer norm | ✓ | N/A | ✓ |
| Gradient clipping | ✓ 1.0 | N/A | ✓ 1.0 |

---

## Evaluation Framework

### Primary Metrics

```typescript
interface ComprehensiveMetrics {
  // === PER-CAPTION METRICS ===
  perCaption: {
    [caption: string]: {
      mae_p50: number;
      rmse_p50: number;
      quantile_loss: number;
      coverage_p10: number;
      coverage_p90: number;
      interval_width: number;
    }
  },
  
  // === AGGREGATE CAPTION METRICS ===
  meanCaptionMAE: number;            // Average MAE across all captions
  worstCaptionMAE: number;           // Highest MAE (weakest caption)
  bestCaptionMAE: number;            // Lowest MAE (strongest caption)
  
  // === TOTAL SCORE METRICS ===
  total: {
    mae_p50: number;                 // MAE on total score prediction
    rmse_p50: number;
    quantile_loss: number;
    coverage_p10: number;
    coverage_p90: number;
    interval_width: number;
  },
  
  // === RANKING METRICS ===
  ranking: {
    rank_mae: number;                // Mean absolute rank error
    rank_correlation: number;        // Spearman correlation
    top3_accuracy: number;           // % correct top 3 identification
    top5_accuracy: number;           // % correct top 5 identification  
    finals_accuracy: number;         // % correct finals qualifiers (top 12)
    pairwise_accuracy: number;       // % of pairs correctly ordered
  },
  
  // === CALIBRATION ===
  calibration: {
    perCaption: { [caption: string]: CalibrationMetrics },
    total: CalibrationMetrics,
    meanCalibrationError: number,
  },
  
  // === CORRELATION PRESERVATION ===
  correlationMetrics: {
    ge1_ge2_predicted: number,       // Correlation in predictions
    ge1_ge2_actual: number,          // Historical correlation
    correlation_error: number,       // |predicted - actual|
  },
}
```

### Model Comparison Table

Track every model variant:

```
| Model                | MAE   | RMSE  | QL    | p10   | p90   | Width | R²    | Notes                |
|----------------------|-------|-------|-------|-------|-------|-------|-------|----------------------|
| baseline_zero        |       |       | N/A   | N/A   | N/A   | N/A   |       | Reference curves     |
| baseline_ema         |       |       | N/A   | N/A   | N/A   | N/A   |       |                      |
| xgboost_v1           |       |       |       |       |       |       |       | Default params       |
| xgboost_tuned        |       |       |       |       |       |       |       | After hyperparam opt |
| ridge_per_caption    |       |       |       |       |       |       |       |                      |
| fixed_bilstm         |       |       |       |       |       |       |       | V4 architecture fixed|
| attention_lstm       |       |       |       |       |       |       |       |                      |
| tcn                  |       |       |       |       |       |       |       |                      |
| multitask_lstm       |       |       |       |       |       |       |       |                      |
| ensemble_simple_avg  |       |       |       |       |       |       |       |                      |
| ensemble_weighted    |       |       |       |       |       |       |       |                      |
| ensemble_stacking    |       |       |       |       |       |       |       |                      |
| ensemble + bayesian  |       |       |       |       |       |       |       | Final system         |
```

### Stratified Analysis

Break down by every dimension that might matter:

```typescript
interface StratifiedResults {
  // By season progress
  byShowNumber: {
    shows_1_3: Metrics;    // Early season (mostly padding)
    shows_4_6: Metrics;    // Building history
    shows_7_10: Metrics;   // Mid season
    shows_11_14: Metrics;  // Late season
    finals: Metrics;       // Finals week
  };
  
  // By corps tier (historical performance)
  byCorpsTier: {
    top_3: Metrics;        // BD, Crown, Vanguard level
    tier_4_7: Metrics;     // Perennial finalists
    tier_8_12: Metrics;    // Finals bubble
    tier_13_plus: Metrics; // Lower placements
    new_corps: Metrics;    // No prior history
  };
  
  // By caption
  byCaption: {
    GE1: Metrics;
    GE2: Metrics;
    VP: Metrics;
    VA: Metrics;
    CG: Metrics;
    MB: Metrics;
    MA: Metrics;
    MP: Metrics;
  };
  
  // By difficulty
  byResidualMagnitude: {
    small_residual: Metrics;   // |residual| < 0.3 (chalk)
    medium_residual: Metrics;  // 0.3 <= |residual| < 0.8
    large_residual: Metrics;   // |residual| >= 0.8 (upsets)
  };
  
  // By season (detect drift)
  bySeason: {
    '2022': Metrics;
    '2023': Metrics;
    '2024': Metrics;  // Test only
  };
}
```

### Ablation Studies

Measure contribution of each component:

```typescript
const ablations = [
  // Feature ablations
  { name: 'no_historical_features', disable: ['prev_season_rank', 'years_in_wc', ...] },
  { name: 'no_momentum_features', disable: ['slope', 'ema', 'streak'] },
  { name: 'no_context_features', disable: ['is_finals', 'is_regional', 'field_size'] },
  { name: 'no_cross_caption', disable: ['ge_vs_visual_gap', 'caption_consistency'] },
  
  // Architecture ablations
  { name: 'single_lstm_layer', config: { layers: 1 } },
  { name: 'no_attention', config: { attention: false } },
  { name: 'no_static_features', config: { staticFeatures: false } },
  
  // Ensemble ablations
  { name: 'no_xgboost', exclude: ['xgboost'] },
  { name: 'no_lstm', exclude: ['fixed_bilstm', 'attention_lstm'] },
  { name: 'lstm_only', include: ['fixed_bilstm'] },
  { name: 'xgboost_only', include: ['xgboost'] },
];

// For each ablation, measure:
// - Performance delta vs full model
// - Statistical significance of difference
```

### Calibration Plots

```typescript
// Reliability diagram
function reliabilityDiagram(predictions: Prediction[], actuals: number[]) {
  // For each quantile level (0.1, 0.2, ..., 0.9)
  // Plot: predicted quantile vs observed frequency
  // Perfect calibration = diagonal line
}

// PIT histogram (Probability Integral Transform)
function pitHistogram(predictions: Prediction[], actuals: number[]) {
  // Transform actuals through predicted CDF
  // Should be uniform if well-calibrated
}

// Sharpness vs Calibration tradeoff
function sharpnessCalibrationCurve(models: Model[]) {
  // Plot: interval width vs coverage error
  // Pareto frontier shows best models
}
```

### Statistical Significance

```typescript
// Don't trust small differences
function compareModels(modelA: Results, modelB: Results): Comparison {
  // Paired t-test or Wilcoxon signed-rank
  const pValue = wilcoxonTest(modelA.errors, modelB.errors);
  
  // Bootstrap confidence interval for difference
  const diffCI = bootstrapCI(modelA.mae - modelB.mae, nBootstrap: 1000);
  
  return {
    meanDifference: modelA.mae - modelB.mae,
    pValue,
    significantAt05: pValue < 0.05,
    confidenceInterval: diffCI,
    effectSize: cohensD(modelA.errors, modelB.errors),
  };
}
```

---

## Flexible & Updateable Architecture

### Requirements

1. **In-season updates**: As 2025 shows happen, incorporate new data without full retraining
2. **New corps handling**: Corps appearing for the first time get reasonable predictions immediately
3. **Drift adaptation**: Scoring norms shift year-to-year; model should adapt
4. **Fast iteration**: Experiment with features/targets without rebuilding everything

### Architecture: Modular Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FEATURE STORE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   Corps     │  │   Show      │  │  Reference  │                  │
│  │   History   │  │   Features  │  │   Curves    │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      MODEL ENSEMBLE                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │   Prior     │  │   Trend     │  │   Context   │                  │
│  │   Model     │  │  (recent)   │  │  (show-type)│                  │
│  │ (historical)│  │             │  │             │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     COMBINATION LAYER                               │
│            (weighted average, learns mixing weights)                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    [ Quantile Predictions ]
```

### Component Design

#### 1. Feature Store (SQLite + JSON)

Maintains updateable state per corps per season:

```typescript
interface CorpsSeasonState {
  corps_key: string;
  season: string;
  
  // Updated after each show
  shows_completed: number;
  last_show_date: string;
  
  // Running statistics (updateable online)
  residual_ema: Record<Caption, number>;      // EMA with α=0.3
  residual_mean: Record<Caption, number>;     // Running mean
  residual_var: Record<Caption, number>;      // Running variance (Welford's)
  best_residual: Record<Caption, number>;
  worst_residual: Record<Caption, number>;
  
  // Trajectory
  rank_history: number[];                     // [show1_rank, show2_rank, ...]
  total_score_history: number[];
  
  // Computed on read
  trend_slope?: Record<Caption, number>;      // Linear fit of recent residuals
}

// Update function - called after each show
function updateCorpsState(
  state: CorpsSeasonState, 
  newShow: ShowResult
): CorpsSeasonState {
  // Welford's online algorithm for mean/variance
  // EMA update: new_ema = α * new_value + (1 - α) * old_ema
  // Append to histories
  // Return updated state
}
```

#### 2. Prior Model (Historical Knowledge)

What we expect before seeing any shows this season:

```typescript
interface PriorModel {
  // Trained offline on historical data
  // Input: prev_season_rank, years_in_wc, historical_avg_residuals
  // Output: expected residual distribution (mean, std per caption)
  
  predict(corps: CorpsHistoricalFeatures): ResidualPrior;
}

// This rarely needs retraining - historical patterns are stable
// Retrain annually after season completes
```

#### 3. Trend Model (Recent Performance)

What recent shows tell us:

```typescript
interface TrendModel {
  // Simple and fast - can be updated online
  // Input: last 3-5 residuals, EMA, slope
  // Output: predicted next residual
  
  // Options (in order of complexity):
  // A. Pure EMA (no training needed)
  // B. Linear regression on recent residuals (closed-form, instant update)
  // C. Small online-updateable model (SGD after each show)
  
  predict(recentHistory: RecentFeatures): ResidualPrediction;
  update(actual: ShowResult): void;  // Online update
}
```

#### 4. Context Model (Show-Specific Adjustments)

Adjustments based on show context:

```typescript
interface ContextModel {
  // Captures: finals boost, regional effects, schedule density
  // Input: is_finals, is_regional, days_since_last, pct_through
  // Output: adjustment factors per caption
  
  // Can be simple lookup table or small model
  // Retrain occasionally as show-type effects become clearer
  
  predict(showContext: ShowContext): AdjustmentFactors;
}
```

#### 5. Combination Layer

Learns how to weight the component models:

```typescript
interface CombinationWeights {
  // Weights vary by:
  // - shows_completed (early season → trust prior; late season → trust trend)
  // - corps tier (stable corps → trust prior; volatile corps → trust trend)
  
  getWeights(shows_completed: number, corps_stability: number): {
    prior_weight: number;
    trend_weight: number;
    context_weight: number;
  };
}

function combinePredictions(
  prior: ResidualPrediction,
  trend: ResidualPrediction,
  context: AdjustmentFactors,
  weights: CombinationWeights,
  features: CombinationFeatures
): FinalPrediction {
  const w = weights.getWeights(features.shows_completed, features.corps_stability);
  
  // Weighted combination for point estimate
  const p50 = w.prior_weight * prior.p50 
            + w.trend_weight * trend.p50 
            + context.adjustment;
  
  // Uncertainty combines (wider early season, narrower late)
  const interval_width = /* function of component uncertainties and weights */;
  
  return { p10: p50 - interval_width/2, p50, p90: p50 + interval_width/2 };
}
```

### Online Update Protocol

After each show result comes in:

```typescript
async function onShowComplete(show: ShowResult) {
  // 1. Update feature store
  const state = await getCorpsState(show.corps_key, show.season);
  const newState = updateCorpsState(state, show);
  await saveCorpsState(newState);
  
  // 2. Update trend model (online learning)
  trendModel.update(show);
  
  // 3. Optionally update combination weights
  // (if we're tracking prediction errors)
  if (config.adaptiveCombination) {
    const prediction = lastPredictionFor(show.corps_key, show.competition_slug);
    const error = computeError(prediction, show);
    combinationWeights.update(error, features);
  }
  
  // 4. Log for later offline analysis
  await logPredictionResult(prediction, show);
}
```

### Model Versioning & Retraining

```typescript
interface ModelRegistry {
  models: {
    prior: {
      version: "v1.2",
      trained_on: "2015-2023",
      last_updated: "2024-01-15",
      metrics: { val_mae: 0.32 }
    },
    trend: {
      version: "v2.0",
      type: "online_linear",
      last_updated: "2025-07-04"  // Updates continuously
    },
    context: {
      version: "v1.0",
      trained_on: "2015-2023",
      last_updated: "2024-01-15"
    },
    combination: {
      version: "v1.1",
      strategy: "shows_completed_interpolation"
    }
  };
  
  // Retraining schedule
  schedule: {
    prior: "annually, after finals",
    trend: "online (continuous)",
    context: "annually or when show types change",
    combination: "quarterly or after significant drift"
  };
}
```

### New Corps Protocol

When a corps appears with no history:

```typescript
function getPriorForNewCorps(corps_key: string, season: string): ResidualPrior {
  // 1. Check if corps exists in ANY historical data
  const historical = lookupHistoricalAppearances(corps_key);
  
  if (historical.length > 0) {
    // Returning corps - use their historical performance
    return priorModel.predict({
      prev_season_rank: historical.last()?.final_rank || 15,
      years_in_wc: historical.length,
      historical_avg_residuals: computeHistoricalAvg(historical)
    });
  }
  
  // 2. Truly new corps - use population prior
  return {
    // Conservative estimate: expect baseline performance
    mean_residual: 0,
    std_residual: POPULATION_STD,  // Wide uncertainty
    
    // Or: use Open Class performance if promoted
    // Or: use any available preseason info
  };
}
```

### Advantages of This Design

| Aspect | Benefit |
|--------|---------|
| **Updateability** | Trend model updates after every show; no full retrain needed |
| **Cold start** | Prior model gives reasonable predictions with zero shows |
| **Interpretability** | Can inspect each component's contribution |
| **Debugging** | If predictions are bad, can identify which component failed |
| **Experimentation** | Swap out trend model without touching prior model |
| **Drift handling** | Trend model naturally adapts; prior model retrains annually |
| **Uncertainty** | Early season: wide intervals (prior-heavy). Late season: narrow (trend-heavy) |

### Simplified Alternative: Online Bayesian Updates

If the ensemble feels overengineered, a Bayesian approach is conceptually cleaner:

```typescript
interface BayesianCorpsModel {
  // Per corps, per caption, maintain belief distribution
  // Prior: N(μ_prior, σ_prior²) from historical data
  // Likelihood: each show is an observation with noise
  // Posterior: conjugate Normal-Normal update
  
  prior_mean: number;
  prior_variance: number;
  
  update(observed_residual: number): void {
    // Closed-form Bayesian update (conjugate prior)
    const obs_var = OBSERVATION_VARIANCE;
    const posterior_precision = 1/this.prior_variance + 1/obs_var;
    const posterior_var = 1 / posterior_precision;
    const posterior_mean = posterior_var * (
      this.prior_mean / this.prior_variance + 
      observed_residual / obs_var
    );
    
    this.prior_mean = posterior_mean;
    this.prior_variance = posterior_var;
  }
  
  predict(): { p10: number, p50: number, p90: number } {
    const std = Math.sqrt(this.prior_variance);
    return {
      p10: this.prior_mean - 1.28 * std,
      p50: this.prior_mean,
      p90: this.prior_mean + 1.28 * std
    };
  }
}
```

This is elegant, fully online, and naturally handles:
- Wide uncertainty early (prior dominates)
- Narrow uncertainty late (data dominates)  
- Cold start (just use prior)
- Updates (closed-form, instant)

The downside: assumes Gaussian residuals and doesn't capture nonlinear patterns (e.g., finals effects).

### Recommendation

**Start with the Bayesian approach** for simplicity and mathematical rigor. If evaluation reveals nonlinear patterns it misses (context effects, trajectory shapes), graduate to the modular ensemble.

The Bayesian model can become one component (the "trend model") in the ensemble later—no wasted work.

---

## Implementation Phases

### Phase 1: Infrastructure & Baselines (Week 1)

**Deliverables:**
- [x] ~~Build comprehensive evaluation harness (all metrics from framework)~~
- [x] ~~Implement trivial baselines (zero, last, EMA, linear extrapolation)~~
- [x] ~~Analyze reference curve accuracy (this is your implicit strong baseline)~~
- [x] ~~Generate stratified analysis infrastructure~~
- [x] ~~Establish statistical significance testing~~

**Exit criteria:** Know exactly what "good" looks like. Have numbers for every baseline.

### Phase 2: Feature Engineering V5 (Week 1)

**Deliverables:**
- [x] ~~Implement 30 timestep features + 20 static features~~
- [x] ~~Fix baseline alignment (rank_entering everywhere)~~
- [x] ~~Build feature store with online update capability~~
- [x] ~~Add derived/interaction features for XGBoost~~
- [ ] Verify no leakage through careful inspection
- [x] ~~Backfill all historical data~~
- [x] ~~Data integrity audits: null checks, curve monotonicity, residual centering~~
- [x] ~~Outlier detection for extreme scores/residuals~~

**Exit criteria:** Clean, aligned features ready for all models.

### Phase 2.5: Field History + Context Expansion (Week 1.5)

**Deliverables:**
- [ ] Opponent/field aggregates computed as-of show (mean/median/std/min/max, p25/p75)
- [ ] Rank-weighted opponent summaries + top-K opponent snapshot (K=3–5)
- [ ] Corps momentum features (last residual, EMA, slope, volatility)
- [ ] Judge panel priors (bias/spread) with coverage flags
- [ ] Travel/logistics features (days since last show, distance, travel load)
- [ ] Subcaption/context features (content vs achievement) if available
- [ ] Guardrails: exclude target corps; strict as-of computation
- [ ] Ablation checkpoints per feature group

**Exit criteria:** Feature expansion improves validation metrics without leakage.

### Phase 3: Classical ML Models (Week 2)

**Deliverables:**
- [x] ~~XGBoost with quantile regression (full hyperparam search)~~
- [x] ~~LightGBM variant~~
- [x] ~~Ridge regression per caption~~
- [x] ~~Feature importance analysis~~
- [x] ~~Compare all to baselines with statistical significance~~

**Exit criteria:** Know the best XGBoost can do. Have feature importance insights.

### Phase 4: Fixed LSTM (Week 2)

**Deliverables:**
- [ ] Implement V4 architecture with fixes (no embeddings, full regularization)
- [ ] Hyperparameter search (units, dropout, LR, batch size)
- [ ] Layer normalization and gradient clipping
- [ ] Compare to XGBoost with statistical significance
- [ ] Training curve analysis (is it still overfitting?)
- [ ] Judge dropout/masking strategy for missing panels

**Exit criteria:** Know if sequence modeling beats feature aggregation.

### Phase 5: Enhanced Sequence Models (Week 3)

**Deliverables:**
- [ ] Attention-based LSTM
- [ ] Temporal Convolutional Network (TCN)
- [ ] Transformer encoder (if data supports)
- [ ] **Multi-output architecture (shared encoder, per-caption heads)**
- [ ] **Cross-caption attention refinement**
- [ ] Consistency loss: enforce total ≈ sum(captions)
- [ ] Compare all sequence models
- [ ] Ablation: joint vs independent caption prediction

**Exit criteria:** Identify best sequence architecture. Prove multi-caption helps.

### Phase 6: Ensemble Construction (Week 3)

**Deliverables:**
- [ ] Simple average ensemble
- [ ] Weighted average (weights from val performance)
- [ ] Stacking meta-learner
- [ ] Dynamic weights (by show number / corps tier)
- [ ] Ablation studies (which models contribute?)
- [ ] Diversity analysis (are models making different errors?)

**Exit criteria:** Best possible offline model. Know contribution of each component.

### Phase 7: Online Adaptation Layer (Week 4)

**Deliverables:**
- [ ] Implement Bayesian adjustment layer on top of ensemble
- [ ] Tune observation variance parameter
- [ ] Simulate online updates on 2023 season
- [ ] Compare ensemble vs ensemble+Bayesian
- [ ] Build `onShowComplete()` handler

**Exit criteria:** System ready for live predictions with adaptation.

### Phase 8: Calibration & Final Tuning (Week 4)

**Deliverables:**
- [ ] Generate calibration plots for final model
- [ ] Apply Platt scaling or isotonic regression if needed
- [ ] Post-hoc calibration for quantiles
- [ ] Final test set evaluation (ONE TIME ONLY)
- [ ] Document all results

**Exit criteria:** Well-calibrated, maximum accuracy model ready for deployment.

### Phase 9: Production & Monitoring (Week 5)

**Deliverables:**
- [ ] Prediction API (single corps and full show)
- [ ] **Full recap generation endpoint**
- [ ] **Show prediction with rankings and Monte Carlo uncertainty**
- [ ] Model versioning and registry
- [ ] Prediction logging for retrospective analysis
- [ ] **User-facing recap display format**
- [ ] Monitoring dashboard (optional)
- [ ] Runbook for in-season operation
- [ ] Model card documenting capabilities and limitations

**Exit criteria:** System running for 2025 season with full recap output.

---

## Success Criteria

### Minimum Viable (Must Hit)
- Per-caption: Beat baseline_ema on MAE by >15% for all 8 captions
- Total score: MAE < 1.5 points on total score prediction
- Ranking: Pairwise accuracy > 75% (correctly order 3/4 of corps pairs)
- Calibration: p10/p90 coverage within 5 percentage points of target
- Online: Update completes in <1 second per show
- Architecture: Multi-caption model beats independent per-caption models

### Target (Strong Success)
- Per-caption: Beat baseline_ema on MAE by >25% for all 8 captions
- Total score: MAE < 1.0 points, R² > 0.8
- Ranking: Top-5 accuracy > 80%, pairwise accuracy > 85%
- Calibration: Within 2 percentage points across all captions
- Correlation: Predicted caption correlations within 0.05 of historical
- Insights: Correctly identify "upset potential" shows 60%+ of the time

### Stretch (Exceptional)
- Per-caption: MAE < 0.3 for all captions mid/late season
- Total score: MAE < 0.7 points, correctly predict winner 90%+ of shows
- Ranking: Perfectly predict top 3 in >50% of shows
- Early season: Useful signal even for shows 1-3
- Upset detection: >50% precision at 30% recall on large residuals
- Caption insights: Identify which specific caption will improve/decline

### Anti-Goals (Avoid)
- Overfitting: val loss << test loss is a failure
- Uncalibrated uncertainty: intervals that don't match coverage
- Complexity without value: if XGBoost wins, accept it
- Caption imbalance: one caption much worse than others
- Correlated errors: systematic bias for certain corps/show types

---

## Accuracy Improvement Techniques

### Feature Engineering Tricks

```typescript
// 1. Target encoding (with proper CV to avoid leakage)
// For categorical-ish features like corps, encode as mean residual
// Use leave-one-out within training folds only
const corpsTargetEncoding = computeTargetEncoding(corps, residuals, cv_folds);

// 2. Lag features at multiple horizons
// Not just "last show" but "2 shows ago", "3 shows ago"
const lagFeatures = [
  residual_lag1, residual_lag2, residual_lag3,
  rank_lag1, rank_lag2, rank_lag3,
];

// 3. Rolling statistics with different windows
const rollingFeatures = [
  ema_3, ema_5, ema_all,    // Different smoothing
  std_3, std_5,              // Volatility at different windows
  min_3, max_3,              // Recent range
];

// 4. Difference features
const diffFeatures = [
  residual_diff_1: residual_t - residual_t1,
  residual_diff_2: residual_t - residual_t2,
  rank_diff_1: rank_t - rank_t1,
];

// 5. Ratio features (for XGBoost especially)
const ratioFeatures = [
  rank_vs_prev_season: current_rank / prev_season_rank,
  residual_vs_historical: current_residual / historical_mean_residual,
];
```

### Model-Specific Tricks

```typescript
// XGBoost
const xgboostTricks = {
  // Pseudo-Huber loss for robustness to outliers
  objective: 'reg:pseudohubererror',
  
  // Feature interactions via polynomial features
  // Or let XGBoost find them (increase max_depth)
  
  // Monotonic constraints if domain knowledge supports
  // e.g., more shows_completed should reduce uncertainty
  monotone_constraints: { shows_completed: -1 }, // for uncertainty
  
  // Custom evaluation metric matching your actual goal
  eval_metric: 'pinball_loss',
};

// LSTM
const lstmTricks = {
  // Bidirectional (already in V4) - helps
  bidirectional: true,
  
  // Layer normalization (instead of batch norm for sequences)
  layerNorm: true,
  
  // Residual connections if going deep
  residualConnections: depth > 2,
  
  // Variational dropout (same mask across timesteps)
  variationalDropout: true,
  
  // Attention over timesteps (learns what to focus on)
  selfAttention: true,
  
  // Gradient clipping (prevents exploding gradients)
  clipNorm: 1.0,
};
```

### Ensemble Tricks

```typescript
// 1. Diversity is key - ensemble models that make DIFFERENT errors
const diversityStrategy = {
  // Different model families
  models: ['xgboost', 'lstm', 'ridge'],
  
  // Different feature subsets
  featureSubsets: ['full', 'sequential_only', 'static_only'],
  
  // Different random seeds (bagging)
  seeds: [42, 123, 456, 789, 1011],
  
  // Different hyperparameters (even suboptimal ones add diversity)
  hyperparamVariants: true,
};

// 2. Stacking with careful CV
// Train base models on fold 1-4, generate predictions for fold 5
// Collect OOF predictions for all folds
// Train meta-model on OOF predictions
// This avoids overfitting the meta-model

// 3. Weighted average with optimized weights
// Don't just use validation performance
// Optimize weights directly on validation loss
const optimizedWeights = optimizeWeights(
  basePredictions, 
  actuals, 
  objective: 'pinball_loss'
);

// 4. Per-stratum ensembles
// Different weights for early vs late season
// Different weights for top corps vs lower corps
const stratumWeights = {
  early_season: { xgboost: 0.6, lstm: 0.2, prior: 0.2 },
  late_season: { xgboost: 0.3, lstm: 0.5, prior: 0.2 },
};
```

### Calibration Tricks

```typescript
// 1. Platt scaling for point predictions
// Fit: calibrated = sigmoid(a * raw + b)
// On held-out calibration set

// 2. Isotonic regression for quantiles
// Non-parametric, monotonic calibration
// Fit separately for each quantile level

// 3. Temperature scaling for intervals
// Scale interval width: calibrated_width = raw_width * temperature
// Tune temperature on calibration set

// 4. Conformal prediction (distribution-free calibration)
// Guarantees coverage without distributional assumptions
// Requires held-out calibration set
```

### Training Tricks

```typescript
// 1. Learning rate warmup
// Start low, ramp up, then decay
const lrSchedule = warmupCosineDecay({
  warmupSteps: 100,
  peakLr: 0.001,
  decaySteps: 1000,
});

// 2. Label smoothing (for classification-style outputs)
// Softens targets slightly to prevent overconfidence

// 3. Mixup / CutMix for sequences
// Interpolate between training examples
// Regularization that can help generalization

// 4. Multi-objective training
// Optimize for multiple metrics simultaneously
// Pareto-optimal solutions

// 5. Snapshot ensembles
// Save model at multiple points during training
// Ensemble the snapshots (free diversity)

// 6. Stochastic Weight Averaging (SWA)
// Average weights from last N epochs
// Often improves generalization
```

### Data Tricks

```typescript
// 1. Careful handling of padding
// Don't just zero-pad - use learnable padding embedding
// Or mask padded positions in attention

// 2. Weighted sampling
// Upweight rare but important examples
// e.g., finals predictions, upset shows

// 3. Synthetic minority oversampling
// If large residuals are rare but important
// Generate synthetic examples (carefully)

// 4. Backtranslation / Noise injection
// Add small noise to inputs during training
// Improves robustness
```

---

## Open Questions

1. **Is 2015-2019 → 2022-2024 too big a gap?** The activity skipped 2020-2021. Scoring norms may have drifted. Consider including 2019 in validation to sanity-check.

2. **How much does joint caption modeling help?** Need ablation: independent models vs shared encoder vs cross-caption attention. Hypothesis: 5-10% improvement from joint modeling.

3. **Should total score have its own prediction head?** Or just sum caption predictions? A dedicated head might learn constraints (totals cluster around certain values).

4. **How to handle schedule variation?** Some corps attend 8 shows, others 14. Does this affect predictions? The Bayesian approach handles this naturally (more shows = tighter posterior).

5. **What about Open Class?** Current focus is World Class. Expanding to Open Class doubles data but introduces different dynamics. Could train separate models.

6. **How fast should the online model adapt?** EMA α=0.3 is a guess. Too high = overreacts to one bad show. Too low = slow to catch real changes. Could tune per-corps based on historical volatility.

7. **Caption-specific uncertainty?** Some captions are more volatile (CG historically). Should each caption have its own uncertainty model?

8. **Real-time data source?** For live 2025 predictions, where do show results come from? DCI website scraping? Manual entry? This affects update latency.

9. **How to display uncertainty to users?** Users may not understand intervals. Test: point estimate + confidence indicator vs full interval display.

10. **Rank prediction: regression or classification?** Could model rank directly as ordinal classification instead of deriving from total scores.

---

## Appendix: Reference Curve Investigation

The baseline model (reference curves) is doing a lot of heavy lifting. Worth investigating:

1. How were reference curves generated? (Binned historical averages by rank × season progress?)
2. Are they stable across years? (Check 2015 curves vs. 2019)
3. What's the baseline MAE if we just predict the reference curve value?

If reference curves are already very accurate, residuals will be noisy and hard to predict. This would explain the val_loss plateau.

```typescript
// Suggested analysis
for each show in val_set:
  baseline_pred = getBaseline(rank_entering, pct_through, caption)
  actual = show.captions[caption].score
  error = actual - baseline_pred
  
// Compute MAE/RMSE of baseline predictions directly
// This is effectively "baseline_zero" performance
```

---

## Appendix: Recommended File Structure

```
dci-ml-v5/
├── src/
│   ├── data/
│   │   ├── schema.ts                # Table definitions
│   │   ├── featureStore.ts          # CorpsSeasonState CRUD
│   │   ├── features.ts              # Feature extraction (30 + 20)
│   │   ├── derived.ts               # Interaction/momentum features
│   │   ├── referenceCurves.ts       # Baseline curve logic
│   │   ├── backfill.ts              # Populate historical state
│   │   └── ingest.ts                # Parse new show results
│   │
│   ├── models/
│   │   ├── types.ts                 # Shared interfaces (Prediction, Recap, etc.)
│   │   ├── captionTypes.ts          # Caption-specific types and constants
│   │   ├── baselines/
│   │   │   ├── zero.ts              # Predict 0
│   │   │   ├── ema.ts               # Exponential moving average
│   │   │   └── linear.ts            # Linear extrapolation
│   │   ├── classical/
│   │   │   ├── xgboost.ts           # XGBoost quantile
│   │   │   ├── lightgbm.ts          # LightGBM variant
│   │   │   └── ridge.ts             # Ridge per caption
│   │   ├── sequence/
│   │   │   ├── fixedLstm.ts         # V4 architecture fixed
│   │   │   ├── attentionLstm.ts     # Self-attention variant
│   │   │   ├── tcn.ts               # Temporal convolutional
│   │   │   ├── transformer.ts       # Transformer encoder
│   │   │   ├── multitask.ts         # Shared encoder, per-caption heads
│   │   │   └── multiOutput.ts       # Cross-caption attention refinement
│   │   ├── ensemble/
│   │   │   ├── average.ts           # Simple average
│   │   │   ├── weighted.ts          # Validation-weighted
│   │   │   ├── stacking.ts          # Meta-learner
│   │   │   └── dynamic.ts           # Context-dependent weights
│   │   └── online/
│   │       ├── bayesian.ts          # Bayesian adjustment layer
│   │       └── adaptation.ts        # Online update logic
│   │
│   ├── training/
│   │   ├── hyperopt.ts              # Hyperparameter search (Optuna)
│   │   ├── crossval.ts              # Time-series CV
│   │   ├── losses.ts                # Quantile loss variants
│   │   ├── multiCaptionLoss.ts      # Joint loss with correlation preservation
│   │   └── callbacks.ts             # Early stopping, LR schedule
│   │
│   ├── evaluation/
│   │   ├── metrics.ts               # All metrics (MAE, RMSE, calibration, etc.)
│   │   ├── stratified.ts            # By show/corps/caption
│   │   ├── significance.ts          # Statistical tests
│   │   ├── ablation.ts              # Component contribution
│   │   ├── calibration.ts           # Reliability diagrams, PIT
│   │   └── comparison.ts            # Model comparison tables
│   │
│   ├── inference/
│   │   ├── predict.ts               # Single corps prediction
│   │   ├── predictShow.ts           # Full show with rankings
│   │   ├── recap.ts                 # Generate full predicted recap
│   │   ├── rankings.ts              # Monte Carlo rank uncertainty
│   │   ├── explain.ts               # Feature importance, component breakdown
│   │   └── serve.ts                 # HTTP API
│   │
│   └── online/
│       ├── updateHandler.ts         # onShowComplete() logic
│       ├── predictionLog.ts         # Track predictions vs actuals
│       ├── monitor.ts               # Drift detection
│       └── registry.ts              # Model versioning
│
├── scripts/
│   ├── train-all.ts                 # Train all model variants
│   ├── hyperopt-xgboost.ts          # XGBoost hyperparam search
│   ├── hyperopt-lstm.ts             # LSTM hyperparam search
│   ├── build-ensemble.ts            # Construct final ensemble
│   ├── calibrate.ts                 # Post-hoc calibration
│   ├── evaluate-all.ts              # Full evaluation suite
│   ├── simulate-season.ts           # Replay historical season online
│   ├── ablation-study.ts            # Run all ablations
│   └── generate-report.ts           # Create comparison tables/plots
│
├── models/                          # Saved model artifacts
│   ├── baselines/
│   ├── xgboost/
│   │   ├── xgboost_v1.json
│   │   └── xgboost_tuned.json
│   ├── lstm/
│   │   ├── fixed_bilstm.h5
│   │   ├── attention_lstm.h5
│   │   └── tcn.h5
│   ├── ensemble/
│   │   ├── weights.json
│   │   └── stacking_meta.json
│   └── online/
│       └── bayesian_params.json
│
├── state/                           # Runtime state
│   ├── corps_state.db               # Feature store (SQLite)
│   └── prediction_log.db            # Prediction history
│
├── results/                         # Evaluation outputs
│   ├── baseline_comparison.csv
│   ├── model_comparison.csv
│   ├── ablation_results.csv
│   ├── stratified/
│   │   ├── by_show_number.csv
│   │   ├── by_corps_tier.csv
│   │   └── by_caption.csv
│   ├── calibration/
│   │   ├── reliability_diagram.png
│   │   └── pit_histogram.png
│   └── training_curves/
│
├── notebooks/                       # Exploration & analysis
│   ├── 01-baseline-analysis.ipynb
│   ├── 02-feature-exploration.ipynb
│   ├── 03-xgboost-tuning.ipynb
│   ├── 04-lstm-experiments.ipynb
│   ├── 05-ensemble-construction.ipynb
│   ├── 06-calibration-analysis.ipynb
│   └── 07-final-evaluation.ipynb
│
└── docs/
    ├── model-card.md                # Capabilities & limitations
    ├── architecture.md              # System design
    ├── runbook.md                   # Operating procedures
    └── results-summary.md           # Final performance report
```
