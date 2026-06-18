import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

import { scrapeWebsiteRecaps } from './websiteScraper.js';
import { ensureRelationalSchema } from './relational.js';

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

const parseNumberArg = (flag: string) => {
  const raw = getArg(flag);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
};

const hasFlag = (flag: string) => process.argv.includes(flag);

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  yield* (ensureRelationalSchema);

  const seasons = parseSeasons();
  // NOTE: an optional pre-scrape "ingest from API cache" step was stubbed here
  // against `ingestRelationalDataFromApiResponses`, but that function was never
  // implemented (no offline api_responses-backed ingestion path exists — only
  // `ingestRelationalData`, which ingests live via a network DciApi). The dead
  // reference is removed; if an offline API-cache ingest is ever needed, it must
  // be built (model it on `ingestRelationalData` + the api_responses readers).

  const maxPages = parseNumberArg('--maxPages');
  const concurrency = parseNumberArg('--concurrency');

  const options = {
    seasons,
    maxPages,
    concurrency,
    ingest: true,
  };

  const result = yield* (scrapeWebsiteRecaps(options));
  console.log(`[scrape] seasons=${result.seasons.join(',') || '(none)'}`);
  console.log(`[scrape] score list pages=${result.scoreLists}`);
  console.log(`[scrape] recaps=${result.recaps}`);
  console.log(`[scrape] corps scores=${result.corpsScores}`);
});

const dbUrl = getArg('--db') ?? 'file:./dci-relational.db';
const SqlLive: any = (LibsqlClient as unknown as { layer: (config: { url: string }) => any }).layer(
  {
    url: dbUrl,
  }
);

Effect.runPromise(
  program.pipe(Effect.provide(SqlLive)) as Effect.Effect<void, unknown, never>
).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
