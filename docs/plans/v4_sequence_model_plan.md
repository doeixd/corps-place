# V4 Plan: Temporal Sequence Model with Residual Learning

**Objective**: Build the ultimate DCI score prediction model by combining:
- **V2's residual learning** (Rank-Driven Baselines)
- **V3's temporal modeling** (LSTM sequence processing)
- **Best practices** from all prior iterations

---

## 1. Core Philosophy: "The Trajectory + The Deviation"

### The V4 Formula
```
PredictedScore = BaselineScore(Rank, PctThroughSeason) + LSTM(Trajectory) + Context(Panel, Field)
```

| Component | Source | Purpose |
|-----------|--------|---------|
| **BaselineScore** | Pre-computed reference curves | "What a Rank-5 corps typically scores in late July" |
| **LSTM(Trajectory)** | Sequence of prior shows | "This corps is trending +0.3/show above expectations" |
| **Context** | Judge embeddings, field strength | "This panel tends +0.2 on GE; field is weaker than usual" |

### Why This Works
- **V1 problem**: Learned everything from scratch → overfits to corps identity
- **V2 problem**: Static features only → can't capture momentum/trajectory shape
- **V3 problem**: Raw scores → LSTM wastes capacity learning the calendar curve
- **V4 solution**: LSTM focuses on trajectory *deviations*, not absolute values

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         V4 MODEL ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────┐      ┌──────────────────────┐             │
│  │   SEQUENCE INPUT     │      │   CONTEXT INPUT      │             │
│  │   [SeqLen, Features] │      │   [Embeddings]       │             │
│  └──────────┬───────────┘      └──────────┬───────────┘             │
│             │                              │                         │
│             ▼                              ▼                         │
│  ┌──────────────────────┐      ┌──────────────────────┐             │
│  │  Layer Normalization │      │  Corps Embedding     │             │
│  └──────────┬───────────┘      │  Season Embedding    │             │
│             │                  │  Division Embedding  │             │
│             ▼                  │  Judge Pool Embed    │             │
│  ┌──────────────────────┐      └──────────┬───────────┘             │
│  │ Stacked BiLSTM       │                 │                         │
│  │ Layer 1: 64×2 units  │                 │                         │
│  │ Layer 2: 32×2 units  │                 │                         │
│  │ + Residual Connection│                 │                         │
│  └──────────┬───────────┘                 │                         │
│             │                              │                         │
│             ▼                              │                         │
│  ┌──────────────────────┐                 │                         │
│  │ Temporal Attention   │                 │                         │
│  │ (learn which shows   │                 │                         │
│  │  matter most)        │                 │                         │
│  └──────────┬───────────┘                 │                         │
│             │                              │                         │
│             └──────────────┬───────────────┘                         │
│                            ▼                                         │
│                 ┌──────────────────────┐                             │
│                 │  GATED FUSION LAYER  │                             │
│                 │  gate = σ(W·[seq,ctx])│                             │
│                 │  out = gate*seq +    │                             │
│                 │        (1-gate)*ctx  │                             │
│                 └──────────┬───────────┘                             │
│                            │                                         │
│                            ▼                                         │
│                 ┌──────────────────────┐                             │
│                 │  SHARED TRUNK        │                             │
│                 │  Dense(256) + ReLU   │                             │
│                 │  Dropout(0.25) + L2  │                             │
│                 │  Dense(128) + ReLU   │                             │
│                 │  Dropout(0.20) + L2  │                             │
│                 └──────────┬───────────┘                             │
│                            │                                         │
│          ┌─────────────────┼─────────────────┐                       │
│          ▼                 ▼                 ▼                       │
│    ┌───────────┐    ┌───────────┐    ┌───────────┐                  │
│    │ GE Head   │    │ Vis Head  │    │ Mus Head  │    + Aux Heads   │
│    │ [6 out]   │    │ [9 out]   │    │ [9 out]   │    [3 aux outs]  │
│    │ GE1,GE2   │    │ VP,VA,CG  │    │ MB,MA,MP  │                  │
│    │ p10/50/90 │    │ p10/50/90 │    │ p10/50/90 │    Total, Rank,  │
│    └───────────┘    └───────────┘    └───────────┘    Improved?     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Architecture Design Decisions

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Stacked LSTM** | 2 layers (64→32) | Hierarchical feature learning; deeper = more abstract patterns |
| **Bidirectional** | Yes | Future shows don't exist, but later shows in sequence inform earlier context |
| **Residual Connection** | Skip from Layer 1 to output | Prevents gradient vanishing; allows shallow path |
| **Temporal Attention** | Self-attention over timesteps | Learns which past shows are most predictive (e.g., recent > distant) |
| **Gated Fusion** | Learnable gate | Balances sequence vs context; handles sparse early-season sequences |
| **Separate Heads** | GE / Visual / Music | Allows caption-group-specific learned patterns |
| **Auxiliary Outputs** | Total, Rank, Improved? | Multi-task regularization; enforces consistency |

