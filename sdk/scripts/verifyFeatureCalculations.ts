
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

// From buildMlSequencesV10.ts
// x_static layout validation
// 10: residualEmaMean
// 1043: start of captionRangeFeatures (16 floats) -> indices 1043 to 1058
// 1071: start of rankBaselineFeatures (8 floats) -> indices 1071 to 1078

const FEATURE_INDICES = {
  residualEmaMean: 10,
  captionRangeStart: 25, // Wait, earlier static features:
  // 0-8: historical/prev vars (9 vars)
  // 9: sequenceLength/SEQ_LEN
  // 10: rankEma ?? 
  // Let's re-count carefully from header
  /*
  1017: normalizeRank(prevRank), // 0
  1018: yearsInWorldClass / 20, // 1
  1019: normalizeRank(meanRank), // 2
  1020: stdRank / 10, // 3
  1021: normalizeRank(bestRank), // 4
  1022: bestRankRecency / 20, // 5
  1023: madeFinalsRate, // 6
  1024: isNew, // 7
  1025: sequenceLength / SEQ_LEN, // 8
  1026: normalizeRank(rankEma), // 9
  1027: residualEmaMean, // 10
  ...
  1042: isMajorShow, // 24
  1043: ...captionRangeFeatures (16) -> 25 to 40
  ...
  1071: ...rankBaselineFeatures (8) (Wait, I need to count strictly)
  
  Let's actually just define functions to check specific slices based on known offsets from end or start.
  */
};

// We will scan a sample of rows
const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const rows = yield* (sql<any>`
    SELECT row_id, season, corps_key, x_static_json 
    FROM ml_sequence_rows_v10 
    ORDER BY RANDOM() 
    LIMIT 2000
  `);

  let count = 0;
  let poisonedEmaCount = 0;
  let invalidBaselineCount = 0;
  let invalidRangeCount = 0;

  for (const row of rows) {
    const staticFeats = JSON.parse(row.x_static_json);

    // Check 1: Residual EMA (Index 10 in V10? Need to be sure)
    // Based on counting: 0..9 are ranks/hist. 10 is residualEmaMean.
    const residualEma = staticFeats[10];

    // Normalize logic: (score - 75) / 25? No, residual is (score - baseline). 
    // Usually residual is around 0. Range -10 to +10?
    // If we have a 0 score vs 15 baseline -> -15.
    // Normalized? "residualEmaMean" in code is passed as is? 
    // Line 1028 in buildMlSequencesV10: `residualEmaMean`. 
    // It is calculated from `meanResidualSeries`. `residual` is `score - baseline`.
    // It is NOT normalized in `x_static`.
    // So -15 is a possible value if poisoned. Normal range +/- 2.

    if (residualEma < -5) {
      poisonedEmaCount++;
    }

    // Check 2: Rank Baseline Features
    // These are pushed near the end.
    // ...perCaptionCorpsElo (8)
    // ...rankBaselineFeatures (8)
    // isWorldClass, isOpenClass, isAllAgeClass (3)
    // dates (4)
    // So baselines are at length - 3 - 4 - 8 = length - 15.
    // They are normalizedCaptionScore -> score / 20.
    // Expected: 0.5 to 1.0 (10 to 20 score).
    // If < 0.1 (score 2), likely bad baseline data or bad rank input.
    const baselineFeats = staticFeats.slice(staticFeats.length - 15, staticFeats.length - 7);

    for (const b of baselineFeats) {
      if (b < 0.1 && b !== 0) { // 0 might be padding/missing? But usually 15.0/20 = 0.75
        // Reference curves fallback is 15.0. 
        // If we see very low value, it means reference curve has a low value.
        invalidBaselineCount++;
      }
    }

    count++;
  }

  console.log(`Checked ${count} rows.`);
  console.log(`Rows with Residual EMA < -5 (Poisoned): ${poisonedEmaCount} (${(poisonedEmaCount / count * 100).toFixed(1)}%)`);
  console.log(`Feature instances with low Baseline (< 2.0 score): ${invalidBaselineCount}`);

  // Also check if reference curves have any 0s
});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
