/**
 * Read-only access to the fantasy score data for the draft: the draftable corps
 * pool (Appendix C.4) and the prior-season finals caption ranking that powers
 * auto-pick + the suggested-pick hint (Appendix C.3).
 *
 * Two sources, transparently (UI/UX plan §2.1): in production the serving image
 * ships only the read-model (no 3.4 GB `dci-relational.db`), so when
 * `readModelEnabled()` these read the frozen `rm_fantasy_*` tables; otherwise (dev,
 * the ingest box) they query `dci-relational.db` directly. The emit
 * (sdk/scripts/emitReadModel.ts) builds the rm_fantasy_* tables with the SAME SQL,
 * so the two sources can't drift. Both paths degrade to empty on error.
 *
 * SERVER-ONLY. Never writes. The client is created lazily (not at module load)
 * so importing this from a server module stays browse-safe in the dev bundle.
 */
import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { CAPTION_NAME_TO_KEY, type CaptionKey } from './captions';

const DRAFT_DIVISIONS = ['World Class', 'Open Class'];

// Corps excluded from the draftable pool by request — feeder / non-competitive
// entries that shouldn't be draft picks. Matched by corps_key (stable) with a
// case-insensitive name fallback in case keys change.
const EXCLUDED_CORPS_KEYS = new Set([
  'high-school-affiliated-to-bit',
  'calgary-round-up-band',
  '001j000000i6kalaa3', // Blue Devils C
  '001j000000iwxa3aal', // Mandarins — not performing the 2026 season
]);
const EXCLUDED_CORPS_NAMES = new Set([
  'high school affiliated to bit',
  'calgary round-up band',
  'blue devils c',
  'mandarins',
]);
const isExcludedCorps = (corpsKey: string, name: string): boolean =>
  EXCLUDED_CORPS_KEYS.has(corpsKey) ||
  EXCLUDED_CORPS_NAMES.has(name.trim().toLowerCase());

// Division overrides for the current season, where a corps has moved class since
// the read-model's source season. Keyed by corps_key, with a name fallback.
const DIVISION_OVERRIDES_BY_KEY: Record<string, string> = {
  '001j000000iwxacaa1': 'World Class', // Spartans — World Class for 2026
};
const DIVISION_OVERRIDES_BY_NAME: Record<string, string> = {
  spartans: 'World Class',
};
const overrideDivision = (corpsKey: string, name: string, division: string | null): string | null =>
  DIVISION_OVERRIDES_BY_KEY[corpsKey] ??
  DIVISION_OVERRIDES_BY_NAME[name.trim().toLowerCase()] ??
  division;

let _dbUrl: string | undefined;
const dbUrl = (): string =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ??
    `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`);

let sharedDb: Client | null = null;
const scoreDb = (): Client => (sharedDb ??= createClient({ url: dbUrl() }));

// In production the relational score DB is intentionally NOT on the request path
// (the serving image ships only the read-model), so these reads can fail there
// until the fantasy slices are emitted into the read-model
// (FANTASY_UI_UX_IMPROVEMENT_PLAN §2.1). Degrade to safe empties rather than throw,
// so the draft room renders an explainer instead of a 500 that takes the whole
// page + nav down (§2.3). Warn once.
let warnedScoreDbUnavailable = false;
function scoreDbFallback<T>(fn: string, fallback: T, err: unknown): T {
  if (!warnedScoreDbUnavailable) {
    warnedScoreDbUnavailable = true;
    console.error(
      `[fantasy/score-db] ${fn} failed — scoring DB unavailable on this host; degrading to empty ` +
        `(emit the fantasy read-model slices to fix; see FANTASY_UI_UX_IMPROVEMENT_PLAN §2.1).`,
      err
    );
  }
  return fallback;
}

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

/**
 * Eligible draftable corps (Appendix C.4): World + Open class corps that actually
 * COMPETED in the latest season with results — not the whole all-time corps table
 * (which includes folded/hiatus corps), and not the stale `corps.active` flag. The
 * division is taken from that season's participation (`corps_scores.division_name`,
 * which can differ from the corps' static division). Pre-season this resolves to
 * the prior completed season — the same season the auto-pick ranking uses — and it
 * auto-advances once the new season's shows land. Cached ~60s.
 */
export async function getDraftPool(): Promise<DraftableCorps[]> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.value;
  try {
    const res = readModelEnabled()
      ? await getReadModelClient().execute(
          `SELECT corps_key, slug, name, division_name, display_city, corps_logo
           FROM rm_fantasy_draft_pool ORDER BY sort_index`
        )
      : await scoreDb().execute({
          sql: `SELECT DISTINCT co.corps_key, co.slug, co.name, cs.division_name, co.display_city, co.corps_logo
                FROM corps co
                JOIN corps_scores cs ON cs.corps_key = co.corps_key
                JOIN competitions c ON c.slug = cs.competition_slug
                WHERE c.season = (SELECT MAX(season) FROM competitions)
                  AND cs.division_name IN (?, ?)
                ORDER BY cs.division_name, co.name COLLATE NOCASE`,
          args: DRAFT_DIVISIONS,
        });
    const value = res.rows
      .map((r) => {
        const corpsKey = r.corps_key as string;
        const name = r.name as string;
        return {
          corpsKey,
          slug: (r.slug as string | null) ?? null,
          name,
          divisionName: overrideDivision(corpsKey, name, (r.division_name as string | null) ?? null),
          displayCity: (r.display_city as string | null) ?? null,
          corpsLogo: (r.corps_logo as string | null) ?? null,
        };
      })
      .filter((c) => !isExcludedCorps(c.corpsKey, c.name));
    poolCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    return scoreDbFallback('getDraftPool', [] as DraftableCorps[], err);
  }
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
  try {
    const res = readModelEnabled()
      ? await getReadModelClient().execute({
          sql: `SELECT corps_key, caption_name, score FROM rm_fantasy_prior_finals WHERE season = ?`,
          args: [prevSeason],
        })
      : await scoreDb().execute({
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
  } catch (err) {
    return scoreDbFallback('getPriorSeasonRanking', new Map() as RankingLookup, err);
  }
}

/**
 * `${corpsKey}|${captionKey}` → the corps' SEASON-BEST score in that caption so
 * far this season (Appendix C.2 / §5.2): a single grouped MAX over scored
 * World/Open competitions. This is the scoring input for standings.
 */
export async function getSeasonBestLookup(season: string): Promise<RankingLookup> {
  try {
    const res = readModelEnabled()
      ? await getReadModelClient().execute({
          sql: `SELECT corps_key, caption_name, best FROM rm_fantasy_season_best WHERE season = ?`,
          args: [season],
        })
      : await scoreDb().execute({
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
  } catch (err) {
    return scoreDbFallback('getSeasonBestLookup', new Map() as RankingLookup, err);
  }
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
  try {
    const res = readModelEnabled()
      ? await getReadModelClient().execute({
          sql: `SELECT slug, date, recap_present AS has_recap FROM rm_fantasy_season_finals
                WHERE season = ? ORDER BY date DESC LIMIT 1`,
          args: [season],
        })
      : await scoreDb().execute({
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
  } catch (err) {
    return scoreDbFallback('getSeasonFinals', null as SeasonFinals, err);
  }
}