---

## 3. Sequence Features (Per Timestep)

Each of the last N shows (N=15) will have these features:

### A. Temporal Context
| Feature | Description | Range |
|---------|-------------|-------|
| `percentThroughSeason` | 0-100% through season | [0, 1] |
| `daysSinceLastShow` | Days since previous show | [0, 30] |
| `showNumber` | Which show of the season (global, 1-indexed) | [1, 20] |
| `showOfSeason` | Corps' show count this season (1=debut) | [1, 20] |

### B. Performance (per caption) - **RESIDUALS, NOT RAW**
| Feature | Description | Notes |
|---------|-------------|-------|
| `residual_GE1` | GE1 score - baseline(rank, pct) | ±5 range |
| `residual_GE2` | GE2 score - baseline | |
| `residual_VP` | Visual Proficiency residual | |
| `residual_VA` | Visual Analysis residual | |
| `residual_CG` | Color Guard residual | |
| `residual_MB` | Music Brass residual | |
| `residual_MA` | Music Analysis residual | |
| `residual_MP` | Music Percussion residual | |

### C. Competitive Position
| Feature | Description | Notes |
|---------|-------------|-------|
| `rankAtShow` | Corps' rank at this show | [1, 25] |
| `gapToLeader` | Points behind 1st place | [0, 20] |
| `gapToPrev` | Points behind next-higher corps | [0, 5] |
| `fieldStrength` | Average rank of competitors | [5, 15] |
| `prevSeasonRankAsOf` | Corps' final rank from previous season | [1, 25] or 0 if new |
| `gapToPrevSeasonRank` | Current rank - previous season rank | [-10, +10] |

### D. Competition Context
| Feature | Description | Notes |
|---------|-------------|-------|
| `isFinals` | Championship/Finals show | 0/1 |
| `isRegional` | Regional competition | 0/1 |
| `corpsCountInClass` | Number of corps at show | [5, 25] |
| `performanceOrder` | Where in lineup corps performed | [1, 25] normalized |
| `performanceOrderPct` | % through lineup (0=first, 1=last) | [0, 1] |

### E. Travel & Logistics
| Feature | Description | Notes |
|---------|-------------|-------|
| `distanceFromLastShowKm` | Distance traveled since last show | [0, 2000] log-scaled |
| `totalDistanceLast7Days` | Cumulative travel in past week | Fatigue indicator |
| `showCountLast7Days` | Number of shows in past week | [0, 5] |

### F. Optional Judge Features (if known)
| Feature | Description | Notes |
|---------|-------------|-------|
| `panelBias_total` | Historical panel scoring tendency | [-2, +2] |
| `hasKnownPanel` | Whether panel was known | 0/1 |

### G. Trajectory/Momentum Features (Derived)
| Feature | Description | Notes |
|---------|-------------|-------|
| `residualSlope_3show` | Linear trend of total residual over last 3 shows | Captures momentum |
| `residualVolatility` | Std dev of residuals over last 5 shows | Consistency indicator |
| `improvementStreak` | Consecutive shows with positive residual delta | [0, 10] |
| `bestResidualSoFar` | Maximum residual achieved this season | Peak performance |

### H. Caption-Level Trajectory (Per Caption)
| Feature | Description | Notes |
|---------|-------------|-------|
| `slope_GE1`, `slope_GE2`, ... | Trend per caption over last 3 shows | Caption-specific momentum |
| `rank_GE1`, `rank_VP`, ... | Per-caption rank at each show | [1, 25] |
| `gapToLeader_GE1`, ... | Per-caption gap to best in field | |

**Total: ~35-45 features per timestep**

---

## 4. Context Features (Static per prediction)

