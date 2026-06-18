// Prime Wayback availability cache for DCI API /events endpoints.
// Usage: npx tsx scripts/primeWaybackApiAvailability.ts [--season 2024] [--seasons 2023,2024] [--db file:./dci-relational.db]

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const cdxBaseUrl = 'https://web.archive.org/cdx/search/cdx';

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const parseSeasons = () => {
  const single = getArg('--season');
  const multi = getArg('--seasons');
  const out = new Set<string>();
  if (single) out.add(single);
  if (multi) {
    multi
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .forEach((v) => out.add(v));
  }
  return [...out];
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchJsonWithRetry = async (url: string, attempt = 0): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json,text/plain,*/*',
    },
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    const delay = 500 * 2 ** attempt;
    await sleep(delay);
    return fetchJsonWithRetry(url, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`CDX request failed (${response.status}): ${url}`);
  }
  return response.json();
};

const buildSnapshotUrl = (timestamp: string, original: string) =>
  `https://web.archive.org/web/${timestamp}/${original}`;

const ensureApiWaybackTable = (sql: SqlClient.SqlClient) =>
  sql`
    CREATE TABLE IF NOT EXISTS api_wayback_availability (
      endpoint_name TEXT NOT NULL,
      season TEXT NOT NULL,
      api_url TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_url TEXT,
      snapshot_timestamp TEXT,
      last_checked_at TEXT NOT NULL,
      PRIMARY KEY (endpoint_name, season, api_url)
    )
  `.pipe(Effect.asVoid);

const upsertFound = (
  sql: SqlClient.SqlClient,
  args: {
    season: string;
    apiUrl: string;
    snapshotUrl: string;
    timestamp: string;
  }
) =>
  sql`
    INSERT INTO api_wayback_availability (
      endpoint_name, season, api_url, status, snapshot_url, snapshot_timestamp, last_checked_at
    ) VALUES (
      'events', ${args.season}, ${args.apiUrl}, 'found', ${args.snapshotUrl}, ${args.timestamp}, ${new Date().toISOString()}
    )
    ON CONFLICT(endpoint_name, season, api_url) DO UPDATE SET
      status = 'found',
      snapshot_url = excluded.snapshot_url,
      snapshot_timestamp = excluded.snapshot_timestamp,
      last_checked_at = excluded.last_checked_at
  `.pipe(Effect.asVoid);

const inferSeasons = (sql: SqlClient.SqlClient) =>
  sql<{ season: string }>`
    SELECT DISTINCT COALESCE(season, strftime('%Y', start_date)) AS season
    FROM events
    WHERE COALESCE(season, strftime('%Y', start_date)) IS NOT NULL
    ORDER BY season
  `.pipe(Effect.map((rows) => rows.map((row) => row.season).filter(Boolean)));

const cdxQueryForSeason = async (season: string) => {
  const params = new URLSearchParams({
    url: 'api.dci.org/api/v1/events*',
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest',
    from: `${season}0101000000`,
    to: `${season}1231235959`,
    collapse: 'digest',
  });
  params.append('filter', 'statuscode:200');

  const raw = (await fetchJsonWithRetry(`${cdxBaseUrl}?${params.toString()}`)) as unknown;
  if (!Array.isArray(raw) || raw.length <= 1)
    return [] as Array<{ timestamp: string; original: string }>;

  return raw
    .slice(1)
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 2)
    .map((row) => ({
      timestamp: String(row[0] ?? '').trim(),
      original: String(row[1] ?? '').trim(),
    }))
    .filter((row) => row.timestamp.length > 0 && row.original.includes('/api/v1/events'));
};

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (ensureApiWaybackTable(sql));

  const selected = parseSeasons();
  const seasons = selected.length > 0 ? selected : yield* (inferSeasons(sql));
  if (seasons.length === 0) {
    console.log('[wayback-api-prime] No seasons to process.');
    return;
  }

  console.log(`[wayback-api-prime] seasons=${seasons.join(',')}`);
  let total = 0;

  for (const season of seasons) {
    const rows = yield* (Effect.tryPromise(() => cdxQueryForSeason(season)));
    const latestByOriginal = new Map<string, { timestamp: string; original: string }>();

    for (const row of rows) {
      const prev = latestByOriginal.get(row.original);
      if (!prev || row.timestamp > prev.timestamp) {
        latestByOriginal.set(row.original, row);
      }
    }

    let upserts = 0;
    for (const row of latestByOriginal.values()) {
      yield* (
        upsertFound(sql, {
          season,
          apiUrl: row.original,
          snapshotUrl: buildSnapshotUrl(row.timestamp, row.original),
          timestamp: row.timestamp,
        })
      );
      upserts += 1;
    }

    total += upserts;
    console.log(`[wayback-api-prime] ${season}: cached ${upserts} API snapshot(s)`);
  }

  console.log(`[wayback-api-prime] done. upserts=${total}`);
});

const dbUrl = getArg('--db') ?? 'file:./dci-relational.db';
const SqlLayer = LibsqlClient.layer({ url: dbUrl });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('[wayback-api-prime] failed:', error);
  process.exitCode = 1;
});
