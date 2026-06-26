// /rankings RPC (plan M1). Reads the rm_rankings shard in prod (relational
// builder fallback in dev) and resolves the chosen view. LEAK-SAFE: a
// createServerFn module — server/SDK/node value-imports are stripped client-side.
import { createServerFn } from '@tanstack/react-start';
import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import { buildRankings, buildRankingSeasons } from '@sdk/src/readModel/builders/rankings.js';
import { readRankings, readRankingSeasons } from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { resolveRankings } from '@/lib/rankings/resolve';
import {
  DEFAULT_DIVISIONS,
  type RankAgg,
  type RankMetric,
  type RankingsResult,
} from '@/lib/rankings/types';

let sharedDb: Client | null = null;
const getDb = () =>
  (sharedDb ??= createClient({
    url:
      process.env.DCI_RELATIONAL_DB_URL ??
      `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`,
  }));

const readOrBuild = <A>(read: (db: Client) => Promise<A>, build: (db: Client) => Promise<A>) =>
  readModelEnabled() ? read(getReadModelClient()) : build(getDb());

export const getRankings = createServerFn({ method: 'GET' })
  .validator(
    (data: {
      season: string;
      asof?: string;
      metric?: RankMetric;
      agg?: RankAgg;
      div?: string[];
    }) => data
  )
  .handler(async ({ data }): Promise<RankingsResult> => {
    const rows = await readOrBuild(
      (db) => readRankings(db, data.season),
      (db) => buildRankings(db, data.season)
    ).catch(() => []);
    return resolveRankings(rows, {
      metric: data.metric ?? 'total',
      agg: data.agg ?? 'best',
      asof: data.asof ?? null,
      divisions: data.div && data.div.length ? data.div : DEFAULT_DIVISIONS,
    });
  });

/** Seasons with ranking data (newest first) — for the season chips. */
export const getRankingSeasons = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ seasons: string[] }> => {
    const seasons = await readOrBuild(
      (db) => readRankingSeasons(db),
      (db) => buildRankingSeasons(db)
    ).catch(() => [] as string[]);
    return { seasons };
  }
);