### A. Identity Embeddings
| Input | Vocabulary | Embedding Dim | Dropout |
|-------|------------|---------------|---------|
| `corps_id` | ~50 | 16 | 0.15 |
| `season_id` | ~12 | 8 | 0.10 |
| `division_id` | ~5 | 4 | 0.05 |

### B. Judge Panel (if known)
| Input | Vocabulary | Embedding Dim | Notes |
|-------|------------|---------------|-------|
| `judge_ids[16]` | ~200 | 12 | Mean-pooled |

### C. Prediction Context (numeric)
| Feature | Description |
|---------|-------------|
| `currentRankAsOf` | Corps' rank heading into this show |
| `currentPctThroughSeason` | When in season we're predicting |
| `avgFieldRank` | Strength of field at target show |
| `daysUntilShow` | How far out the prediction is |
| `performanceOrderAtTarget` | Expected lineup position (if known) |
| `distanceToVenueKm` | Travel distance to target show (if known) |

---

## 5. Target Variables

### Primary: Caption Residuals (24 outputs)
```
For each of 8 captions:
  - p10 residual (10th percentile)
  - p50 residual (median)  
  - p90 residual (90th percentile)
```

### Reconstruction
```typescript
// At inference time:
const baseline = getBaselineCurve(corps.rankAsOf, pctThroughSeason);
const predictedScore = {
  GE1: baseline.GE1 + model.predict(...).GE1_p50,
  GE2: baseline.GE2 + model.predict(...).GE2_p50,
  // ...
};
```

---

## 6. Loss Function: Combined Multi-Task Loss

```typescript
function v4CombinedLoss(
  quantiles: number[],      // [0.1, 0.5, 0.9]
  rankWeight: number,       // pairwise ranking loss weight
  totalWeight: number,      // total score consistency weight
  consistencyWeight: number, // caption sum consistency weight
  auxWeight: number         // auxiliary task weight
) {
  return (yTrue, yPred) => {
    // 1. Quantile Loss (pinball) - primary objective
    const qLoss = quantileLoss(quantiles, yTrue, yPred);
    
    // 2. Pairwise Ranking Loss - relative ordering matters
    const rLoss = pairwiseRankingLoss(yTrue, yPred);
    
    // 3. Total Score MSE - calibration anchor
    const tLoss = totalScoreMSE(yTrue, yPred);
    
    // 4. Consistency Loss - captions should sum to total
    const cLoss = consistencyLoss(yPred);
    
    // 5. Auxiliary: Improvement prediction (binary)
    const auxLoss = improvementBCE(yTrue, yPred);
    
    return qLoss 
      + rankWeight * rLoss 
      + totalWeight * tLoss 
      + consistencyWeight * cLoss
      + auxWeight * auxLoss;
  };
}
```

### Multi-Task Auxiliary Losses
| Task | Output | Loss | Weight |
|------|--------|------|--------|
| Caption residuals (primary) | 24 values | Quantile | 1.0 |
| Total score | 1 value | MSE | 0.5 |
| Rank prediction | 1 value | MSE | 0.3 |
| Improved vs last show | 1 binary | BCE | 0.2 |

### Uncertainty-Aware Sample Weighting
```typescript
// Weight hard samples more heavily
function computeSampleWeight(row: TrainingRow): number {
  const baseWeight = 1.0;
  
  // Early season = harder = upweight
  const seasonMultiplier = 1.0 + (1.0 - row.pctThroughSeason) * 0.5;
  
  // Volatile corps = harder = upweight
  const volatilityMultiplier = 1.0 + Math.min(row.residualVolatility / 2.0, 0.5);
  
  // Recent seasons = more relevant = upweight
  const recencyMultiplier = Math.exp(-0.1 * row.seasonsAgo);
  
  return baseWeight * seasonMultiplier * volatilityMultiplier * recencyMultiplier;
}
```

---

## 7. Anti-Overfitting Strategy

### A. Regularization
| Technique | Setting | Purpose |
|-----------|---------|---------|
| L2 weight decay | 1e-4 | Penalize large weights |
| Dropout (dense) | 0.25 | Force redundant pathways |
| Embedding dropout | 0.15 | Prevent corps memorization |
| Recurrent dropout | 0.10 | LSTM regularization |

### B. Data Augmentation
| Technique | Rate | Purpose |
|-----------|------|---------|
| Judge masking | 30% | Cold-start robustness |
| Score feature noise | σ=0.1 | Smooth decision boundaries |
| Sequence truncation | 20% | Handle variable history lengths |

