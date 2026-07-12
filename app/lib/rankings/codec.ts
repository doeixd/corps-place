// /rankings URL ⇄ state codec (plan M5/M7). Pure parsers for the search params,
// extracted from the route so they're unit-tested. Tolerant of array OR comma-
// string inputs (TanStack may serialize a list either way) and drops anything
// invalid — the URL never yields a value the resolver can't use. Client-safe.
import {
  RANK_DIVISIONS,
  RANK_METRICS,
  type RankChartMode,
  type RankDateMode,
  type RankMetric,
} from './types';

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [];

export const parseMetric = (v: unknown): RankMetric | undefined =>
  RANK_METRICS.includes(v as RankMetric) ? (v as RankMetric) : undefined;

/** Chart mode; `undefined` (= default `rank`) for anything but an explicit `score`. */
export const parseChart = (v: unknown): RankChartMode | undefined =>
  v === 'score' ? 'score' : undefined;

/** Display toggles that DEFAULT ON: only an explicit '0' (off) survives in the
 *  URL — the default state stays param-free (canonical URLs unaffected). */
export const parseOffFlag = (v: unknown): '0' | undefined =>
  v === '0' || v === 0 ? '0' : undefined;

/** Row date display; `undefined` (= default recency-dot behavior) otherwise. */
export const parseDateMode = (v: unknown): RankDateMode | undefined =>
  v === 'days' || v === 'date' ? v : undefined;

/** Included divisions; `undefined` (= default world+open) when empty/invalid. */
export const parseDivs = (v: unknown): string[] | undefined => {
  const valid = asList(v).filter((d) => (RANK_DIVISIONS as readonly string[]).includes(d));
  return valid.length ? valid : undefined;
};

/**
 * Canonical `/rankings` path for pSEO. `season` (when not the newest, which is
 * the bare `/rankings` default), `metric` (when not the default `total`), and a
 * SINGLE selected division survive — a lone World/Open/All-Age list is a real,
 * distinct landing page ("2026 open class drum corps rankings"). Every other
 * filter (as-of, multi-division combos, aggregation, recency) collapses onto
 * this base, so the param permutations dedupe to one indexable URL per
 * season×metric×division. The sitemap builds its rankings URLs with this same
 * helper, so the emitted `<link rel="canonical">` and the sitemap entries always
 * agree. Built by hand (not URLSearchParams) so the string is byte-identical.
 */
export function rankingsCanonicalPath(
  season: string,
  metric: RankMetric,
  newestSeason: string,
  div?: readonly string[],
): string {
  const parts: string[] = [];
  if (season && season !== newestSeason) parts.push(`season=${encodeURIComponent(season)}`);
  if (metric !== 'total') parts.push(`metric=${metric}`);
  if (div?.length === 1 && (RANK_DIVISIONS as readonly string[]).includes(div[0]))
    parts.push(`div=${div[0]}`);
  return parts.length ? `/rankings?${parts.join('&')}` : '/rankings';
}

/** Recency thresholds — exactly 3 positive days, ascending; else `undefined`. */
export const parseRecency = (v: unknown): number[] | undefined => {
  const nums = asList(v)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return nums.length === 3 ? nums : undefined;
};
