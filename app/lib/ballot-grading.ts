// Post-finals ballot grading (M5) — pure functions, no I/O. The "actuals" come
// from rm_fantasy_prior_finals (championships-WEEK best caption score per corps:
// prelims covers everyone, so semis/world/open/all ballots grade too, not just
// the 12 finalists). Placements derive from the same DCI total formula the
// editor's ▲▼ arrows use (ballot.ts getPredictionPool), so the grade agrees
// with what users compared against while arranging.

import type { BallotCaption } from '@/lib/server-fns/ballot';
import { BALLOT_CAPTIONS } from '@/lib/server-fns/ballot';

/** Points for a pick in exactly the right spot; each position off costs DECAY. */
export const POINTS_EXACT = 10;
export const POINTS_DECAY = 3;

export const pickPoints = (delta: number): number =>
  Math.max(0, POINTS_EXACT - POINTS_DECAY * Math.abs(delta));

export interface ActualStandings {
  /** slug → championship placement (1-based), by computed total. */
  overall: Map<string, number>;
  /** per caption: slug → placement by that caption's score. */
  captions: Record<BallotCaption, Map<string, number>>;
  /** Corps in the championship field (drives "did not compete" labeling). */
  fieldSize: number;
}

export interface PriorFinalsRow {
  corps_key: string;
  caption_name: string;
  score: number;
}

const CAPTION_NAME_TO_KEY: Record<string, BallotCaption> = {
  'General Effect 1': 'GE1',
  'General Effect 2': 'GE2',
  'Visual Proficiency': 'VP',
  'Visual - Analysis': 'VA',
  'Color Guard': 'CG',
  'Music - Brass': 'MB',
  'Music - Analysis': 'MA',
  'Music - Percussion': 'MP',
};

const totalOf = (m: Partial<Record<BallotCaption, number>>): number =>
  (m.GE1 ?? 0) +
  (m.GE2 ?? 0) +
  ((m.VP ?? 0) + (m.VA ?? 0) + (m.CG ?? 0)) / 2 +
  ((m.MB ?? 0) + (m.MA ?? 0) + (m.MP ?? 0)) / 2;

/**
 * Rank the championship field. `keyToSlug` maps the caption rows' corps_key to
 * the slug vocabulary ballots use (rm_fantasy_draft_pool); keys with no slug
 * fall back to the key itself, matching getPredictionPool's corpsSlug fallback.
 */
export function buildActualStandings(
  rows: PriorFinalsRow[],
  keyToSlug: Map<string, string>
): ActualStandings {
  const scores = new Map<string, Partial<Record<BallotCaption, number>>>();
  for (const row of rows) {
    const cap = CAPTION_NAME_TO_KEY[row.caption_name];
    if (!cap) continue;
    const slug = keyToSlug.get(row.corps_key) ?? row.corps_key;
    const m = scores.get(slug) ?? {};
    m[cap] = Number(row.score);
    scores.set(slug, m);
  }

  const overall = new Map<string, number>();
  [...scores.entries()]
    .sort((a, b) => totalOf(b[1]) - totalOf(a[1]))
    .forEach(([slug], i) => overall.set(slug, i + 1));

  const captions = {} as Record<BallotCaption, Map<string, number>>;
  for (const cap of BALLOT_CAPTIONS) {
    const ranked = [...scores.entries()]
      .filter(([, m]) => typeof m[cap] === 'number')
      .sort((a, b) => (b[1][cap] ?? 0) - (a[1][cap] ?? 0));
    captions[cap] = new Map(ranked.map(([slug], i) => [slug, i + 1]));
  }

  return { overall, captions, fieldSize: scores.size };
}

export interface GradedPick {
  slug: string;
  /** 1-based position the ballot predicted. */
  predicted: number;
  /** Actual championship placement, or null if the corps never competed there. */
  actual: number | null;
  /** predicted − actual (negative = finished better than picked). null when actual is. */
  delta: number | null;
  points: number;
}

export interface OrderingGrade {
  picks: GradedPick[];
  earned: number;
  possible: number;
  /** 0–100, rounded to one decimal. */
  pct: number;
  exact: number;
}

/** Grade one ordered list of slugs against an actual placement map. */
export function gradeOrdering(
  predictedSlugs: string[],
  actual: Map<string, number>
): OrderingGrade {
  const picks: GradedPick[] = predictedSlugs.map((slug, i) => {
    const actualRank = actual.get(slug) ?? null;
    const delta = actualRank === null ? null : i + 1 - actualRank;
    return {
      slug,
      predicted: i + 1,
      actual: actualRank,
      delta,
      points: delta === null ? 0 : pickPoints(delta),
    };
  });
  const earned = picks.reduce((s, p) => s + p.points, 0);
  const possible = POINTS_EXACT * picks.length;
  return {
    picks,
    earned,
    possible,
    pct: possible ? Math.round((earned / possible) * 1000) / 10 : 0,
    exact: picks.filter((p) => p.delta === 0).length,
  };
}

/** Median of a non-empty numeric array (lower-of-two for even lengths kept simple: true median). */
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export interface ConsensusRow {
  slug: string;
  name: string;
  /** Median predicted 1-based position across ballots that included the corps. */
  medianPredicted: number;
  /** How many ballots included the corps. */
  appearances: number;
  actual: number | null;
}

/**
 * Community consensus: for each corps, the median predicted position across all
 * ballots that placed it. Ordered by median (ties: more appearances first).
 */
export function buildConsensus(
  ballots: Array<{ overall: Array<{ slug: string; name: string }> }>,
  actual: Map<string, number>
): ConsensusRow[] {
  const positions = new Map<string, { name: string; at: number[] }>();
  for (const b of ballots) {
    b.overall.forEach((entry, i) => {
      const rec = positions.get(entry.slug) ?? { name: entry.name, at: [] };
      rec.at.push(i + 1);
      positions.set(entry.slug, rec);
    });
  }
  return [...positions.entries()]
    .map(([slug, rec]) => ({
      slug,
      name: rec.name,
      medianPredicted: median(rec.at),
      appearances: rec.at.length,
      actual: actual.get(slug) ?? null,
    }))
    .sort(
      (a, b) =>
        a.medianPredicted - b.medianPredicted ||
        b.appearances - a.appearances ||
        a.name.localeCompare(b.name)
    );
}
