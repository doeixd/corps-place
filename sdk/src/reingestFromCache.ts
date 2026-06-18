import { Effect, Ref } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';

import type * as Domain from './domain.js';
import {
  parseRecapHtml,
  buildCompetitionFromWebsiteRecap,
  buildCorpsScoresFromWebsiteRecap,
} from './websiteRecap.js';
import { ingestRelationalData, ingestWebsiteRecap } from './relational.js';
import { makeDciApiLayer } from './client.js';

interface RecapRow {
  recap_slug: string;
  season: string;
  source_url: string | null;
  raw_html: string;
  event_name: string | null;
  event_date: string | null;
  location: string | null;
}

const parseDivisionFromCorpsType = (
  type: string | null | undefined
): Domain.DivisionName | undefined => {
  if (!type) return undefined;
  const lower = type.toLowerCase();
  if (lower.includes('world class')) return 'World Class';
  if (lower.includes('open class')) return 'Open Class';
  if (lower.includes('all age') || lower.includes('all-age')) return 'All Age Class';
  if (lower.includes('soundsport')) return 'SoundSport';
  if (lower.includes('international')) return 'International Class';
  return undefined;
};

const buildCorpsDivisionMapForSeason = (
  sql: SqlClient.SqlClient,
  season: string
): Effect.Effect<Record<string, Domain.DivisionName>, unknown> =>
  Effect.gen(function* () {
    const divisionMap: Record<string, Domain.DivisionName> = {};
    const seen = new Set<string>();

    const registerDivision = (name: string, division: Domain.DivisionName) => {
      const key = name.toLowerCase().trim();
      if (!key) return;
      if (!seen.has(key)) {
        divisionMap[key] = division;
        seen.add(key);
      }
      const parts = key.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        const tail = parts[parts.length - 1];
        if (tail && !seen.has(tail)) {
          divisionMap[tail] = division;
          seen.add(tail);
        }
      }
    };

    const corpsRows = yield* (
      sql<{ name: string; type: string | null }>`
        SELECT name, type
        FROM corps
        WHERE type IS NOT NULL
      `
    );

    for (const row of corpsRows) {
      const division = parseDivisionFromCorpsType(row.type);
      if (division) {
        registerDivision(row.name, division);
      }
    }

    const currentSeasonRows = yield* (
      sql<{ corps_name: string; division_name: string }>`
        SELECT corps_name, division_name
        FROM corps_scores
        WHERE competition_slug LIKE ${season + '-%'}
        GROUP BY corps_name, division_name
      `
    );

    for (const row of currentSeasonRows) {
      registerDivision(row.corps_name, row.division_name as Domain.DivisionName);
    }

    if (Object.keys(divisionMap).length === seen.size) {
      const prevSeason = String(parseInt(season) - 1);
      const prevSeasonRows = yield* (
        sql<{ corps_name: string; division_name: string }>`
          SELECT corps_name, division_name
          FROM corps_scores
          WHERE competition_slug LIKE ${prevSeason + '-%'}
          GROUP BY corps_name, division_name
        `
      );

      for (const row of prevSeasonRows) {
        registerDivision(row.corps_name, row.division_name as Domain.DivisionName);
      }
    }

    return divisionMap;
  });

const differenceInDays = (later: Date, earlier: Date) =>
  Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

const buildSeasonMeta = (competitions: ReadonlyArray<Domain.Competition>) => {
  const sorted = [...competitions].sort((a, b) => a.date.getTime() - b.date.getTime());
  const firstDate = sorted[0]?.date;
  const lastDate = sorted[sorted.length - 1]?.date ?? firstDate;
  const seasonLength =
    firstDate && lastDate ? Math.max(1, differenceInDays(lastDate, firstDate)) : 0;
  return { firstDate, lastDate, seasonLength };
};

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