### C. Training Discipline
| Technique | Setting | Purpose |
|-----------|---------|---------|
| Early stopping | patience=15 | Prevent overfitting |
| Best weights restore | ✓ | Use optimal checkpoint |
| Learning rate schedule | ReduceOnPlateau | Fine-tune convergence |
| Gradient clipping | 1.0 | LSTM stability |

---

## 8. Implementation Phases

### Phase 1: Data Engineering (Foundation)
- [ ] **1.1** Compute per-caption reference curves (not just total)
  - File: `scripts/computeReferenceCurvesV4.ts`
  - Output: `referenceCurvesV4.json` with curves for each caption
  
- [ ] **1.2** Update sequence builder for residual targets
  - File: `src/buildMlSequencesV4.ts`
  - Store `x_sequence_json` with residual features
  - Store `y_residuals_json` with residual targets
  
- [ ] **1.3** Add caption rank history to sequences
  - Query: Per-show caption ranks for each corps
  - Include: `rank_GE1`, `rank_VP`, etc. per timestep

### Phase 2: Model Architecture
- [ ] **2.1** Build V4 model with multi-input architecture
  - File: `src/training/trainModelV4.ts`
  - Inputs: sequence + all embeddings
  
- [ ] **2.2** Implement combined loss function
  - Quantile + Ranking + Total + Consistency
  
- [ ] **2.3** Add bidirectional LSTM option
  - Compare unidirectional vs bidirectional

### Phase 3: Training Infrastructure
- [ ] **3.1** Progress logger with finals prediction table
  - Show reconstructed scores (baseline + residual)
  - Display ranking accuracy
  
- [ ] **3.2** Validation metrics
  - MAE per caption
  - Ranking accuracy (top-3, top-5)
  - Calibration (% in p10-p90 interval)
  
- [ ] **3.3** Model checkpointing and comparison
  - Save best model per metric
  - Compare V4 vs V3 vs V2

### Phase 4: Evaluation & Refinement
- [ ] **4.1** Comprehensive evaluation script
  - By season phase (early/mid/late)
  - By corps tier (top-6, mid-pack, lower)
  - By prediction horizon
  
- [ ] **4.2** Ablation studies
  - LSTM only vs LSTM + embeddings
  - Residual vs raw scores
  - With vs without consistency loss

---

## 9. Success Metrics

### Primary Metrics
| Metric | Target | V3 Baseline |
|--------|--------|-------------|
| MAE (total score) | < 1.0 pts | ~1.5 pts |
| Top-3 ranking accuracy | > 85% | ~75% |
| Finals ranking accuracy | > 90% | ~80% |

### Calibration Metrics
| Metric | Target | Notes |
|--------|--------|-------|
| % in p10-p90 interval | 78-82% | Should be ~80% |
| % in p25-p75 interval | 48-52% | Should be ~50% |

### Per-Caption Metrics
| Caption | Target MAE | Notes |
|---------|------------|-------|
| GE1, GE2 | < 0.3 pts | Most stable |
| VP, VA, CG | < 0.4 pts | More variable |
| MB, MA, MP | < 0.4 pts | Panel-dependent |

---

## 10. File Structure

```
sdk/
├── src/
│   ├── training/
│   │   ├── trainModelV4.ts          # Main training script
│   │   ├── buildMlSequencesV4.ts    # Sequence data builder
│   │   ├── evaluateV4.ts            # Evaluation metrics
│   │   └── referenceCurvesV4.json   # Per-caption baselines
│   └── mlQueries.ts                  # Extended queries for caption ranks
├── models/
│   └── v4_trajectory/                # Saved model artifacts
├── scripts/
│   └── computeReferenceCurvesV4.ts   # Reference curve generator
└── v4_sequence_model_plan.md         # This document
```

---

## 11. Data Engineering Best Practices

### A. Sequence Padding & Masking Strategy
```typescript
// Option 1: Masking (Recommended)
// - Use tf.layers.masking to tell LSTM to ignore padded timesteps
// - Pad with zeros but add mask layer before LSTM

// Option 2: Virtual First Show (for corps debut)
// - If corps has 0 shows, use division average as "virtual show 0"
// - Helps cold-start predictions

const paddingStrategy = {
  shortSequence: "mask",     // < 15 shows: pad with zeros + mask
  newCorps: "divisionAvg",   // 0 shows: use division average features
  maskValue: 0.0
};
```

