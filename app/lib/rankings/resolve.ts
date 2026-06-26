// /rankings resolver (plan M1). Pure: turns the raw per-show metric grid into a
// standings result for a (metric, agg, as-of, divisions) view, plus the per-day
// rank history the bump chart plots. Client-safe except the `divisionCategory`
// import (pure helper). No DB access — the RPC feeds it rows.
import { divisionCategory } from '@/lib/prediction-scenario';
import type { RankingScoreRow } from '@sdk/src/readModel/builders/rankings.js';
import type { RankAgg, RankMetric, RankRow, RankingsResult } from './types';

export interface ResolveRankingsOpts {
  metric: RankMetric;
  agg: RankAgg;
  asof?: string | null; // YYYY-MM-DD; null/undefined = latest
  divisions: string[]; // category keys (e.g. ['world','open'])
}

const dayOf = (iso: string) => iso.slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

interface CorpsScores {
  slug: string;
  name: string;
  division: string;
  days: { day: string; score: number }[];
}

/** Aggregate a corps's scores up to (and including) `cutoff`. Null if it hasn't
 *  performed by then. */
function aggregate(
  c: CorpsScores,
  agg: RankAgg,
  cutoff: string
): { score: number; lastDay: string; partial: boolean } | null {
  const upto = c.days.filter((d) => d.day <= cutoff);
  if (upto.length === 0) return null;
  const sorted = [...upto].sort((a, b) => a.day.localeCompare(b.day));
  const lastDay = sorted[sorted.length - 1].day;
  if (agg === 'best') {
    return { score: Math.max(...upto.map((d) => d.score)), lastDay, partial: false };
  }
  const last3 = sorted.slice(-3);
  const score = last3.reduce((s, d) => s + d.score, 0) / last3.length;
  return { score, lastDay, partial: last3.length < 3 };
}

/** Standings (slug → rank, score) for everyone with a result at `cutoff`. */
function standingsAt(corps: CorpsScores[], agg: RankAgg, cutoff: string) {
  const scored = corps
    .map((c) => ({ c, agg: aggregate(c, agg, cutoff) }))
    .filter((x): x is { c: CorpsScores; agg: NonNullable<ReturnType<typeof aggregate>> } => !!x.agg)
    // Score desc; stable tiebreak by name so reorder animation is deterministic.
    .sort((a, b) => b.agg.score - a.agg.score || a.c.name.localeCompare(b.c.name));
  return scored.map((x, i) => ({ slug: x.c.slug, score: x.agg.score, lastDay: x.agg.lastDay, rank: i + 1, partial: x.agg.partial }));
}

export function resolveRankings(
  rows: RankingScoreRow[],
  opts: ResolveRankingsOpts
): RankingsResult {
  const season = rows[0]?.season ?? '';
  const divSet = new Set(opts.divisions);

  // Filter to the chosen metric + included divisions; bucket per corps.
  const byCorps = new Map<string, CorpsScores>();
  for (const r of rows) {
    if (r.metric !== opts.metric) continue;
    if (!divSet.has(divisionCategory(r.division))) continue;
    let c = byCorps.get(r.corpsSlug);
    if (!c) {
      c = { slug: r.corpsSlug, name: r.corpsName, division: r.division, days: [] };
      byCorps.set(r.corpsSlug, c);
    }
    c.days.push({ day: dayOf(r.date), score: r.score });
  }
  const corps = [...byCorps.values()];

  const allDays = [...new Set(corps.flatMap((c) => c.days.map((d) => d.day)))].sort();
  if (allDays.length === 0)
    return { season, asof: null, dates: [], allDates: [], rows: [] };
  const asof = opts.asof && allDays.includes(opts.asof) ? opts.asof : allDays[allDays.length - 1];
  const dates = allDays.filter((d) => d <= asof);

  // Per-day standings → each corps's rank history (for the bump chart).
  const history = new Map<string, { date: string; rank: number; score: number }[]>();
  for (const day of dates) {
    for (const s of standingsAt(corps, opts.agg, day)) {
      const h = history.get(s.slug) ?? [];
      h.push({ date: day, rank: s.rank, score: Number(s.score.toFixed(3)) });
      history.set(s.slug, h);
    }
  }

  // Final standings at asof.
  const final = standingsAt(corps, opts.agg, asof);
  const out: RankRow[] = final.map((s) => {
    const c = byCorps.get(s.slug)!;
    return {
      corpsSlug: s.slug,
      corpsName: c.name,
      division: c.division,
      score: Number(s.score.toFixed(3)),
      rank: s.rank,
      lastPerformedDate: s.lastDay,
      daysSinceLast: Math.max(0, daysBetween(s.lastDay, asof)),
      partial: s.partial,
      history: history.get(s.slug) ?? [],
    };
  });

  return { season, asof, dates, allDates: allDays, rows: out };
}
