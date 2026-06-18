
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  // Find a show where a corps had a 0 score previously in the same season
  const poisonedExamples = yield* (sql<any>`
    SELECT ml.season, ml.competition_slug, ml.corps_key, ml.x_sequence_json, ml.x_static_json
    FROM ml_sequence_rows_v10 ml
    WHERE ml.y_total > 50 -- A valid show
    AND EXISTS (
      SELECT 1 FROM corps_scores cs 
      JOIN competitions c ON c.slug = cs.competition_slug
      WHERE cs.corps_key = ml.corps_key 
      AND c.season = ml.season 
      AND cs.total_score = 0
      AND c.date < ml.competition_date
    )
    LIMIT 5
  `);

  console.log(`Found ${poisonedExamples.length} shows preceded by a 0-score show in the same season.`);

  for (const ex of poisonedExamples) {
    const sequence = JSON.parse(ex.x_sequence_json);
    const staticFeats = JSON.parse(ex.x_static_json);

    console.log(`\nAnalyzing ${ex.corps_key} at ${ex.competition_slug} (${ex.season})`);

    // Check if the 0-score show is in the sequence
    let foundZeroInHistory = false;
    for (const step of sequence) {
      if (step[3] === 1) continue; // padding
      const score = step[8]; // totalScore normalizeScore index
      if (score < -2) { // (0 - 75) / 25 = -3
        foundZeroInHistory = true;
        console.log(`  [!] Zero score found in history: normalized total = ${score.toFixed(2)}`);
      }
    }

    // Check EMA
    const residualEma = staticFeats[10];
    console.log(`  Residual EMA: ${residualEma.toFixed(4)}`);
    // If there's a 0 score in history, the residual EMA should be heavily negative
  }
});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