### B. Reference Curve Smoothing
```typescript
// Problem: Sparse data at rare (rank, pct) combinations
// Solution: Hierarchical fallback with interpolation

function getReferenceCurve(rank: number, pct: number, caption: string): number {
  // 1. Try exact match
  const exact = curves[`${rank}-${Math.floor(pct/5)*5}`]?.[caption];
  if (exact !== undefined) return exact;
  
  // 2. Try interpolation between nearby buckets
  const lower = curves[`${rank}-${Math.floor(pct/5)*5}`]?.[caption];
  const upper = curves[`${rank}-${Math.ceil(pct/5)*5}`]?.[caption];
  if (lower && upper) return lower + (upper - lower) * (pct % 5) / 5;
  
  // 3. Fall back to rank-only average
  const rankAvg = rankAverages[rank]?.[caption];
  if (rankAvg !== undefined) return rankAvg;
  
  // 4. Fall back to global average
  return globalAverages[caption];
}
```

### C. Cross-Season Validation Strategy
```
Training Strategy:
├── Development: Leave-one-season-out (LOSO)
│   └── Train on 2015-2022, validate on 2023, test on 2024
│   └── Train on 2015-2021+2023, validate on 2022, test on 2024
│   └── ... average metrics across all folds
│
└── Final Model: Train on 2015-2023, test on 2024

This ensures model generalizes across:
- Scoring trend changes
- New corps entering/exiting
- Judge panel composition changes
```

### D. Feature Normalization
| Feature Type | Normalization | Notes |
|--------------|---------------|-------|
| Percentages (pctThrough, etc.) | None | Already [0, 1] |
| Scores/residuals | Z-score (per caption) | Use training set mean/std |
| Ranks | MinMax to [0, 1] | rank / max_rank |
| Distances | Log transform + Z-score | Skewed distribution |
| Binary flags | None | Already 0/1 |
| Counts | Log transform | showCount, etc. |

---

## 12. Design Clarifications

### A. Sequence Length Justification
| Length | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| N=10 | Faster training; fewer params | May miss early-season context | ❌ |
| N=15 | Good balance; covers most seasons | - | ✅ **Recommended** |
| N=20 | Full season coverage | More padding; slower | Consider for Finals only |

**Ablation**: Test N=10, 15, 20 and compare val_loss.

### B. Handling "New" Corps (No History)
```typescript
// Corps with showOfSeason = 0 (predicting debut)
if (corpsHistory.length === 0) {
  // Use fallback features:
  // - prevSeasonRank (if returning corps) 
  // - division average trajectory (if new corps)
  // - Set all trajectory features to 0
  // - Set hasHistory flag = 0
  
  // The model learns: "No history + Rank 8 last year = predict baseline"
}
```

### C. Judge Panel Availability
```
Production Reality:
- Panel known: ~70% of predictions (announced 1-7 days before)
- Panel unknown: ~30% of predictions (TBA or future shows)

Strategy:
- hasKnownPanel flag tells model when to rely on panel
- Judge masking (30% during training) ensures robustness
- When unknown: use panelBias_total = 0 (neutral)
```

### D. Model Size Constraints
| Constraint | Limit | Impact |
|------------|-------|--------|
| TFJS in browser | < 5MB | May need smaller embeddings |
| Node.js inference | < 50MB | No concern |
| Real-time latency | < 500ms | Single forward pass is fine |

**Recommendation**: Start unconstrained; optimize if needed for browser deployment.

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Sequence length mismatch** | Medium | High | Pad sequences; use masking |
| **Reference curve sparsity** | Medium | Medium | Use interpolation + global fallback |
| **Judge data missing** | High | Low | Judge dropout during training |
| **LSTM training slow** | High | Medium | Batch size tuning; GPU if available |
| **Overfitting to recent seasons** | Medium | High | Sample weighting; cross-season validation |
| **Attention overhead** | Medium | Medium | Profile; fall back to BiLSTM-only if slow |

---

## 14. Future Work (V5 Ideas)

