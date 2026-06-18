
import { Effect, Layer } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';
import { ensureRelationalSchema } from './relational.js';

const SqlLive = LibsqlClient.layer({
  url: "file:c:/Users/Patrick/corps-place/sdk/dci-relational.db",
});

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Ensuring relational schema...");
  yield* (ensureRelationalSchema);

  console.log("\nChecking season_participation_view count...");
  const spvCount = yield* (sql`SELECT count(*) as count FROM season_participation_view`);
  console.log(`Season Participation View: ${spvCount[0].count}`);

  console.log("\nChecking appearances count...");
  const appearancesCount = yield* (sql`SELECT count(*) as count FROM appearances`);
  console.log(`Appearances: ${appearancesCount[0].count}`);

  console.log("\nChecking enriched schedules view count...");
  const newViewCount = yield* (sql`SELECT count(*) as count FROM event_schedules_with_event_order_and_corps_key_and_class_from_that_season`);
  console.log(`Enriched Schedules View: ${newViewCount[0].count}`);

  console.log("\nSample row from appearances (first 3):");
  const appearancesSample = yield* (sql`SELECT event_slug, lineup_unit_name, division_name, performance_time FROM appearances WHERE division_name IS NOT NULL LIMIT 3`);
  console.table(appearancesSample);

  console.log("\nSample row from enriched schedules view (first 3):");
  const enrichedSample = yield* (sql`SELECT event_slug, unit_name, corps_key, class_from_that_season, event_order FROM event_schedules_with_event_order_and_corps_key_and_class_from_that_season LIMIT 3`);
  console.table(enrichedSample);
}).pipe(
  Effect.provide(SqlLive)
);

Effect.runPromise(program).catch(console.error);
