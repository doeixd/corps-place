// /tour URL ⇄ state codec (TOUR_MAP_PLAN §/tour). Pure, unit-tested, tolerant
// parsers — the URL never yields state the page can't render. Client-safe.
import { RANK_DIVISIONS } from '@/lib/rankings/types';

/** Focused-selection cap (matches VS_SERIES_CAP — legend/palette legibility). */
export const TOUR_FOCUS_CAP = 12;

/** Division categories shown by default (SoundSport is opt-in clutter). */
export const TOUR_DEFAULT_DIVS = ['world', 'open', 'all-age'] as const;
export const TOUR_DIVS = [...RANK_DIVISIONS, 'soundsport'] as const;
export type TourDiv = (typeof TOUR_DIVS)[number];

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [];

/** Focused corps slugs: deduped, slug-shaped only, capped. Empty → undefined
 *  (= all-corps mode). Validity against the season roster is the page's job —
 *  the codec can't know the season. */
export const parseCorpsList = (v: unknown): string[] | undefined => {
  const seen = new Set<string>();
  for (const raw of asList(v)) {
    const slug = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) continue;
    seen.add(slug);
    if (seen.size >= TOUR_FOCUS_CAP) break;
  }
  return seen.size ? [...seen] : undefined;
};

/** Included divisions; undefined = default (world+open+all-age). */
export const parseTourDivs = (v: unknown): TourDiv[] | undefined => {
  const valid = asList(v).filter((d): d is TourDiv =>
    (TOUR_DIVS as readonly string[]).includes(d)
  );
  return valid.length ? [...new Set(valid)] : undefined;
};

/** As-of date; undefined for anything not YYYY-MM-DD (page clamps to season). */
export const parseTourAsof = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

/** Year path param; undefined unless a plausible season. */
export const parseTourYear = (v: unknown): string | undefined => {
  const s = String(v ?? '');
  return /^(19|20)\d{2}$/.test(s) ? s : undefined;
};

/**
 * Canonical /tour path for pSEO (rankingsCanonicalPath pattern): newest season
 * is the bare `/tour`; other seasons get `/tour/<year>`. Every filter (?c,
 * ?div, ?asof) collapses. Shared with sitemap-core.
 */
export const tourCanonicalPath = (year: string, newestSeason: string): string =>
  year === newestSeason ? '/tour' : `/tour/${encodeURIComponent(year)}`;
