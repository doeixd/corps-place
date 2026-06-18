
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const versions = [
    { name: 'V7', table: 'ml_sequence_rows_v7', scoreIndex: 10 },
    { name: 'V9', table: 'ml_sequence_rows_v9', scoreIndex: 10 },
    { name: 'V10', table: 'ml_sequence_rows_v10', scoreIndex: 8 },
  ];

  // Helper to run query for a specific table
  const checkVersion = (name: string, table: string, scoreIndex: number) => Effect.gen(function* () {
    console.log(`\nVerifying ${name} (${table})...`);

    // I'll use separate queries to be safe and simple.
    let rows: any[] = [];
    if (name === 'V7') {
      rows = yield* (sql`
            SELECT ml.season, ml.competition_slug, ml.corps_key, ml.x_sequence_json, ml.x_static_json, ml.created_at
            FROM ml_sequence_rows_v7 ml
            JOIN competitions cCurrent ON cCurrent.slug = ml.competition_slug
            WHERE ml.y_total > 50 
            AND ml.created_at > '2026-01-23T19:00:00'
            AND EXISTS (
                SELECT 1 FROM corps_scores cs 
                JOIN competitions c ON c.slug = cs.competition_slug
                WHERE cs.corps_key = ml.corps_key 
                AND c.season = ml.season 
                AND cs.total_score = 0
                AND c.date < cCurrent.date
            )
            LIMIT 10
         `);
    } else if (name === 'V9') {
      rows = yield* (sql`
            SELECT ml.season, ml.competition_slug, ml.corps_key, ml.x_sequence_json, ml.x_static_json, ml.created_at
            FROM ml_sequence_rows_v9 ml
            JOIN competitions cCurrent ON cCurrent.slug = ml.competition_slug
            WHERE ml.y_total > 50 
            AND ml.created_at > '2026-01-23T19:00:00'
            AND EXISTS (
                SELECT 1 FROM corps_scores cs 
                JOIN competitions c ON c.slug = cs.competition_slug
                WHERE cs.corps_key = ml.corps_key 
                AND c.season = ml.season 
                AND cs.total_score = 0
                AND c.date < cCurrent.date
            )
            LIMIT 10
         `);
    } else {
      rows = yield* (sql`
            SELECT ml.season, ml.competition_slug, ml.corps_key, ml.x_sequence_json, ml.x_static_json, ml.created_at
            FROM ml_sequence_rows_v10 ml
            JOIN competitions cCurrent ON cCurrent.slug = ml.competition_slug
            WHERE ml.y_total > 50 
            AND ml.created_at > '2026-01-23T19:00:00'
            AND EXISTS (
                SELECT 1 FROM corps_scores cs 
                JOIN competitions c ON c.slug = cs.competition_slug
                WHERE cs.corps_key = ml.corps_key 
                AND c.season = ml.season 
                AND cs.total_score = 0
                AND c.date < cCurrent.date
            )
            LIMIT 10
         `);
    }

    console.log(`[${name}] Found ${rows.length} potentially affected rows.`);

    for (const ex of rows) {
      const sequence = JSON.parse(ex.x_sequence_json);
      const staticFeats = JSON.parse(ex.x_static_json);

      console.log(`  Row Created At: ${ex.created_at}`);

      // Check Sequence
      let foundZeroInHistory = false;
      for (const step of sequence) {
        if (step[3] === 1) continue; // padding
        const score = step[scoreIndex];
        // Normalized score of 0 (which is 75) is NOT 0 score.
        // 0 score normalized is (0 - 75)/25 = -3.
        if (score < -2.5) {
          foundZeroInHistory = true;
          console.log(`  [${name}] ALERT: Zero score found in history for ${ex.corps_key}@${ex.competition_slug}. Val=${score}`);
        }
      }

      // Check EMA
      const residualEma = staticFeats[10];
      if (residualEma < -10) {
        console.log(`  [${name}] ALERT: Low residual EMA for ${ex.corps_key}@${ex.competition_slug}: ${residualEma}`);
      }
    }
  });

  yield* (checkVersion('V7', 'ml_sequence_rows_v7', 10));
  yield* (checkVersion('V9', 'ml_sequence_rows_v9', 10));
  yield* (checkVersion('V10', 'ml_sequence_rows_v10', 8));

});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
