// Prime event Wayback availability cache from CDX index.
// Usage: npx tsx scripts/primeWaybackEventAvailability.ts [--season 2024] [--seasons 2023,2024] [--db file:./dci-relational.db]

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const baseEventUrl = 'https://www.dci.org/events';
const cdxBaseUrl = 'https://web.archive.org/cdx/search/cdx';

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const parseSeasons = () => {
  const single = getArg('--season');
  const multi = getArg('--seasons');
  const seasons = new Set<string>();
  if (single) seasons.add(single);
  if (multi) {
    multi
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => seasons.add(value));
  }
  return [...seasons];
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchJsonWithRetry = async (url: string, attempt = 0): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
    },
  });

  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    const delay = 500 * 2 ** attempt;
    console.warn(`[wayback-prime] HTTP ${response.status}; retrying in ${delay}ms`);
    await sleep(delay);
    return fetchJsonWithRetry(url, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`CDX request failed (${response.status}): ${url}`);
  }

  return response.json();
};

const extractEventSlug = (originalUrl: string): string | undefined => {
  try {
    const parsed = new URL(originalUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    const marker = '/events/';
    const idx = path.indexOf(marker);
    if (idx === -1) return undefined;
    const slug = path.slice(idx + marker.length).trim();
    if (!slug) return undefined;
    if (slug.includes('/')) return undefined;
    return decodeURIComponent(slug).toLowerCase();
  } catch {
    return undefined;
  }
};

const snapshotUrl = (timestamp: string, originalUrl: string) =>
  `https://web.archive.org/web/${timestamp}/${originalUrl}`;

interface CdxEntry {
  readonly timestamp: string;
  readonly original: string;
}

const queryCdxForSeason = async (
  season: string,
  hostPattern: string
): Promise<ReadonlyArray<CdxEntry>> => {
  const from = `${season}0101000000`;
  const to = `${season}1231235959`;
  const params = new URLSearchParams({
    url: `${hostPattern}/events/*`,
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest',
    filter: 'statuscode:200',
    from,
    to,
    collapse: 'digest',
  });

  const raw = (await fetchJsonWithRetry(`${cdxBaseUrl}?${params.toString()}`)) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }

  const rows = raw.slice(1);
  const out: CdxEntry[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const timestamp = String(row[0] ?? '').trim();
    const original = String(row[1] ?? '').trim();
    if (!timestamp || !original) continue;
    out.push({ timestamp, original });
  }
  return out;
};

const ensureWaybackCacheTable = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS event_wayback_availability (
      event_slug TEXT NOT NULL,
      season TEXT,
      target_url TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_url TEXT,
      last_checked_at TEXT NOT NULL,
      PRIMARY KEY (event_slug, season, target_url)
    )
  `.pipe(Effect.asVoid);

const upsertWaybackFound = (
  sql: SqlClient.SqlClient,
  args: {
    season: string;
    slug: string;
    targetUrl: string;
    snapshot: string;
  }
) =>
  sql`
    INSERT INTO event_wayback_availability (
      event_slug, season, target_url, status, snapshot_url, last_checked_at
    ) VALUES (
      ${args.slug}, ${args.season}, ${args.targetUrl}, 'found', ${args.snapshot}, ${new Date().toISOString()}
    )
    ON CONFLICT(event_slug, season, target_url) DO UPDATE SET
      status = 'found',
      snapshot_url = excluded.snapshot_url,
      last_checked_at = excluded.last_checked_at
  `.pipe(Effect.asVoid);

const inferSeasonsFromEvents = (sql: SqlClient.SqlClient) =>
  sql<{ season: string }>`
    SELECT DISTINCT COALESCE(season, strftime('%Y', start_date)) AS season
    FROM events
    WHERE COALESCE(season, strftime('%Y', start_date)) IS NOT NULL
    ORDER BY season
  `.pipe(Effect.map((rows) => rows.map((row) => row.season).filter(Boolean)));

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (ensureWaybackCacheTable(sql));

  const argSeasons = parseSeasons();
  const seasons = argSeasons.length > 0 ? argSeasons : yield* (inferSeasonsFromEvents(sql));
  if (seasons.length === 0) {
    console.log('[wayback-prime] No seasons to process.');
    return;
  }

  console.log(`[wayback-prime] seasons=${seasons.join(',')}`);

  let totalUpserts = 0;
  for (const season of seasons) {
    const bySlug = new Map<string, { timestamp: string; original: string }>();

    for (const hostPattern of ['www.dci.org', 'dci.org']) {
      const entries = yield* (Effect.tryPromise(() => queryCdxForSeason(season, hostPattern)));
      for (const entry of entries) {
        const slug = extractEventSlug(entry.original);
        if (!slug) continue;
        const previous = bySlug.get(slug);
        if (!previous || entry.timestamp > previous.timestamp) {
          bySlug.set(slug, { timestamp: entry.timestamp, original: entry.original });
        }
      }
    }

    let seasonUpserts = 0;
    for (const [slug, capture] of bySlug.entries()) {
      const targetUrl = `${baseEventUrl}/${slug}`;
      const snapshot = snapshotUrl(capture.timestamp, capture.original);
      yield* (upsertWaybackFound(sql, { season, slug, targetUrl, snapshot }));
      seasonUpserts += 1;
    }

    totalUpserts += seasonUpserts;
    console.log(`[wayback-prime] ${season}: cached ${seasonUpserts} event snapshot(s)`);
  }

  console.log(`[wayback-prime] done. upserts=${totalUpserts}`);
});

const dbUrl = getArg('--db') ?? 'file:./dci-relational.db';
const SqlLayer = LibsqlClient.layer({ url: dbUrl });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('[wayback-prime] failed:', error);
  process.exitCode = 1;
});
