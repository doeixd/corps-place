# Domain Mapping Post-Mortem: V5 vs. V6

This document explains the technical inaccuracies identified in the V5 data pipeline and how the V6 implementation corrects them to ensure better training data for the multitask model.

## 1. The "Aggregation Fallacy"
### The V5 Problem
V5 used a "bottom-up" approach. It queried only the `subcaption_scores` table and attempted to **reconstruct** caption scores (like GE1, GE2) by summing these sub-scores in SQL.
- **Why it failed**: Not all seasons define subcaptions consistently. Some years might name a subcaption "Achievement" while others use "Perf". Summing them manually led to missing or inflated caption totals.
- **Why it limited data**: Because it was summing subcaptions, if a subcaption was missing (due to a scrape error or API change), the entire caption score was often lost or calculated as `0`.

### The V6 Solution
V6 uses the official DCI hierarchy. We now ingest and query from the `caption_scores` and `category_scores` tables. These tables contain the **pre-aggregated totals** provided directly by the DCI API.
- **Result**: Even if subcaptions are missing or oddly named, the high-level caption scores (which the model predicts) remain 100% accurate and consistent across all seasons.

## 2. Caption Naming Fragmentation
### The V5 Problem
The DCI API uses slightly different strings for the same captions depending on the year or region. 
- *Example*: `Visual Analysis` vs. `Visual - Analysis`.
V5's matching logic was rigid, meaning it often skipped captions that didn't match an exact string, resulting in the "empty 2022+ data" observation.

### The V6 Solution
We implemented a robust normalization layer in the `relational.ts` ingestion and `mlQueries.ts`. We now map these variants into a standardized set of eight canonical keys (GE1, GE2, VP, VA, CG, MB, MA, MP) used by the TensorFlow model.

## 3. The Judge Multiplicity Error
### The V5 Problem
In many DCI shows, multiple judges score the same caption (e.g., two GE judges). V5's SQL queries often:
1.  **Double-counted** the scores if joined incorrectly.
2.  **Ignored** the second judge if using a `LIMIT 1`.
3.  **Failed** to properly average them, leading to unrealistic target values for the model.

### The V6 Solution
The new schema includes a specialized `judge_scores` table. The V6 ingestion logic explicitly iterates through all judges assigned to a caption and calculates a proper **arithmetic mean** before saving the final `caption_score`. This ensures the model learns the "consensus" score, which is how DCI actually computes the final total.

## 4. Non-Destructive Schema Evolution
### The V5 Problem
The schema initialization script (`ensureRelationalSchema`) used `DROP TABLE IF EXISTS`. Every time you tried to fix a bug in the ingestion, it would wipe your existing data. This is why the database was often stuck at older years (2013-2019)—the ingestion was never allowed to finish because a single crash or restart triggered a full reset.

### The V6 Solution
We removed all `DROP` statements and switched to `CREATE TABLE IF NOT EXISTS`. This allowed us to **incrementally fill the gaps** (like 2022, 2023, and 2024) without losing the historical context.

---

## Conclusion
The transition from V5 to V6 wasn't just a table rename; it was a shift from **manual reconstruction** to **official domain alignment**. By trusting the API's own category/caption totals, we eliminated the biggest source of "noise" and "missing data" in the ML training set.
