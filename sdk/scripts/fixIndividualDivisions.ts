// Fix individual performers that were ingested as if they were corps.
// These are entries from "DCI Performers Showcase" competitions where the
// corps_name is a person like "Josh Koester (Blue Stars)".
// Sets division_name to "Individual" in both corps_scores and corps tables,
// and sets entity_type to "individual" in the corps table.
//
// Usage: npx tsx scripts/fixIndividualDivisions.ts [--dryRun]

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const args = process.argv.slice(2);
const dryRun = args.includes('--dryRun');

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log('=== Fix Individual Performer Divisions ===\n');

  if (dryRun) {
    console.log('DRY RUN - No changes will be made\n');
  }

  // Preview: show affected rows in corps_scores
  const affectedScores = yield* (
    sql<{ corps_name: string; division_name: string; competition_slug: string }>`
      SELECT corps_name, division_name, competition_slug
      FROM corps_scores
      WHERE corps_name LIKE '% (%)'
    `
  );

  console.log(`Found ${affectedScores.length} individual entries in corps_scores`);

  // Show division breakdown
  const divisionBreakdown = yield* (
    sql<{ division_name: string; cnt: number }>`
      SELECT division_name, COUNT(*) as cnt
      FROM corps_scores
      WHERE corps_name LIKE '% (%)'
      GROUP BY division_name
      ORDER BY cnt DESC
    `
  );

  console.log('\nCurrent division_name breakdown:');
  for (const row of divisionBreakdown) {
    console.log(`  ${row.division_name}: ${row.cnt}`);
  }

  // Preview: show affected rows in corps table
  const affectedCorps = yield* (
    sql<{ corps_key: string; name: string; division_name: string | null }>`
      SELECT corps_key, name, division_name
      FROM corps
      WHERE name LIKE '% (%)'
        AND corps_key IN (SELECT DISTINCT corps_key FROM corps_scores WHERE corps_name LIKE '% (%)')
    `
  );

  console.log(`\nFound ${affectedCorps.length} individual entries in corps table`);

  // Show competitions involved
  const competitions = yield* (
    sql<{ competition_slug: string; cnt: number }>`
      SELECT competition_slug, COUNT(*) as cnt
      FROM corps_scores
      WHERE corps_name LIKE '% (%)'
      GROUP BY competition_slug
      ORDER BY competition_slug
    `
  );

  console.log('\nCompetitions with individuals:');
  for (const row of competitions) {
    console.log(`  ${row.competition_slug}: ${row.cnt} performers`);
  }

  if (dryRun) {
    console.log('\nDRY RUN complete. Run without --dryRun to apply changes.');
    return;
  }

  // Fix corps_scores: set division_name to "Individual"
  yield* (
    sql`
      UPDATE corps_scores
      SET division_name = 'Individual'
      WHERE corps_name LIKE '% (%)'
    `.pipe(Effect.asVoid)
  );

  // Fix corps table: set division_name and entity_type
  yield* (
    sql`
      UPDATE corps
      SET division_name = 'Individual',
          entity_type = 'individual',
          is_other_type = 1
      WHERE corps_key IN (
        SELECT DISTINCT corps_key FROM corps_scores WHERE division_name = 'Individual'
      )
    `.pipe(Effect.asVoid)
  );

  // Verify
  const remaining = yield* (
    sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt
      FROM corps_scores
      WHERE corps_name LIKE '% (%)'
        AND division_name != 'Individual'
    `
  );

  const corpsFixed = yield* (
    sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt
      FROM corps
      WHERE entity_type = 'individual'
    `
  );

  console.log(`\n=== Results ===`);
  console.log(`corps_scores updated: ${affectedScores.length}`);
  console.log(`corps records marked as individual: ${corpsFixed[0]?.cnt ?? 0}`);
  console.log(`Remaining unpatched: ${remaining[0]?.cnt ?? 0}`);

  if ((remaining[0]?.cnt ?? 0) === 0) {
    console.log('\nAll individual performers fixed!');
  }
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => {
    console.log('\nDone!');
  })
  .catch((err) => {
    console.error('\nFix failed:', err);
    process.exitCode = 1;
  });
