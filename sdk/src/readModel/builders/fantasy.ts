// Fantasy-draft read-model builders (FANTASY_UI_UX_IMPROVEMENT_PLAN §2.1). These
// freeze the four score-DB reads the fantasy draft needs — the draftable corps
// pool, prior-season finals caption scores, season-best caption scores, and the
// finals competition per season — so the serving container (which ships only the
// read-model, not the 3.4 GB dci-relational.db) can run drafts. Generalized across
// all seasons so any league season works; app/lib/fantasy/score-db.ts reads these
// tables in prod and imports the eligibility rules below so the two paths share one
// definition (no silent drift between emitted rows and app-visible pool).
import type { Client } from "@libsql/client";

const DRAFT_DIVISIONS = ["World Class", "Open Class"];

// ── Draft-pool eligibility rules (single source of truth) ────────────────────
// score-db.ts imports these so the emit and the live/dev read apply identical
// rules. Exclusion is applied HERE (emitted table is already clean) and again in
// score-db for the relational/dev path; the division override is corps-keyed
// "current truth" and applied at read time (see score-db.ts).

// Feeder / non-competitive entries that shouldn't be draft picks. Matched by
// corps_key (stable) with a case-insensitive name fallback in case keys change.
export const FANTASY_EXCLUDED_CORPS_KEYS = new Set([
  "high-school-affiliated-to-bit",
  "calgary-round-up-band",
  "001j000000i6kalaa3", // Blue Devils C
  "001j000000iwxa3aal", // Mandarins — not performing the 2026 season
]);
export const FANTASY_EXCLUDED_CORPS_NAMES = new Set([
  "high school affiliated to bit",
  "calgary round-up band",
  "blue devils c",
  "mandarins",
]);
export const isExcludedCorps = (corpsKey: string, name: string): boolean =>
  FANTASY_EXCLUDED_CORPS_KEYS.has(corpsKey) ||
  FANTASY_EXCLUDED_CORPS_NAMES.has(name.trim().toLowerCase());

// Division overrides where a corps has changed class since its competed season.
// Corps-keyed current truth (not season-relative); applied at read time.
export const FANTASY_DIVISION_OVERRIDES_BY_KEY: Record<string, string> = {
  "001j000000iwxacaa1": "World Class", // Spartans — World Class for 2026
};
export const FANTASY_DIVISION_OVERRIDES_BY_NAME: Record<string, string> = {
  spartans: "World Class",
};
export const overrideDivision = (
  corpsKey: string,
  name: string,
  division: string | null,
): string | null =>
  FANTASY_DIVISION_OVERRIDES_BY_KEY[corpsKey] ??
  FANTASY_DIVISION_OVERRIDES_BY_NAME[name.trim().toLowerCase()] ??
  division;

export interface FantasyPoolRow {
  season: string;
  corps_key: string;
  slug: string | null;
  name: string;
  division_name: string | null;
  display_city: string | null;
  corps_logo: string | null;
}

/**
 * Eligible draftable corps per season: World/Open corps that competed in that
 * season (excl. feeder/non-competitive entries). Emitted for EVERY season so a
 * league drafts from its PRIOR completed season (a 2026 league reads 2025) — the
 * prior season is full and stable, instead of collapsing to the handful of corps
 * that have scored so far in the current season.
 */
export async function buildFantasyDraftPool(src: Client): Promise<FantasyPoolRow[]> {
  const res = await src.execute({
    sql: `SELECT DISTINCT c.season, co.corps_key, co.slug, co.name, cs.division_name,
                 co.display_city, co.corps_logo
          FROM corps co
          JOIN corps_scores cs ON cs.corps_key = co.corps_key
          JOIN competitions c ON c.slug = cs.competition_slug
          WHERE cs.division_name IN (?, ?)
          ORDER BY c.season, cs.division_name, co.name COLLATE NOCASE`,
    args: DRAFT_DIVISIONS,
  });
  return res.rows
    .map((r) => ({
      season: r.season as string,
      corps_key: r.corps_key as string,
      slug: (r.slug as string | null) ?? null,
      name: r.name as string,
      division_name: (r.division_name as string | null) ?? null,
      display_city: (r.display_city as string | null) ?? null,
      corps_logo: (r.corps_logo as string | null) ?? null,
    }))
    .filter((r) => !isExcludedCorps(r.corps_key, r.name));
}

export interface FantasyCaptionRow {
  season: string;
  corps_key: string;
  caption_name: string;
  score: number;
}

/**
 * Prior-season CHAMPIONSHIPS-WEEK caption ranking, per season: each corps' best
 * caption score across prelims (everyone) / semifinals / finals (World + Open).
 * Using the whole week — not just finals night — means every corps that competed
 * gets a rank, not just the ~12 finalists. MAX per (season, corps, caption).
 */
export async function buildFantasyPriorFinals(src: Client): Promise<FantasyCaptionRow[]> {
  const res = await src.execute({
    sql: `SELECT c.season, cap.corps_key, cap.caption_name, MAX(cap.score) AS score
          FROM caption_scores cap
          JOIN competitions c  ON c.slug = cap.competition_slug
          JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
          WHERE (c.slug LIKE '%world-championship-prelims'
                 OR c.slug LIKE '%world-championship-semifinals'
                 OR c.slug LIKE '%world-championship-finals')
            AND cs.division_name IN (?, ?)
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
