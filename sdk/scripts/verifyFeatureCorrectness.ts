
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';
import * as fs from 'node:fs';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const REFERENCE_CURVES = JSON.parse(fs.readFileSync("./src/training/referenceCurvesV4.json", "utf-8"));
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

const getBaseline = (rank: number, pct: number, caption: string): number => {
  if (rank < 1) rank = 12;
  const bucket = Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
  const key = `${rank}-${bucket}`;
  const curves = REFERENCE_CURVES.curves;

  if (curves[key] && curves[key][caption]) {
    return curves[key][caption];
  }
  return curves[`${rank}-50`]?.[caption] || 15.0;
};

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("=== Feature Verification Report ===\n");

  // 1. Check for rows with obviously poisoned residuals in existing ML sequences
  const poisonedRows = yield* (sql<any>`
    SELECT season, competition_slug, corps_key, x_sequence_json, x_static_json
    FROM ml_sequence_rows_v10
    LIMIT 1000
  `);

  let lowResidualCount = 0;
  let zeroScoreInSequence = 0;

  for (const row of poisonedRows) {
    const sequence = JSON.parse(row.x_sequence_json);
    const staticFeatures = JSON.parse(row.x_static_json);

    // Look at residuals in the sequence
    // In V10, caption residuals start at index 12 + 1 (daysSince) + 1 (showIdx) ... wait
    // Let's check V10 feature indices again.
    // feats index: 0: pct, 1: daysSince, 2: showIdx, 3: padding, 4: daysFromStart, 5: idx/past, 6: rem/past, 7: gapToWinnerPrev ...
    // then 8-15: totalScore, rank, rankDelta, gapToLeader, gapToNext, percentile, totalScoreDelta
    // then 16-19: order...
    // then 20...: captions. each caption has 4 feats: [diff_from_baseline, rank/field, normScore, normDelta]

    for (let t = 0; t < sequence.length; t++) {
      const step = sequence[t];
      if (step[3] === 1) continue; // Skip padding

      // Check caption residuals (starting at index 20, 24, 28...)
      for (let c = 0; c < 8; c++) {
        const residual = step[20 + c * 4];
        if (residual < -10) {
          lowResidualCount++;
        }
        const normScore = step[20 + c * 4 + 2];
        if (normScore === 0) {
          zeroScoreInSequence++;
        }
      }
    }
  }

  console.log(`Found ${lowResidualCount} occurrences of residuals < -10 in ${poisonedRows.length} sequence samples (Potential data poisoning)`);
  console.log(`Found ${zeroScoreInSequence} occurrences of normalized caption scores = 0 in sequences`);

  // 2. Verify "highest-score-at-this-percentage-bucket-of-the-season-for-a-given-rank"
  // This is 'rankBaselineFeatures' in static_json (index 107 in static features for V10)
  // Let's find some examples.
  console.log("\nVerifying Baseline (Rank-Percentage) features:");

  const sample = poisonedRows.find(r => !r.competition_slug.includes("finals")); // Use a non-finals show to see mid-season
  if (sample) {
    const staticFeats = JSON.parse(sample.x_static_json);
    // V10: STATIC_FEATURES = 126 or so. Let's find the baseline features.
    // They are added at the end of the 126 features.
    // Actually perCaptionCorpsElo is 8, rankBaselineFeatures is 8.
    // static indices: ... 113-120 (perCaptionCorpsElo), 121-128 (rankBaselineFeatures)
    // Actually it varies by version.

    console.log(`Sample: ${sample.corps_key} at ${sample.competition_slug}`);
    console.log(`Season: ${sample.season}`);

    // Recalculate rank entering
    // This is hard to do without full context, but we can check if they are non-zero
    const baselines = staticFeats.slice(-8 - 2 - 2 - 3, -2 - 2 - 3); // Rough slice
    // Wait, let's look at buildMlSequencesV10 code again to be sure of indices.
    /*
    1065: ...perCaptionJudgeElo (8)
    1066: panelEloMean
    1067: panelEloStd
    1068: panelEloMax
    1069: panelEloMin
    1070: ...perCaptionCorpsElo (8)
    1071: ...rankBaselineFeatures (8)
    1072: isWorldClass
    1073: isOpenClass
    1074: isAllAgeClass
    1075: month
    1076: day
    1077: premiereMonth
    1078: premiereDay
    */
    // So rankBaselineFeatures are at staticFeats.length - 7.
    const baselineFeats = staticFeats.slice(staticFeats.length - 7 - 8, staticFeats.length - 7);
    console.log("Rank Baseline Features (Normalized):", baselineFeats);
    console.log("Denormalized (approx):", baselineFeats.map(f => (f * 20).toFixed(2)));
  }

  // 3. Check for 0 values in EMA
  let zeroEmaCount = 0;
  for (const row of poisonedRows) {
    const staticFeats = JSON.parse(row.x_static_json);
    const residualEma = staticFeats[10]; // index 10 is residualEmaMean
    if (residualEma === 0 && staticFeats[8] > 0) { // sequenceLength > 0
      zeroEmaCount++;
    }
  }
  console.log(`\nFound ${zeroEmaCount} cases where Residual EMA is exactly 0 despite having history (Potential math error or masked data)`);

  console.log("\nCONCLUSIONS:");
  if (lowResidualCount > 0) {
    console.log("⚠️  DATA POISONING DETECTED: Large negative residuals suggest 0-scores are being compared against baselines.");
  } else {
    console.log("✓ No obvious large negative residuals found in sample.");
  }

  if (zeroScoreInSequence > 0) {
    console.log("⚠️  DATA INTEGRITY ISSUE: 0-scores are present in the historical sequence vector.");
  }

});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
