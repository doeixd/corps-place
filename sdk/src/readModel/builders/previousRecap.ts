// Read-model builder for the "previous show" diff basis on the prediction page.
//
// For a given event, resolve — per participating corps — that corps's OWN most
// recent prior show this season, and fold its caption/category scores into the
// same RecapRowOut shape the recap builder emits. The comparand event differs
// per corps (tour routing differs), so we also return a `sources` map naming each
// corps's prior event (slug/name/date) for the diff table's tooltip.
//
// Alias-robust: a corps can be recorded under different corps_keys across events
// (id/slug drift). We resolve each participant's full org identity group via the
// same union-find `buildCorpsCanonicalMap` the corps profile uses, find the prior
// show under ANY of the group's keys, then re-key the folded row back to the
// CURRENT event's corps_key so the diff join still matches.
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
import { buildCorpsCanonicalMap, type CanonicalCorps } from './corpsAliases.js';

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
// row that belongs to each corps's *selected* prior competition.
type CorpsScoreRowWithComp = CorpsScoreRow & { competition_slug: string };
type CaptionScoreRowWithComp = CaptionScoreRow & { competition_slug: string };
type CategoryScoreRowWithComp = CategoryScoreRow & { competition_slug: string };

// Build a `?,?,…` placeholder list for an IN clause.
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/**
 * Resolve, for every corps in `slug`'s scored recap, that corps's most recent
 * prior show earlier in the same season (matched across its whole alias group),
 * and fold those (per-corps) prior scores into a RecapRow set + a per-corps
 * `sources` map. Rows are keyed by the CURRENT event's corps_key.
 *
 * `canonical` (corps_key → representative identity) may be passed in so a bulk
 * emit builds it once instead of per event; omitted, it is built here.
 */
