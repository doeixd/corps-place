
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

const run = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  try {
    const v7Poison = yield* (sql<any>`SELECT COUNT(*) as count FROM ml_sequence_rows_v7 WHERE y_total = 0`);
    console.log('Poison in V7:', v7Poison[0].count);
  } catch (e) {
    console.log('V7 table not found or error accessing.');
  }

  try {
    const v9Poison = yield* (sql<any>`SELECT COUNT(*) as count FROM ml_sequence_rows_v9 WHERE y_total = 0`);
    console.log('Poison in V9:', v9Poison[0].count);
  } catch (e) {
    console.log('V9 table not found or error accessing.');
  }
});

Effect.runPromise(run.pipe(Effect.provide(SqlLayer)))
  .catch(console.error);
