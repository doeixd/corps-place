import type { JudgeAssignment, JudgeCorpsScore } from '@/lib/judge-directory';
import { byCaptionFamily } from '@/lib/caption-family';

// Derivation for the judge profile page. Pure functions over the loaded profile
// rows so the route component stays presentational (no inline grouping/sorting).

/** One show the judge worked, with every caption they judged there. */
export type ShowGroup = {
  competition_slug: string;
  event_slug: string;
  event_name: string;
  season: string | null;
  start_date: string | null;
  captions: string[];
};

/** One corps the judge scored, with every (show × caption) entry. */
export type CorpsGroup = {
  corps_key: string;
  corps_name: string;
  corps_slug: string | null;
  corps_logo: string | null;
  corps_logo_dark: number | null;
  corps_logo_dark_url: string | null;
  entries: {
    competition_slug: string;
    event_slug: string;
    event_name: string;
    season: string | null;
    start_date: string | null;
    caption_name: string;
    score: number | null;
    rank: number | null;
  }[];
};

/**
 * The season-year slug for an event link. Prefer the explicit season; fall back
 * to the leading `YYYY-` of the competition slug (most slugs start with it).
 */
export const eventYearSlug = (season: string | null, competitionSlug: string): string =>
  season ?? competitionSlug.split('-')[0] ?? 'unknown';

/** Keep only rows in the given season; `'all'` passes everything through. */
export const filterBySeason = <T extends { season: string | null }>(
  rows: readonly T[],
  season: string
): readonly T[] => (season === 'all' ? rows : rows.filter((r) => r.season === season));

/**
 * Distinct caption names a judge has worked, ordered GE → Visual → Music. Derive
 * from the judge's full (career) assignments so the caption-filter option list is
 * stable as the season filter changes.
 */
export const availableCaptions = (assignments: readonly JudgeAssignment[]): string[] =>
  [...new Set(assignments.map((a) => a.caption_name))].sort(byCaptionFamily);

/** Keep only rows in the given captions; an empty list passes everything through. */
export const filterByCaptions = <T extends { caption_name: string }>(
  rows: readonly T[],
  captions: readonly string[]
): readonly T[] =>
  captions.length === 0 ? rows : rows.filter((r) => captions.includes(r.caption_name));

/**
 * Group assignments by show (one card per competition), collecting the captions
 * judged there. Captions are ordered GE → Visual → Music so their colors band
 * together; shows are ordered newest first (by date, then name).
 */
export const groupAssignmentsByShow = (assignments: readonly JudgeAssignment[]): ShowGroup[] => {
  const map = new Map<string, ShowGroup>();
  for (const a of assignments) {
    const existing = map.get(a.competition_slug);
    if (existing) {
      if (!existing.captions.includes(a.caption_name)) existing.captions.push(a.caption_name);
    } else {
      map.set(a.competition_slug, {
        competition_slug: a.competition_slug,
        event_slug: a.event_slug,
        event_name: a.event_name,
        season: a.season,
        start_date: a.start_date,
        captions: [a.caption_name],
      });
    }
  }
  for (const g of map.values()) g.captions.sort(byCaptionFamily);
  return [...map.values()].sort((a, b) => {
    if (a.start_date && b.start_date) return b.start_date.localeCompare(a.start_date);
    return b.event_name.localeCompare(a.event_name);
  });
};

/**
 * Group corps scores by corps (one collapsible row per corps), de-duping
 * identical (competition × caption) rows. Within a corps, entries are ordered
 * newest show first, then caption family (GE → Visual → Music); corps are
 * ordered alphabetically.
 */
export const groupScoresByCorps = (scores: readonly JudgeCorpsScore[]): CorpsGroup[] => {
  const map = new Map<string, CorpsGroup>();
  // Track seen (competition × caption) per corps so duplicate judge_scores rows
  // don't render twice.
  const seen = new Map<string, Set<string>>();
  for (const s of scores) {
    let existing = map.get(s.corps_key);
    if (!existing) {
      existing = {
        corps_key: s.corps_key,
        corps_name: s.corps_name,
        corps_slug: s.corps_slug ?? null,
        corps_logo: s.corps_logo ?? null,
        corps_logo_dark: s.corps_logo_dark ?? null,
        corps_logo_dark_url: s.corps_logo_dark_url ?? null,
        entries: [],
      };
      map.set(s.corps_key, existing);
      seen.set(s.corps_key, new Set());
    }
    const seenKeys = seen.get(s.corps_key)!;
    const dedupeKey = `${s.competition_slug}|${s.caption_name}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    existing.entries.push({
      competition_slug: s.competition_slug,
      event_slug: s.event_slug,
      event_name: s.event_name,
      season: s.season,
      start_date: s.start_date,
      caption_name: s.caption_name,
      score: s.score,
      rank: s.rank,
    });
  }
  for (const g of map.values()) {
    g.entries.sort(
      (a, b) =>
        (b.start_date ?? '').localeCompare(a.start_date ?? '') ||
        byCaptionFamily(a.caption_name, b.caption_name)
    );
  }
  return [...map.values()].sort((a, b) => a.corps_name.localeCompare(b.corps_name));
};
