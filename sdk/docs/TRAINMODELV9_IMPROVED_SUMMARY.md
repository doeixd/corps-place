# trainModelV9-improved.ts Summary

## Overview
Enhanced version of trainModelV9-test.ts targeting **0.18-0.25 MAE** (down from current 0.43 MAE).

## Key Improvements

### 1. Increased Model Capacity
**Previous (V9-test)**: 216K parameters
**New (V9-improved)**: ~520K parameters (+142% increase)

| Component | V9-test | V9-improved | Gain |
|-----------|---------|-------------|------|
| LSTM Layer 1 | 64 units | 128 units | +100% |
| LSTM Layer 2 | 32 units | 64 units | +100% |
| Dense Layer 1 | 128 units | 256 units | +100% |
| Dense Layer 2 | 64 units | 128 units | +100% |
| Judge Embedding | 16 dim | 24 dim | +50% |
| Corps Embedding | 16 dim | 20 dim | +25% |
| Show Embedding | 8 dim | 12 dim | +50% |
| Strength Layer | 16 units | 24 units | +50% |

### 2. Optimized Training Schedule
| Parameter | V9-test | V9-improved | Rationale |
|-----------|---------|-------------|-----------|
| Learning Rate | 0.0005 | 0.0003 | Finer optimization |
| Min Learning Rate | 0.00005 | 0.00003 | Better late-stage convergence |
| Total Epochs | 500 | 800 | More time to converge |
| Early Stopping | 50 epochs | 80 epochs | Match longer training |

### 3. Earlier Corps-Specific Learning
**Identity Dropout Ramp**:
- **V9-test**: Starts at epoch 150, ramps to 0.1 over 150 epochs
- **V9-improved**: Starts at epoch 100, ramps to 0.05 over 200 epochs

**Benefit**: Corps-specific patterns learned 50 epochs earlier, with even lower final dropout (0.05 vs 0.1).

### 4. Extended Phase C
**V9-test**: Phase C ends at epoch 400
**V9-improved**: Phase C extends through epoch 800

The quantile weight ramp now has 680 epochs instead of 280 to reach full uncertainty quantification.

## Expected Performance Gains

### Conservative Estimates
- **Model Capacity**: -0.05 to -0.08 MAE
- **Training Schedule**: -0.02 to -0.04 MAE
- **Earlier Dropout Ramp**: -0.01 to -0.03 MAE
- **Total Expected Gain**: **-0.08 to -0.15 MAE**

**Target Performance**: 0.28-0.35 MAE (from current 0.43)

### Optimistic Estimates
With all improvements working synergistically:
- **Best Case**: 0.22-0.28 MAE
- **Realistic**: 0.28-0.32 MAE
- **Conservative**: 0.33-0.37 MAE

## Training Time
- **V9-test**: ~3.5 hours (500 epochs)
- **V9-improved**: ~5-7 hours (800 epochs)
- **Extra time**: +1.5-3.5 hours

## Parameter Counts by Component

### BiLSTM Layers
- **Layer 1**: 128 units bidirectional = 256 total output
  - Params: ~165K (vs 84K in V9-test)
- **Layer 2**: 64 units bidirectional = 128 total output
  - Params: ~82K (vs 41K in V9-test)

### Embeddings
- **Judge**: 356 judges × 24 dim = ~8.5K params (+50%)
- **Corps**: 453 corps × 20 dim = ~9K params (+25%)
- **Show**: ~160 shows × 12 dim = ~1.9K params (+50%)

### Dense Layers
- **Dense 1**: 256 units (input ~458 dim) = ~117K params (+100%)
- **Dense 2**: 128 units (input 256 dim) = ~33K params (+100%)
- **Strength**: 24 units (input 64 dim) = ~1.6K params (+50%)

## Usage

```bash
# Basic training (uses all defaults)
npx tsx src/training/trainModelV9-improved.ts

# With custom hyperparameters
npx tsx src/training/trainModelV9-improved.ts \
  --lr 0.0002 \
  --lstm1-units 160 \
  --lstm2-units 80 \
  --epochs 1000

# Load from checkpoint
npx tsx src/training/trainModelV9-improved.ts \
  --load-model ./models/v9_improved/run_xxx/best
```

## File Locations
- **Model**: `./models/v9_improved/`
- **Normalization**: `./results/v9-improved-target-norm.json`
- **Training logs**: Console output (redirect to file if needed)

## Next Steps After This Model

If V9-improved achieves 0.28-0.32 MAE, implement Phase 2:
1. **Multi-head self-attention** (expected -0.03 to -0.08 MAE)
2. **Judge-caption interaction embeddings** (expected -0.02 to -0.05 MAE)
3. **Historical judge-corps bias features** (expected -0.02 to -0.04 MAE)

Combined with Phase 1, should reach **0.20-0.25 MAE range**.

## Validation

To verify improvements are working:
1. **Epoch 50**: Should see ~0.35-0.40 MAE (vs 0.40-0.45 in V9-test)
2. **Epoch 200**: Should see ~0.30-0.35 MAE (vs 0.35-0.40 in V9-test)
3. **Epoch 500**: Should see ~0.25-0.30 MAE (vs 0.30-0.35 in V9-test)
4. **Epoch 800**: Target 0.22-0.28 MAE

If not hitting these milestones, may need to:
- Reduce learning rate further (0.0002)
- Increase dropout (0.25 LSTM dropout)
- Add gradient clipping (already at 1.0, could try 0.5)
