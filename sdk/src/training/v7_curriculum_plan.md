# V7 Curriculum Learning Implementation Plan

Building on the successes of V6-PROD, V7 will transition from "all-at-once" training to a **tiered curriculum**. This mimics how human judges learn: first understanding the overall competitive field, then mastering categorical captions, and finally developing the intuition for judge-specific variability.

## 📜 Project Context & Evolution
The journey to V7 has been a progression of "De-averaging" the truth:
*   **V4 & V5**: Focused on predicting single totals. We discovered the **Aggregation Fallacy**—averaging judge scores masks the "Judge Signal" (the systematic bias of a specific judge).
*   **V6**: Introduced **Multitask Residuals**. Instead of predicting scores, we predict how far a judge will deviate from an EMA baseline.
*   **The V6 Coverage Lesson**: We learned that **Inverse-Noise Weighting** (weighting by caption reliability) is good for MAE but terrible for Coverage. It causes "Width Shrinkage" where the model ignores uncertainty in noisy captions to minimize total loss.

V7's mission is to integrate these lessons into a structured learning path.

---

## 📅 The 3-Phase Syllabus

### Phase 1: Macro-Gravity (The "Coarse" Stage)
*   **Duration**: Epochs 1–50
*   **Focus**: `total_score` and `recap` heads only across **both World Class and Open Class**.
*   **Curriculum Context**: 
    *   `SEQ_LEN`: Starts at **5 shows** to learn immediate trends.
    *   Loss Weighting: **1.0 Total/Recap**, **0.0 Residuals**.
*   **Goal**: Force the Bi-LSTM to learn the coarse hierarchical structure of the DCI season (World Class vs. Open Class spreads) without being distracted by noisy judge residuals.

### Phase 2: Category Alignment (The "Recap" Stage)
*   **Duration**: Epochs 51–150
*   **Focus**: Categorical breakdowns (GE1, MA, VP, etc.).
*   **Curriculum Context**:
    *   `SEQ_LEN`: Increases to **15 shows**.
    *   Loss Weighting: **0.5 Recaps**, **0.5 Residuals** (Median head only).
*   **Goal**: The model now understands categorical "buckets" and starts to learn why a corps might be an "MA powerhouse" but weak in "VP," even if their total score is high.

### Phase 3: The Grokking Tail (The "Fine" Stage)
*   **Duration**: Epochs 151–300
*   **Focus**: `residuals` and `quantiles` (p10/p90) for all corps.
*   **Curriculum Context**:
    *   Full Sequence Context.
    *   **Judge Intelligence**: Integration of **Judge Embeddings** to learn specific judge biases (e.g., "Judge X is harsh on GE").
    *   **Relative Show Context**: Integration of the **Comparative Vector** (how everyone else did that night).
    *   **Mixed Class Training**: Balanced sampling between World and Open Class.
    *   **Identity Dropout**: Corps ID is masked (set to 0) with 80% probability to prevent over-reliance on names.
    *   Loss Weighting: Focus on **Quantile Consistency** and **Interval Coverage**.
*   **Goal**: Fine-tune the uncertainty intervals. Turning "general noise" into "specific judge personality."

### Phase 4: Identity Unmasking (The "V7-CA" Stage)
*   **Duration**: Epochs 301–500
*   **Focus**: Corps Identity Integration.
*   **Curriculum Context**:
    *   **Identity Unmasking**: Reduce Identity Dropout from 80% to 10%.
    *   **Corps-Aware Embeddings**: Allow the model to learn specific historical tendencies or judge-corps interactions.
    *   SWA (Stochastic Weight Averaging) begins here.
*   **Goal**: The "Final Polish." Use identity as a secondary signal to refine predictions when performance features are ambiguous.

---

## 🧠 The Reasoning: Why Mask Identity?
The user raised a critical question: *Should we provide identities first, or drop them out later?*

The **V7-CA** strategy chooses **Masking First (Unmasking Later)** for the following reasons:
1.  **Anti-Reputation Bias**: We want the model to learn the *logic* of the scores. If it knows a legendary corps is performing, it might "guess" a high score based on the name alone. Masking forces it to look at the residuals and comparative context.
2.  **Robust Backbone**: By the time Phase 4 starts, the LSTM and Attention layers have already learned how to extract signal from performance data. The Corps Embedding then acts as a "corrective residual" rather than the primary driver.
3.  **Generalization**: A model that can predict a score without knowing the corps name is inherently more robust to "dark horse" seasons or emerging corps.

---

## 🏁 Project Milestones

| Milestone | Deliverable | Success Criteria |
| :--- | :--- | :--- |
| **M1: Dynamic Loader** | Data provider supporting `valSplit=0.01` and balanced class sampling. | Batch consistency: 3:1 World/Open ratio. |
| **M2: Loss Engine** | `LossScheduler` class modifying weights per-epoch. | Automated weight shift at E50 and E150. |
| **M3: Comp Vector** | Head-to-Head feature injection (`compAvg` for each show). | Model sensitivity to "Hard Judge" shows increases. |
| **M4: V7-Prod** | Full 500-epoch training run on 11-year dataset. | MAE < 0.85, Coverage > 0.82. |

---

## ⚠️ Implementation Hazards & Considerations

### 1. Catastrophic Forgetting
**Risk**: Between Phase 1 and Phase 2, the model might "forget" how to predict accurate total scores as it obsesses over sub-caption residuals.
**Mitigation**: We will not use hard transitions. Instead, we use a **decaying loss floor**. Even in Phase 3, the `total_score` head will maintain a minimum weight of 0.1 to keep the backbone grounded in reality.

