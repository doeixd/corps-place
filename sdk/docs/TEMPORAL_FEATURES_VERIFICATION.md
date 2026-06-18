# Temporal Features Verification Summary

## Executive Summary

✅ **ALL TEMPORAL FEATURES ARE CORRECTLY CALCULATED**

All temporal progression features (percent-through-season, number-of-shows-performed, etc.) are mathematically correct across V7, V9, and V10. No bugs were found.

## Verified Features

### 1. **percent_through** ✓ CORRECT

- **Source**: Pre-computed in database during ingestion
- **Calculation**: `(dayOfSeason / seasonLength) × 100`
  - `dayOfSeason = days_between(competition_date, season_first_date)`
  - `seasonLength = days_between(season_last_date, season_first_date)`
- **Location**: `relational.ts:3789-3790`
- **Usage**: `feats.push(show.percent_through / 100)` (normalized to 0-1)
- **Test Result**: All 18 test shows matched calculated values perfectly

### 2. **number-of-shows-performed** ✓ CORRECT

- **Calculation**: `(showIdx + 1) / pastCount`
  - `showIdx`: Index in the sequence (0-based)
  - `pastCount`: Total number of shows this corps has performed so far
- **Meaning**: "This is the Nth show out of M shows performed"
- **Example**: At show #3 out of 12 total → 3/12 = 0.25
- **Test Result**: Correctly represents cumulative show count

### 3. **days_since_corps_start** ✓ CORRECT

- **Calculation**: `normalizeDays(daysBetween(corpsFirstShowDate, currentShowDate))`
- **Meaning**: How many days since THIS corps started competing this season
- **Note**: Uses corps' first show, NOT season start (intentional)
- **Purpose**: Captures late-starting vs early-starting corps

### 4. **days_since_prev_show** ✓ CORRECT

- **Calculation**: `min(daysBetween(prevShow, currentShow), 14) / 14`
- **Meaning**: Days since last performance, capped at 14, normalized to [0, 1]
- **Fallback**: 0.5 for first show (neutral value)
- **Purpose**: Captures show frequency and rest time

### 5. **position_in_sequence** ✓ CORRECT

- **Calculation**: `(showIdx + 1) / SEQ_LEN`
- **Meaning**: Position within the fixed-length sequence window
- **Example**: For SEQ_LEN=12, ranges from 0.083 (1/12) to 1.0 (12/12)
- **Independent of**: Total shows performed

### 6. **cyclic_date** (sin/cos) ✓ CORRECT

- **V7/V9 Calculation**:
  ```typescript
  const dayOfYear = (date - startOfYear) / 86400000;
  const dayRad = (dayOfYear / 366) × 2π;
  feats.push(sin(dayRad), cos(dayRad));
  ```
- **V10 Calculation**:
  ```typescript
  const dayOfYear = (date - startOfYear) / 86400000;
  feats.push(sin(2π × dayOfYear / 365), cos(2π × dayOfYear / 365));
  ```
- **Purpose**: Captures seasonal patterns (spring shows vs summer shows vs finals)

### 7. **show_count_progress** ✓ CORRECT (with differences)

- **V7/V9**: `(showIdx + 1) / 40.0` - NO CAP, can exceed 1.0
- **V10**: `Math.min(showIdx + 1, 40) / 40` - CAPPED at 1.0
- **Both are valid**: V10 prevents unbounded feature growth
- **Location**:
  - V7/V9: Line ~709 (immediately after cyclic date)
  - V10: Line ~809 (later in feature list)

## Semantic Clarifications

### ⚠️ The "remaining" Feature

**Current Name**: "remaining"
**Calculation**: `(pastCount - showIdx - 1) / pastCount`

**What it ACTUALLY represents**:
- Temporal distance from the present moment within the sequence
- At oldest timestep: ~0.92 (far from present)
- At most recent timestep: 0.0 (at present)

**What it DOES NOT represent**:
- ❌ Shows left until finals
- ❌ Percentage of season remaining

**Better mental model**: "recency_weight" or "lookback_distance"

**Is this a bug?** NO - It's mathematically correct and useful for attention mechanisms. The name is just potentially confusing.

## Version Differences

### V7 & V9: IDENTICAL

Temporal features (10 total):
1. percent_through / 100
2. daysSince (prev show)
3. (showIdx + 1) / SEQ_LEN
4. 0 (padding marker)
5. days_since_corps_start
6. (showIdx + 1) / pastCount
7. (pastCount - showIdx - 1) / pastCount
8. sin(dayRad)
9. cos(dayRad)
10. (showIdx + 1) / 40.0

### V10: DIFFERENT

Temporal features (11 total):
1-7. Same as V7/V9
8. **normalizeGap(gapToWinnerPrev)** ← EXTRA, not in V7/V9
9-12. Performance order features
... (captions, opponents, comparative)
XX. Math.min(showIdx + 1, 40) / 40 ← CAPPED
XX. sin(dayOfYear)
XX. cos(dayOfYear)

**Key Differences**:
- V10 adds `gapToWinnerPrev` early
- V10 caps show count at 40
- V10 places cyclic date later in feature list
- V10 feature set is incompatible with V7/V9 models

## Test Results

### Test 1: percent_through Accuracy
```
Found 18 shows for Bluecoats 2024
All 18 shows: ✓ Database value matched calculated value
```

### Test 2: Temporal Feature Calculations
```
Simulating show #13 (using shows 1-12 as history):
- Season progress: 75.6% through season ✓
- Days since corps start: 34 days ✓
- Show count: 12 shows performed ✓
- Position in sequence: timesteps 1-12 ✓
```

### Test 3: Show Count Normalization
```
Show 40: V7/V9 = 1.0000, V10 = 1.0000 ✓ Same
Show 50: V7/V9 = 1.2500, V10 = 1.0000 ⚠️ Different (intentional)
```

## Recommendations

1. ✅ **No code changes needed** - All calculations are correct
2. ✅ **percent_through correctly represents season progress**
3. ✅ **number-of-shows-performed is correctly calculated**
4. ⚠️ **Document V10's intentional differences** from V7/V9
5. ℹ️ **Consider the "remaining" feature as "recency_weight"** mentally
6. ✅ **All three versions are internally consistent**

## Scripts Used for Verification

- `scripts/testTemporalFeatures.ts` - Tests percent_through accuracy and feature calculations
- `scripts/compareTemporalFeaturesV7V9V10.ts` - Analyzes differences between versions
- `scripts/verifyTemporalFeaturesAllVersions.ts` - Comprehensive verification report

## Conclusion

**All temporal progression features are correctly calculated.** The feature engineering is sound, and there are no bugs in the computation of:
- Percent through season
- Number of shows performed
- Days since corps started
- Show frequency/spacing
- Seasonal timing (cyclic date)
- Position in sequence

The only "issues" are semantic (naming) and intentional differences between versions, not calculation errors.

✅ **VERIFICATION COMPLETE - ALL SYSTEMS NOMINAL**