const hasFlag = (flag: string) => process.argv.includes(flag);

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const seasonsFilter = parseSeasons();
  const skipApi = hasFlag('--skip-api');
  const persistRankings = hasFlag('--persist-rankings');

  console.log(`[reingest] start seasons=${seasonsFilter.join(',') || 'all'} skipApi=${skipApi}`);

  if (!skipApi) {
    yield* (
      ingestRelationalData({
        seasons: seasonsFilter.length > 0 ? seasonsFilter : undefined,
        warm: true,
        seasonConcurrency: 1,
        competitionConcurrency: 2,
        scoreConcurrency: 4,
        persistRankings,
      })
    );
  }

  const recapRows = yield* (
    sql<RecapRow>`
      SELECT wr.recap_slug, wr.season, wr.source_url, wr.raw_html, wr.event_name, wr.event_date, wr.location
      FROM website_recaps wr
      JOIN (
        SELECT recap_slug, MAX(scraped_at) as max_scraped
        FROM website_recaps
        GROUP BY recap_slug
      ) latest
        ON wr.recap_slug = latest.recap_slug
       AND wr.scraped_at = latest.max_scraped
    `
  );
  console.log(`[reingest] cached recap rows loaded: ${recapRows.length}`);

  const bySeason = new Map<string, RecapRow[]>();
  for (const row of recapRows) {
    if (seasonsFilter.length > 0 && !seasonsFilter.includes(row.season)) {
      continue;
    }
    const list = bySeason.get(row.season) ?? [];
    list.push(row);
    bySeason.set(row.season, list);
  }

  const totalIngested = yield* (Ref.make(0));
  const totalFailed = yield* (Ref.make(0));

  for (const [season, rows] of bySeason.entries()) {
    console.log(`[reingest] Season ${season}: ${rows.length} recaps`);
    const corpsDivisionMap = yield* (buildCorpsDivisionMapForSeason(sql, season));

    const parsedResults: Array<{ competition: Domain.Competition; scores: Domain.CorpsScore[] }> =
      [];

    for (const row of rows) {
      const parsed = yield* (
        Effect.gen(function* () {
          const recap = yield* (parseRecapHtml(row.raw_html));
          const entry: Domain.WebsiteScoreListEntry = {
            id: row.recap_slug,
            title: row.event_name ?? recap.meta.title,
            date: row.event_date ?? recap.meta.date,
            location: row.location ?? recap.meta.location,
            url: row.source_url ?? '',
          };

          const competition = buildCompetitionFromWebsiteRecap(row.recap_slug, recap, entry);
          const scores = buildCorpsScoresFromWebsiteRecap(competition, recap, corpsDivisionMap);
          return { competition, scores };
        }).pipe(
          Effect.catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            return Ref.update(totalFailed, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.logWarning(
                  `[reingest] skip ${row.season}:${row.recap_slug} parse failed: ${message}`
                )
              ),
              Effect.as(undefined)
            );
          })
        )
      );

      if (parsed) {
        parsedResults.push(parsed);
      }
    }

    const seasonMeta = buildSeasonMeta(parsedResults.map((result) => result.competition));

    for (const result of parsedResults) {
      yield* (
        ingestWebsiteRecap(
          sql,
          { season, competition: result.competition, scores: result.scores },
          { seasonMeta, scoreConcurrency: 4 }
        )
      );
      yield* (Ref.update(totalIngested, (count) => count + 1));
    }
  }

  const total = yield* (Ref.get(totalIngested));
  const failed = yield* (Ref.get(totalFailed));
  console.log(`[reingest] Completed ${total} recaps; skipped ${failed} parse failures.`);
});

const dbUrl = getArg('--db') ?? 'file:./dci-relational.db';
const SqlLive: any = (LibsqlClient as unknown as { layer: (config: { url: string }) => any }).layer(
  {
    url: dbUrl,
  }
);
const ApiLayer = makeDciApiLayer();

Effect.runPromise(
  program.pipe(Effect.provide(SqlLive), Effect.provide(ApiLayer)) as Effect.Effect<
    void,
    unknown,
    never
  >
).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
