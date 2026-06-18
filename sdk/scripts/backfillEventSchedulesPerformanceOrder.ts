// Backfill event_schedules.performance_order from lineup-derived entries.
// Usage: npx tsx scripts/backfillEventSchedulesPerformanceOrder.ts

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const before = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM event_schedules
      WHERE performance_order IS NULL
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
  );

  yield* (
    sql`
      WITH lineup_match AS (
        SELECT
          es.schedule_id AS schedule_id,
          MIN(ele.performance_order) AS performance_order
        FROM event_schedules es
        JOIN events e
          ON e.event_id = es.event_id
        JOIN event_lineup_entries ele
          ON ele.event_slug = e.slug
         AND lower(trim(ele.unit_name)) = lower(trim(es.unit_name))
        WHERE ele.performance_order IS NOT NULL
        GROUP BY es.schedule_id
      )
      UPDATE event_schedules
      SET performance_order = (
        SELECT lm.performance_order
        FROM lineup_match lm
        WHERE lm.schedule_id = event_schedules.schedule_id
      )
      WHERE performance_order IS NULL
        AND schedule_id IN (SELECT schedule_id FROM lineup_match)
    `.pipe(Effect.asVoid)
  );

  const after = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM event_schedules
      WHERE performance_order IS NULL
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
  );

  console.log('event_schedules.performance_order backfill complete.');
  console.log(`  Null before: ${before}`);
  console.log(`  Null after:  ${after}`);
  console.log(`  Filled:      ${Math.max(before - after, 0)}`);
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});