### 2. Class Imbalance (World vs. Open)
**Risk**: World Class has significantly more shows and more "stable" judging panels. The model might treat Open Class as "noise" rather than a different distribution.
**Mitigation**: Implement **Class-Weighted Sampling** in the data loader. Every batch of 32 should ideally contain at least 8 Open Class sequences.

### 3. Feature Drift
**Risk**: Historical features (Years in World Class, etc.) are static, but corps evolve.
**Mitigation**: The Bi-LSTM's internal state is responsible for capturing this "momentum." We must ensure the `SEQ_LEN` is long enough (15+) to capture a full season's upward trajectory.

---

## 🧪 Technical Advancements

### 1. Judge Embeddings (Bias Capture)
We will map each judge ID to a 16-dimensional embedding vector.
*   **Mechanism**: Concatenate the judge embedding to the static feature vector.
*   **Impact**: Allows the model to differentiate between "generic Music Analysis" and "Judge John Doe's specific Music Analysis style."

### 2. The Comparative Vector (Social Normalization)
For every show in the sequence, we add the average score of all other corps at that show.
*   **Logic**: `residual = (corps_score - show_avg) - EMA_prediction`.
*   **Impact**: Isolates a corps' performance from the judge's overall "harshness" for that night.

### 3. Elo-Based Momentum (Long-Term Priors)
We will calculate an Elo-style rating for every corps that persists across seasons.
*   **Mechanism**: A static feature representing the corps' starting Elo for the year and a dynamic feature for their current season Elo.
*   **Impact**: Prevents the model from "over-reacting" to early-season judge noise and provides a stable baseline for corps with limited 2024 data.

---

## 🛠️ Step-by-Step Implementation Steps

1.  **Refactor `SequenceDataProvider`**:
    *   Modify to accept an `epoch` parameter.
    *   Implement variable sequence slicing (randomly slicing sequences down to 5 in early epochs).
2.  **Develop `V7LossScheduler`**:
    *   Create a class that maps `epoch -> {totalWeight, recapWeight, residualWeight, quantileWeight}`.
    *   Plug this into the `trainStep` to multiply gradients.
3.  **Engineered Features**:
    *   Update `mlQueries.ts` to fetch "Show Average" for each corps-show junction.
    *   Map Judge Names to IDs for embedding lookups.
    *   **Elo Calculator**: Create a pre-processing script to generate historical Elo ratings for all corps.
4.  **Model Archetype**:
    *   Add `tf.layers.embedding` for judges.
    *   Inject Elo ratings into the static feature vector.

---

