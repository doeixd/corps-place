// Retry failed website recap scrapes recorded in website_scrape_failures.
// Usage: npx tsx scripts/retryWebsiteScrapeFailures.ts [--season 2025] [--seasons 2024,2025] [--concurrency 3]

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

import {
  buildCompetitionFromWebsiteRecap,
  buildCorpsScoresFromWebsiteRecap,
  parseRecapHtml,
  recapUrl,
  WebsiteRecapParseError,
} from '../src/websiteRecap.js';
import { ingestWebsiteRecap, upsertWebsiteRecap } from '../src/relational.js';

type FailureRow = {
  recap_slug: string;
  season: string;
  source_url: string | null;
};

const requestHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const maxRetries = 6;
const retryDelayMs = 250;

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const parseNumberArg = (flag: string, fallback: number) => {
  const raw = getArg(flag);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
};

const parseSeasons = () => {
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
  return seasons;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoffDelay = (attempt: number) => retryDelayMs * 2 ** attempt;

const buildFinalScoresUrls = (url: string) => {
  if (url.includes('/scores/recap/')) {
    const slug = url.split('/scores/recap/')[1]?.replace(/\/+$/, '');
    if (slug) {
      return [
        `https://www.dci.org/scores/final-scores/${slug}/`,
        `https://www.dci.org/score/final-scores/${slug}/`,
      ];
    }
  }
  if (url.includes('/score/recap/')) {
    const slug = url.split('/score/recap/')[1]?.replace(/\/+$/, '');
    if (slug) {
      return [
        `https://www.dci.org/score/final-scores/${slug}/`,
        `https://www.dci.org/scores/final-scores/${slug}/`,
      ];
    }
  }
  return [] as string[];
};

const fetchHtmlWithRetry = async (
  url: string,
  attempt = 0,
  allowFallback = true
): Promise<string> => {
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders });
  } catch (error) {
    if (attempt < maxRetries) {
      if (attempt === 0) {
        console.warn(`[retry] network error, retrying ${url}`);
      }
      await sleep(backoffDelay(attempt));
      return fetchHtmlWithRetry(url, attempt + 1, allowFallback);
    }
    throw new WebsiteRecapParseError(`Failed to fetch ${url}: ${String(error)}`, {
      attempts: attempt + 1,
    });
  }

  const html = await response.text();
  if (response.status === 404 && allowFallback) {
    const fallbacks = buildFinalScoresUrls(url);
    if (fallbacks.length > 0) {
      console.warn(`[retry] 404 for ${url}; trying final-scores fallback`);
    }
    for (const altUrl of fallbacks) {
      try {
        console.warn(`[retry] fallback fetch ${altUrl}`);
        return await fetchHtmlWithRetry(altUrl, 0, false);
      } catch {
        continue;
      }
    }
  }

  const shouldRetry = response.status === 429 || response.status >= 500;
  if (shouldRetry && attempt < maxRetries) {
    if (attempt === 0) {
      console.warn(`[retry] HTTP ${response.status}, retrying ${url}`);
    }
    await sleep(backoffDelay(attempt));
    return fetchHtmlWithRetry(url, attempt + 1, allowFallback);
  }

  if (!response.ok) {
    throw new WebsiteRecapParseError(`Failed to fetch ${url}: ${response.status}`, {
      status: response.status,
      attempts: attempt + 1,
    });
  }

  return html;
};

const failureDetails = (error: unknown) => {
  if (error instanceof WebsiteRecapParseError) {
    const meta = error.originalError as { status?: number; attempts?: number } | undefined;
    return {
      message: error.message,
      status: meta?.status,
      attempts: meta?.attempts,
    };
  }
  return {
    message: String(error),
    status: undefined as number | undefined,
    attempts: undefined as number | undefined,
  };
};

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const seasons = parseSeasons();
  const concurrency = Math.max(1, Math.min(parseNumberArg('--concurrency', 3), 8));

  const rows = yield* (
    sql<FailureRow>`
      SELECT recap_slug, season, source_url
      FROM website_scrape_failures
      ORDER BY last_attempt_at ASC
    `
  );

  const failures = rows.filter((row) => seasons.size === 0 || seasons.has(row.season));
  console.log(`Found ${failures.length} failed recap(s) to retry.`);

  let succeeded = 0;
  let stillFailing = 0;

  yield* (
    Effect.forEach(
      failures,
      (row) =>
        Effect.gen(function* () {
          const slug = row.recap_slug;
          const url = row.source_url ?? recapUrl(slug);

          const attempt = Effect.gen(function* () {
            const rawHtml = yield* (Effect.tryPromise(() => fetchHtmlWithRetry(url)));
            const recap = yield* (parseRecapHtml(rawHtml));
            const competition = buildCompetitionFromWebsiteRecap(slug, recap);
            const scores = buildCorpsScoresFromWebsiteRecap(competition, recap);

            yield* (
              upsertWebsiteRecap(sql, {
                slug,
                season: row.season,
                sourceUrl: url,
                rawHtml,
                recap,
              })
            );

            yield* (
              ingestWebsiteRecap(
                sql,
                {
                  season: row.season,
                  competition,
                  scores,
                },
                { scoreConcurrency: 4 }
              )
            );

            yield* (
              sql`
                DELETE FROM website_scrape_failures
                WHERE recap_slug = ${slug}
                  AND season = ${row.season}
              `.pipe(Effect.asVoid)
            );

            succeeded += 1;
            console.log(`[retry] success ${row.season}:${slug}`);
          });

          yield* (
            attempt.pipe(
              Effect.catch((error) => {
                const details = failureDetails(error);
                stillFailing += 1;
                console.warn(`[retry] failed ${row.season}:${slug} :: ${details.message}`);
                return sql`
                  UPDATE website_scrape_failures
                  SET source_url = ${url},
                      error_message = ${details.message},
                      status_code = ${details.status ?? null},
                      attempts = ${details.attempts ?? null},
                      last_attempt_at = ${new Date().toISOString()}
                  WHERE recap_slug = ${slug}
                    AND season = ${row.season}
                `.pipe(Effect.asVoid);
              })
            )
          );
        }),
      { concurrency, discard: true }
    )
  );

  const remaining = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM website_scrape_failures
    `.pipe(Effect.map((result) => result[0]?.count ?? 0))
  );

  console.log('Retry pass complete.');
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Still failing: ${stillFailing}`);
  console.log(`  Remaining failure rows: ${remaining}`);
});

const dbUrl = getArg('--db') ?? 'file:./dci-relational.db';
const SqlLayer = LibsqlClient.layer({ url: dbUrl });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('Retry failed:', error);
  process.exitCode = 1;
});
