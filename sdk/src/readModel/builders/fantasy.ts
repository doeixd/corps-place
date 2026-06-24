// Fantasy-draft read-model builders (FANTASY_UI_UX_IMPROVEMENT_PLAN §2.1). These
// freeze the four score-DB reads the fantasy draft needs — the draftable corps
// pool, prior-season finals caption scores, season-best caption scores, and the
// finals competition per season — so the serving container (which ships only the
// read-model, not the 3.4 GB dci-relational.db) can run drafts. The SQL mirrors
// app/lib/fantasy/score-db.ts exactly, generalized across all seasons so any
// league season works; app/lib/fantasy/score-db.ts reads these tables in prod.
import type { Client } from "@libsql/client";

const DRAFT_DIVISIONS = ["World Class", "Open Class"];

export interface FantasyPoolRow {
  corps_key: string;
  slug: string | null;
  name: string;
  division_name: string | null;
  display_city: string | null;
  corps_logo: string | null;
}

/** Eligible draftable corps: World/Open corps that competed in the latest season. */
export async function buildFantasyDraftPool(src: Client): Promise<FantasyPoolRow[]> {
  const res = await src.execute({
    sql: `SELECT DISTINCT co.corps_key, co.slug, co.name, cs.division_name, co.display_city, co.corps_logo
          FROM corps co
          JOIN corps_scores cs ON cs.corps_key = co.corps_key
          JOIN competitions c ON c.slug = cs.competition_slug
          WHERE c.season = (SELECT MAX(season) FROM competitions)
            AND cs.division_name IN (?, ?)
          ORDER BY cs.division_name, co.name COLLATE NOCASE`,
    args: DRAFT_DIVISIONS,
  });
  return res.rows.map((r) => ({
    corps_key: r.corps_key as string,
    slug: (r.slug as string | null) ?? null,
    name: r.name as string,
    division_name: (r.division_name as string | null) ?? null,
    display_city: (r.display_city as string | null) ?? null,
    corps_logo: (r.corps_logo as string | null) ?? null,
  }));
}

export interface FantasyCaptionRow {
  season: string;
  corps_key: string;
  caption_name: string;
  score: number;
}

/** Prior-season finals caption scores, per season (World/Open finals only). */
export async function buildFantasyPriorFinals(src: Client): Promise<FantasyCaptionRow[]> {
  const res = await src.execute({
    sql: `SELECT c.season, cap.corps_key, cap.caption_name, cap.score
          FROM caption_scores cap
          JOIN competitions c  ON c.slug = cap.competition_slug
          JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
          WHERE c.slug LIKE '%world-championship-finals'
            AND cs.division_name IN (?, ?)
            AND cap.score IS NOT NULL`,
    args: DRAFT_DIVISIONS,
  });
  return res.rows.map((r) => ({
    season: r.season as string,
    corps_key: r.corps_key as string,
    caption_name: r.caption_name as string,
    score: Number(r.score),
  }));
}

/** Season-best (MAX) caption score per (season, corps, caption) over World/Open shows. */
export async function buildFantasySeasonBest(src: Client): Promise<FantasyCaptionRow[]> {
  const res = await src.execute({
    sql: `SELECT c.season, cap.corps_key, cap.caption_name, MAX(cap.score) AS score
          FROM caption_scores cap
          JOIN competitions c  ON c.slug = cap.competition_slug
          JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
          WHERE cs.division_name IN (?, ?)
            AND cap.score IS NOT NULL
          GROUP BY c.season, cap.corps_key, cap.caption_name`,
    args: DRAFT_DIVISIONS,
  });
  return res.rows.map((r) => ({
    season: r.season as string,
    corps_key: r.corps_key as string,
    caption_name: r.caption_name as string,
    score: Number(r.score),
  }));
}

export interface FantasySeasonFinalsRow {
  season: string;
  slug: string;
  date: string;
  recap_present: number;
}

/** Each season's World Championship Finals competition + whether its recap landed. */
export async function buildFantasySeasonFinals(src: Client): Promise<FantasySeasonFinalsRow[]> {
  const res = await src.execute({
    sql: `SELECT c.season, c.slug, c.date,
                 EXISTS (SELECT 1 FROM caption_scores cap WHERE cap.competition_slug = c.slug) AS has_recap
          FROM competitions c
          WHERE c.slug LIKE '%world-championship-finals'`,
    args: [],
  });
  return res.rows.map((r) => ({
    season: r.season as string,
    slug: r.slug as string,
    date: (r.date as string | null) ?? "",
    recap_present: Number(r.has_recap) ? 1 : 0,
  }));
}
