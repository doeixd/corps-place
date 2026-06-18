// Ingest relational data from cached API responses only.
// Usage: npx tsx scripts/ingestApiFromCache.ts [--season 2024] [--seasons 2023,2024]

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';

import { ensureRelationalSchema, ingestRelationalDataFromApiResponses } from '../src/relational.js';

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const parseSeasons = (): string[] => {
  const single = getArg('--season');
  const multi = getArg('--seasons');
  const seasons = new Set<string>();
  if (single) seasons.add(single);
  if (multi) {
    multi
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => seasons.add(s));
  }
  return [...seasons];
};

const main = Effect.gen(function* () {
  const seasons = parseSeasons();
  console.log(`[api-cache] ingest start seasons=${seasons.join(',') || 'all'}`);

  yield* (ensureRelationalSchema);
  const result = yield* (
    ingestRelationalDataFromApiResponses({
      seasons: seasons.length > 0 ? seasons : undefined,
      includeAuxiliary: true,
    })
  );

  console.log('API cache ingest complete.');
  console.log(`  Seasons:      ${result.seasons}`);
  console.log(`  Competitions: ${result.competitions}`);
  console.log(`  Recaps:       ${result.recaps}`);
  console.log(`  Corps scores: ${result.corpsScores}`);
  if (result.competitions === 0) {
    console.warn(
      '[api-cache] No cached competitions matched filter; live API stage may be needed.'
    );
  }
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('API cache ingest failed:', error);
  process.exitCode = 1;
});
