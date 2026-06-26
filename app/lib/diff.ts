/**
 * Pure scored-vs-predicted diff computation for the 2026 Diff view.
 *
 * No Effect, no DB, no side effects — safe to import in the client bundle. Given
 * the scored recap rows and the predicted recap rows (both `RecapRow`, keyed on
 * `corps_key`), it produces one `DiffRow` per corps via a full outer join.
 *
 * See docs/plans/SCORES_PREDICTION_DIFF_TABS_PLAN.md §3 / §P1.
 */

import { CAPTIONS, type Caption, type RecapRow } from './prediction-scenario';

// The 8 subcaptions plus `total` are the only diffable keys (aggregates GE /
// Visual / Music are derived from subcaption diffs, not joined directly).
export const DIFF_CAPTION_KEYS = [...CAPTIONS, 'total'] as const;
export type DiffCaptionKey = (typeof DIFF_CAPTION_KEYS)[number];

export interface DiffCaption {
  /** Actual score, or null if the corps was not scored / lacks this caption. */
  scored: number | null;
  /** Predicted mean, or null if the corps is not in the prediction / lacks it. */
  predicted: number | null;
  /** `scored - predicted`, or null if either side is missing. */
  diff: number | null;
}

export interface DiffRow {
  corps_key: string;
  name: string;
  division?: string;
  rank?: number;
  // Aggregates (derived from the subcaption diffs).
  total: DiffCaption;
  ge: DiffCaption;
  visual: DiffCaption;
  music: DiffCaption;
  // The 8 subcaptions, keyed by canonical caption name.
  captions: Record<Caption, DiffCaption>;
}

const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const diffOf = (scored: number | null, predicted: number | null): number | null =>
  scored == null || predicted == null ? null : Number((scored - predicted).toFixed(3));

const makeCaption = (scored: number | null, predicted: number | null): DiffCaption => ({
  scored,
  predicted,
  diff: diffOf(scored, predicted),
});

// Aggregate one side (scored or predicted) from its subcaption values, mirroring
// the recap builder's fold (ge = ge1+ge2; visual = (vp+va+cg)/2; music =
// (mb+ma+mp)/2; total = ge+visual+music). Returns null when ALL contributing
// subcaptions are missing on that side, so a one-sided corps stays one-sided.
const aggregateSide = (
  caps: Record<Caption, DiffCaption>,
  side: 'scored' | 'predicted'
): { ge: number | null; visual: number | null; music: number | null; total: number | null } => {
  const v = (c: Caption) => caps[c][side];
  const present = (...cs: Caption[]) => cs.some((c) => v(c) != null);
  const sum = (...cs: Caption[]) => cs.reduce((a, c) => a + (v(c) ?? 0), 0);

  const ge = present('GE1', 'GE2') ? Number(sum('GE1', 'GE2').toFixed(3)) : null;
  const visual = present('VP', 'VA', 'CG') ? Number((sum('VP', 'VA', 'CG') / 2).toFixed(3)) : null;
  const music = present('MB', 'MA', 'MP') ? Number((sum('MB', 'MA', 'MP') / 2).toFixed(3)) : null;
  const total =
    ge == null && visual == null && music == null
      ? null
      : Number(((ge ?? 0) + (visual ?? 0) + (music ?? 0)).toFixed(3));
  return { ge, visual, music, total };
};

const indexByKey = (rows: readonly RecapRow[]): Map<string, RecapRow> => {
  const map = new Map<string, RecapRow>();
  for (const row of rows) {
    const key = typeof row.corps_key === 'string' ? row.corps_key : undefined;
    if (key && !map.has(key)) map.set(key, row);
  }
  return map;
};

/**
 * Full outer join of scored vs predicted recap rows on `corps_key`. Per
 * subcaption: `diff = scored - predicted`, null when either side lacks it.
 * Aggregate diffs are derived from the subcaption diffs (not the joined
 * aggregate columns), so a source carrying only subcaptions still diffs.
 */
export const computeDiff = (
  scoredRows: readonly RecapRow[],
  predictedRows: readonly RecapRow[]
): DiffRow[] => {
  const scored = indexByKey(scoredRows);
  const predicted = indexByKey(predictedRows);

  // Preserve order: scored rows first (real results lead), then predicted-only.
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of scored.keys()) {
    if (!seen.has(k)) (seen.add(k), keys.push(k));
  }
  for (const k of predicted.keys()) {
    if (!seen.has(k)) (seen.add(k), keys.push(k));
  }

  return keys.map((corps_key) => {
    const s = scored.get(corps_key);
    const p = predicted.get(corps_key);

    const captions = {} as Record<Caption, DiffCaption>;
    for (const cap of CAPTIONS) {
      captions[cap] = makeCaption(numOrNull(s?.[cap]), numOrNull(p?.[cap]));
    }

    const sAgg = aggregateSide(captions, 'scored');
    const pAgg = aggregateSide(captions, 'predicted');

    const name =
      (typeof s?.corps === 'string' && s.corps) ||
      (typeof p?.corps === 'string' && p.corps) ||
      corps_key;
    const division =
      (typeof s?.division === 'string' && s.division) ||
      (typeof p?.division === 'string' && p.division) ||
      undefined;
    const rank = typeof s?.rank === 'number' ? s.rank : typeof p?.rank === 'number' ? p.rank : undefined;

    return {
      corps_key,
      name,
      division,
      rank,
      total: makeCaption(sAgg.total, pAgg.total),
      ge: makeCaption(sAgg.ge, pAgg.ge),
      visual: makeCaption(sAgg.visual, pAgg.visual),
      music: makeCaption(sAgg.music, pAgg.music),
      captions,
    };
  });
};
