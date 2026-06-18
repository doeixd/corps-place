
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const zeroScores = yield* (sql<any>`SELECT COUNT(*) as count FROM corps_scores WHERE total_score = 0`);
  const nullScores = yield* (sql<any>`SELECT COUNT(*) as count FROM corps_scores WHERE total_score IS NULL`);
  const zeroCaptions = yield* (sql<any>`SELECT COUNT(*) as count FROM caption_scores WHERE score = 0`);
  const smallScores = yield* (sql<any>`SELECT COUNT(*) as count FROM corps_scores WHERE total_score > 0 AND total_score < 10`);

  console.log('Zero Total Scores:', zeroScores[0].count);
  console.log('Null Total Scores:', nullScores[0].count);
  console.log('Zero Caption Scores:', zeroCaptions[0].count);
  console.log('Suspiciously Small Scores (<10):', smallScores[0].count);

  const competitionCount = yield* (sql<any>`SELECT COUNT(*) as count FROM competitions`);
  console.log('Total Competitions:', competitionCount[0].count);

  const releaseRecaps = yield* (sql<any>`SELECT COUNT(*) as count FROM competitions WHERE recap_released = 1`);
  console.log('Competitions with Recaps:', releaseRecaps[0].count);
});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
