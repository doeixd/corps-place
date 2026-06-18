// Backfill event_group_types from competitions + competition_group_types.
// Usage: npx tsx scripts/backfillEventGroupTypes.ts

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const before = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM event_group_types
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
  );

  // Pass 1: strict date match + event name alignment.
  yield* (
    sql`
      INSERT INTO event_group_types (event_slug, group_type_id)
      SELECT DISTINCT e.slug, cgt.group_type_id
      FROM competition_group_types cgt
      JOIN competitions c
        ON c.slug = cgt.competition_slug
      JOIN events e
        ON date(e.start_date) = date(c.date)
       AND (
         lower(trim(e.name)) = lower(trim(c.event_name))
         OR lower(trim(COALESCE(e.event_name, ''))) = lower(trim(c.event_name))
       )
      ON CONFLICT(event_slug, group_type_id) DO NOTHING
    `.pipe(Effect.asVoid)
  );

  // Pass 2: season + name fallback when date mismatch exists.
  yield* (
    sql`
      INSERT INTO event_group_types (event_slug, group_type_id)
      SELECT DISTINCT e.slug, cgt.group_type_id
      FROM competition_group_types cgt
      JOIN competitions c
        ON c.slug = cgt.competition_slug
      JOIN events e
        ON (
          e.season = c.season
          OR substr(e.start_date, 1, 4) = c.season
        )
       AND (
         lower(trim(e.name)) = lower(trim(c.event_name))
         OR lower(trim(COALESCE(e.event_name, ''))) = lower(trim(c.event_name))
       )
      ON CONFLICT(event_slug, group_type_id) DO NOTHING
    `.pipe(Effect.asVoid)
  );

  const after = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM event_group_types
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0))
  );

  console.log('event_group_types backfill complete.');
  console.log(`  Rows before: ${before}`);
  console.log(`  Rows after:  ${after}`);
  console.log(`  Added:       ${Math.max(after - before, 0)}`);
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});
