// /rankings URL ⇄ state codec (plan M5/M7). Pure parsers for the search params,
// extracted from the route so they're unit-tested. Tolerant of array OR comma-
// string inputs (TanStack may serialize a list either way) and drops anything
// invalid — the URL never yields a value the resolver can't use. Client-safe.
import { RANK_DIVISIONS, RANK_METRICS, type RankMetric } from './types';

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [];

export const parseMetric = (v: unknown): RankMetric | undefined =>
  RANK_METRICS.includes(v as RankMetric) ? (v as RankMetric) : undefined;

/** Included divisions; `undefined` (= default world+open) when empty/invalid. */
export const parseDivs = (v: unknown): string[] | undefined => {
  const valid = asList(v).filter((d) => (RANK_DIVISIONS as readonly string[]).includes(d));
  return valid.length ? valid : undefined;
};

/** Recency thresholds — exactly 3 positive days, ascending; else `undefined`. */
export const parseRecency = (v: unknown): number[] | undefined => {
  const nums = asList(v)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return nums.length === 3 ? nums : undefined;
};
