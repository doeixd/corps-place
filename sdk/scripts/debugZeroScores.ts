
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const zeros = yield* (sql<any>`
    SELECT cs.competition_slug, cs.corps_key, cs.total_score, c.recap_released
    FROM corps_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    WHERE cs.total_score = 0
    LIMIT 20
  `);
  console.log('Sample of Zero Score Rows:');
  console.table(zeros);

  const recapZeros = yield* (sql<any>`
    SELECT COUNT(*) as count 
    FROM corps_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    WHERE cs.total_score = 0 AND c.recap_released = 1
  `);
  console.log('Zero scores in competitions WITH recap released:', recapZeros[0].count);
});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
