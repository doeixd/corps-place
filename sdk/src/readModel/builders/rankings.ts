// Read-model builder for the /rankings page (RANKINGS_PAGE_PLAN.md). Emits the
// RAW per-show, per-corps, per-metric score grid for a season — the resolver
// windows it for the chosen aggregation (best-so-far / avg-of-last-3), as-of
// date, and the bump-chart rank history, all in prod from the shard.
//
// Metrics use the SAME caption/category math as the recap table (foldRecapRows):
// total prefers published total_score; GE/Visual prefer published category_scores
// (fall back to caption sums); Guard/Brass/Perc are the CG/MB/MP captions. We do
// NOT use season_ranking_entries — its metric taxonomy is messy / lacks a clean
// "Total" (verified 2026-06-26).
import type { Client } from '@libsql/client';
import {
  foldRecapRows,
  type CorpsScoreRow,
  type CaptionScoreRow,
  type CategoryScoreRow,
  type RecapRowOut,
} from './recap.js';

export const RANK_METRICS = ['total', 'ge', 'visual', 'guard', 'brass', 'perc'] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

/** One corps's score for one metric at one competition. */
export interface RankingScoreRow {
  season: string;
  competitionSlug: string;
  date: string;
  corpsSlug: string;
  corpsName: string;
  division: string;
  metric: RankMetric;
  score: number;
}

/** Resolve a metric to its RecapRowOut field. Guard/Brass/Perc are single
 *  captions and may be absent (reduced sheets / exhibitions) → undefined, which
 *  excludes that corps from the metric's ranking (plan edge case). */
const metricValue = (r: RecapRowOut, m: RankMetric): number | undefined => {
  switch (m) {
    case 'total':
      return r.total || undefined;
    case 'ge':
      return r.GE || undefined;
    case 'visual':
      return r.Visual || undefined;
    case 'guard':
      return r.CG;
    case 'brass':
      return r.MB;
    case 'perc':
      return r.MP;
  }
};

export const buildRankings = async (db: Client, season: string): Promise<RankingScoreRow[]> => {
  // Released competitions for the season (slug → date). Three season-wide score
  // queries, grouped in JS per competition — not N per-competition round trips.
  const [comps, scores, caps, cats, slugs] = await Promise.all([
    db.execute({
      sql: `SELECT slug, date FROM competitions
            WHERE season = ? AND scores_released = 1 AND date IS NOT NULL`,
      args: [season],
    }),
    db.execute({
      sql: `SELECT cs.competition_slug, cs.corps_key, cs.corps_name, cs.total_score,
                   cs.rank, cs.division_name
            FROM corps_scores cs JOIN competitions c ON c.slug = cs.competition_slug
            WHERE c.season = ? AND c.scores_released = 1 AND cs.total_score IS NOT NULL`,
      args: [season],
    }),
    db.execute({
      sql: `SELECT cap.competition_slug, cap.corps_key, cap.caption_name, cap.score
            FROM caption_scores cap JOIN competitions c ON c.slug = cap.competition_slug
            WHERE c.season = ? AND c.scores_released = 1`,
      args: [season],
    }),
    db.execute({
      sql: `SELECT cat.competition_slug, cat.corps_key, cat.category_name, cat.score
            FROM category_scores cat JOIN competitions c ON c.slug = cat.competition_slug
            WHERE c.season = ? AND c.scores_released = 1`,
      args: [season],
    }),
    db.execute({ sql: `SELECT corps_key, slug FROM corps WHERE slug IS NOT NULL`, args: [] }),
  ]);

  const dateBySlug = new Map<string, string>();
  for (const r of comps.rows as any[]) dateBySlug.set(String(r.slug), String(r.date));
  const slugByKey = new Map<string, string>();
  for (const r of slugs.rows as any[]) slugByKey.set(String(r.corps_key), String(r.slug));

  // Bucket the three score sets by competition_slug.
  const byComp = new Map<
    string,
    { scores: CorpsScoreRow[]; caps: CaptionScoreRow[]; cats: CategoryScoreRow[] }
  >();
  const bucket = (slug: string) => {
    let b = byComp.get(slug);
    if (!b) {
      b = { scores: [], caps: [], cats: [] };
      byComp.set(slug, b);
    }
    return b;
  };
  for (const r of scores.rows as any[])
    bucket(String(r.competition_slug)).scores.push(r as CorpsScoreRow);
  for (const r of caps.rows as any[])
    bucket(String(r.competition_slug)).caps.push(r as CaptionScoreRow);
  for (const r of cats.rows as any[])
    bucket(String(r.competition_slug)).cats.push(r as CategoryScoreRow);

  const out: RankingScoreRow[] = [];
  for (const [competitionSlug, b] of byComp) {
    const date = dateBySlug.get(competitionSlug);
    if (!date) continue;
    const folded = foldRecapRows(b.scores, b.caps, b.cats);
    for (const r of folded) {
      const corpsSlug = slugByKey.get(r.corps_key);
      if (!corpsSlug) continue; // no directory slug → can't link/group; skip
      for (const metric of RANK_METRICS) {
        const v = metricValue(r, metric);
        if (typeof v === 'number' && v > 0) {
          out.push({
            season,
            competitionSlug,
            date,
            corpsSlug,
            corpsName: r.corps,
            division: r.division ?? '',
            metric,
            score: Number(v.toFixed(3)),
          });
        }
      }
    }
  }
  return out;
};

/** Seasons that have released scores (newest first) — for the season chips. */
export const buildRankingSeasons = async (db: Client): Promise<string[]> => {
  const r = await db.execute({
    sql: `SELECT DISTINCT season FROM competitions WHERE scores_released = 1 ORDER BY season DESC`,
    args: [],
  });
  return (r.rows as any[]).map((x) => String(x.season)).filter(Boolean);
};