- **Transformer architecture**: Full self-attention over sequence (if V4 attention works well)
- **Design complexity embeddings**: Encode show difficulty from repertoire
- **Venue effects**: Add venue embeddings for acoustic/visual differences
- **Multi-task with sub-breakdowns**: Predict Content/Achievement splits
- **Ensemble**: Combine V4 with V2 for robust predictions
- **Real-time updates**: Fine-tune on new data during season

---

## 15. Implementation Notes & Considerations

### A. Critical Implementation Notes

1. **Leakage Prevention (CRITICAL)**
   - ALL features must be computed "as-of" the prediction time
   - Never use data from the target competition or later
   - Double-check: `competition_date < target_date` in ALL queries
   - Test: Pick random rows, verify no future data leaks

2. **Residual Target Computation**
   ```typescript
   // CORRECT: Use rank and pct from BEFORE the target show
   const baseline = getReferenceCurve(rankAsOfPriorShow, pctThroughSeason);
   const residual = actualScore - baseline;
   
   // WRONG: Using rank AT the target show (leakage!)
   ```

3. **Sequence Ordering**
   - Sequences should be **chronologically ordered** (oldest first, newest last)
   - LSTM processes oldest → newest, final hidden state captures recent context
   - Attention can look back at any timestep

4. **Missing Data Encoding**
   - Use `0.0` for missing numeric values
   - Set corresponding `has_*` flag to `0`
   - Model learns: "When hasLastShow=0, ignore lastScore values"

5. **Judge Panel Encoding**
   - Pad judge array to fixed length (16)
   - Use `0` for unknown/missing judges (maps to UNK embedding)
   - Sort judges by caption order for consistency

### B. Performance Considerations

1. **Memory Usage**
   - Sequence shape: [batch, 15, 45] = 675 floats per sample
   - With batch=64, one batch = 43K floats = ~170KB
   - Should fit comfortably in memory even with full dataset

2. **Training Speed**
   - BiLSTM is not parallelizable across timesteps
   - Expect ~1-2 epochs/minute on CPU
   - Consider: Start with smaller model, scale up if underfitting

3. **Tensor Type Consistency**
   - Sequence input: `float32`
   - Embedding inputs: `int32`
   - Targets: `float32`
   - Mismatch causes silent errors!

### C. Debugging Strategies

1. **Overfit Test**: Train on 10 samples, verify loss → 0
2. **Single Corps Test**: Does model predict reasonably for one well-known corps?
3. **Baseline Comparison**: Does V4 beat V3? V2? Simple "last score" baseline?
4. **Feature Ablation**: Remove one feature group, see impact
5. **Attention Visualization**: Which timesteps get highest attention weights?

### D. Known Gotchas from V1/V2/V3

| Problem | Symptom | Solution |
|---------|---------|----------|
| Corps memorization | Train loss << val loss | Increase embedding dropout |
| Calendar curve learning | Slow convergence | Use residuals, not raw scores |
| Ranking errors | High MAE but close scores | Add pairwise ranking loss |
| Early season poor | High error for pct < 30% | Add prevSeasonRank; upweight samples |
| Panel-dependent variance | Music captions vary more | Add judge embeddings + dropout |

---

## 16. Detailed TODO List

### Phase 1: Data Engineering [Priority: HIGH]

#### 1.1 Reference Curves
- [ ] Create `scripts/computeReferenceCurvesV4.ts`
- [ ] Query historical scores grouped by (rank, pct_bucket, caption)
- [ ] Compute mean score per (rank, pct, caption) combination
- [ ] Implement interpolation for sparse buckets
- [ ] Add global fallback for very sparse regions
- [ ] Save to `src/training/referenceCurvesV4.json`
- [ ] Verify: curves[1-100] > curves[12-100] for all captions

#### 1.2 Sequence Data Builder
- [ ] Create `src/buildMlSequencesV4.ts`
- [ ] Define V4SequenceRow schema in database
- [ ] Implement feature extraction per timestep:
  - [ ] Temporal context (pct, days, showNumber, showOfSeason)
  - [ ] Residuals per caption (8 features)
  - [ ] Competitive position (rank, gaps, prevSeasonRank)
  - [ ] Competition context (finals, regional, order, count)
  - [ ] Travel (distance, total7day, showCount7day)
  - [ ] Trajectory (slopes, volatility, streak, best)
  - [ ] Caption trajectory (per-caption slopes, ranks)
- [ ] Implement padding for short sequences
- [ ] Add split assignment (train/val/test by date)
- [ ] Verify: Feature count matches expected (~40)
- [ ] Verify: No NaN/Inf values in output