export const buildEventPreviousRecap = async (
  db: Client,
  slug: string,
  canonical?: Map<string, CanonicalCorps>
): Promise<EventPreviousRecap> => {
  // 1. Resolve this event's competition + its event slug (for same-event
  //    exclusion) + date/season. Works whether `slug` is an event or comp slug.
  const metaRes = await db.execute({
    sql: `
      WITH this_comp AS (
        SELECT COALESCE(
          (SELECT competition_slug FROM event_to_competition WHERE event_slug = ?1),
          (SELECT slug FROM competitions WHERE slug = ?1)
        ) AS cslug
      )
      SELECT
        tc.cslug AS cslug,
        COALESCE(
          (SELECT event_slug FROM event_to_competition WHERE competition_slug = tc.cslug),
          ?1
        ) AS eslug,
        (SELECT date FROM competitions WHERE slug = tc.cslug) AS d,
        (SELECT season FROM competitions WHERE slug = tc.cslug) AS s
      FROM this_comp tc
    `,
    args: [slug],
  });
  const meta = metaRes.rows[0] as unknown as
    | { cslug: string | null; eslug: string | null; d: string | null; s: string | null }
    | undefined;
  if (!meta?.cslug || meta.d == null || meta.s == null) return { rows: [], sources: {} };
  const cslug = String(meta.cslug);
  const eventSlug = String(meta.eslug ?? slug);
  const date = String(meta.d);
  const season = String(meta.s);

  // 2. Participants — the corps_keys scored at this event.
  const partRes = await db.execute({
    sql: `SELECT DISTINCT corps_key FROM corps_scores WHERE competition_slug = ?`,
    args: [cslug],
  });
  const currentKeys = (partRes.rows as unknown as Array<{ corps_key: string }>).map((r) =>
    String(r.corps_key)
  );
  if (currentKeys.length === 0) return { rows: [], sources: {} };

  // 3. Identity groups. `groupOf` maps any key to its org's representative key
  //    (itself when it has no alias siblings); `membersByGroup` lists every key
  //    in a group so we can look for prior shows under sibling keys too.
  const canon = canonical ?? (await buildCorpsCanonicalMap(db));
  const groupOf = (key: string): string => canon.get(key)?.corps_key ?? key;
  const membersByGroup = new Map<string, string[]>();
  for (const [key, rep] of canon) {
    const g = rep.corps_key;
    const arr = membersByGroup.get(g);
    if (arr) arr.push(key);
    else membersByGroup.set(g, [key]);
  }
  const keysInGroup = (key: string): string[] => membersByGroup.get(groupOf(key)) ?? [key];

  // participant group → the current display key (first participant wins); and the
  // full set of member keys to search for prior shows.
  const groupToCurrent = new Map<string, string>();
  const searchKeys = new Set<string>();
  for (const ck of currentKeys) {
    const g = groupOf(ck);
    if (!groupToCurrent.has(g)) groupToCurrent.set(g, ck);
    for (const k of keysInGroup(ck)) searchKeys.add(k);
  }

  // 4. Candidate prior scored rows for every member key this season, before this
  //    event's date. Pick the most recent per GROUP (not per key), excluding any
  //    competition mapping back to THIS event.
  const searchArr = [...searchKeys];
  const candRes = await db.execute({
    sql: `
      SELECT cs.corps_key AS corps_key,
             cs.competition_slug AS competition_slug,
             c.date AS date,
             COALESCE(c.event_name, cs.competition_slug) AS event_name,
             COALESCE(m.event_slug, cs.competition_slug) AS event_slug
      FROM corps_scores cs
      JOIN competitions c ON c.slug = cs.competition_slug
      LEFT JOIN event_to_competition m ON m.competition_slug = cs.competition_slug
      WHERE cs.corps_key IN (${placeholders(searchArr.length)})
        AND c.season = ?
        AND c.date < ?
        AND (cs.total_score IS NOT NULL OR cs.rank IS NOT NULL)
    `,
    args: [...searchArr, season, date],
  });

  type Best = {
    competition_slug: string;
    corps_key: string;
    date: string;
    event_name: string;
    event_slug: string;
  };
  const bestByGroup = new Map<string, Best>();
  for (const raw of candRes.rows as unknown as Array<{
    corps_key: string;
    competition_slug: string;
    date: string | null;
    event_name: string;
    event_slug: string;
  }>) {
    const evSlug = String(raw.event_slug);
    if (evSlug === eventSlug) continue; // never a prior round of the same event
    const g = groupOf(String(raw.corps_key));
    if (!groupToCurrent.has(g)) continue; // not one of this event's participants
    const d = String(raw.date ?? '');
    const cur = bestByGroup.get(g);
    // Most recent wins; tie-break on competition_slug for determinism.
    if (
      !cur ||
      d > cur.date ||
      (d === cur.date && String(raw.competition_slug) < cur.competition_slug)
    ) {
      bestByGroup.set(g, {
        competition_slug: String(raw.competition_slug),
        corps_key: String(raw.corps_key),
        date: d,
        event_name: String(raw.event_name),
        event_slug: evSlug,
      });
    }
  }
  if (bestByGroup.size === 0) return { rows: [], sources: {} };

  // 5. For the chosen (competition, prior-key) pairs, bulk-fetch the score tables
  //    and keep only those pairs. Map each prior key back to the participant's
  //    CURRENT key so the folded rows join the current scored recap.
  const chosenPairs = new Set<string>();
  const comps = new Set<string>();
  const priorKeyToCurrent = new Map<string, string>();
  const sources: Record<string, PreviousSource> = {};
  for (const [g, best] of bestByGroup) {
    const currentKey = groupToCurrent.get(g)!;
    chosenPairs.add(`${best.competition_slug}|${best.corps_key}`);
    comps.add(best.competition_slug);
    priorKeyToCurrent.set(best.corps_key, currentKey);
    sources[currentKey] = { slug: best.event_slug, name: best.event_name, date: best.date };
  }

  const compArr = [...comps];
  const priorKeys = [...priorKeyToCurrent.keys()];
  const inComp = placeholders(compArr.length);
  const inKey = placeholders(priorKeys.length);
  // Scope both the competitions AND the corps_keys we actually chose, so a prior
  // competition's non-participant corps aren't fetched then thrown away.
  const [scoreResult, captionResult, categoryResult] = await Promise.all([
    db.execute({
      sql: `
        SELECT cs.competition_slug AS competition_slug,
               cs.corps_key AS corps_key,
               COALESCE(ca.canonical_name, cs.corps_name) AS corps_name,
               cs.total_score AS total_score,
               cs.rank AS rank,
               cs.division_name AS division_name
        FROM corps_scores cs
        LEFT JOIN corps_aliases ca ON lower(ca.alias_name) = lower(cs.corps_name)
        WHERE cs.competition_slug IN (${inComp}) AND cs.corps_key IN (${inKey})
      `,
      args: [...compArr, ...priorKeys],
    }),
    db.execute({
      sql: `SELECT competition_slug, corps_key, caption_name, score
            FROM caption_scores
            WHERE competition_slug IN (${inComp}) AND corps_key IN (${inKey})`,
      args: [...compArr, ...priorKeys],
    }),
    db.execute({
      sql: `SELECT competition_slug, corps_key, category_name, score
            FROM category_scores
            WHERE competition_slug IN (${inComp}) AND corps_key IN (${inKey})`,
      args: [...compArr, ...priorKeys],
    }),
  ]);

  const inPair = <T extends { competition_slug: string; corps_key: string }>(rows: readonly T[]) =>
    rows.filter((r) => chosenPairs.has(`${r.competition_slug}|${r.corps_key}`));

  const scoreRows = inPair(scoreResult.rows as unknown as CorpsScoreRowWithComp[]);
  const captionRows = inPair(captionResult.rows as unknown as CaptionScoreRowWithComp[]);
  const categoryRows = inPair(categoryResult.rows as unknown as CategoryScoreRowWithComp[]);

  // Fold (keyed by the prior key), then re-key each row to the current key.
  const folded = foldRecapRows(scoreRows, captionRows, categoryRows);
  const rows = folded.map((row) => ({
    ...row,
    corps_key: priorKeyToCurrent.get(row.corps_key) ?? row.corps_key,
  }));

  return { rows, sources };
};