## 📈 Success Metrics for V7
*   **Generalization MAE**: Target < 0.90 points on randomized 11-year validation.
*   **Interval Coverage**: Target > 0.82 (consistently).
*   **GE/VP Bias**: Reduction in the systematic bias observed in V6 for these specific captions.




 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 V7 Curriculum Learning Implementation Plan

 Overview

 Implement the V7 curriculum learning system that trains a DCI score prediction model in 3 phases, mimicking how human
 judges learn: first understanding the competitive field, then mastering categorical captions, and finally developing
 intuition for judge-specific variability.

 Context Summary

 V7 Philosophy (from v7_curriculum_plan.md)

 - 3-Phase Training Curriculum:
   - Phase 1 (Epochs 1-50): Macro-Gravity - Focus on total_score and recap heads only
   - Phase 2 (Epochs 51-150): Category Alignment - Add categorical breakdowns
   - Phase 3 (Epochs 151-500): The Grokking Tail - Full residuals, quantiles, judge embeddings
 - Key Innovations: Judge embeddings, comparative vectors, Elo-based momentum
 - Goals: MAE < 0.90, Coverage > 0.82, reduce GE/VP bias

 V6 Architecture (Current State)

 - Stacked Bi-LSTM (64→32 units) with attention mechanism
 - Multi-task outputs: Q10/Q50/Q90 quantiles + recap + total (33 values)
 - 57 sequence features × 15 timesteps + 53 static features
 - Complex loss function: residual + recap + total + consistency + width penalty
 - Training on 2013-2024 data, Finals 2024 held out for testing

 Database Schema

 - Core tables: competitions, corps_scores, caption_scores, judge_scores
 - Judge data: judges, judge_assignments, judge_scores, subcaption_scores
 - Historical features: corps_historical_features_v6
 - Missing: Judge Elo ratings (need to create)

 Implementation Plan

 IMPLEMENTATION ORDER & DEPENDENCIES

 M0: Database Schema [BLOCKING - 2 hrs]
   ↓
 M1: Elo Computation [8 hrs] ←── Needs M0
 M2: Judge Embedding Infrastructure [4 hrs] ←── Needs M0
 M3: Comparative Vector [4 hrs] ←── Independent
   ↓
 M4: V7 Sequence Builder [10 hrs] ←── Needs M1, M2, M3
   ↓
 M5: Loss Scheduler [2 hrs] ←── Independent
 M6: Dynamic Data Loader [3 hrs] ←── Independent
   ↓
 M7: Training Script [6 hrs] ←── Needs M4, M5, M6
   ↓
 M8: Evaluation & Validation [5 hrs] ←── Needs M7

 TOTAL: ~44 hours + buffer = 55-65 hours

 Critical Path: M0 → M1/M2/M3 (parallel) → M4 → M7 → M8

 ---
 PHASE 1: FOUNDATION & SETUP

 Milestone M0: Database Schema Extensions

 Goal: Add all required tables non-destructively (V6 remains untouched)

 Tasks:
 1. Add 4 new tables to sdk/src/relational.ts in ensureRelationalSchema():
 -- Judge Elo per season/caption
 CREATE TABLE IF NOT EXISTS judge_elo_ratings (
   judge_id TEXT NOT NULL,
   season TEXT NOT NULL,
   caption_name TEXT NOT NULL,
   elo_rating REAL NOT NULL DEFAULT 1500,
   confidence REAL NOT NULL DEFAULT 50,
   num_scores INTEGER NOT NULL DEFAULT 0,
   last_updated TEXT,
   PRIMARY KEY (judge_id, season, caption_name),
   FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
 );

 -- Judge Elo history (chronological updates)
 CREATE TABLE IF NOT EXISTS judge_elo_history (
   history_id INTEGER PRIMARY KEY AUTOINCREMENT,
   judge_id TEXT NOT NULL,
   season TEXT NOT NULL,
   competition_slug TEXT NOT NULL,
   caption_name TEXT NOT NULL,
   elo_before REAL NOT NULL,
   elo_after REAL NOT NULL,
   updated_at TEXT NOT NULL,
   FOREIGN KEY (judge_id) REFERENCES judges(judge_id) ON DELETE CASCADE
 );

 -- Corps Elo per season (overall + per-caption)
 CREATE TABLE IF NOT EXISTS corps_elo_ratings (
   corps_key TEXT NOT NULL,
   season TEXT NOT NULL,
   caption_name TEXT, -- NULL = overall Elo
   elo_rating REAL NOT NULL DEFAULT 1500,
   confidence REAL NOT NULL DEFAULT 50,
   num_shows INTEGER NOT NULL DEFAULT 0,
   last_updated TEXT,
   PRIMARY KEY (corps_key, season, COALESCE(caption_name, 'overall')),
   FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
 );

 -- Corps Elo history
 CREATE TABLE IF NOT EXISTS corps_elo_history (
   history_id INTEGER PRIMARY KEY AUTOINCREMENT,
   corps_key TEXT NOT NULL,
   season TEXT NOT NULL,
   competition_slug TEXT NOT NULL,
   caption_name TEXT,
   elo_before REAL NOT NULL,
   elo_after REAL NOT NULL,
   competition_date TEXT NOT NULL,
   FOREIGN KEY (corps_key) REFERENCES corps(corps_key) ON DELETE CASCADE
 );

 -- ML sequences table for V7
 CREATE TABLE IF NOT EXISTS ml_sequence_rows_v7 (
   corps_key TEXT NOT NULL,
   target_slug TEXT NOT NULL,
   x_sequence_json TEXT NOT NULL,
   x_static_json TEXT NOT NULL,
   judge_indices_json TEXT NOT NULL,  -- NEW: judge IDs for embedding
   y_residuals_json TEXT NOT NULL,
   y_recap_json TEXT NOT NULL,
   y_total REAL NOT NULL,
   division_name TEXT NOT NULL,  -- NEW: for class balancing
   created_at TEXT NOT NULL,
   PRIMARY KEY (corps_key, target_slug)
 );

 -- Indexes for performance
 CREATE INDEX IF NOT EXISTS idx_judge_elo_season ON judge_elo_ratings(season, caption_name);
 CREATE INDEX IF NOT EXISTS idx_corps_elo_season ON corps_elo_ratings(season);
 CREATE INDEX IF NOT EXISTS idx_corps_elo_history_date ON corps_elo_history(corps_key, season, competition_date);
 CREATE INDEX IF NOT EXISTS idx_ml_v7_division ON ml_sequence_rows_v7(division_name);
 2. Create v7_progress.md tracking document:
   - sdk/src/training/v7_progress.md
 3. Set up model output directory:
   - sdk/models/v7_curriculum/

 Validation:
 # Verify tables created
 sqlite3 dci-relational.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%v7%' OR name LIKE
 '%elo%'"

 # Ensure V6 still works
 npm run build-sequences-v6 -- --maxRows 10

 Critical Files:
 - sdk/src/relational.ts (lines ~650-750)
 - New: sdk/src/training/v7_progress.md

 ---
 PHASE 2: DATA FOUNDATION

 Milestone M1: Judge Elo Computation System

 Goal: Compute judge-specific Elo ratings to capture bias and expertise

 Algorithm (Glicko-style Elo with Confidence Decay):
 // For each judge score on a caption at a show
 const expectedPerformance = 1 / (1 + Math.exp(-(corpsElo - judgeElo) / 400));
 const actualPerformance = normalizeScoreToUnit(judgeScore, captionMin, captionMax);
 const K = computeKFactor(judgeConfidence, corpsConfidence); // 8-32 range
 const judgeEloNew = judgeElo + K * (actualPerformance - expectedPerformance);
 const judgeConfidenceNew = Math.max(5, judgeConfidence * 0.95); // 5% decay

 Parameters:
 - Initial Elo: 1500 (neutral baseline)
 - Initial Confidence: 50 (high uncertainty)
 - K-factor: 32 (new judges) → 16 (experienced) → 8 (veteran)
 - Confidence Decay: 5% per show, minimum 5
 - Per-Caption: Separate Elo for each caption (judge expertise varies)

 Tasks:
 1. Create sdk/scripts/computeEloRatingsV7.ts:
   - Process competitions chronologically to prevent data leakage
   - For each season → for each show → for each judge-corps-caption score:
       - Fetch current Elo (or init to 1500)
     - Compute expected vs actual performance
     - Update both judge and corps Elo
     - Decay confidence (95% of previous)
     - Record history for momentum features
   - Cap Elo change at ±100 per show (prevent instability)
 2. Add query helpers to sdk/src/mlQueries.ts:
   - queryJudgeEloRatings(season, caption) - Fetch judge Elo
   - queryCorpsEloHistory(corpsKey, season) - Fetch corps trajectory
   - queryJudgePanelForShow(slug) - Fetch judges at show

 Validation:
 // After running computeEloRatingsV7.ts
 const judgeElos = await sql`SELECT elo_rating FROM judge_elo_ratings`;
 const mean = avg(judgeElos);
 const std = stdDev(judgeElos);
 console.assert(Math.abs(mean - 1500) < 50, "Mean Elo should ≈ 1500");
 console.assert(std < 200, "Std Elo should < 200");

 Success Criteria:
 - Elo ratings computed for all seasons (2013-2024)
 - Mean ≈ 1500, Std < 200 (balanced system)
 - 90% of judges have confidence < 15 by season end
 - No NaN/Inf values

 Critical Files:
 - New: sdk/scripts/computeEloRatingsV7.ts (~400 lines)
 - sdk/src/mlQueries.ts (+100 lines)

 ---
 Milestone M2: Judge Embedding Infrastructure

 Goal: Create judge ID mappings for embedding layer

 Tasks:
 1. Create sdk/scripts/buildJudgeIndexMap.ts:
 // Query all unique judge_id values
 const judges = await sql`SELECT DISTINCT judge_id FROM judge_scores ORDER BY judge_id`;

 // Create mapping: judgeId -> integer index
 const mapping = { 'unknown': 0 }; // Reserve 0 for unknown judges
 judges.forEach((j, idx) => mapping[j.judge_id] = idx + 1);

 // Save to JSON
 fs.writeFileSync('./src/training/judgeIndexMap.json', JSON.stringify(mapping, null, 2));
 2. Update sequence builder to include judge indices:
   - For target show, get judge panel from judge_assignments
   - Look up index for each judge in mapping
   - Create array: [judgeIdx_GE1, judgeIdx_GE2, ..., judgeIdx_MP] (8 indices)
   - Store in judge_indices_json column

 Validation:
 const mapping = JSON.parse(fs.readFileSync('./src/training/judgeIndexMap.json'));
 console.log(`Mapped ${Object.keys(mapping).length} judges`);
 console.assert(mapping['unknown'] === 0, "Index 0 reserved for unknown");

 // Check coverage
 const coverage = (mappedJudges / totalJudgeScores) * 100;
 console.assert(coverage > 95, "Should map 95%+ of judge scores");

 Success Criteria:
 - Judge mapping covers 200-300 unique judges
 - Unknown judges default to index 0
 - 95%+ of judge_scores have mapped judges

 Critical Files:
 - New: sdk/scripts/buildJudgeIndexMap.ts (~50 lines)
 - New: sdk/src/training/judgeIndexMap.json (generated)

 ---
 Milestone M3: Comparative Vector Engineering

 Goal: Add "show context" features to isolate corps performance from judge harshness

 Tasks:
 1. Create sdk/scripts/buildShowAggregatesV7.ts:
 // For each competition
 for (const show of competitions) {
   const scores = await sql`
     SELECT total_score, caption_scores
     FROM corps_scores cs
     JOIN caption_scores caps ON cs.corps_key = caps.corps_key AND cs.competition_slug = caps.competition_slug
     WHERE cs.competition_slug = ${show.slug}
   `;

   const showAggregate = {
     slug: show.slug,
     avg_total: mean(scores.map(s => s.total_score)),
     std_total: stdDev(scores.map(s => s.total_score)),
     avg_by_caption: computeCaptionAverages(scores), // 8 values
     field_size: scores.length
   };

   // Store in show_aggregates_v7 table
   await insertShowAggregate(showAggregate);
 }
 2. Add comparative features in buildMlSequencesV7.ts:
   - For each show in sequence:
       - relative_total = (corps_total - show_avg_total) / show_std_total
     - relative_caption[i] = (corps_caption[i] - show_avg_caption[i])
     - show_competitiveness = show_std_total
     - field_size_norm = field_size / 25
   - Add ~10 new sequence features per timestep

 Validation:
 // Check feature ranges
 const compVectors = sequences.map(s => s.comparativeVector);
 console.assert(compVectors.every(v => Math.abs(v.relative_total) < 5), "Relative total should be z-score");
 console.assert(compVectors.every(v => v.show_competitiveness > 0), "Competitiveness should be positive");

 Success Criteria:
 - Show aggregates computed for all competitions
 - Comparative features capture "hard judge" vs "easy judge" nights
 - Finals shows have higher show_competitiveness than regionals

 Critical Files:
 - New: sdk/scripts/buildShowAggregatesV7.ts (~200 lines)
 - sdk/src/relational.ts (add show_aggregates_v7 table)

 ---
 Milestone M4: V7 Sequence Builder (Integration)

 Goal: Combine all new features into training sequences

 Tasks:
 1. Create sdk/src/buildMlSequencesV7.ts (copy from buildMlSequencesV6Production.ts):
   - Import all V6 feature computation logic
   - Add Elo feature extraction (from M1)
   - Add judge index lookup (from M2)
   - Add comparative vectors (from M3)
   - Update feature dimensions:
       - Sequence features: 57 → 67 (add 10 comparative features)
     - Static features: 53 → 73 (add 12 judge Elo + 8 corps Elo)
 2. Feature breakdown per timestep (67 total):
   - V6 Features (57): temporal (7), performance context (7), per-caption (32), opponent (7), show context (4)
   - NEW Comparative (10): relative_total, relative_caption×8, show_competitiveness
 3. Static feature breakdown (73 total):
   - V6 Features (53): historical, sequence properties, opponent stats
   - NEW Judge Features (12): per-caption avg judge Elo (8), panel Elo mean/std/max/min (4)
   - NEW Corps Features (8): per-caption corps Elo (8)
 4. Update table insertion:
   - Insert into ml_sequence_rows_v7 table
   - Include judge_indices_json column
   - Include division_name for class balancing

 Validation:
 # Build sequences
 npx tsx src/buildMlSequencesV7.ts --maxRows 100

 # Verify dimensions
 sqlite3 dci-relational.db "SELECT x_sequence_json FROM ml_sequence_rows_v7 LIMIT 1"
 # Parse and check: timestep.length === 67

 # Check judge indices
 sqlite3 dci-relational.db "SELECT judge_indices_json FROM ml_sequence_rows_v7 WHERE target_slug LIKE '%finals%'"
 # Should be array of 8 integers

 Success Criteria:
 - Sequence features = 67 per timestep
 - Static features = 73
 - Judge indices populated for 95%+ of rows
 - Division name populated for all rows
 - Row count matches V6 (±5%)

 Critical Files:
 - New: sdk/src/buildMlSequencesV7.ts (~800 lines, mostly copied from V6)

 ---
 PHASE 3: CURRICULUM & TRAINING INFRASTRUCTURE

 Milestone M5: Loss Scheduler

 Goal: Implement dynamic loss weighting across training phases

 Tasks:
 1. Create V7LossScheduler class in trainModelV7.ts:
 class V7LossScheduler {
   getWeights(epoch: number): {
     totalWeight: number;
     recapWeight: number;
     residualWeight: number;
     quantileWeight: number;
     consistencyWeight: number;
   } {
     // Phase 1 (1-50): Focus on total/recap
     if (epoch < 48) {
       return { total: 1.0, recap: 1.0, residual: 0.0, quantile: 0.0, consistency: 0.2 };
     }
     // Transition 1 (48-52): Smooth ramp
     if (epoch < 52) {
       const t = (epoch - 48) / 4; // 0 to 1
       return {
         total: 1.0 - 0.7 * t,  // 1.0 → 0.3
         recap: 1.0 - 0.5 * t,  // 1.0 → 0.5
         residual: 0.5 * t,     // 0.0 → 0.5
         quantile: 0.0,
         consistency: 0.2
       };
     }
     // Phase 2 (52-148): Category alignment
     if (epoch < 148) {
       return { total: 0.3, recap: 0.5, residual: 0.5, quantile: 0.0, consistency: 0.2 };
     }
     // Transition 2 (148-152): Ramp to Phase 3
     if (epoch < 152) {
       const t = (epoch - 148) / 4;
       return {
         total: 0.3 - 0.2 * t,  // 0.3 → 0.1
         recap: 0.5 - 0.3 * t,  // 0.5 → 0.2
         residual: 0.5 - 0.1 * t, // 0.5 → 0.4
         quantile: 0.3 * t,     // 0.0 → 0.3
         consistency: 0.2
       };
     }
     // Phase 3 (152-500): Full quantiles
     return { total: 0.1, recap: 0.2, residual: 0.4, quantile: 0.3, consistency: 0.2 };
   }
 }
 2. Integrate into training loop:
   - Call scheduler.getWeights(epoch) at start of each epoch
   - Multiply loss components before summing
   - Log weights to console and v7_progress.md

 Validation:
 const scheduler = new V7LossScheduler();
 console.log("E1:", scheduler.getWeights(1));    // Should be Phase 1
 console.log("E50:", scheduler.getWeights(50));  // Should be Phase 1/2 transition
 console.log("E100:", scheduler.getWeights(100)); // Should be Phase 2
 console.log("E200:", scheduler.getWeights(200)); // Should be Phase 3

 Success Criteria:
 - Weights transition smoothly (no jumps)
 - Total weight never drops below 0.1
 - Console logs show weight progression

 Critical Files:
 - sdk/src/training/trainModelV7.ts (lines ~100-150)

 ---
 Milestone M6: Dynamic Data Loader with Curriculum

 Goal: Support variable sequence length and class-balanced sampling

 Tasks:
 1. Create SequenceDataProviderV7 class:
 class SequenceDataProviderV7 {
   constructor(
     private rows: MLSequenceRow[],
     private epoch: number,
     private batchSize: number = 32
   ) {}

   getSequenceLength(): number {
     if (this.epoch < 50) return 5;   // Phase 1
     if (this.epoch < 150) return 15; // Phase 2
     return 15;                        // Phase 3 (full)
   }

   sliceSequence(fullSeq: number[][], targetLength: number): number[][] {
     if (fullSeq.length <= targetLength) return fullSeq;
     // Random slice of targetLength consecutive timesteps
     const start = Math.floor(Math.random() * (fullSeq.length - targetLength));
     return fullSeq.slice(start, start + targetLength);
   }

   sampleBatch(): MLSequenceRow[] {
     const worldRows = this.rows.filter(r => r.division === 'World Class');
     const openRows = this.rows.filter(r => r.division === 'Open Class');

     // Enforce 3:1 ratio
     const batchWorld = shuffle(worldRows).slice(0, 24);
     const batchOpen = shuffle(openRows).slice(0, 8);

     return shuffle([...batchWorld, ...batchOpen]);
   }
 }
 2. Integrate into training loop:
   - Create new data provider each epoch (pass current epoch)
   - Use getSequenceLength() to determine slicing
   - Use sampleBatch() to enforce class balance

 Validation:
 const provider = new SequenceDataProviderV7(rows, 10, 32);
 const batch = provider.sampleBatch();
 const worldCount = batch.filter(r => r.division === 'World Class').length;
 const openCount = batch.filter(r => r.division === 'Open Class').length;
 console.assert(worldCount === 24 && openCount === 8, "Should be 3:1 ratio");

 const seqLen = provider.getSequenceLength();
 console.assert(seqLen === 5, "Epoch 10 should use 5-show sequences");

 Success Criteria:
 - Sequence length = 5 in Phase 1, 15 in Phase 2/3
 - Batch composition averages 24 World, 8 Open
 - Random slicing creates variety

 Critical Files:
 - sdk/src/training/trainModelV7.ts (lines ~150-250)

 ---
 PHASE 4: TRAINING & EVALUATION

 Milestone M7: Training Script with Judge Embeddings

 Goal: Complete training pipeline with all V7 components

 Tasks:
 1. Create sdk/src/training/trainModelV7.ts (copy from V6Production, extend):

 1. Model Architecture Changes:
 // Update feature dimensions
 const SEQ_LEN = 15; // Will be sliced dynamically by data provider
 const FEAT_DIM = 67; // Was 57 in V6
 const STATIC_DIM = 73; // Was 53 in V6

 // Add judge embedding layer
 const judgeIdsInput = tf.input({ shape: [8], dtype: 'int32', name: 'judge_ids' });
 const judgeEmbedding = tf.layers.embedding({
   inputDim: 300, // Total unique judges
   outputDim: 16,  // Embedding dimension
   embeddingsRegularizer: tf.regularizers.l2({ l2: 0.00001 }),
   name: 'judge_embedding'
 }).apply(judgeIdsInput);
 const judgeFlat = tf.layers.flatten().apply(judgeEmbedding); // [batch, 128]

 // Concatenate with static features
 const staticConcat = tf.layers.concatenate().apply([staticInput, judgeFlat]);
 // staticConcat shape: [batch, 73 + 128 = 201]

 1. Training Loop Updates:
   - Instantiate V7LossScheduler and SequenceDataProviderV7
   - Each epoch:
       - Get loss weights from scheduler
     - Create data provider with current epoch
     - Slice sequences to appropriate length
     - Sample class-balanced batches
     - Compute loss with dynamic weights
     - Log phase info and metrics
 2. Configuration (Pilot Run):
   - Epochs: 200 (pilot run to validate approach)
   - Batch size: 32
   - Learning rate: 0.0005 (cosine annealing)
   - Min LR: 0.00005
   - Early stopping: Disabled for pilot
   - SWA: Not used in pilot (starts at epoch 400 in full run)
   - Snapshots: Save at epochs 50, 150, 200
 3. Monitoring:
   - Log current phase and loss weights each epoch
   - Track total_score MAE separately (watch for forgetting)
   - Log coverage and interval width
   - Save metrics to v7_progress.md

 Validation:
 # Smoke test (10 epochs, 100 samples)
 npx tsx src/training/trainModelV7.ts --epochs 10 --maxRows 100

 # Check logs
 # - Epoch 1-10: Phase 1, seqLen=5, totalWeight=1.0
 # - Loss should decrease
 # - No NaN values

 Success Criteria:
 - Model compiles without errors
 - Forward pass works with judge embeddings
 - Loss decreases in Phase 1
 - Phase transitions at epochs 50, 150
 - No catastrophic forgetting (total_score MAE stable)

 Critical Files:
 - New: sdk/src/training/trainModelV7.ts (~1200 lines)

 ---
 Milestone M8: Pilot Training Run & Evaluation

 Goal: Execute 200-epoch pilot and validate approach

 Tasks:
 1. Run pilot training:
 # 200-epoch pilot run
 npx tsx src/training/trainModelV7.ts --epochs 200 --batch 32

 # Monitor progress
 tail -f sdk/src/training/v7_progress.md
 2. Create evaluation script sdk/scripts/evaluateV7.ts:
   - Load V7 model from models/v7_curriculum/
   - Load V6-Production model for comparison
   - Evaluate on 2024 Finals (test set)
   - Compute metrics:
       - MAE (overall and per-caption)
     - Coverage (% within [Q10, Q90])
     - Interval width (Q90 - Q10)
     - Per-caption bias (predicted - actual)
     - GE/VP specific bias analysis
 3. Generate comparison report:
 # V7 vs V6 Comparison

 | Metric | V6 Baseline | V7 Curriculum | Improvement |
 |--------|-------------|---------------|-------------|
 | MAE    | 0.92        | 0.87          | -5.4%       |
 | Coverage | 0.78      | 0.83          | +6.4%       |
 | GE Bias | -0.15      | -0.09         | +40%        |
 | VP Bias | +0.12      | +0.07         | +42%        |
 4. Ablation studies:
   - Train V7 without judge embeddings → measure impact
   - Train V7 without comparative vectors → measure impact
   - Train V7 without Elo features → measure impact
   - Document which components provide the most value

 Validation:
 # Run evaluation
 npx tsx scripts/evaluateV7.ts

 # Check results
 # - V7 MAE should be < 0.90 (minimum acceptable)
 # - V7 Coverage should be > 0.80
 # - V7 should beat V6 on most metrics

 Success Criteria (Pilot Run):
 - Training completes 200 epochs without NaN
 - V7 MAE < 0.95 (pilot acceptable range)
 - V7 Coverage > 0.75 (pilot acceptable range)
 - Loss decreases across all phases
 - No catastrophic forgetting observed (total_score MAE stable)
 - Phase transitions smooth (no loss spikes at E50, E150)

 Post-Pilot Decision:
 If pilot meets criteria:
 - ✅ Extend to full 500 epochs
 - ✅ Enable SWA starting at epoch 400
 - ✅ Add more snapshots (300, 400, 500)

 If pilot fails:
 - ❌ Run ablation studies to identify weak components
 - ❌ Tune hyperparameters (loss weights, learning rate, etc.)
 - ❌ Consider simplifications (remove judge embeddings, etc.)

 Critical Files:
 - New: sdk/scripts/evaluateV7.ts (~300 lines)
 - sdk/src/training/v7_progress.md (results documentation)

 ---
 Technical Risks & Mitigations

 Risk 1: Catastrophic Forgetting (Phase Transitions)

 Symptom: Model forgets total_score prediction in Phase 2/3 as focus shifts to residuals

 Mitigation:
 - Maintain minimum totalWeight = 0.1 in all phases (never zero)
 - Use smooth cosine interpolation for transitions (4-epoch ramps at E48-52, E148-152)
 - Monitor total_score MAE separately each epoch
 - Alarm: If MAE increases >10% from Phase 1 baseline → increase floor weight

 Code:
 // In V7LossScheduler: totalWeight never drops below 0.1
 return { total: 0.1, recap: 0.2, residual: 0.4, quantile: 0.3, consistency: 0.2 };

 ---
 Risk 2: Judge Embedding Overfitting

 Symptom: Training MAE drops, validation MAE plateaus

 Mitigation:
 - Apply L2 regularization to embeddings: l2: 0.00001
 - Add dropout (0.2) after embedding concatenation
 - Track train vs validation gap each epoch
 - Ablation study: Train without embeddings to validate contribution

 Code:
 const judgeEmbedding = tf.layers.embedding({
   embeddingsRegularizer: tf.regularizers.l2({ l2: 0.00001 })
 });
 const concatDropout = tf.layers.dropout({ rate: 0.2 }).apply(staticConcat);

 ---
 Risk 3: Elo Rating Instability

 Symptom: Elo values explode (>2500) or collapse (<500)

 Mitigation:
 - Cap Elo change at ±100 per show
 - Verify system balance after each season: mean ≈ 1500, std < 200
 - Assert no NaN/Inf values during computation

 Code:
 const eloDelta = K * (actual - expected);
 const cappedDelta = Math.max(-100, Math.min(100, eloDelta));
 judgeElo += cappedDelta;

 // Validation
 console.assert(Math.abs(meanJudgeElo - 1500) < 50);
 console.assert(Number.isFinite(judgeElo));

 ---
 Risk 4: Class Imbalance (World vs Open)

 Symptom: Model ignores Open Class (only 10% of data)

 Mitigation:
 - Enforce 3:1 World/Open ratio in sampleBatch()
 - Track Open Class MAE separately
 - Validate Open Class coverage > 0.75

 Code:
 sampleBatch(): MLSequenceRow[] {
   const batchWorld = shuffle(worldRows).slice(0, 24);
   const batchOpen = shuffle(openRows).slice(0, 8);
   return shuffle([...batchWorld, ...batchOpen]);
 }

 ---
 Risk 5: Feature Dimension Mismatch

 Symptom: Model crashes with tensor shape errors

 Mitigation:
 - Update constants: FEAT_DIM = 67, STATIC_DIM = 73
 - Print tensor shapes on first batch
 - Add assertions in data loader

 Code:
 console.assert(xSeq.shape[2] === FEAT_DIM, `Expected ${FEAT_DIM}, got ${xSeq.shape[2]}`);
 console.assert(xStatic.shape[1] === STATIC_DIM, `Expected ${STATIC_DIM}, got ${xStatic.shape[1]}`);

 ---
 Risk 6: Unknown Judges in 2024

 Symptom: New judges not in training data → embedding lookup fails

 Mitigation:
 - Reserve index 0 for "unknown" judges
 - Default to index 0 for unmapped judges
 - Test on 2024 data to verify fallback works

 Code:
 const judgeIdx = judgeIndexMap[judgeId] ?? 0; // Default to "unknown"

 ---
 Risk 7: Comparative Vector Division by Zero

 Symptom: NaN features for solo shows (single corps)

 Mitigation:
 - Fallback to 0 when field size = 1
 - Check for NaN after computation

 Code:
 const showAvgTotal = totalScores.length > 1 ? mean(totalScores) : 0;
 const relativeTotal = showStdTotal > 0 ? (corpsTotal - showAvgTotal) / showStdTotal : 0;

 ---
 Computational Considerations

 - Added Parameters: Judge embeddings add ~5K params (300 judges × 16 dims)
 - Training Time: Expect 500 epochs to take 10-15 hours on CPU (vs 4-5 for V6)
 - Memory: Minimal increase (<100MB additional)
 - Checkpoints: Save every 50 epochs to allow restarts

 ---
 File Structure

 New Files to Create (12 total)

 sdk/
 ├── src/
 │   ├── buildMlSequencesV7.ts          [~800 lines, copy from V6Production + new features]
 │   ├── training/
 │   │   ├── trainModelV7.ts            [~1200 lines, copy from V6Production + curriculum]
 │   │   ├── v7_progress.md             [Progress tracking document]
 │   │   └── judgeIndexMap.json         [Generated: judge ID → index mapping]
 │   └── relational.ts                  [UPDATE: +5 tables, +200 lines]
 ├── scripts/
 │   ├── computeEloRatingsV7.ts         [~400 lines, Elo computation]
 │   ├── buildJudgeIndexMap.ts          [~50 lines, judge mapping]
 │   ├── buildShowAggregatesV7.ts       [~200 lines, comparative vectors]
 │   └── evaluateV7.ts                  [~300 lines, evaluation]
 └── models/
     └── v7_curriculum/                 [Output directory for model checkpoints]
         ├── epoch_50/
         ├── epoch_150/
         ├── epoch_200/
         ├── epoch_300/
         ├── epoch_400/
         └── epoch_500/

 Modified Files (1 total)

 sdk/src/relational.ts                  [Add 5 tables: judge_elo_ratings, judge_elo_history,
                                         corps_elo_ratings, corps_elo_history, ml_sequence_rows_v7]
 sdk/src/mlQueries.ts                   [Add 3 query helpers: +100 lines]

 Critical Dependencies

 - All new files depend on M0 (schema) being completed first
 - buildMlSequencesV7.ts depends on M1 (Elo), M2 (judge indices), M3 (comparative vectors)
 - trainModelV7.ts depends on M4 (sequence builder) and M5/M6 (schedulers)

 ---
 Summary & Key Decisions

 Implementation Approach

 1. Non-destructive: V6 files and tables remain untouched, V7 runs in parallel
 2. Incremental: 8 milestones with clear validation points
 3. Testable: Each milestone has specific success criteria
 4. Rollback-friendly: Can revert to V6 anytime by changing model path

 Key Technical Innovations

 1. Judge Embeddings (16-dim): Capture judge-specific bias patterns
 2. Glicko-style Elo: Track judge and corps ratings over time with confidence decay
 3. Comparative Vectors: Normalize performance against field strength
 4. Curriculum Learning: 3-phase training with dynamic loss weighting
 5. Class Balancing: Enforce 3:1 World/Open ratio in batches

 Expected Outcomes

 - MAE: 0.92 (V6) → < 0.85 (V7 target)
 - Coverage: 0.78 (V6) → > 0.82 (V7 target)
 - GE/VP Bias: Reduction by 10-40%
 - Training Time: 4-5 hours (V6) → 10-15 hours (V7)

 ---
 Finalized Decisions

 Based on user input, the following implementation decisions have been made:

 1. Elo Algorithm: ✅ Glicko-style Elo with confidence decay
   - New judges: K=32 (fast learning)
   - Experienced: K=16
   - Veterans: K=8 (stable)
   - Confidence decay: 5% per show, minimum 5
 2. Judge Embedding Dimension: ✅ 16-dim embeddings
   - Total parameters: 300 judges × 16 = 4,800 params
   - Balanced expressiveness without excessive overfitting
 3. Show Aggregates: ✅ Precompute to table
   - Run buildShowAggregatesV7.ts as preprocessing step
   - Store in show_aggregates_v7 table
   - Faster sequence building
 4. Training Budget: ✅ 200-epoch pilot run first
   - Phase 1: Epochs 1-50 (macro-gravity)
   - Phase 2: Epochs 51-150 (category alignment)
   - Phase 3: Epochs 151-200 (partial grokking)
   - Estimated time: 4-6 hours
   - If successful, extend to full 500 epochs
 5. V6 Compatibility: ✅ Maintain parallel deployment
   - V6 and V7 coexist in same database
   - Easy rollback by changing model path
   - V7 becomes default only after beating V6 on all minimum thresholds

 ---
 Success Metrics
 ┌────────────────┬─────────────┬────────────┬─────────────┬────────┐
 │     Metric     │ V6 Baseline │ V7 Minimum │  V7 Target  │ Status │
 ├────────────────┼─────────────┼────────────┼─────────────┼────────┤
 │ MAE (points)   │ 0.92        │ 0.90       │ < 0.85      │ 🎯     │
 ├────────────────┼─────────────┼────────────┼─────────────┼────────┤
 │ Coverage       │ 0.78        │ 0.80       │ > 0.82      │ 🎯     │
 ├────────────────┼─────────────┼────────────┼─────────────┼────────┤
 │ GE Bias        │ -0.15       │ -0.12      │ < -0.10     │ 🎯     │
 ├────────────────┼─────────────┼────────────┼─────────────┼────────┤
 │ VP Bias        │ +0.12       │ +0.10      │ < +0.08     │ 🎯     │
 ├────────────────┼─────────────┼────────────┼─────────────┼────────┤
 │ Open Class MAE │ ~1.1        │ 1.0        │ < 0.95      │ 🎯     │
 ├────────────────┼─────────────┼────────────┼─────────────┼────────┤
 │ Training Time  │ 4-5 hours   │ 8 hours    │ 10-15 hours │ ⏱️     │
 └────────────────┴─────────────┴────────────┴─────────────┴────────┘
 Deployment Criteria: V7 must meet ALL minimum thresholds AND beat V6 on at least 3 of 5 metrics.

 there is v7_progress.md with more info