#### 1.3 Caption Rank History
- [ ] Add query for per-caption ranks at each show
- [ ] Compute rank within show for each caption
- [ ] Store in sequence features

### Phase 2: Model Architecture [Priority: HIGH]

#### 2.1 Core Model
- [ ] Create `src/training/trainModelV4.ts`
- [ ] Implement sequence input with LayerNormalization
- [ ] Implement stacked BiLSTM (64 → 32 units)
- [ ] Add residual connection from Layer 1
- [ ] Implement temporal attention layer
- [ ] Implement embedding layers (corps, season, division, judge)
- [ ] Implement gated fusion layer
- [ ] Implement shared trunk (256 → 128)
- [ ] Implement separate heads (GE, Visual, Music)
- [ ] Implement auxiliary heads (total, rank, improved)
- [ ] Verify: Model compiles without errors
- [ ] Verify: Output shape is [batch, 27] (24 + 3 aux)

#### 2.2 Loss Function
- [ ] Implement quantile loss for 24 caption outputs
- [ ] Implement pairwise ranking loss
- [ ] Implement total score MSE loss
- [ ] Implement consistency loss (sum check)
- [ ] Implement improvement BCE loss
- [ ] Combine with configurable weights
- [ ] Verify: Loss decreases during training

#### 2.3 Sample Weighting
- [ ] Implement `computeSampleWeight()` function
- [ ] Weight by season phase (early = higher)
- [ ] Weight by volatility (higher = higher weight)
- [ ] Weight by recency (recent seasons = higher)
- [ ] Verify: Weights sum to reasonable total

### Phase 3: Training Infrastructure [Priority: MEDIUM]

#### 3.1 Progress Logger
- [ ] Create ProgressLogger callback class
- [ ] Load 2024 Finals data for preview
- [ ] Compute reconstructed scores (baseline + residual)
- [ ] Display prediction table each epoch
- [ ] Show ranking vs actual ranking
- [ ] Display MAE per caption

#### 3.2 Metrics & Evaluation
- [ ] Create `src/training/evaluateV4.ts`
- [ ] Compute MAE per caption
- [ ] Compute total score MAE
- [ ] Compute ranking accuracy (top-3, top-5, exact)
- [ ] Compute calibration (% in p10-p90)
- [ ] Compare vs V3 and V2 baselines
- [ ] Segment by season phase and corps tier

#### 3.3 Checkpointing
- [ ] Implement early stopping (patience=15)
- [ ] Save best weights by val_loss
- [ ] Save model artifacts (JSON + weights)
- [ ] Save normalization stats
- [ ] Save reference curves used
- [ ] Save training metadata (hyperparams, data hash)

### Phase 4: Validation & Refinement [Priority: MEDIUM]

#### 4.1 Ablation Studies
- [ ] Test: LSTM only (no embeddings)
- [ ] Test: Residuals vs raw scores
- [ ] Test: With/without attention
- [ ] Test: With/without auxiliary losses
- [ ] Test: Sequence length N=10, 15, 20
- [ ] Document results in comparison table

#### 4.2 Error Analysis
- [ ] Identify worst predictions (corps, shows)
- [ ] Analyze: Are they early season? New corps? Panel issues?
- [ ] Check for systematic biases
- [ ] Iterate on features if needed

---

## 17. Verification Criteria & Requirements

### A. Data Quality Requirements

| Check | Requirement | How to Verify |
|-------|-------------|---------------|
| No NaN/Inf | 0 NaN or Inf in any feature | `df.isna().sum() == 0` |
| Feature ranges | All values in expected ranges | Min/max checks per feature |
| Sequence completeness | All rows have valid sequences | JSON parse succeeds |
| Split integrity | Train < Val < Test by date | Date range checks |
| No leakage | No target data in features | Manual audit of 10 random rows |
| Caption coverage | All 8 captions present | Check y_recap_json keys |
| Reference curve coverage | >95% of (rank, pct) pairs filled | Sparsity check |

### B. Model Quality Requirements

