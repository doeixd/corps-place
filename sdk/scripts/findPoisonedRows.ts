
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const zeros = yield* (sql<any>`
    SELECT cs.competition_slug, cs.corps_key
    FROM corps_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    WHERE cs.total_score = 0 AND c.recap_released = 1
  `);

  console.log(`Found ${zeros.length} zero-score rows in raw data.`);

  let foundInV10 = 0;
  for (const zero of zeros) {
    const mlRows = yield* (sql<any>`
      SELECT COUNT(*) as count 
      FROM ml_sequence_rows_v10 
      WHERE competition_slug = ${zero.competition_slug} AND corps_key = ${zero.corps_key}
    `);
    if (mlRows[0].count > 0) {
      foundInV10++;
      console.log(`POISON FOUND: ${zero.corps_key} at ${zero.competition_slug} has total_score=0 but IS IN V10`);
    }
  }

  console.log(`Total poisoned rows in V10: ${foundInV10}`);

  // Also check if these 0-score rows are appearing as PRIOR shows for OTHER rows.
  // This is where they really do damage (EMA, history).
});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
