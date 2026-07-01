// Read-model builder for the "previous show" diff basis on the prediction page.
//
// For a given event, resolve — per participating corps — that corps's OWN most
// recent prior show this season, and fold its caption/category scores into the
// same RecapRowOut shape the recap builder emits. The comparand event differs
// per corps (tour routing differs), so we also return a `sources` map naming each
// corps's prior event (slug/name/date) for the diff table's tooltip.
//
// Shared by the app service (live/dev fallback) and the emitter so the two can't
// drift. Reuses `foldRecapRows` for byte-parity with the released recap.
//
// See docs/plans/DIFF_BASIS_TOGGLE_PLAN.md §3.

import type { Client } from '@libsql/client';
import {
  foldRecapRows,
  type CaptionScoreRow,
  type CategoryScoreRow,
  type CorpsScoreRow,
  type RecapRowOut,
} from './recap.js';

/** The prior event a corps's "previous" row was drawn from (for the tooltip). */
export interface PreviousSource {
  /** Event slug (mapped from competition_slug via event_to_competition). */
  slug: string;
  /** Human event name. */
  name: string;
  /** Event date (YYYY-MM-DD). */
  date: string;
}

export interface EventPreviousRecap {
  rows: RecapRowOut[];
  /** Keyed by corps_key → the prior event that corps's row came from. */
  sources: Record<string, PreviousSource>;
}

// Score/caption/category rows carry the competition_slug so we can keep only the
// row that belongs to each corps's *selected* prior competition (a corps may have
// competed at several earlier shows; we fold exactly one per corps).
type CorpsScoreRowWithComp = CorpsScoreRow & { competition_slug: string };
type CaptionScoreRowWithComp = CaptionScoreRow & { competition_slug: string };
type CategoryScoreRowWithComp = CategoryScoreRow & { competition_slug: string };

// Build a `?,?,…` placeholder list for an IN clause.
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/**
 * Resolve, for every corps in `slug`'s scored recap, that corps's most recent
 * prior show earlier in the same season, and fold those (per-corps) prior scores
 * into a RecapRow set + a per-corps `sources` map.
 */
export const buildEventPreviousRecap = async (
  db: Client,
  slug: string
): Promise<EventPreviousRecap> => {
  // One pass: resolve this event's competition (date+season), its participants,
  // then each participant's single most-recent prior competition this season —
  // excluding any competition that maps back to THIS event (prelims/finals share
  // an event slug, so a prior round of the same show must not count).
  const priorResult = await db.execute({
    sql: `
      WITH this_comp AS (
        SELECT COALESCE(
          (SELECT competition_slug FROM event_to_competition WHERE event_slug = ?1),
          (SELECT slug FROM competitions WHERE slug = ?1)
        ) AS cslug
      ),
      -- The current event slug, resolved from the competition so the exclusion
      -- below works whether the caller passed an event slug (app) or a competition
      -- slug (emit). Falls back to the raw input when unmapped.
      this_event AS (
        SELECT COALESCE(
          (SELECT event_slug FROM event_to_competition
             WHERE competition_slug = (SELECT cslug FROM this_comp)),
          ?1
        ) AS eslug
      ),
      this_meta AS (
        SELECT c.date AS d, c.season AS s
        FROM competitions c
        WHERE c.slug = (SELECT cslug FROM this_comp)
      ),
      participants AS (
        SELECT DISTINCT corps_key
        FROM corps_scores
        WHERE competition_slug = (SELECT cslug FROM this_comp)
      ),
      prior AS (
        SELECT cs.corps_key,
               cs.competition_slug AS competition_slug,
               c.date AS date,
               COALESCE(c.event_name, cs.competition_slug) AS event_name,
               COALESCE(m.event_slug, cs.competition_slug) AS event_slug,
               ROW_NUMBER() OVER (
                 PARTITION BY cs.corps_key ORDER BY c.date DESC
               ) AS rn
        FROM corps_scores cs
        JOIN competitions c ON c.slug = cs.competition_slug
        LEFT JOIN event_to_competition m ON m.competition_slug = cs.competition_slug
        CROSS JOIN this_meta tm
        WHERE cs.corps_key IN (SELECT corps_key FROM participants)
          AND c.season = tm.s
          AND c.date < tm.d
          -- Never count a prior round of the SAME event, nor the current comp
          -- itself (belt-and-suspenders alongside the date filter).
          AND COALESCE(m.event_slug, cs.competition_slug) <> (SELECT eslug FROM this_event)
          AND cs.competition_slug <> (SELECT cslug FROM this_comp)
          AND (cs.total_score IS NOT NULL OR cs.rank IS NOT NULL)
      )
      SELECT corps_key, competition_slug, date, event_name, event_slug
      FROM prior
      WHERE rn = 1
    `,
    args: [slug],
  });

  const priorRows = priorResult.rows as unknown as Array<{
    corps_key: string;
    competition_slug: string;
    date: string | null;
    event_name: string;
    event_slug: string;
  }>;

  if (priorRows.length === 0) return { rows: [], sources: {} };

  // corps_key → its selected prior competition_slug, and the sources map.
  const prevComp = new Map<string, string>();
  const sources: Record<string, PreviousSource> = {};
  const compSlugs = new Set<string>();
  for (const r of priorRows) {
    prevComp.set(r.corps_key, r.competition_slug);
    compSlugs.add(r.competition_slug);
    sources[r.corps_key] = {
      slug: String(r.event_slug),
      name: String(r.event_name),
      date: r.date ?? '',
    };
  }

  const comps = Array.from(compSlugs);
  const inClause = placeholders(comps.length);

  // Bulk-fetch the three score tables for all the prior competitions at once,
  // then keep only the rows whose (competition_slug, corps_key) is the pair we
  // selected for that corps. Mirror the recap builder's alias-canonical name.
  const scoreResult = await db.execute({
    sql: `
      SELECT cs.competition_slug AS competition_slug,
             cs.corps_key AS corps_key,
             COALESCE(ca.canonical_name, cs.corps_name) AS corps_name,
             cs.total_score AS total_score,
             cs.rank AS rank,
             cs.division_name AS division_name
      FROM corps_scores cs
      LEFT JOIN corps_aliases ca ON lower(ca.alias_name) = lower(cs.corps_name)
      WHERE cs.competition_slug IN (${inClause})
    `,
    args: comps,
  });

  const captionResult = await db.execute({
    sql: `
      SELECT competition_slug, corps_key, caption_name, score
      FROM caption_scores
      WHERE competition_slug IN (${inClause})
    `,
    args: comps,
  });

  const categoryResult = await db.execute({
    sql: `
      SELECT competition_slug, corps_key, category_name, score
      FROM category_scores
      WHERE competition_slug IN (${inClause})
    `,
    args: comps,
  });

  // Keep only the row belonging to each corps's selected prior competition.
  const keep = <T extends { competition_slug: string; corps_key: string }>(rows: readonly T[]) =>
    rows.filter((r) => prevComp.get(r.corps_key) === r.competition_slug);

  const scoreRows = keep(scoreResult.rows as unknown as CorpsScoreRowWithComp[]);
  const captionRows = keep(captionResult.rows as unknown as CaptionScoreRowWithComp[]);
  const categoryRows = keep(categoryResult.rows as unknown as CategoryScoreRowWithComp[]);

  return { rows: foldRecapRows(scoreRows, captionRows, categoryRows), sources };
};