| Metric | V4 Target | V3 Baseline | V2 Baseline | Requirement |
|--------|-----------|-------------|-------------|-------------|
| Total MAE | < 1.0 pts | ~1.5 pts | ~1.2 pts | Pass |
| Caption MAE (avg) | < 0.35 pts | ~0.5 pts | ~0.4 pts | Pass |
| Top-3 Accuracy | > 85% | ~75% | ~80% | Pass |
| Finals Top-5 Exact | > 60% | ~45% | ~50% | Pass |
| Calibration (p10-p90) | 75-85% | ~70% | ~75% | Pass |
| Val Loss < Train Loss | < 2x | - | - | Pass (no overfit) |

### C. Functional Requirements

| Requirement | Description | Verification |
|-------------|-------------|--------------|
| **FR-1** | Model accepts variable-length sequences (1-15 shows) | Test with len=1, 5, 15 |
| **FR-2** | Model handles missing judge panels gracefully | Test with all-zero judge IDs |
| **FR-3** | Model produces valid quantile ordering (p10 ≤ p50 ≤ p90) | Check output monotonicity |
| **FR-4** | Inference completes in < 500ms for single batch | Time `model.predict()` |
| **FR-5** | Model saves/loads correctly | Save → Load → Predict matches |
| **FR-6** | Training is deterministic with seed | Run twice, compare weights |

### D. Testing Checklist

#### Unit Tests
- [ ] Reference curve lookup returns valid values
- [ ] Sequence builder produces correct shape
- [ ] Loss function computes without NaN
- [ ] Sample weight function returns > 0

#### Integration Tests
- [ ] Full pipeline: DB → Sequences → Tensors → Model → Prediction
- [ ] Training runs for 5 epochs without error
- [ ] Saved model loads and predicts successfully
- [ ] ProgressLogger displays valid table

#### Regression Tests
- [ ] V4 MAE ≤ V3 MAE on validation set
- [ ] V4 ranking accuracy ≥ V3 on finals
- [ ] No performance regression on any metric

#### Smoke Tests
- [ ] Predict 2024 Finals:
- [ ] Predict early season show: reasonable uncertainty (wide p10-p90)
- [ ] Predict for new corps: falls back to prevSeasonRank baseline

---

## 18. Acceptance Criteria

### Minimum Viable V4 (MVP)
- [ ] Model trains without errors
- [ ] Val loss < 0.20 (quantile loss scale)
- [ ] Total MAE < 1.5 pts (better than naive baseline)
- [ ] Produces reasonable Finals predictions

### Production Ready V4
- [ ] All verification criteria pass
- [ ] Total MAE < 1.0 pts
- [ ] Top-3 accuracy > 85%
- [ ] Calibration 75-85%
- [ ] Model saves/loads correctly
- [ ] Documentation complete

### Stretch Goals
- [ ] Total MAE < 0.8 pts
- [ ] Finals exact ranking matches actual (all 12 corps)
- [ ] Browser-deployable TFJS model (<5MB)
- [ ] Real-time prediction API

---

## Appendix A: Reference Curve Schema

```json
{
  "version": "v4",
  "captions": ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"],
  "curves": {
    "1-0": { "GE1": 19.2, "GE2": 19.1, "VP": 19.0, ... },
    "1-5": { "GE1": 19.3, "GE2": 19.2, "VP": 19.1, ... },
    "1-10": { "GE1": 19.4, "GE2": 19.3, "VP": 19.2, ... },
    ...
    "12-100": { "GE1": 17.8, "GE2": 17.7, "VP": 17.5, ... }
  }
}
```

Key format: `{rank}-{percentThroughSeason}`

---

## Appendix B: Sequence Data Schema

```typescript
interface V4SequenceRow {
  row_id: number;
  season: string;
  competition_slug: string;
  competition_date: string;
  division_name: string;
  corps_key: string;
  corps_id: number;
  season_id: number;
  division_id: number;
  
  // Sequence input: [SeqLen, Features]
  x_sequence_json: string; // JSON array of timestep feature vectors
  
  // Context features
  current_rank_as_of: number;
  current_pct_through: number;
  avg_field_rank: number;
  judge_ids_json: string; // [16] padded judge IDs
  
  // Targets: residuals from baseline
  y_residuals_json: string; // {GE1: 0.3, GE2: 0.1, ...}
  
  // Raw recap for evaluation
  y_recap_json: string; // {GE1: 19.5, GE2: 19.3, ...}
  
  split: "train" | "val" | "test";
}
```

---

*Document created: 2026-01-09*
*Based on learnings from V1, V2, V3 iterations and DCI scoring domain expertise*
