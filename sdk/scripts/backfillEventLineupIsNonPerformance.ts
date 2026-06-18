import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const nonPerformanceKeywords = [
  'gates open',
  'intermission',
  'anthem',
  'scores announced',
  'final scores',
  'recognition',
  'ceremony',
  'age-out',
  'age out',
  'retreat',
  'welcome',
  'preshow',
  'pre show',
  'pre-show',
  'announcement',
  'encore',
  'change',
  'changeover',
  'score',
  'annouced',
  'givaway',
  'presentation',
  'closing',
  'concludes',
  'event concludes',
  'event ends',
  'end of event',
  'spectator',
  'legacy',
  'brassworks',
  'bkxperience',
  'experience',
  'alumni',
  'community',
  'exhibition',
  'drumline',
  'color guard',
  'guard exhibition',
];

const isNonPerformanceLabel = (label: string) => {
  const normalized = label
    .toLowerCase()
    .replace(/[–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return nonPerformanceKeywords.some((kw) => normalized.includes(kw));
};

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log('Backfilling is_non_performance on event_lineup_entries...');

  const rows = yield* (sql<{
    entry_id: string;
    unit_name: string;
    participant_id: string | null;
    is_non_performance: number | null;
    is_exhibition: number | null;
  }>`
    SELECT entry_id, unit_name, participant_id, is_non_performance, is_exhibition
    FROM event_lineup_entries
  `);

  let updated = 0;
  let alreadySet = 0;

  for (const row of rows) {
    if (row.is_non_performance === 1) {
      alreadySet++;
      continue;
    }

    const shouldBeNonPerformance =
      row.participant_id == null || row.is_exhibition === 1 || isNonPerformanceLabel(row.unit_name);

    if (shouldBeNonPerformance) {
      yield* (
        sql`
        UPDATE event_lineup_entries
        SET is_non_performance = 1
        WHERE entry_id = ${row.entry_id}
      `.pipe(Effect.asVoid)
      );
      updated++;
    }
  }

  console.log(`Done. Updated: ${updated}, Already set: ${alreadySet}, Total rows: ${rows.length}`);
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});
