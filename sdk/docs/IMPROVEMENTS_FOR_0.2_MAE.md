# Improvements to Reach 0.2 MAE Target

Current: 0.43 MAE @ Epoch 213
Target: 0.2 MAE
Gap: 0.23 points to close

## Category 1: Model Architecture (Highest Impact)

### 1. Increase Model Capacity
**Current**: 216K params, LSTM(64→32)
**Proposed**: Try LSTM(128→64) or add another layer
```typescript
lstm1Units: 128,  // was 64
lstm2Units: 64,   // was 32
```
**Expected gain**: -0.05 to -0.10 MAE
**Rationale**: More capacity to learn complex judge-specific patterns

### 2. Add Transformer Attention
**Current**: BiLSTM with simple attention pool
**Proposed**: Replace with multi-head self-attention
```typescript
// After LSTM layers
const attention = tf.layers.multiHeadAttention({
  numHeads: 4,
  keyDim: 32
}).apply([lstm2, lstm2]);
```
**Expected gain**: -0.03 to -0.08 MAE
**Rationale**: Better capture long-range dependencies in season trajectory

### 3. Judge-Caption Interaction Layer
**Current**: Judge embeddings → flatten → concat
**Proposed**: Learn judge-caption-specific biases
```typescript
// Per-caption judge embeddings
const judgeCapEmbed = tf.layers.embedding({
  inputDim: JUDGE_COUNT * CAPTION_COUNT,
  outputDim: 8
});
```
**Expected gain**: -0.02 to -0.05 MAE
**Rationale**: Some judges score certain captions systematically different

## Category 2: Training Improvements (Medium Impact)

### 4. Lower Learning Rate + Longer Training
**Current**: lr=0.0005, 500 epochs
**Proposed**: lr=0.0002, 800 epochs with cosine schedule
```typescript
learningRate: 0.0002,
epochs: 800,
```
**Expected gain**: -0.02 to -0.04 MAE
**Rationale**: Fine-tune to find better local minimum

### 5. Reduce Identity Dropout Earlier
**Current**: identityDropout starts 0.95, ends 0.1 at epoch 400
**Proposed**: Ramp down earlier to learn corps patterns sooner
```typescript
// Start ramping down at epoch 150 instead of 250
const idDrop = (epoch < 150) ? 0.95 : Math.max(0.05, 0.95 - 0.9 * ((epoch - 150) / 250));
```
**Expected gain**: -0.01 to -0.03 MAE
**Rationale**: Corps-specific adjustments help for familiar corps

### 6. Ensemble Multiple Models
**Current**: Single model
**Proposed**: Train 3-5 models with different seeds, average predictions
**Expected gain**: -0.03 to -0.06 MAE
**Rationale**: Reduces variance, smooths out individual model quirks

## Category 3: Feature Engineering (Low-Medium Impact)

### 7. Add Weather/Venue Features
**Missing**: Outdoor vs indoor, temperature, time of day
**Proposed**: Scrape venue metadata, add to static features
**Expected gain**: -0.01 to -0.02 MAE
**Rationale**: Weather affects performance (especially brass)

### 8. Judge Fatigue Features
**Missing**: Position in show order, number of corps judged so far
**Proposed**: Add "judge_shows_today", "position_in_lineup"
**Expected gain**: -0.01 to -0.02 MAE
**Rationale**: Judges get stricter/looser as night progresses

### 9. Historical Judge-Corps Interactions
**Current**: No memory of past judge-corps pairings
**Proposed**: Feature: "avg score this judge gave this corps historically"
**Expected gain**: -0.02 to -0.03 MAE
**Rationale**: Some judges consistently favor/penalize certain corps

### 10. Momentum/Streak Features
**Missing**: "Won last 3 shows", "Improving trajectory"
**Proposed**: Add win_streak, improvement_rate to static features
**Expected gain**: -0.01 to -0.02 MAE
**Rationale**: Psychological momentum affects performance

## Category 4: Data Quality (Low Impact)

### 11. Clean Outliers
**Current**: All data used as-is
**Proposed**: Remove scores >3σ from mean (likely errors)
**Expected gain**: -0.01 MAE
**Rationale**: Bad data hurts more than it helps

### 12. Augment Early-Season Data
**Current**: Less data for shows with <3 performances
**Proposed**: Synthetic augmentation via mixup/noise injection
**Expected gain**: -0.005 to -0.01 MAE
**Rationale**: Better early-season predictions

## Recommended Implementation Order

### Phase 1: Quick Wins (1-2 days)
1. ✅ Increase model capacity (128→64 LSTM)
2. ✅ Lower learning rate + extend training
3. ✅ Ramp down identity dropout earlier

**Expected combined gain**: -0.08 to -0.17 MAE
**New target**: 0.26-0.35 MAE

### Phase 2: Architecture (3-5 days)
4. ✅ Add multi-head attention
5. ✅ Judge-caption interaction embeddings

**Expected combined gain**: -0.05 to -0.13 MAE
**New target**: 0.21-0.30 MAE

### Phase 3: Features (5-7 days)
6. ✅ Historical judge-corps interactions
7. ✅ Momentum/streak features
8. ✅ Judge fatigue features

**Expected combined gain**: -0.04 to -0.07 MAE
**New target**: 0.17-0.26 MAE

### Phase 4: Polish (2-3 days)
9. ✅ Ensemble 3 models
10. ✅ Clean outliers

**Expected combined gain**: -0.03 to -0.07 MAE
**Final target**: 0.14-0.23 MAE

## Realistic Target

With all improvements: **0.18-0.25 MAE**

- Best case: 0.18 MAE (approaching judge variance floor)
- Expected: 0.22 MAE (reasonable with full effort)
- Conservative: 0.25 MAE (with Phase 1+2 only)

## Immediate Next Steps

1. **Test capacity increase**: Modify trainModelV9-test.ts to use LSTM(128→64)
2. **Run overnight**: 800 epochs with lr=0.0002
3. **Measure gain**: If we hit 0.35 MAE, continue to Phase 2

Would you like me to implement Phase 1 changes now?
