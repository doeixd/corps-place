# V7 Curriculum Learning - Progress Tracking

## Overview
This document tracks the implementation and training progress of the V7 Curriculum Learning model for DCI score prediction.

## Implementation Progress

### ✅ Milestone M0: Database Schema Extensions (COMPLETED)
**Date**: 2026-01-16

**Tasks Completed**:
- [x] Added 6 new tables to relational.ts:
  - `judge_elo_ratings` - Judge Elo per season/caption
  - `judge_elo_history` - Chronological Elo updates
  - `corps_elo_ratings` - Corps Elo per season
  - `corps_elo_history` - Corps Elo trajectory
  - `ml_sequence_rows_v7` - Training sequences
  - `show_aggregates_v7` - Comparative vectors
- [x] Added 5 indexes for performance
- [x] Created v7_progress.md tracking document
- [x] Model output directory structure

**Validation**:
```bash
# Verify tables created
sqlite3 dci-relational.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%v7%' OR name LIKE '%elo%'"
```

---

### ✅ Milestone M1: Judge Elo Computation System (COMPLETED)
**Date**: 2026-01-16

**Tasks Completed**:
- [x] Implemented computeEloRatingsV7.ts with Glicko-style algorithm
  - Per-caption Elo tracking for judges and corps
  - Confidence decay (95% per show, minimum 5)
  - K-factor computation (8-32 based on confidence)
  - Capped Elo changes at ±100 per show
- [x] Added 4 query helpers to mlQueries.ts:
  - `queryJudgeEloRatings()` - Fetch judge Elo
  - `queryCorpsEloHistory()` - Fetch corps trajectory
  - `queryJudgePanelElo()` - Fetch judges at show
  - `queryCorpsEloRatings()` - Fetch corps Elo
- [x] Ran Elo computation on historical data (2013-2024, excluding 2020-2021)
- [x] Validated Elo distribution

**Results**:
- Total Elo updates: 71,607 across 10 seasons
- Judge Elo ratings: 3,760 records
- Corps Elo ratings: 5,091 records
- Judge Elo mean: 1507.2 (target: ~1500) ✅
- Judge Elo std: 70.0 (target: <200) ✅
- Judge Elo range: 1285.2 - 2119.0
- Mean confidence: 26.6 (decay working correctly) ✅
- No NaN/Inf values ✅

**Key Fixes**:
- Fixed critical bug: Judge Elo was moving in wrong direction (needed `-judgeK * error`)
- Fixed caption name formatting (Music Brass → Music - Brass)
- Fixed PRIMARY KEY constraint in corps_elo_ratings (removed COALESCE expression)

---

### ✅ Milestone M2: Judge Embedding Infrastructure (COMPLETED)
**Date**: 2026-01-16

**Tasks Completed**:
- [x] Created buildJudgeIndexMap.ts script
- [x] Queried all unique judge IDs from judge_scores table
- [x] Built mapping: judgeId → integer index
- [x] Reserved index 0 for 'unknown' judges
- [x] Saved mapping to src/training/judgeIndexMap.json

**Results**:
- Total unique judges: 302
- Total mapping entries: 303 (including 'unknown')
- Coverage: 100.0% of judge scores have mapped judges
- Embedding input dimension: 303
- Index range: 0-302

---

### ✅ Milestone M3: Comparative Vector Engineering (COMPLETED)
**Date**: 2026-01-16

**Tasks Completed**:
- [x] Created buildShowAggregatesV7.ts script
- [x] Computed show-level aggregates for all competitions
- [x] Calculated per-caption averages (8 captions)
- [x] Stored aggregates in show_aggregates_v7 table

**Results**:
- Total show aggregates: 984 competitions
- Average field size: 8.5 corps per show
- Average total score: 69.94
- Average competitiveness (std): 7.70
- Competitiveness range: 0.00 - 42.19
- Finals 2024 World Class: Avg=92.87, Std=3.81, Field=12
- Finals 2024 Open Class: Avg=76.35, Std=4.93, Field=10

**Comparative Features Ready**:
- `relative_total = (corps_total - show_avg_total) / show_std_total`
- `relative_caption[i] = (corps_caption[i] - show_avg_caption[i])`
- `show_competitiveness = show_std_total`
- `field_size_norm = field_size / 25`

---

### ⏳ Milestone M4: V7 Sequence Builder (PENDING)
**Status**: Not started

---

### ⏳ Milestone M5: Loss Scheduler (PENDING)
**Status**: Not started

---

### ⏳ Milestone M6: Dynamic Data Loader (PENDING)
**Status**: Not started

---

### ⏳ Milestone M7: Training Script (PENDING)
**Status**: Not started

---

### ⏳ Milestone M8: Pilot Training & Evaluation (PENDING)
**Status**: Not started

---

## Training Logs

### Pilot Run (200 epochs)
*Training not started*

---

## Performance Metrics

### Validation Metrics (200-epoch pilot)
| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| MAE (points) | < 0.95 | - | ⏳ |
| Coverage | > 0.75 | - | ⏳ |
| Phase 1 completion | Smooth | - | ⏳ |
| Phase 2 completion | Smooth | - | ⏳ |
| Phase 3 completion | Smooth | - | ⏳ |

---

## Issues & Notes

### 2026-01-16
- M0 completed successfully
- Database schema extensions added non-destructively
- V6 compatibility maintained

---

## Next Steps
1. Implement Elo computation (M1)
2. Build judge index mapping (M2)
3. Compute show aggregates (M3)
4. Integrate features into sequence builder (M4)

---

## Decisions Made
- **Elo Algorithm**: Glicko-style with confidence decay (K=8-32)
- **Embedding Dimension**: 16-dim
- **Show Aggregates**: Precompute to table
- **Training Budget**: 200-epoch pilot first
- **V6 Compatibility**: Parallel deployment, easy rollback
