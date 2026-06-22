/**
 * Read-only access to the score DB (`dci-relational.db`) for the draft:
 * the draftable corps pool (Appendix C.4) and the prior-season finals caption
 * ranking that powers auto-pick + the suggested-pick hint (Appendix C.3).
 *
 * SERVER-ONLY. Never writes. The client is created lazily (not at module load)
 * so importing this from a server module stays browse-safe in the dev bundle.
 */
import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import { CAPTION_NAME_TO_KEY, type CaptionKey } from './captions';

const DRAFT_DIVISIONS = ['World Class', 'Open Class'];

let _dbUrl: string | undefined;
const dbUrl = (): string =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ??
    `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`);

let sharedDb: Client | null = null;
const scoreDb = (): Client => (sharedDb ??= createClient({ url: dbUrl() }));

export type DraftableCorps = {
  corpsKey: string;
  slug: string | null;
  name: string;
  divisionName: string | null;
  displayCity: string | null;
  corpsLogo: string | null;
};

// The corps directory changes rarely, but the pool is read on every draft pick
// (twice — legality + the UI snapshot) and on every auto-pick. Memoize it for a
// short window so a fast-paced draft doesn't hammer the score DB.
const POOL_TTL_MS = 60_000;
let poolCache: { at: number; value: DraftableCorps[] } | null = null;

/** Active World + Open corps for the season (Appendix C.4). Cached ~60s. */
export async function getDraftPool(): Promise<DraftableCorps[]> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.value;
  const res = await scoreDb().execute({
    sql: `SELECT corps_key, slug, name, division_name, display_city, corps_logo
          FROM corps
          WHERE division_name IN (?, ?)
          ORDER BY division_name, name COLLATE NOCASE`,
    args: DRAFT_DIVISIONS,
  });
  const value = res.rows.map((r) => ({
    corpsKey: r.corps_key as string,
    slug: (r.slug as string | null) ?? null,
    name: r.name as string,
    divisionName: (r.division_name as string | null) ?? null,
    displayCity: (r.display_city as string | null) ?? null,
    corpsLogo: (r.corps_logo as string | null) ?? null,
  }));
  poolCache = { at: Date.now(), value };
  return value;
}

/** `${corpsKey}|${captionKey}` → prior-season finals score. */
export type RankingLookup = Map<string, number>;

export const rankingKey = (corpsKey: string, caption: CaptionKey): string =>
  `${corpsKey}|${caption}`;

/**
 * Prior-season World Championship Finals caption scores (Appendix C.3). Used only
 * to rank the draft pool for auto-pick + suggestions — never as a scoring input.
 * Corps/captions with no finals row simply don't appear (they rank last).
 */
// Prior-season finals scores are historical/immutable — cache permanently per
// season (read on every auto-pick).
const rankingCache = new Map<string, RankingLookup>();

export async function getPriorSeasonRanking(prevSeason: string): Promise<RankingLookup> {
  const cached = rankingCache.get(prevSeason);
  if (cached) return cached;
  const res = await scoreDb().execute({
    sql: `SELECT cap.corps_key, cap.caption_name, cap.score
          FROM caption_scores cap
          JOIN competitions c  ON c.slug = cap.competition_slug
          JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
          WHERE c.season = ?
            AND c.slug LIKE '%world-championship-finals'
            AND cs.division_name IN (?, ?)
            AND cap.score IS NOT NULL`,
    args: [prevSeason, ...DRAFT_DIVISIONS],
  });
  const lookup: RankingLookup = new Map();
  for (const r of res.rows) {
    const key = CAPTION_NAME_TO_KEY[r.caption_name as string];
    if (!key) continue;
    lookup.set(rankingKey(r.corps_key as string, key), r.score as number);
  }
  rankingCache.set(prevSeason, lookup);
  return lookup;
}

/**
 * `${corpsKey}|${captionKey}` → the corps' SEASON-BEST score in that caption so
 * far this season (Appendix C.2 / §5.2): a single grouped MAX over scored
 * World/Open competitions. This is the scoring input for standings.
 */
export async function getSeasonBestLookup(season: string): Promise<RankingLookup> {
  const res = await scoreDb().execute({
    sql: `SELECT cap.corps_key, cap.caption_name, MAX(cap.score) AS best
          FROM caption_scores cap
          JOIN competitions c  ON c.slug = cap.competition_slug
          JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
          WHERE c.season = ?
            AND cs.division_name IN (?, ?)
            AND cap.score IS NOT NULL
          GROUP BY cap.corps_key, cap.caption_name`,
    args: [season, ...DRAFT_DIVISIONS],
  });
  const lookup: RankingLookup = new Map();
  for (const r of res.rows) {
    const key = CAPTION_NAME_TO_KEY[r.caption_name as string];
    if (!key) continue;
    lookup.set(rankingKey(r.corps_key as string, key), r.best as number);
  }
  return lookup;
}

export type SeasonFinals = {
  slug: string;
  date: string;
  /** Whether the finals recap has landed (caption scores present). */
  recapPresent: boolean;
} | null;

/**
 * The season's World Championship Finals competition + whether its recap has
 * landed (§5.5 finals detection). Heuristic slug match `%world-championship-finals`
 * — verify the exact 2026 slug against the DB during M4 acceptance.
 */
export async function getSeasonFinals(season: string): Promise<SeasonFinals> {
  const res = await scoreDb().execute({
    sql: `SELECT c.slug, c.date,
                 EXISTS (SELECT 1 FROM caption_scores cap WHERE cap.competition_slug = c.slug) AS has_recap
          FROM competitions c
          WHERE c.season = ? AND c.slug LIKE '%world-championship-finals'
          ORDER BY c.date DESC LIMIT 1`,
    args: [season],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    slug: row.slug as string,
    date: row.date as string,
    recapPresent: Boolean(row.has_recap),
  };
}
